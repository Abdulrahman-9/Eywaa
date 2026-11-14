import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { canonicalId, editDistance, normalizeDocNumber, normalizeName, toAsciiDigits } from '../common/arabic';
import { FieldCrypto, mask } from '../common/crypto';
import { formatFamilyNo } from '../common/family-no';
import { Db } from '../db/db.module';
import { ScoringService } from '../scoring/scoring.service';
import { SettingsService } from '../settings/settings.service';
import { CreateFamilyInput, DocumentInput, documentKey, documentNumberKey } from './families.schema';

/** حدّ تشابه الاسم الكامل الذي تُرفع عنده شبهة التكرار. */
const NAME_SIMILARITY = 0.6;
/** حدّ تشابه الاسم الأول (يُخرج الإخوة وأبناء العمومة المتفقين في بقية الاسم). */
const FIRST_NAME_SIMILARITY = 0.5;
const MOTHER_SIMILARITY = 0.7;
/** حدّ الاسم «شبه المطابق» الذي يكفي معه تطابق تاريخ الميلاد باليوم. */
const NEAR_EXACT_NAME = 0.85;
const MAX_FLAGS_PER_PERSON = 5;
/** الاسم من أربعة مقاطع فأكثر (رباعي، أو ثلاثي ولقب) إن طابق اسماً مسجَّلاً فهو شبهة بذاته. */
const FULL_NAME_PARTS = 4;
const FULL_NAME_MATCH = 0.97;
/** الرقم نفسه بسجل آخر قرينة قوية بذاتها، فيكفي معها تشابه اسم أدنى مما يُطلب في التشابه العام. */
const SAME_NUMBER_NAME_SIMILARITY = 0.4;

export interface HardConflict {
  kind: 'DOCUMENT' | 'RATION_CARD';
  memberIndex?: number;
  documentType?: string;
  familyNo: string;
  familyStatus: string;
  personName?: string;
}

