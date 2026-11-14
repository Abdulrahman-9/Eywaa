import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { normalizeDocNumber, normalizeName, toAsciiDigits } from '../common/arabic';
import { FieldCrypto, mask } from '../common/crypto';
import { formatFamilyNo } from '../common/family-no';
import { Db } from '../db/db.module';
import { SettingsService } from '../settings/settings.service';
import { CreateFamilyInput, DocumentInput, documentKey } from './families.schema';

/** حدّ تشابه الاسم الكامل الذي تُرفع عنده شبهة التكرار. */
const NAME_SIMILARITY = 0.6;
/** حدّ تشابه الاسم الأول (يُخرج الإخوة وأبناء العمومة المتفقين في بقية الاسم). */
const FIRST_NAME_SIMILARITY = 0.5;
const MOTHER_SIMILARITY = 0.7;
/** حدّ الاسم «شبه المطابق» الذي يكفي معه تطابق تاريخ الميلاد باليوم. */
const NEAR_EXACT_NAME = 0.85;
const MAX_FLAGS_PER_PERSON = 5;

export interface HardConflict {
  kind: 'DOCUMENT' | 'RATION_CARD';
  memberIndex?: number;
  documentType?: string;
  familyNo: string;
  familyStatus: string;
  personName?: string;
}

@Injectable()
export class FamiliesService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  /** يضيف وثيقة هوية لفرد. قيد الفرادة في القاعدة يمنع تكرارها. */
  async insertDocument(c: PoolClient, personId: string, doc: DocumentInput) {
    const d = doc as DocumentInput & { register?: string; page?: string; portfolio?: string };
    await c.query(
      `insert into person_documents (person_id, type, key_hash, number_enc, register, page, portfolio, issued_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        personId, d.type, this.crypto.blindIndex(documentKey(d)), this.crypto.encrypt(d.number),
        d.register ?? null, d.page ?? null, d.portfolio ?? null, d.issuedAt ?? null,
      ],
    );
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
             lat, lng, notes, client_op_id, created_by)
           values ($1,'PENDING_APPROVAL',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
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
            input.clientOpId ?? null, actor.id,
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

        const flags = await this.flagSuspectedDuplicates(c, id, input, personIds);
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
   * التشابه الترجيحي: اسم كامل متقارب واسم أول متقارب، ومعهما قرينة قوية واحدة على الأقل:
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
                  (f.phone1 = any($5::text[]) or f.phone2 = any($5::text[])) as same_phone
           from persons p join families f on f.id = p.family_id
           where p.name_norm % $1
             and p.family_id <> $2 and f.status <> 'REJECTED'
             and similarity(split_part(p.name_norm, ' ', 1), split_part($1, ' ', 1)) >= $7
         ) m
         where same_mother or same_phone or (same_birth_date and score >= $8)
         order by score desc limit $9`,
        [nameNorm, familyId, m.birthDate ?? null, motherNorm, phones, MOTHER_SIMILARITY, FIRST_NAME_SIMILARITY,
         NEAR_EXACT_NAME, MAX_FLAGS_PER_PERSON],
      );
      for (const r of rows) {
        const reasons = [r.same_mother && 'اسم الأم', r.same_phone && 'الهاتف', r.same_birth_date && 'تاريخ الميلاد'].filter(Boolean);
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

  // ---------- القراءة ----------

  async get(id: string) {
    const fam = await this.db.query(
      `select f.*, cu.username as created_by_username, du.username as decided_by_username
       from families f join users cu on cu.id = f.created_by left join users du on du.id = f.decided_by
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
      tags: f.tags,
      phone1: f.phone1,
      phone2: f.phone2,
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

  async list(params: { status?: string; q?: string; limit: number; offset: number }) {
    const q = params.q?.trim();
    const digits = q ? toAsciiDigits(q).replace(/\D/g, '') : '';
    const isNumeric = !!q && digits.length > 0 && /^[\d٠-٩\s+]+$/.test(q);
    const nameNorm = q && !isNumeric ? normalizeName(q) : null;
    const { rows } = await this.db.query(
      `select f.id, f.family_no, f.status, f.tags, f.phone1, f.created_at, h.full_name as head_name,
              (select count(*) from persons p where p.family_id = f.id and p.status = 'ACTIVE')::int as members
       from families f left join persons h on h.family_id = f.id and h.relation = 'HEAD'
       where ($1::family_status is null or f.status = $1)
         and ($2::text is null or f.family_no = $2 or f.phone1 like '%' || $2 or f.phone2 like '%' || $2)
         and ($3::text is null or exists (
               select 1 from persons p where p.family_id = f.id and p.name_norm like '%' || $3 || '%'))
       order by f.created_at desc limit $4 offset $5`,
      [params.status ?? null, isNumeric ? digits : null, nameNorm, params.limit, params.offset],
    );
    return rows.map((r) => ({
      id: r.id, familyNo: r.family_no, status: r.status, tags: r.tags, phone1: r.phone1,
      headName: r.head_name, members: r.members, createdAt: r.created_at,
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
    return rows[0]
      ? { found: true, familyId: rows[0].id, familyNo: rows[0].family_no, status: rows[0].status, personName: rows[0].full_name }
      : { found: false };
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
        `update person_documents set key_hash = key_hash || ':rejected:' || id::text
         where person_id in (select id from persons where family_id = $1)`,
        [id],
      );
      await c.query('update families set ration_hash = null where id = $1', [id]);
    }
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
