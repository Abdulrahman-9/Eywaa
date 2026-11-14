import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { Db } from '../db/db.module';
import { ScoringService } from '../scoring/scoring.service';

export const openSchema = z.object({
  familyId: z.string().uuid(),
  source: z.enum(['FAMILY', 'STAFF']),
  reason: z.string().trim().min(3, 'يلزم ذكر سبب الطلب').max(500),
  assignedTo: z.string().uuid().optional(),
});
export const visitSchema = z.object({
  findings: z.string().trim().min(10, 'اكتب ما رأيتَه في الزيارة').max(2000),
  outcome: z.enum(['NO_CHANGE', 'CHANGED']),
  visitedAt: z.string().datetime().optional(),
  clientOpId: z.string().uuid().optional(),
});
export const closeSchema = z.object({ note: z.string().trim().min(1).max(500).optional() });
export const cancelSchema = z.object({ note: z.string().trim().min(3, 'يلزم ذكر السبب').max(500) });
export type OpenInput = z.infer<typeof openSchema>;
export type VisitInput = z.infer<typeof visitSchema>;

/**
 * إعادة التقييم. الزيارة تشهد على حال العائلة اليوم؛ وما تغيّر من بياناتها يُطلب تعديله
 * بطلبات التعديل المعتادة (يعتمدها غير طالبها). فلا تُغلق زيارة «تغيّرت» وطلباتها معلّقة.
 */
