import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { normalizeName } from '../common/arabic';
import { FieldCrypto, mask } from '../common/crypto';
import { Db } from '../db/db.module';
import { documentSchema, memberSchema, optionalText, phone, text } from '../families/families.schema';
import { FamiliesService } from '../families/families.service';
import { ScoringService } from '../scoring/scoring.service';

const nullableText = z.string().trim().min(1).nullable().optional();

const NON_HEAD = z.enum(['SPOUSE', 'SON', 'DAUGHTER', 'FATHER', 'MOTHER', 'BROTHER', 'SISTER', 'OTHER']);

/** ما يجوز طلب تعديله، وصيغة كل طلب. */
const PAYLOADS = {
  UPDATE_FAMILY: z
    .object({
      tags: z.array(z.enum(['ORPHANS', 'WIDOW', 'DISABLED', 'SICK', 'DIVORCED', 'NEEDY', 'UNMARRIED'])).optional(),
      phone1: phone.nullable().optional(),
      phone2: phone.nullable().optional(),
      mahalla: nullableText,
      street: nullableText,
      house: nullableText,
      landmark: nullableText,
      housing: z.enum(['OWNED', 'RENTED', 'OTHER']).optional(),
      housingOther: nullableText,
      notes: nullableText,
      hasWhatsapp: z.boolean().optional(),
      prefersVoice: z.boolean().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, 'لا تعديل في الطلب'),
  SET_INCOMES: z.object({
    incomes: z.array(
      z.object({
        kind: z.enum(['SALARY', 'PENSION', 'SOCIAL_WELFARE', 'WORK', 'OTHER_AID']),
        amountIqd: z.number().int().min(0),
        note: optionalText,
      }),
    ),
  }),
  SET_PROXIES: z.object({
    proxies: z.array(z.object({ fullName: text, phone: phone.optional(), relation: optionalText })),
  }),
  ADD_MEMBER: z.object({ member: memberSchema.refine((m) => m.relation !== 'HEAD', 'للعائلة رب أسرة واحد') }),
  UPDATE_MEMBER: z.object({
    personId: z.string().uuid(),
    status: z.enum(['ACTIVE', 'DECEASED']).optional(),
    isOrphan: z.boolean().optional(),
    disability: nullableText,
    chronicIllness: nullableText,
  }),
  ADD_DOCUMENT: z.object({ personId: z.string().uuid(), document: documentSchema }),
  CHANGE_HEAD: z.object({ newHeadId: z.string().uuid(), formerHeadRelation: NON_HEAD }),
  TRANSFER_MEMBER: z.object({ personId: z.string().uuid(), toFamilyNo: z.string().trim().regex(/^\d{5,12}$/, 'رقم العائلة أرقام فقط'), relation: NON_HEAD }),
} as const;
export type ChangeType = keyof typeof PAYLOADS;
export const CHANGE_TYPES = Object.keys(PAYLOADS) as [ChangeType, ...ChangeType[]];

const FAMILY_COLUMNS: Record<string, string> = {
  tags: 'tags', phone1: 'phone1', phone2: 'phone2', mahalla: 'mahalla', street: 'street', house: 'house',
  landmark: 'landmark', housing: 'housing', housingOther: 'housing_other', notes: 'notes',
  hasWhatsapp: 'has_whatsapp', prefersVoice: 'prefers_voice',
};

@Injectable()
export class ChangesService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FamiliesService) private readonly families: FamiliesService,
    @Inject(ScoringService) private readonly scoring: ScoringService,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
  ) {}

  /** أرقام الوثائق في طلب التعديل تُحفظ مشفّرة كما تُحفظ في سجل الفرد. */
  private seal(type: ChangeType, payload: any): any {
    const enc = (d: any) => ({ ...d, number: undefined, numberEnc: this.crypto.encrypt(d.number), numberMasked: mask(d.number) });
    if (type === 'ADD_DOCUMENT') return { ...payload, document: enc(payload.document) };
    if (type === 'ADD_MEMBER') return { member: { ...payload.member, documents: payload.member.documents.map(enc) } };
    return payload;
  }

  private unseal(type: ChangeType, payload: any): any {
    const dec = (d: any) => { const { numberEnc, numberMasked, ...rest } = d; return { ...rest, number: this.crypto.decrypt(numberEnc) }; };
    if (type === 'ADD_DOCUMENT') return { ...payload, document: dec(payload.document) };
    if (type === 'ADD_MEMBER') return { member: { ...payload.member, documents: payload.member.documents.map(dec) } };
    return payload;
  }

  async request(familyId: string, type: ChangeType, rawPayload: unknown, reason: string, actor: AuthUser) {
    const parsed = PAYLOADS[type].safeParse(rawPayload);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'بيانات غير صالحة',
        errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const payload = parsed.data as any;

    const id = await this.db.tx(async (c) => {
      const fam = await c.query('select status from families where id = $1', [familyId]);
      if (!fam.rows[0]) throw new NotFoundException('العائلة غير موجودة');
      if (fam.rows[0].status === 'REJECTED') throw new ConflictException('لا يُعدَّل سجل مرفوض');
      // الأسماء تُحفظ مع الطلب ليقرأها المعتمِد؛ والتنفيذ يعتمد المعرّفات وحدها.
      const names = await this.precheck(c, familyId, type, payload);
      const { rows } = await c.query(
        'insert into change_requests (family_id, type, payload, reason, requested_by) values ($1,$2,$3,$4,$5) returning id',
        [familyId, type, JSON.stringify({ ...this.seal(type, payload), ...names }), reason, actor.id],
      );
      await this.audit.append(c, {
        actorId: actor.id, action: 'change.request', entity: 'change_request', entityId: rows[0].id,
        payload: { familyId, type, reason },
      });
      return rows[0].id as string;
    });
    return this.get(id);
  }

  /** يُفحص عند الطلب وعند الاعتماد معاً: فقد تتغير الحال بينهما. */
  private async precheck(c: PoolClient, familyId: string, type: ChangeType, payload: any): Promise<Record<string, string>> {
    if (type === 'CHANGE_HEAD') {
      const { rows } = await c.query(
        `select p.full_name, p.relation, p.status, exists (select 1 from person_documents d where d.person_id = p.id) as has_doc
         from persons p where p.id = $1 and p.family_id = $2`,
        [payload.newHeadId, familyId],
      );
      const p = rows[0];
      if (!p) throw new BadRequestException('الفرد ليس من هذه العائلة');
      if (p.relation === 'HEAD') throw new BadRequestException('هو رب الأسرة الآن');
      if (p.status !== 'ACTIVE') throw new BadRequestException('لا يكون المتوفى رب أسرة');
      if (!p.has_doc) throw new BadRequestException('يلزم لرب الأسرة وثيقة هوية. أضف وثيقته أولاً ثم اطلب التغيير');
      return { newHeadName: p.full_name };
    }
    if (type === 'TRANSFER_MEMBER') {
      const person = await c.query('select full_name, relation from persons where id = $1 and family_id = $2', [payload.personId, familyId]);
      if (!person.rows[0]) throw new BadRequestException('الفرد ليس من هذه العائلة');
      if (person.rows[0].relation === 'HEAD') throw new BadRequestException('رب الأسرة لا يُنقل. غيّر رب الأسرة أولاً');
      const target = await c.query('select id, status from families where family_no = $1', [payload.toFamilyNo]);
      if (!target.rows[0]) throw new BadRequestException('لا عائلة بهذا الرقم');
      if (target.rows[0].id === familyId) throw new BadRequestException('الفرد في هذه العائلة أصلاً');
      if (target.rows[0].status === 'REJECTED') throw new ConflictException('العائلة المنقول إليها سجلها مرفوض');
      return { personName: person.rows[0].full_name };
    }
    if (type === 'UPDATE_MEMBER' || type === 'ADD_DOCUMENT') {
      const p = await c.query('select 1 from persons where id = $1 and family_id = $2', [payload.personId, familyId]);
      if (!p.rowCount) throw new BadRequestException('الفرد ليس من هذه العائلة');
    }
    const docs =
      type === 'ADD_DOCUMENT' ? this.families.hashDocuments([{ documents: [payload.document] }])
      : type === 'ADD_MEMBER' ? this.families.hashDocuments([payload.member])
      : [];
    if (docs.length) {
      const conflicts = await this.families.findHardConflicts(c, docs, null);
      if (conflicts.length) throw this.families.conflictError(conflicts);
    }
    return {};
  }

  async decide(id: string, approve: boolean, note: string | undefined, actor: AuthUser) {
    try {
      await this.db.tx(async (c) => {
        const { rows } = await c.query('select * from change_requests where id = $1 for update', [id]);
        const req = rows[0];
        if (!req) throw new NotFoundException('طلب التعديل غير موجود');
        if (req.status !== 'PENDING') throw new ConflictException('فُصل في هذا الطلب من قبل');
        if (req.requested_by === actor.id) throw new ForbiddenException('لا يعتمد الموظف تعديلاً طلبه بنفسه');
        if (!approve && !note) throw new BadRequestException('يلزم ذكر سبب الرفض');

        let before: unknown = null;
        if (approve) {
          const payload = this.unseal(req.type, req.payload);
          await this.precheck(c, req.family_id, req.type, payload);
          before = await this.apply(c, req.family_id, req.type, payload);
          // تغيّرت بيانات العائلة، فتُعاد نقاطها (لا أثر له إن لم تكن معتمدة).
          await this.scoring.recompute(c, req.family_id);
        }
        await c.query(
          'update change_requests set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1',
          [id, approve ? 'APPROVED' : 'REJECTED', actor.id, note ?? null],
        );
        await this.audit.append(c, {
          actorId: actor.id, action: approve ? 'change.approve' : 'change.reject', entity: 'change_request', entityId: id,
          payload: { familyId: req.family_id, type: req.type, before, note: note ?? null },
        });
      });
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException('الوثيقة سُجّلت لغير هذا الفرد بعد تقديم الطلب');
      throw err;
    }
    return this.get(id);
  }

  /** ينفّذ التعديل ويعيد القيم السابقة لتُحفظ في سجل التدقيق. */
  private async apply(c: PoolClient, familyId: string, type: ChangeType, p: any): Promise<unknown> {
    switch (type) {
      case 'UPDATE_FAMILY': {
        const keys = Object.keys(p).filter((k) => FAMILY_COLUMNS[k]);
        const cols = keys.map((k) => FAMILY_COLUMNS[k]);
        const old = await c.query(`select ${cols.join(', ')} from families where id = $1`, [familyId]);
        await c.query(
          `update families set ${cols.map((col, i) => `${col} = $${i + 2}`).join(', ')} where id = $1`,
          [familyId, ...keys.map((k) => p[k])],
        );
        return old.rows[0];
      }
      case 'SET_INCOMES': {
        const old = await c.query('select kind, amount_iqd, note from income_sources where family_id = $1', [familyId]);
        await c.query('delete from income_sources where family_id = $1', [familyId]);
        for (const inc of p.incomes) {
          await c.query('insert into income_sources (family_id, kind, amount_iqd, note) values ($1,$2,$3,$4)', [
            familyId, inc.kind, inc.amountIqd, inc.note ?? null,
          ]);
        }
        return old.rows;
      }
      case 'SET_PROXIES': {
        // الوكيل السابق يُعطَّل ولا يُحذف: قد يكون استلم من قبل، فيبقى اسمه في التاريخ.
        const old = await c.query('update proxies set active = false where family_id = $1 and active returning full_name', [familyId]);
        for (const px of p.proxies) {
          await c.query('insert into proxies (family_id, full_name, phone, relation) values ($1,$2,$3,$4)', [
            familyId, px.fullName, px.phone ?? null, px.relation ?? null,
          ]);
        }
        return old.rows.map((r) => r.full_name);
      }
      case 'ADD_MEMBER': {
        const m = p.member;
        const person = await c.query(
          `insert into persons (family_id, relation, status, full_name, name_norm, mother_name, mother_norm,
                                gender, birth_date, is_orphan, disability, chronic_illness)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
          [
            familyId, m.relation, m.status, m.fullName, normalizeName(m.fullName), m.motherName ?? null,
            m.motherName ? normalizeName(m.motherName) : null, m.gender, m.birthDate ?? null,
            m.isOrphan, m.disability ?? null, m.chronicIllness ?? null,
          ],
        );
        for (const d of m.documents) await this.families.insertDocument(c, person.rows[0].id, d);
        return null;
      }
      case 'UPDATE_MEMBER': {
        const old = await c.query('select status, is_orphan, disability, chronic_illness from persons where id = $1', [p.personId]);
        await c.query(
          `update persons set
             status = coalesce($2, status),
             is_orphan = coalesce($3, is_orphan),
             disability = case when $4 then $5 else disability end,
             chronic_illness = case when $6 then $7 else chronic_illness end
           where id = $1`,
          [p.personId, p.status ?? null, p.isOrphan ?? null, 'disability' in p, p.disability ?? null,
           'chronicIllness' in p, p.chronicIllness ?? null],
        );
        return old.rows[0];
      }
      case 'ADD_DOCUMENT':
        await this.families.insertDocument(c, p.personId, p.document);
        return null;
      case 'CHANGE_HEAD': {
        // السابق أولاً: القاعدة لا تقبل ربَّي أسرة في لحظة.
        const former = await c.query(
          `update persons set relation = $2 where family_id = $1 and relation = 'HEAD' returning id, full_name`,
          [familyId, p.formerHeadRelation],
        );
        const next = await c.query(`select relation from persons where id = $1`, [p.newHeadId]);
        await c.query(`update persons set relation = 'HEAD' where id = $1`, [p.newHeadId]);
        return { formerHeadId: former.rows[0]?.id ?? null, formerHeadName: former.rows[0]?.full_name ?? null, newHeadWas: next.rows[0].relation };
      }
      case 'TRANSFER_MEMBER': {
        const target = await c.query('select id from families where family_no = $1 for no key update', [p.toFamilyNo]);
        const old = await c.query('select relation from persons where id = $1', [p.personId]);
        await c.query('update persons set family_id = $2, relation = $3 where id = $1', [p.personId, target.rows[0].id, p.relation]);
        // مرفقاته (هويته، تقريره الطبي) تتبعه إلى ملف عائلته الجديدة.
        await c.query('update attachments set family_id = $2 where person_id = $1', [p.personId, target.rows[0].id]);
        await this.scoring.recompute(c, target.rows[0].id);
        return { fromFamilyId: familyId, toFamilyId: target.rows[0].id, relationWas: old.rows[0].relation };
      }
    }
  }

  async get(id: string) {
    const { rows } = await this.db.query(`${SELECT} where r.id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException('طلب التعديل غير موجود');
    return present(rows[0]);
  }

  async list(params: { familyId?: string; status?: string }) {
    const { rows } = await this.db.query(
      `${SELECT} where ($1::uuid is null or r.family_id = $1) and ($2::change_status is null or r.status = $2)
       order by r.requested_at desc limit 200`,
      [params.familyId ?? null, params.status ?? null],
    );
    return rows.map(present);
  }
}

const SELECT = `
  select r.*, f.family_no, ru.username as requested_by_username, du.username as decided_by_username
  from change_requests r join families f on f.id = r.family_id
    join users ru on ru.id = r.requested_by left join users du on du.id = r.decided_by`;

/** في الطلب المحفوظ رقم الوثيقة مشفّر؛ ويُعرض منه آخر أربع خانات فقط. */
function redact(type: string, payload: any) {
  const hide = (d: any) => { const { numberEnc, numberMasked, ...rest } = d; return { ...rest, number: numberMasked }; };
  if (type === 'ADD_DOCUMENT') return { ...payload, document: hide(payload.document) };
  if (type === 'ADD_MEMBER') return { member: { ...payload.member, documents: payload.member.documents.map(hide) } };
  return payload;
}

function present(r: any) {
  return {
    id: r.id, familyId: r.family_id, familyNo: r.family_no, type: r.type, payload: redact(r.type, r.payload),
    reason: r.reason, status: r.status, requestedBy: r.requested_by_username, requestedAt: r.requested_at,
    decidedBy: r.decided_by_username, decidedAt: r.decided_at, decisionNote: r.decision_note,
  };
}