@Injectable()
export class FamiliesService implements OnModuleInit {
  private readonly log = new Logger('FamiliesService');
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ScoringService) private readonly scoring: ScoringService,
  ) {}

  /** يضيف وثيقة هوية لفرد. قيد الفرادة في القاعدة يمنع تكرارها. */
  async insertDocument(c: PoolClient, personId: string, doc: DocumentInput) {
    const d = doc as DocumentInput & { register?: string; page?: string; portfolio?: string };
    await c.query(
      `insert into person_documents (person_id, type, key_hash, number_hash, key_version, number_enc, register, page, portfolio, issued_at)
       values ($1,$2,$3,$4,2,$5,$6,$7,$8,$9)`,
      [
        personId, d.type, this.crypto.blindIndex(documentKey(d)), this.crypto.blindIndex(documentNumberKey(d.type, d.number)), this.crypto.encrypt(d.number),
        d.register ?? null, d.page ?? null, d.portfolio ?? null, d.issuedAt ?? null,
      ],
    );
  }

  /**
   * عند الإقلاع: الوثائق المحفوظة بالمفتاح القديم (رقم|سجل|صفحة) يُعاد حساب مفتاحها بالجديد (سجل ثم رقم).
   * يُعاد مرة واحدة لكل وثيقة، ولا يضرّ تكراره.
   */
  async onModuleInit() {
    try {
      const n = await this.rekeyDocuments();
      if (n.rekeyed || n.collisions) this.log.log(`أُعيد حساب مفاتيح ${n.rekeyed} وثيقة، منها ${n.collisions} تصادمت مع وثيقة قائمة ورُفعت للمراجعة`);
    } catch (err) {
      // قاعدة لم تُرحَّل بعد: لا يمنع الإقلاع.
      this.log.warn(`تعذّر إعادة حساب مفاتيح الوثائق: ${(err as Error).message}`);
    }
  }

  async rekeyDocuments(): Promise<{ rekeyed: number; collisions: number }> {
    let rekeyed = 0, collisions = 0;
    for (;;) {
      const { rows } = await this.db.query(
        `select d.id, d.person_id, d.type, d.number_enc, d.register, d.page, d.portfolio, p.family_id, f.status
         from person_documents d join persons p on p.id = d.person_id join families f on f.id = p.family_id where d.key_version < 2 order by d.id limit 500`);
      if (!rows.length) break;
      for (const r of rows) {
        const number = this.crypto.decrypt(r.number_enc);
        const doc = { type: r.type, number, register: r.register ?? '', page: r.page ?? '', portfolio: r.portfolio ?? '' } as DocumentInput;
        const rejected = r.status === 'REJECTED';
        // وثائق السجل المرفوض محرَّرة: مفتاحها يبقى ملحقاً بما يفرده، ولا تدخل مطابقة الرقم.
        const key = this.crypto.blindIndex(documentKey(doc)) + (rejected ? `:rejected:${r.id}` : '');
        const numberHash = rejected ? null : this.crypto.blindIndex(documentNumberKey(r.type, number));
        try {
          await this.db.query('update person_documents set key_hash = $2, number_hash = $3, key_version = 2 where id = $1', [r.id, key, numberHash]);
          rekeyed++;
        } catch (err: any) {
          if (err.code !== '23505') throw err;
          // وثيقتان قديمتان صارتا بالمفتاح الجديد واحدة (سجل ورقم واحد، وصفحتان): شخص سُجّل مرتين.
          // لا يُحذف شيء: تبقى الثانية بمفتاح يفردها، وتُرفع شبهةً يفصل فيها المشرف.
          const other = (await this.db.query('select d.person_id, p.family_id from person_documents d join persons p on p.id = d.person_id where d.key_hash = $1', [key])).rows[0];
          await this.db.tx(async (c) => {
            await c.query('update person_documents set key_hash = $2, number_hash = $3, key_version = 2 where id = $1', [r.id, `${key}:collision:${r.id}`, numberHash]);
            if (other && other.family_id !== r.family_id) {
              await c.query(
                `insert into duplicate_flags (family_id, person_id, matched_person_id, matched_family_id, reason, score) values ($1,$2,$3,$4,$5,0.99)`,
                [r.family_id, r.person_id, other.person_id, other.family_id, 'الوثيقة نفسها (السجل والرقم) مسجَّلة لشخصين بصفحتين مختلفتين']);
            }
          });
          collisions++;
        }
      }
    }
    return { rekeyed, collisions };
  }

  /**
   * من يحمل الرقم نفسه بسجل (أو محفظة) آخر. ليس تكراراً بذاته: الرقم يتكرر بين السجلات.
   * يُعاد معه ما يُرجّح أنه الشخص نفسه: تقارب السجلّين كتابةً (خطأ إدخال محتمل)، وتشابه الاسم.
   */
  async sameNumberElsewhere(q: { query: Db['query'] }, doc: DocumentInput, opts: { excludeFamilyId?: string; nameNorm?: string } = {}) {
    if (doc.type === 'NATIONAL_CARD') return [];
    const mine = canonicalId(doc.type === 'CIVIL_ID' ? doc.register : doc.portfolio);
    const { rows } = await q.query(
      `select d.register, d.portfolio, p.id as person_id, p.full_name, p.name_norm, p.mother_norm, p.birth_date, f.id as family_id, f.family_no, f.status,
              case when $4::text is null then null else similarity(p.name_norm, $4) end as name_score
       from person_documents d join persons p on p.id = d.person_id join families f on f.id = p.family_id
       where d.number_hash = $1 and d.key_hash <> $2 and f.status <> 'REJECTED' and ($3::uuid is null or f.id <> $3)
       order by name_score desc nulls last limit 20`,
      [this.crypto.blindIndex(documentNumberKey(doc.type, doc.number)), this.crypto.blindIndex(documentKey(doc)), opts.excludeFamilyId ?? null, opts.nameNorm ?? null]);
    return rows.map((r) => {
      const theirs = canonicalId((doc.type === 'CIVIL_ID' ? r.register : r.portfolio) ?? '');
      return {
        personId: r.person_id as string, familyId: r.family_id as string, familyNo: r.family_no as string, status: r.status as string, personName: r.full_name as string,
        book: theirs, nameScore: r.name_score === null ? null : Number(r.name_score), motherNorm: r.mother_norm as string | null, birthDate: r.birth_date as Date | null,
        // حرف واحد مبدَّل أو زائد أو ناقص، أو حرفان متجاوران مقلوبان: «45» و«54»، «112» و«12».
        bookNear: editDistance(mine, theirs, 1) <= 1,
      };
    });
  }

  hashDocuments(members: { documents: DocumentInput[] }[]) {
    return members.flatMap((m, memberIndex) =>
      m.documents.map((d) => ({ memberIndex, doc: d, hash: this.crypto.blindIndex(documentKey(d)) })),
    );
  }

  // ---------- التسجيل ----------

  async create(input: CreateFamilyInput, actor: AuthUser) {
    // إعادة إرسال العملية نفسها (بعد انقطاع الشبكة مثلاً) تعيد السجل القائم ولا تكرّره.
    if (input.clientOpId) {
      const existing = await this.db.query('select id from families where client_op_id = $1', [input.clientOpId]);
      if (existing.rows[0]) return this.get(existing.rows[0].id);
    }

    const rationHash = input.rationCard ? this.crypto.blindIndex(`RC:${input.rationCard.number}`) : null;
    const docs = this.hashDocuments(input.members);

    try {
      const familyId = await this.db.tx(async (c) => {
        const conflicts = await this.findHardConflicts(c, docs, rationHash);
        if (conflicts.length) throw this.conflictError(conflicts);

        const seq = await c.query("select nextval('family_no_seq') as n");
        const familyNo = formatFamilyNo(seq.rows[0].n);

        const fam = await c.query(
          `insert into families (
             family_no, status, tags, phone1, phone2, mahalla, street, house, landmark,
             housing, housing_other, prev_address, prev_landmark,
             residence_card_no, residence_card_at, residence_card_by,
             ration_hash, ration_enc, ration_issued_at, ration_center,
             lat, lng, notes, client_op_id, created_by, has_whatsapp, prefers_voice)
           values ($1,'PENDING_APPROVAL',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
           returning id`,
          [
            familyNo, input.tags, input.phone1 ?? null, input.phone2 ?? null,
            input.address.mahalla ?? null, input.address.street ?? null, input.address.house ?? null,
            input.address.landmark ?? null, input.housing ?? null, input.housingOther ?? null,
            input.prevAddress ?? null, input.prevLandmark ?? null,
            input.residenceCard?.number ?? null, input.residenceCard?.issuedAt ?? null,
            input.residenceCard?.issuedBy ?? null,
            rationHash, input.rationCard ? this.crypto.encrypt(input.rationCard.number) : null,
            input.rationCard?.issuedAt ?? null, input.rationCard?.center ?? null,
            input.location?.lat ?? null, input.location?.lng ?? null, input.notes ?? null,
            input.clientOpId ?? null, actor.id, input.hasWhatsapp, input.prefersVoice,
          ],
        );
        const id: string = fam.rows[0].id;

        const personIds: string[] = [];
        for (const m of input.members) {
          const p = await c.query(
            `insert into persons (family_id, relation, status, full_name, name_norm, mother_name, mother_norm,
                                  gender, birth_date, is_orphan, disability, chronic_illness)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
            [
              id, m.relation, m.status, m.fullName, normalizeName(m.fullName), m.motherName ?? null,
              m.motherName ? normalizeName(m.motherName) : null, m.gender, m.birthDate ?? null,
              m.isOrphan, m.disability ?? null, m.chronicIllness ?? null,
            ],
          );
          personIds.push(p.rows[0].id);
        }

        for (const d of docs) await this.insertDocument(c, personIds[d.memberIndex], d.doc);
        for (const inc of input.incomes) {
          await c.query('insert into income_sources (family_id, kind, amount_iqd, note) values ($1,$2,$3,$4)', [
            id, inc.kind, inc.amountIqd, inc.note ?? null,
          ]);
        }
        for (const px of input.proxies) {
          await c.query('insert into proxies (family_id, full_name, phone, relation) values ($1,$2,$3,$4)', [
            id, px.fullName, px.phone ?? null, px.relation ?? null,
          ]);
        }

        const flags = (await this.flagSuspectedDuplicates(c, id, input, personIds)) + (await this.flagSameNumber(c, id, input, personIds));
        if (flags > 0) {
          await c.query("update families set status = 'PENDING_DEDUPE_REVIEW' where id = $1", [id]);
        }

        await this.audit.append(c, {
          actorId: actor.id, action: 'family.create', entity: 'family', entityId: id,
          payload: { familyNo, members: input.members.length, documents: docs.length, duplicateFlags: flags },
        });
        return id;
      });
      return this.get(familyId);
    } catch (err: any) {
      // سباق بين تسجيلين متزامنين: قيد الفرادة في القاعدة هو الحكَم الأخير.
      if (err.code === '23505') {
        if (err.constraint === 'families_client_op_id_key' && input.clientOpId) {
          const existing = await this.db.query('select id from families where client_op_id = $1', [input.clientOpId]);
          if (existing.rows[0]) return this.get(existing.rows[0].id);
        }
        const conflicts = await this.db.tx((c) => this.findHardConflicts(c, docs, rationHash));
        throw this.conflictError(conflicts);
      }
      throw err;
    }
  }

  conflictError(conflicts: HardConflict[]) {
    return new ConflictException({
      message: 'مسجَّل سلفاً: وثيقة أو بطاقة تموينية موجودة في النظام',
      conflicts,
    });
  }

  async findHardConflicts(
    c: PoolClient,
    docs: { memberIndex: number; doc: DocumentInput; hash: string }[],
    rationHash: string | null,
  ): Promise<HardConflict[]> {
    const conflicts: HardConflict[] = [];
    if (docs.length) {
      const { rows } = await c.query(
        `select d.key_hash, p.full_name, f.family_no, f.status
         from person_documents d join persons p on p.id = d.person_id join families f on f.id = p.family_id
         where d.key_hash = any($1)`,
        [docs.map((d) => d.hash)],
      );
      for (const r of rows) {
        const hit = docs.find((d) => d.hash === r.key_hash)!;
        conflicts.push({
          kind: 'DOCUMENT', memberIndex: hit.memberIndex, documentType: hit.doc.type,
          familyNo: r.family_no, familyStatus: r.status, personName: r.full_name,
        });
      }
    }
    if (rationHash) {
      const { rows } = await c.query('select family_no, status from families where ration_hash = $1', [rationHash]);
      if (rows[0]) conflicts.push({ kind: 'RATION_CARD', familyNo: rows[0].family_no, familyStatus: rows[0].status });
    }
    return conflicts;
  }

  /**
   * التشابه الترجيحي: اسم رباعي مطابق (وحده يكفي)، أو اسم كامل متقارب واسم أول متقارب ومعهما قرينة قوية واحدة على الأقل:
   * اسم الأم، أو هاتف العائلة، أو تاريخ الميلاد باليوم مع اسم شبه مطابق.
   * سنة الميلاد وحدها ليست قرينة: الأسماء الشائعة تتطابق فيها كثيراً فتغرق المراجعين بالشبهات.
   * يُعلَّق السجل ولا يُمنع.
   */
  private async flagSuspectedDuplicates(c: PoolClient, familyId: string, input: CreateFamilyInput, personIds: string[]) {
    const phones = [input.phone1, input.phone2].filter((p): p is string => !!p);
    // يجعل عامل التشابه (%) يعمل بالحدّ نفسه فيُستعمل فهرس الأسماء.
    await c.query(`set local pg_trgm.similarity_threshold = ${NAME_SIMILARITY}`);
    // المخطِّط يُسيء تقدير انتقائية (%) فيمسح الجدول كله (30 م.ث) بدل الفهرس (2 م.ث). يسري على هذه المعاملة وحدها.
    await c.query('set local enable_seqscan = off');
    let count = 0;
    for (let i = 0; i < input.members.length; i++) {
      const m = input.members[i];
      const nameNorm = normalizeName(m.fullName);
      const motherNorm = m.motherName ? normalizeName(m.motherName) : null;
      const { rows } = await c.query(
        `select * from (
           select p.id, p.family_id, similarity(p.name_norm, $1) as score,
                  (p.birth_date is not null and p.birth_date = $3::date) as same_birth_date,
                  (p.mother_norm is not null and $4::text is not null
                     and similarity(p.mother_norm, $4) >= $6) as same_mother,
                  (f.phone1 = any($5::text[]) or f.phone2 = any($5::text[])) as same_phone,
                  -- اسم الأم معلوم عند الاثنين ومختلف: قرينة أنهما شخصان، فلا يكفي معها تطابق الاسم وحده.
                  (p.mother_norm is not null and $4::text is not null and similarity(p.mother_norm, $4) < $6) as mother_differs
           from persons p join families f on f.id = p.family_id
           where p.name_norm % $1
             and p.family_id <> $2 and f.status <> 'REJECTED'
             and similarity(split_part(p.name_norm, ' ', 1), split_part($1, ' ', 1)) >= $7
         ) m
         where same_mother or same_phone or (same_birth_date and score >= $8) or ($10 and score >= $11 and not mother_differs)
         order by score desc limit $9`,
        [nameNorm, familyId, m.birthDate ?? null, motherNorm, phones, MOTHER_SIMILARITY, FIRST_NAME_SIMILARITY,
         NEAR_EXACT_NAME, MAX_FLAGS_PER_PERSON, nameNorm.split(' ').length >= FULL_NAME_PARTS, FULL_NAME_MATCH],
      );
      for (const r of rows) {
        const reasons = [r.same_mother && 'اسم الأم', r.same_phone && 'الهاتف', r.same_birth_date && 'تاريخ الميلاد'].filter(Boolean);
        // الاسم الرباعي الكامل شبه فريد: تطابقه وحده يكفي للشبهة، بلا قرينة أخرى.
        if (!reasons.length) reasons.push('الاسم الرباعي كاملاً');
        await c.query(
          `insert into duplicate_flags (family_id, person_id, matched_person_id, matched_family_id, reason, score)
           values ($1,$2,$3,$4,$5,$6)`,
          [familyId, personIds[i], r.id, r.family_id, `تشابه الاسم مع تطابق: ${reasons.join('، ')}`, r.score],
        );
        count++;
      }
    }
    return count;
  }

  /**
   * رقم الهوية نفسه بسجل آخر، ومعه قرينة أنه الشخص نفسه: تُرفع شبهة ويُعلَّق السجل.
   * القرائن: اسم متشابه، أو اسم الأم، أو تاريخ الميلاد. وتقارب السجلّين كتابةً يرفع الدرجة ولا يكفي وحده:
   * السجلات متتالية الأرقام، فجارُ السجل ليس دليلاً.
   * الرقم نفسه بلا قرينة لا يُرفع: ذاك هو التكرار المعتاد بين السجلات.
   */
  private async flagSameNumber(c: PoolClient, familyId: string, input: CreateFamilyInput, personIds: string[]) {
    let count = 0;
    for (let i = 0; i < input.members.length; i++) {
      const m = input.members[i];
      const nameNorm = normalizeName(m.fullName);
      const motherNorm = m.motherName ? normalizeName(m.motherName) : null;
      for (const doc of m.documents) {
        if (doc.type === 'NATIONAL_CARD') continue;
        for (const hit of await this.sameNumberElsewhere(c, doc, { excludeFamilyId: familyId, nameNorm })) {
          const sameName = (hit.nameScore ?? 0) >= SAME_NUMBER_NAME_SIMILARITY;
          const sameFirst = nameNorm.split(' ')[0] === (hit.personName ? normalizeName(hit.personName).split(' ')[0] : '');
          const sameMother = !!motherNorm && !!hit.motherNorm && (motherNorm === hit.motherNorm || editDistance(motherNorm, hit.motherNorm, 1) <= 1);
          const sameBirth = !!m.birthDate && !!hit.birthDate && new Date(hit.birthDate).toISOString().slice(0, 10) === m.birthDate;
          // الاسم الأول وحده مع سجل متقارب قرينة أيضاً: «علي» بالرقم نفسه والسجل 45 ثم 54.
          if (!(sameName || sameMother || sameBirth || (sameFirst && hit.bookNear))) continue;
          const evidence = [sameName && 'الاسم', !sameName && sameFirst && 'الاسم الأول', sameMother && 'اسم الأم', sameBirth && 'تاريخ الميلاد'].filter(Boolean);
          const [what, differs, both] = doc.type === 'CIVIL_ID' ? ['السجل', 'مختلف', 'السجلان متقاربان'] : ['المحفظة', 'مختلفة', 'المحفظتان متقاربتان'];
          const mine = canonicalId(doc.type === 'CIVIL_ID' ? doc.register : doc.portfolio);
          const score = Math.min(0.99, 0.55 + 0.25 * (hit.nameScore ?? 0) + (hit.bookNear ? 0.12 : 0) + (sameMother ? 0.08 : 0) + (sameBirth ? 0.08 : 0));
          await c.query(
            `insert into duplicate_flags (family_id, person_id, matched_person_id, matched_family_id, reason, score) values ($1,$2,$3,$4,$5,$6)`,
            [familyId, personIds[i], hit.personId, hit.familyId,
             `${doc.type === 'CIVIL_ID' ? 'رقم الهوية' : 'رقم الشهادة'} نفسه و${what} ${differs} (${mine} هنا، ${hit.book} هناك)، مع تطابق: ${evidence.join('، ')}${hit.bookNear ? `. ${both} كتابةً: يُحتمل خطأ في الإدخال` : ''}`, score]);
          count++;
        }
      }
    }
    return count;
  }

  // ---------- القراءة ----------

  async get(id: string) {
    const fam = await this.db.query(
      `select f.*, f.tags::text[] as tags, cu.username as created_by_username, du.username as decided_by_username,
              sc.points as score_points, sc.class as score_class
       from families f join users cu on cu.id = f.created_by left join users du on du.id = f.decided_by
         left join family_scores sc on sc.family_id = f.id
       where f.id = $1`,
      [id],
    );
    const f = fam.rows[0];
    if (!f) throw new NotFoundException('العائلة غير موجودة');

    const [persons, docs, incomes, proxies, flags] = await Promise.all([
      this.db.query("select * from persons where family_id = $1 order by (relation = 'HEAD') desc, birth_date nulls last", [id]),
      this.db.query(
        'select d.* from person_documents d join persons p on p.id = d.person_id where p.family_id = $1',
        [id],
      ),
      this.db.query('select kind, amount_iqd, note from income_sources where family_id = $1', [id]),
      this.db.query('select id, full_name, phone, relation, active from proxies where family_id = $1', [id]),
      this.db.query(
        `select fl.id, fl.reason, fl.score, fl.status, fl.note, p.full_name as person_name,
                mp.full_name as matched_person_name, mf.family_no as matched_family_no
         from duplicate_flags fl join persons p on p.id = fl.person_id
           join persons mp on mp.id = fl.matched_person_id join families mf on mf.id = fl.matched_family_id
         where fl.family_id = $1`,
        [id],
      ),
    ]);

    const active = persons.rows.filter((p) => p.status === 'ACTIVE');
    const monthlyIncomeIqd: number = incomes.rows.reduce((sum, r) => sum + r.amount_iqd, 0);
    const povertyLineIqd = await this.settings.get<number>('poverty_line_iqd');
    const perCapitaIncomeIqd = active.length ? Math.round(monthlyIncomeIqd / active.length) : null;
    return {
      id: f.id,
      familyNo: f.family_no,
      status: f.status,
      score: f.score_class ? { points: f.score_points, class: f.score_class } : null,
      tags: f.tags,
      phone1: f.phone1,
      phone2: f.phone2,
      hasWhatsapp: f.has_whatsapp,
      prefersVoice: f.prefers_voice,
      address: { mahalla: f.mahalla, street: f.street, house: f.house, landmark: f.landmark },
      housing: f.housing,
      housingOther: f.housing_other,
      prevAddress: f.prev_address,
      prevLandmark: f.prev_landmark,
      residenceCard: f.residence_card_no
        ? { number: f.residence_card_no, issuedAt: f.residence_card_at, issuedBy: f.residence_card_by }
        : null,
      rationCard: f.ration_enc
        ? { numberMasked: mask(this.crypto.decrypt(f.ration_enc)), issuedAt: f.ration_issued_at, center: f.ration_center }
        : null,
      location: f.lat != null ? { lat: f.lat, lng: f.lng } : null,
      notes: f.notes,
      // العدد يُحسب من الأفراد ولا يُدخَل.
      counts: {
        members: active.length,
        males: active.filter((p) => p.gender === 'M').length,
        females: active.filter((p) => p.gender === 'F').length,
      },
      monthlyIncomeIqd,
      perCapitaIncomeIqd,
      povertyLineIqd,
      // شرط القبول في الاستمارة: دخل الفرد دون خط الفقر.
      belowPovertyLine: perCapitaIncomeIqd === null ? null : perCapitaIncomeIqd < povertyLineIqd,
      members: persons.rows.map((p) => ({
        id: p.id,
        relation: p.relation,
        status: p.status,
        fullName: p.full_name,
        motherName: p.mother_name,
        gender: p.gender,
        birthDate: p.birth_date,
        isOrphan: p.is_orphan,
        disability: p.disability,
        chronicIllness: p.chronic_illness,
        documents: docs.rows
          .filter((d) => d.person_id === p.id)
          .map((d) => ({
            type: d.type,
            numberMasked: mask(this.crypto.decrypt(d.number_enc)),
            register: d.register,
            page: d.page,
            portfolio: d.portfolio,
            issuedAt: d.issued_at,
          })),
      })),
      // ينبّه إلى من لا وثيقة له من الأحياء (كالمولود الجديد) ليُستكمل.
      membersWithoutDocument: active.filter((p) => !docs.rows.some((d) => d.person_id === p.id)).map((p) => p.full_name),
      incomes: incomes.rows.map((r) => ({ kind: r.kind, amountIqd: r.amount_iqd, note: r.note })),
      proxies: proxies.rows.map((r) => ({ id: r.id, fullName: r.full_name, phone: r.phone, relation: r.relation, active: r.active })),
      duplicateFlags: flags.rows.map((r) => ({
        id: r.id, reason: r.reason, score: Number(r.score), status: r.status, note: r.note,
        personName: r.person_name, matchedPersonName: r.matched_person_name, matchedFamilyNo: r.matched_family_no,
      })),
      createdBy: f.created_by_username,
      createdAt: f.created_at,
      decidedBy: f.decided_by_username,
      decidedAt: f.decided_at,
      decisionNote: f.decision_note,
    };
  }

  async list(params: { status?: string; q?: string; class?: string; limit: number; offset: number }) {
    const q = params.q?.trim();
    const digits = q ? toAsciiDigits(q).replace(/\D/g, '') : '';
    const isNumeric = !!q && digits.length > 0 && /^[\d٠-٩\s+]+$/.test(q);
    const nameNorm = q && !isNumeric ? normalizeName(q) : null;
    const { rows } = await this.db.query(
      `select f.id, f.family_no, f.status, f.tags::text[] as tags, f.phone1, f.created_at, h.full_name as head_name,
              sc.points as score_points, sc.class as score_class,
              (select count(*) from persons p where p.family_id = f.id and p.status = 'ACTIVE')::int as members
       from families f left join persons h on h.family_id = f.id and h.relation = 'HEAD'
         left join family_scores sc on sc.family_id = f.id
       where ($1::family_status is null or f.status = $1)
         and ($2::text is null or f.family_no = $2 or f.phone1 like '%' || $2 or f.phone2 like '%' || $2
              or exists (select 1 from person_documents d join persons dp on dp.id = d.person_id where dp.family_id = f.id and d.number_hash = any($7::text[])))
         and ($3::text is null or exists (
               select 1 from persons p where p.family_id = f.id and p.name_norm like '%' || $3 || '%'))
         and ($6::text is null or sc.class = $6)
       order by f.created_at desc limit $4 offset $5`,
      [params.status ?? null, isNumeric ? digits : null, nameNorm, params.limit, params.offset, params.class ?? null,
       // رقم الوثيقة وحده، بأي نوع كانت: البطاقة الوطنية، أو هوية الأحوال بلا سجلها.
       isNumeric ? (['NATIONAL_CARD', 'CIVIL_ID', 'NATIONALITY_CERT'] as const).map((t) => this.crypto.blindIndex(documentNumberKey(t, digits))) : null],
    );
    return rows.map((r) => ({
      id: r.id, familyNo: r.family_no, status: r.status, tags: r.tags, phone1: r.phone1,
      headName: r.head_name, members: r.members, createdAt: r.created_at,
      score: r.score_class ? { points: r.score_points, class: r.score_class } : null,
    }));
  }

  /** بحث بالوثيقة: يجيب هل هذا الشخص مسجَّل، دون أن يكشف الرقم. */
  async lookupDocument(doc: DocumentInput) {
    const { rows } = await this.db.query(
      `select f.id, f.family_no, f.status, p.full_name
       from person_documents d join persons p on p.id = d.person_id join families f on f.id = p.family_id
       where d.key_hash = $1`,
      [this.crypto.blindIndex(documentKey(doc))],
    );
    if (rows[0]) return { found: true, familyId: rows[0].id, familyNo: rows[0].family_no, status: rows[0].status, personName: rows[0].full_name, similar: [] };
    // ليست مسجَّلة بسجلها؛ لكن الرقم نفسه قد يكون مسجَّلاً بسجل آخر: يراه الباحث قبل أن يمضي.
    const similar = await this.sameNumberElsewhere(this.db, doc);
    return { found: false, similar: similar.map((x) => ({ familyId: x.familyId, familyNo: x.familyNo, personName: x.personName, book: x.book, near: x.bookNear })) };
  }

  async lookupRationCard(number: string) {
    const { rows } = await this.db.query('select id, family_no, status from families where ration_hash = $1', [
      this.crypto.blindIndex(`RC:${normalizeDocNumber(number)}`),
    ]);
    return rows[0] ? { found: true, familyId: rows[0].id, familyNo: rows[0].family_no, status: rows[0].status } : { found: false };
  }

  // ---------- الاعتماد المزدوج ----------

  async decide(id: string, decision: 'APPROVED' | 'REJECTED', note: string | undefined, actor: AuthUser) {
    await this.db.tx(async (c) => {
      const { rows } = await c.query('select status, created_by from families where id = $1 for update', [id]);
      const f = rows[0];
      if (!f) throw new NotFoundException('العائلة غير موجودة');
      if (f.created_by === actor.id) throw new ForbiddenException('لا يعتمد الموظف ما أدخله بنفسه');
      if (f.status === 'PENDING_DEDUPE_REVIEW' && decision === 'APPROVED') {
        throw new ConflictException('في السجل شبهات تكرار لم يُفصل فيها');
      }
      if (f.status !== 'PENDING_APPROVAL' && f.status !== 'PENDING_DEDUPE_REVIEW') {
        throw new ConflictException('السجل ليس بانتظار قرار');
      }
      if (decision === 'REJECTED' && !note) throw new ConflictException('يلزم ذكر سبب الرفض');
      await this.applyDecision(c, id, decision, note, actor);
    });
    return this.get(id);
  }

  private async applyDecision(c: PoolClient, id: string, decision: 'APPROVED' | 'REJECTED', note: string | undefined, actor: AuthUser) {
    await c.query(
      'update families set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1',
      [id, decision, actor.id, note ?? null],
    );
    if (decision === 'REJECTED') {
      // المرفوض يبقى سجلّه للتاريخ، لكنه لا يحجز الوثائق ولا البطاقة التموينية عن تسجيل لاحق صحيح.
      await c.query(
        `update person_documents set number_hash = null, key_hash = key_hash || ':rejected:' || id::text
         where person_id in (select id from persons where family_id = $1)`,
        [id],
      );
      await c.query('update families set ration_hash = null where id = $1', [id]);
    }
    // النقاط تُحسب عند الاعتماد، وتُمحى إن رُفض السجل.
    if (decision === 'APPROVED') await this.scoring.recompute(c, id);
    else await c.query('delete from family_scores where family_id = $1', [id]);
    await this.audit.append(c, {
      actorId: actor.id, action: decision === 'APPROVED' ? 'family.approve' : 'family.reject',
      entity: 'family', entityId: id, payload: { note: note ?? null },
    });
  }

  // ---------- شبهات التكرار ----------

  async listOpenFlags() {
    const { rows } = await this.db.query(
      `select fl.id, fl.reason, fl.score, f.id as family_id, f.family_no, p.full_name as person_name,
              mp.full_name as matched_person_name, mf.id as matched_family_id, mf.family_no as matched_family_no
       from duplicate_flags fl join families f on f.id = fl.family_id join persons p on p.id = fl.person_id
         join persons mp on mp.id = fl.matched_person_id join families mf on mf.id = fl.matched_family_id
       where fl.status = 'OPEN' order by fl.score desc`,
    );
    return rows.map((r) => ({
      id: r.id, reason: r.reason, score: Number(r.score), familyId: r.family_id, familyNo: r.family_no,
      personName: r.person_name, matchedPersonName: r.matched_person_name,
      matchedFamilyId: r.matched_family_id, matchedFamilyNo: r.matched_family_no,
    }));
  }

  /**
   * الفصل في الشبهة: DISMISS = ليسا شخصاً واحداً، CONFIRM = تكرار فيُرفض السجل الجديد.
   * فإذا صُرفت الشبهات كلها عاد السجل إلى انتظار الاعتماد.
   */
  async resolveFlag(flagId: string, decision: 'DISMISS' | 'CONFIRM', note: string, actor: AuthUser) {
    const familyId = await this.db.tx(async (c) => {
      const { rows } = await c.query(
        `select fl.status, fl.family_id, f.created_by, f.status as family_status
         from duplicate_flags fl join families f on f.id = fl.family_id where fl.id = $1 for update of fl, f`,
        [flagId],
      );
      const flag = rows[0];
      if (!flag) throw new NotFoundException('الشبهة غير موجودة');
      if (flag.status !== 'OPEN') throw new ConflictException('فُصل في هذه الشبهة من قبل');
      if (flag.created_by === actor.id) throw new ForbiddenException('لا يفصل الموظف في شبهة على سجل أدخله بنفسه');

      await c.query(
        'update duplicate_flags set status = $2, resolved_by = $3, resolved_at = now(), note = $4 where id = $1',
        [flagId, decision === 'DISMISS' ? 'DISMISSED' : 'CONFIRMED', actor.id, note],
      );
      await this.audit.append(c, {
        actorId: actor.id, action: 'duplicate_flag.resolve', entity: 'duplicate_flag', entityId: flagId,
        payload: { decision, note, familyId: flag.family_id },
      });

      if (decision === 'CONFIRM') {
        await c.query(
          "update duplicate_flags set status = 'DISMISSED', resolved_by = $2, resolved_at = now(), note = 'أُغلقت برفض السجل' where family_id = $1 and status = 'OPEN'",
          [flag.family_id, actor.id],
        );
        await this.applyDecision(c, flag.family_id, 'REJECTED', `تكرار مؤكَّد: ${note}`, actor);
      } else {
        const open = await c.query("select 1 from duplicate_flags where family_id = $1 and status = 'OPEN' limit 1", [flag.family_id]);
        if (!open.rowCount && flag.family_status === 'PENDING_DEDUPE_REVIEW') {
          await c.query("update families set status = 'PENDING_APPROVAL' where id = $1", [flag.family_id]);
        }
      }
      return flag.family_id as string;
    });
    return this.get(familyId);
  }
}
