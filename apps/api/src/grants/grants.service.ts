import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { normalizeName } from '../common/arabic';
import { Db } from '../db/db.module';
import { phone } from '../families/families.schema';
import { QuickService } from '../quick/quick.service';

export const grantSchema = z.object({
  agentId: z.string().uuid(),
  maxCases: z.number().int().min(1).max(500),
  perCase: z.number().int().min(1).max(1000),
  /** كم ساعة يسري. ينتهي وحده بعدها. */
  hours: z.number().int().min(1).max(72),
  reason: z.string().trim().min(5, 'اكتب سبب التخويل').max(300),
});
export type GrantInput = z.infer<typeof grantSchema>;
export const caseSchema = z.object({
  /** الاسم وحده لازم؛ والباقي إن تيسّر، ليبقى العمل سلساً في الزحام. */
  headName: z.string().trim().min(3, 'اكتب اسم المستلم').max(120),
  phone: phone.optional(),
  mahalla: z.string().trim().min(1).max(80).optional(),
  membersCount: z.number().int().min(1).max(50).optional(),
  note: z.string().trim().min(1).max(300).optional(),
  deliveredAt: z.string().datetime().optional(),
  clientOpId: z.string().uuid(),
});
export type CaseInput = z.infer<typeof caseSchema>;
export const revokeSchema = z.object({ note: z.string().trim().min(3, 'يلزم ذكر السبب').max(300) });

/** الاسم نفسه في الحملة نفسها: يُعدّ هو هو. الاسم الرباعي شبه فريد. */
const SAME_PERSON = 0.9;

/**
 * التخويل الاستثنائي: صرف بلا رمز لمن ليس مسجَّلاً، حين يتأخر الوقت والطعام لا يحتمل.
 * هو أضيق باب في النظام: متعهد بعينه، حملة بعينها، سقف ومدة وسبب؛ وكل حالة باسمها تُراجَع غداً.
 */
