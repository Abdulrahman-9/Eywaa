import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { normalizeName } from '../common/arabic';
import { Db } from '../db/db.module';
import { phone } from '../families/families.schema';
import { NotificationsService } from '../notifications/notifications.service';

export const quickSchema = z.object({
  headName: z.string().trim().min(3, 'اكتب اسم رب الأسرة').max(120),
  phone: phone.optional(),
  mahalla: z.string().trim().min(1).max(80).optional(),
  landmark: z.string().trim().min(1).max(160).optional(),
  membersCount: z.number().int().min(1).max(50).optional(),
  note: z.string().trim().min(1).max(500).optional(),
  clientOpId: z.string().uuid().optional(),
});
export type QuickInput = z.infer<typeof quickSchema>;
export const listQuickSchema = z.object({
  status: z.enum(['NEW', 'INVITED', 'VISIT_ASSIGNED', 'COMPLETED', 'DISMISSED', 'OPEN']).default('OPEN'),
  mine: z.enum(['true', 'false']).optional(),
  q: z.string().trim().optional(),
});
export const assignSchema = z.object({ userId: z.string().uuid() });
export const dismissSchema = z.object({ note: z.string().trim().min(3, 'يلزم ذكر السبب').max(300) });
export const inviteSchema = z.object({ text: z.string().trim().min(10).max(600).optional() });

const NAME_MATCH = 0.55;
const INVITE = 'السلام عليكم {الاسم}. سُجّل طلبكم لدى المركز برقم {رقم_الطلب}. نرجو حضوركم لاستكمال التسجيل ومعكم وثائق الهوية والبطاقة التموينية.';

/**
 * طلبات التسجيل السريع. الطلب اسم وما تيسّر معه؛ يُستكمل بأحد طريقين: دعوة صاحبه للحضور، أو زيارة باحث.
 * وعند الاستكمال تُملأ استمارة التسجيل كاملةً فتمرّ بكشف التكرار والاعتماد كأي عائلة.
 */