@Injectable()
export class ReassessmentsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ScoringService) private readonly scoring: ScoringService,
  ) {}

  async open(input: OpenInput, actor: AuthUser) {
    try {
      const id = await this.db.tx(async (c) => {
        const fam = (await c.query('select status from families where id = $1', [input.familyId])).rows[0];
        if (!fam) throw new NotFoundException('العائلة غير موجودة');
        if (fam.status !== 'APPROVED') throw new ConflictException('إعادة التقييم للعوائل المعتمدة وحدها');
        if (input.assignedTo) {
          const u = (await c.query("select 1 from users where id = $1 and active and role in ('FIELD_RESEARCHER', 'BENEFICIARY_SUPERVISOR')", [input.assignedTo])).rows[0];
          if (!u) throw new BadRequestException('تُسند الزيارة إلى باحث ميداني أو مشرف مستفيدين');
        }
        const { rows } = await c.query(
          'insert into reassessments (family_id, source, reason, assigned_to, opened_by) values ($1,$2,$3,$4,$5) returning id',
          [input.familyId, input.source, input.reason, input.assignedTo ?? null, actor.id]);
        await this.audit.append(c, { actorId: actor.id, action: 'reassessment.open', entity: 'reassessment', entityId: rows[0].id, payload: { familyId: input.familyId, source: input.source, reason: input.reason } });
        return rows[0].id as string;
      });
      return this.get(id);
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException('لهذه العائلة طلب إعادة تقييم قائم');
      throw err;
    }
  }

  async visit(id: string, input: VisitInput, actor: AuthUser) {
    // زيارة سُجّلت على الهاتف دون اتصال ثم أُعيد رفعها: لا تتكرر.
    if (input.clientOpId) {
      const prior = await this.db.query('select id from reassessments where client_op_id = $1', [input.clientOpId]);
      if (prior.rows[0]) return this.get(prior.rows[0].id);
    }
    await this.db.tx(async (c) => {
      const r = (await c.query('select * from reassessments where id = $1 for update', [id])).rows[0];
      if (!r) throw new NotFoundException('طلب إعادة التقييم غير موجود');
      if (r.status !== 'OPEN') throw new ConflictException('سُجّلت زيارة هذا الطلب أو أُغلق');
      if (r.assigned_to && r.assigned_to !== actor.id && actor.role === 'FIELD_RESEARCHER') throw new ForbiddenException('الزيارة مسندة إلى باحث آخر');
      const at = input.visitedAt ? new Date(Math.min(new Date(input.visitedAt).getTime(), Date.now())) : new Date();
      await c.query(
        "update reassessments set status = 'VISITED', visited_by = $2, visited_at = $3, findings = $4, outcome = $5, client_op_id = $6 where id = $1",
        [id, actor.id, at.toISOString(), input.findings, input.outcome, input.clientOpId ?? null]);
      await this.audit.append(c, { actorId: actor.id, action: 'reassessment.visit', entity: 'reassessment', entityId: id, payload: { familyId: r.family_id, outcome: input.outcome } });
    });
    return this.get(id);
  }

  async close(id: string, note: string | undefined, actor: AuthUser) {
    await this.db.tx(async (c) => {
      const r = (await c.query('select * from reassessments where id = $1 for update', [id])).rows[0];
      if (!r) throw new NotFoundException('طلب إعادة التقييم غير موجود');
      if (r.status !== 'VISITED') throw new ConflictException(r.status === 'OPEN' ? 'لم تُسجَّل الزيارة بعد' : 'أُغلق هذا الطلب من قبل');
      if (r.visited_by === actor.id) throw new ForbiddenException('لا يعتمد الزيارةَ من قام بها');
      const pending = (await c.query("select count(*)::int as n from change_requests where family_id = $1 and status = 'PENDING'", [r.family_id])).rows[0].n;
      if (pending) throw new ConflictException(`للعائلة ${pending} طلب تعديل معلّق. افصل فيه أولاً، ثم أغلق الزيارة.`);
      await c.query("update reassessments set status = 'CLOSED', closed_by = $2, closed_at = now(), close_note = $3 where id = $1", [id, actor.id, note ?? null]);
      await this.scoring.recompute(c, r.family_id);
      await this.audit.append(c, { actorId: actor.id, action: 'reassessment.close', entity: 'reassessment', entityId: id, payload: { familyId: r.family_id, outcome: r.outcome, note: note ?? null } });
    });
    return this.get(id);
  }

  async cancel(id: string, note: string, actor: AuthUser) {
    await this.db.tx(async (c) => {
      const r = (await c.query('select * from reassessments where id = $1 for update', [id])).rows[0];
      if (!r) throw new NotFoundException('طلب إعادة التقييم غير موجود');
      if (r.status !== 'OPEN') throw new ConflictException('لا يُلغى طلب سُجّلت زيارته');
      await c.query("update reassessments set status = 'CANCELLED', closed_by = $2, closed_at = now(), close_note = $3 where id = $1", [id, actor.id, note]);
      await this.audit.append(c, { actorId: actor.id, action: 'reassessment.cancel', entity: 'reassessment', entityId: id, payload: { familyId: r.family_id, note } });
    });
    return this.get(id);
  }

  async assignees() {
    const { rows } = await this.db.query("select id, full_name, role from users where active and role in ('FIELD_RESEARCHER', 'BENEFICIARY_SUPERVISOR') order by full_name");
    return rows.map((u) => ({ id: u.id as string, fullName: u.full_name as string, role: u.role as string }));
  }

  async get(id: string) {
    const { rows } = await this.db.query(`${SELECT} where r.id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException('طلب إعادة التقييم غير موجود');
    return present(rows[0]);
  }

  /** mine: ما على هذا الموظف زيارته (المسند إليه، وغير المسند إلى أحد). */
  async list(params: { familyId?: string; status?: string; mine?: boolean }, actor: AuthUser) {
    const { rows } = await this.db.query(
      `${SELECT} where ($1::uuid is null or r.family_id = $1) and ($2::reassessment_status is null or r.status = $2)
         and (not $3 or (r.status = 'OPEN' and (r.assigned_to is null or r.assigned_to = $4)))
       order by r.opened_at desc limit 300`,
      [params.familyId ?? null, params.status ?? null, !!params.mine, actor.id]);
    return rows.map(present);
  }
}

const SELECT = `
  select r.*, f.family_no, f.phone1, f.mahalla, f.landmark, h.full_name as head_name,
         ou.username as opened_by_username, au.full_name as assigned_name, au.username as assigned_username,
         vu.username as visited_by_username, cu.username as closed_by_username
  from reassessments r join families f on f.id = r.family_id left join persons h on h.family_id = f.id and h.relation = 'HEAD'
    join users ou on ou.id = r.opened_by left join users au on au.id = r.assigned_to
    left join users vu on vu.id = r.visited_by left join users cu on cu.id = r.closed_by`;

function present(r: any) {
  return {
    id: r.id as string, familyId: r.family_id as string, familyNo: r.family_no as string, headName: r.head_name as string | null,
    phone: r.phone1 as string | null, mahalla: r.mahalla as string | null, landmark: r.landmark as string | null,
    source: r.source as 'FAMILY' | 'STAFF', reason: r.reason as string, status: r.status as string,
    assignedTo: r.assigned_username as string | null, assignedName: r.assigned_name as string | null,
    openedBy: r.opened_by_username as string, openedAt: r.opened_at,
    visitedBy: r.visited_by_username as string | null, visitedAt: r.visited_at, findings: r.findings as string | null, outcome: r.outcome as string | null,
    closedBy: r.closed_by_username as string | null, closedAt: r.closed_at, closeNote: r.close_note as string | null,
  };
}