@Injectable()
export class GrantsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(QuickService) private readonly quick: QuickService,
  ) {}

  async create(campaignId: string, input: GrantInput, actor: AuthUser) {
    const camp = (await this.db.query(
      'select c.status, c.name, p.kind from campaigns c join programs p on p.id = c.program_id where c.id = $1', [campaignId])).rows[0];
    if (!camp) throw new NotFoundException('الحملة غير موجودة');
    if (camp.status !== 'ACTIVE') throw new ConflictException('الحملة ليست جارية');
    if (camp.kind === 'MONEY') throw new BadRequestException('التخويل للحملات العينية وحدها: المال لا يُصرف بلا رمز');
    if (input.agentId === actor.id) throw new ForbiddenException('لا يخوّل الموظف نفسه');
    // المتعهد يلزم أن يكون في هذه الحملة: يصرف من عهدته فيها.
    const point = (await this.db.query(
      `select p.id from distribution_points p where p.agent_id = $1 and exists (select 1 from entitlements e where e.campaign_id = $2 and e.point_id = p.id)`, [input.agentId, campaignId])).rows[0];
    if (!point) throw new BadRequestException('المتعهد ليس من متعهدي هذه الحملة');
    const open = (await this.db.query("select 1 from emergency_grants where campaign_id = $1 and agent_id = $2 and status = 'ACTIVE' and expires_at > now()", [campaignId, input.agentId])).rowCount;
    if (open) throw new ConflictException('للمتعهد تخويل قائم في هذه الحملة. اسحبه أولاً إن أردت تغييره.');
    const id = await this.db.tx(async (c) => {
      const { rows } = await c.query(
        `insert into emergency_grants (campaign_id, agent_id, point_id, max_cases, per_case, expires_at, reason, created_by)
         values ($1,$2,$3,$4,$5, now() + make_interval(hours => $6), $7, $8) returning id`,
        [campaignId, input.agentId, point.id, input.maxCases, input.perCase, input.hours, input.reason, actor.id]);
      await this.audit.append(c, { actorId: actor.id, action: 'grant.create', entity: 'grant', entityId: rows[0].id, payload: { campaignId, agentId: input.agentId, maxCases: input.maxCases, perCase: input.perCase, hours: input.hours, reason: input.reason } });
      return rows[0].id as string;
    });
    return this.get(id);
  }

  async revoke(id: string, note: string, actor: AuthUser) {
    await this.db.tx(async (c) => {
      const { rowCount } = await c.query("update emergency_grants set status = 'REVOKED', revoked_by = $2, revoked_at = now(), revoke_note = $3 where id = $1 and status = 'ACTIVE'", [id, actor.id, note]);
      if (!rowCount) throw new NotFoundException('التخويل غير موجود أو سُحب من قبل');
      await this.audit.append(c, { actorId: actor.id, action: 'grant.revoke', entity: 'grant', entityId: id, payload: { note } });
    });
    return this.get(id);
  }

  /**
   * حالة صرف لغير مسجَّل. تُمنع إن جاوزت السقف أو انتهى التخويل، أو صُرف للاسم نفسه في هذه الحملة.
   * وما سوى ذلك يُسجَّل ويُنبَّه عليه: الوقت لا يحتمل تحقيقاً، والمراجعة غداً.
   */
  async addCase(grantId: string, input: CaseInput, actor: AuthUser) {
    const prior = await this.db.query('select id from emergency_cases where client_op_id = $1', [input.clientOpId]);
    if (prior.rows[0]) return this.caseOf(prior.rows[0].id);
    const id = await this.db.tx(async (c) => {
      const g = (await c.query(
        `select g.*, c.status as campaign_status, c.program_id, c.name as campaign_name from emergency_grants g join campaigns c on c.id = g.campaign_id where g.id = $1 for update of g`, [grantId])).rows[0];
      if (!g) throw new NotFoundException('التخويل غير موجود');
      if (g.agent_id !== actor.id) throw new ForbiddenException('هذا التخويل لمتعهد آخر');
      // الحالة التي وقعت والهاتف منقطع تُقاس بوقت وقوعها لا بوقت رفعها.
      const at = input.deliveredAt ? new Date(Math.min(new Date(input.deliveredAt).getTime(), Date.now())) : new Date();
      // حالة وقعت والتخويل سارٍ ثم رُفعت بعد سحبه أو انتهائه (هاتف منقطع): واقعٌ وقع، فتُسجَّل ويُنبَّه عليها.
      if (g.status !== 'ACTIVE' && at.getTime() >= new Date(g.revoked_at).getTime()) throw new ConflictException({ message: 'سُحب هذا التخويل', code: 'GRANT_CLOSED' });
      if (at.getTime() > new Date(g.expires_at).getTime()) throw new ConflictException({ message: 'انتهت مدة التخويل', code: 'GRANT_CLOSED' });
      const lateUpload = g.status !== 'ACTIVE' || Date.now() > new Date(g.expires_at).getTime();
      if (at.getTime() < new Date(g.created_at).getTime() - 60_000) throw new ConflictException({ message: 'الحالة قبل صدور التخويل', code: 'GRANT_CLOSED' });
      if (g.campaign_status !== 'ACTIVE') throw new ConflictException({ message: 'الحملة ليست جارية', code: 'GRANT_CLOSED' });
      const used = (await c.query('select count(*)::int as n from emergency_cases where grant_id = $1', [grantId])).rows[0].n;
      if (used >= g.max_cases) throw new ConflictException({ message: `استُنفد التخويل: ${g.max_cases} حالة`, code: 'GRANT_FULL' });

      const norm = normalizeName(input.headName);
      const same = (await c.query(
        `select ec.head_name, u.full_name as by from emergency_cases ec join emergency_grants eg on eg.id = ec.grant_id join users u on u.id = ec.created_by
         where eg.campaign_id = $1 and (similarity(ec.name_norm, $2) >= $3 or ($4::text is not null and ec.phone = $4)) limit 1`,
        [g.campaign_id, norm, SAME_PERSON, input.phone ?? null])).rows[0];
      if (same) throw new ConflictException({ message: `لا تصرف: صُرف في هذه الحملة لـ«${same.head_name}» عند ${same.by}`, code: 'ALREADY_SERVED' });

      const warnings: string[] = lateUpload ? ['رُفعت بعد انتهاء التخويل أو سحبه، بوقت يقوله الهاتف'] : [];
      const m = await this.quick.matches(c, input.headName, input.phone);
      const strong = m.families.filter((f) => f.samePhone || f.score >= SAME_PERSON);
      // مسجَّل وله رمز في هذه الحملة: حقّه برمزه لا بالتخويل.
      if (strong.length) {
        const inCampaign = (await c.query(
          "select f.family_no from entitlements e join families f on f.id = e.family_id where e.campaign_id = $1 and e.family_id = any($2) and e.status <> 'CANCELLED' limit 1",
          [g.campaign_id, strong.map((f) => f.familyId)])).rows[0];
        if (inCampaign) throw new ConflictException({ message: `لا تصرف بالتخويل: هو مسجَّل (العائلة ${inCampaign.family_no}) وله استحقاق في هذه الحملة برمزه`, code: 'HAS_ENTITLEMENT' });
        warnings.push(`يشبه مسجَّلاً: العائلة ${strong[0].familyNo}`);
      }
      const before = (await c.query(
        `select count(*)::int as n from emergency_cases ec join emergency_grants eg on eg.id = ec.grant_id
         where eg.campaign_id <> $1 and (similarity(ec.name_norm, $2) >= $3 or ($4::text is not null and ec.phone = $4))`, [g.campaign_id, norm, SAME_PERSON, input.phone ?? null])).rows[0].n;
      if (before) warnings.push(`صُرف له بتخويل من قبل ${before} مرة ولم يُستكمل تسجيله`);

      const q = await this.quick.insert(c, { headName: input.headName, phone: input.phone, mahalla: input.mahalla, membersCount: input.membersCount, note: input.note }, actor, { source: 'EMERGENCY', campaignId: g.campaign_id });
      const { rows } = await c.query(
        `insert into emergency_cases (grant_id, quick_request_id, head_name, name_norm, phone, quantity, delivered_at, warnings, client_op_id, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [grantId, q.id, input.headName, norm, input.phone ?? null, g.per_case, at.toISOString(), warnings, input.clientOpId, actor.id]);
      // يُخصم من مخزن نقطة المتعهد، إن كان للبرنامج صنف في المخزن.
      const item = (await c.query('select item_id from programs where id = $1', [g.program_id])).rows[0]?.item_id;
      if (item) {
        const wh = (await c.query("insert into warehouses (name, point_id) select 'مخزن ' || name, id from distribution_points where id = $1 on conflict (point_id) do update set name = excluded.name returning id", [g.point_id])).rows[0].id;
        await c.query("insert into stock_moves (kind, item_id, from_wh, quantity, campaign_id, emergency_case_id, created_by) values ('ISSUE', $1, $2, $3, $4, $5, $6)", [item, wh, g.per_case, g.campaign_id, rows[0].id, actor.id]);
      }
      await this.audit.append(c, { actorId: actor.id, action: 'grant.case', entity: 'grant', entityId: grantId, payload: { caseId: rows[0].id, quickNo: q.no, quantity: g.per_case, warnings } });
      return rows[0].id as string;
    });
    return this.caseOf(id);
  }

  private async caseOf(id: string) {
    const r = (await this.db.query(`${CASES} where ec.id = $1`, [id])).rows[0];
    return presentCase(r);
  }

  async get(id: string) {
    const g = (await this.db.query(`${GRANTS} where g.id = $1`, [id])).rows[0];
    if (!g) throw new NotFoundException('التخويل غير موجود');
    const cases = await this.db.query(`${CASES} where ec.grant_id = $1 order by ec.delivered_at desc`, [id]);
    return { ...presentGrant(g), cases: cases.rows.map(presentCase) };
  }

  async forCampaign(campaignId: string) {
    const { rows } = await this.db.query(`${GRANTS} where g.campaign_id = $1 order by g.created_at desc`, [campaignId]);
    const out = [];
    for (const g of rows) out.push(await this.get(g.id));
    return out;
  }

  /** تخويلات المتعهد السارية الآن: يحملها هاتفه ليعمل بها ولو انقطع. */
  async mine(actor: AuthUser) {
    const { rows } = await this.db.query(`${GRANTS} where g.agent_id = $1 and g.status = 'ACTIVE' and g.expires_at > now() and c.status = 'ACTIVE' order by g.created_at desc`, [actor.id]);
    return rows.map(presentGrant);
  }
}

const GRANTS = `
  select g.*, c.name as campaign_name, c.unit, c.status as campaign_status, a.full_name as agent_name, cu.username as created_by_username, ru.username as revoked_by_username,
         (select count(*) from emergency_cases ec where ec.grant_id = g.id)::int as used
  from emergency_grants g join campaigns c on c.id = g.campaign_id join users a on a.id = g.agent_id join users cu on cu.id = g.created_by left join users ru on ru.id = g.revoked_by`;
const CASES = `
  select ec.*, q.no as quick_no, q.status as quick_status, q.mahalla, q.members_count, q.note, u.username as by
  from emergency_cases ec join quick_requests q on q.id = ec.quick_request_id join users u on u.id = ec.created_by`;

function presentGrant(g: any) {
  const expired = new Date(g.expires_at).getTime() <= Date.now();
  return {
    id: g.id as string, campaignId: g.campaign_id as string, campaignName: g.campaign_name as string, unit: g.unit as string, agentId: g.agent_id as string, agentName: g.agent_name as string,
    maxCases: g.max_cases as number, perCase: g.per_case as number, used: g.used as number, remaining: Math.max(0, g.max_cases - g.used),
    expiresAt: g.expires_at, reason: g.reason as string, createdBy: g.created_by_username as string, createdAt: g.created_at,
    // سارٍ، أو انتهت مدته، أو سُحب.
    state: (g.status === 'REVOKED' ? 'REVOKED' : expired || g.campaign_status !== 'ACTIVE' ? 'EXPIRED' : 'ACTIVE') as 'ACTIVE' | 'EXPIRED' | 'REVOKED',
    revokedBy: g.revoked_by_username as string | null, revokeNote: g.revoke_note as string | null,
  };
}
function presentCase(r: any) {
  return {
    id: r.id as string, headName: r.head_name as string, phone: r.phone as string | null, mahalla: r.mahalla as string | null, membersCount: r.members_count as number | null, note: r.note as string | null,
    quantity: r.quantity as number, deliveredAt: r.delivered_at, warnings: r.warnings as string[], by: r.by as string, quickRequestId: r.quick_request_id as string, quickNo: r.quick_no as number, quickStatus: r.quick_status as string,
  };
}