@Injectable()
export class QuickService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  /**
   * من يشبه هذا الاسم أو يحمل هذا الهاتف، في العوائل المسجَّلة وفي الطلبات القائمة.
   * الاسم وحده هو المتاح غالباً في الطلب السريع، فالمطابقة به هي الحارس.
   */
  async matches(q: { query: Db['query'] }, headName: string, phoneNo?: string | null, exceptId?: string) {
    const norm = normalizeName(headName);
    const families = await q.query(
      `select * from (
         select f.id, f.family_no, f.status, p.full_name, similarity(p.name_norm, $1) as score, (f.phone1 = $2 or f.phone2 = $2) as same_phone
         from persons p join families f on f.id = p.family_id
         where f.status <> 'REJECTED' and (similarity(p.name_norm, $1) >= $3 or ($2::text is not null and (f.phone1 = $2 or f.phone2 = $2)))
       ) m order by same_phone desc nulls last, score desc limit 5`, [norm, phoneNo ?? null, NAME_MATCH]);
    const requests = await q.query(
      `select id, no, head_name, status, similarity(name_norm, $1) as score, (phone = $2) as same_phone from quick_requests
       where status not in ('DISMISSED', 'COMPLETED') and ($4::uuid is null or id <> $4) and (similarity(name_norm, $1) >= $3 or ($2::text is not null and phone = $2))
       order by score desc limit 5`, [norm, phoneNo ?? null, NAME_MATCH, exceptId ?? null]);
    return {
      families: families.rows.map((r) => ({ familyId: r.id as string, familyNo: r.family_no as string, name: r.full_name as string, score: Number(r.score), samePhone: !!r.same_phone })),
      requests: requests.rows.map((r) => ({ id: r.id as string, no: r.no as number, name: r.head_name as string, score: Number(r.score), samePhone: !!r.same_phone })),
    };
  }

  /** يُنشئ الطلب داخل معاملة قائمة (يستعمله التخويل الاستثنائي) أو وحده. */
  async insert(c: PoolClient, input: QuickInput, actor: AuthUser, extra: { source?: 'STAFF' | 'EMERGENCY'; campaignId?: string } = {}) {
    const { rows } = await c.query(
      `insert into quick_requests (head_name, name_norm, phone, mahalla, landmark, members_count, note, source, campaign_id, client_op_id, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id, no`,
      [input.headName, normalizeName(input.headName), input.phone ?? null, input.mahalla ?? null, input.landmark ?? null, input.membersCount ?? null, input.note ?? null,
       extra.source ?? 'STAFF', extra.campaignId ?? null, input.clientOpId ?? null, actor.id]);
    await this.audit.append(c, { actorId: actor.id, action: 'quick.create', entity: 'quick_request', entityId: rows[0].id, payload: { no: rows[0].no, source: extra.source ?? 'STAFF' } });
    return rows[0] as { id: string; no: number };
  }

  async create(input: QuickInput, actor: AuthUser) {
    if (input.clientOpId) {
      const prior = await this.db.query('select id from quick_requests where client_op_id = $1', [input.clientOpId]);
      if (prior.rows[0]) return this.get(prior.rows[0].id);
    }
    const row = await this.db.tx((c) => this.insert(c, input, actor));
    return this.get(row.id);
  }

  async get(id: string) {
    const { rows } = await this.db.query(`${SELECT} where r.id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException('طلب التسجيل غير موجود');
    const r = present(rows[0]);
    // المطابقة تُحسب عند العرض لا عند الإنشاء: من سُجّل بعد الطلب يظهر أيضاً.
    return { ...r, matches: r.status === 'COMPLETED' || r.status === 'DISMISSED' ? { families: [], requests: [] } : await this.matches(this.db, r.headName, r.phone, id) };
  }

  async list(p: z.infer<typeof listQuickSchema>, actor: AuthUser) {
    const statuses = p.status === 'OPEN' ? ['NEW', 'INVITED', 'VISIT_ASSIGNED'] : [p.status];
    const q = p.q ? normalizeName(p.q) : null;
    const { rows } = await this.db.query(
      `${SELECT} where r.status::text = any($1) and (not $2 or r.assigned_to = $3)
         and ($4::text is null or r.name_norm like '%' || $4 || '%' or r.phone like '%' || $5 or r.no::text = $5)
       order by r.created_at desc limit 300`, [statuses, p.mine === 'true', actor.id, q || null, p.q ?? null]);
    return rows.map(present);
  }

  private async open(c: PoolClient, id: string) {
    const r = (await c.query('select * from quick_requests where id = $1 for update', [id])).rows[0];
    if (!r) throw new NotFoundException('طلب التسجيل غير موجود');
    if (r.status === 'COMPLETED' || r.status === 'DISMISSED') throw new ConflictException('أُغلق هذا الطلب من قبل');
    return r;
  }

  /** الطريق الأول: رسالة تدعو صاحب الطلب للحضور إلى المركز. */
  async invite(id: string, text: string | undefined, actor: AuthUser) {
    const r = await this.db.tx(async (c) => {
      const row = await this.open(c, id);
      if (!row.phone) throw new BadRequestException('لا رقم هاتف في الطلب: لا يُدعى برسالة. أسند زيارته إلى باحث.');
      await c.query("update quick_requests set status = 'INVITED', invited_at = now() where id = $1", [id]);
      await this.audit.append(c, { actorId: actor.id, action: 'quick.invite', entity: 'quick_request', entityId: id, payload: { no: row.no } });
      return row;
    });
    await this.notifications.direct('دعوة لاستكمال التسجيل', (text ?? INVITE).replace('{الاسم}', r.head_name).replace('{رقم_الطلب}', String(r.no)), r.phone, id);
    return this.get(id);
  }

  /** الطريق الثاني: زيارة ميدانية يقوم بها باحث. */
  async assign(id: string, userId: string, actor: AuthUser) {
    await this.db.tx(async (c) => {
      const row = await this.open(c, id);
      const u = (await c.query("select username from users where id = $1 and active and role in ('FIELD_RESEARCHER', 'BENEFICIARY_SUPERVISOR')", [userId])).rows[0];
      if (!u) throw new BadRequestException('تُسند الزيارة إلى باحث ميداني أو مشرف مستفيدين');
      await c.query("update quick_requests set status = 'VISIT_ASSIGNED', assigned_to = $2 where id = $1", [id, userId]);
      await this.audit.append(c, { actorId: actor.id, action: 'quick.assign', entity: 'quick_request', entityId: id, payload: { no: row.no, to: u.username } });
    });
    return this.get(id);
  }

  async dismiss(id: string, note: string, actor: AuthUser) {
    await this.db.tx(async (c) => {
      const row = await this.open(c, id);
      await c.query("update quick_requests set status = 'DISMISSED', closed_by = $2, closed_at = now(), close_note = $3 where id = $1", [id, actor.id, note]);
      await this.audit.append(c, { actorId: actor.id, action: 'quick.dismiss', entity: 'quick_request', entityId: id, payload: { no: row.no, note } });
    });
    return this.get(id);
  }

  /** يُغلق الطلب بالعائلة التي سُجّلت منه. يُستدعى داخل معاملة تسجيل العائلة. */
  async complete(c: PoolClient, id: string, familyId: string, actor: AuthUser) {
    const row = await this.open(c, id);
    await c.query("update quick_requests set status = 'COMPLETED', family_id = $2, closed_by = $3, closed_at = now() where id = $1", [id, familyId, actor.id]);
    await this.audit.append(c, { actorId: actor.id, action: 'quick.complete', entity: 'quick_request', entityId: id, payload: { no: row.no, familyId } });
  }
}

const SELECT = `
  select r.*, cu.username as created_by_username, au.full_name as assigned_name, au.username as assigned_username, f.family_no, c.name as campaign_name
  from quick_requests r join users cu on cu.id = r.created_by left join users au on au.id = r.assigned_to
    left join families f on f.id = r.family_id left join campaigns c on c.id = r.campaign_id`;

function present(r: any) {
  return {
    id: r.id as string, no: r.no as number, headName: r.head_name as string, phone: r.phone as string | null, mahalla: r.mahalla as string | null, landmark: r.landmark as string | null,
    membersCount: r.members_count as number | null, note: r.note as string | null, source: r.source as 'STAFF' | 'EMERGENCY', campaignName: r.campaign_name as string | null,
    status: r.status as string, assignedTo: r.assigned_username as string | null, assignedName: r.assigned_name as string | null, invitedAt: r.invited_at,
    familyId: r.family_id as string | null, familyNo: r.family_no as string | null, createdBy: r.created_by_username as string, createdAt: r.created_at, closeNote: r.close_note as string | null,
  };
}
