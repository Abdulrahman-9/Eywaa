import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { AccountingService } from '../accounting/accounting.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { normalizeIraqiPhone } from '../common/arabic';
import { Db } from '../db/db.module';

const money = z.number().int().min(1).max(1_000_000_000_000);
export const contractorSchema = z.object({ name: z.string().trim().min(3).max(120), phone: z.string().optional(), note: z.string().trim().max(200).optional() });
export const projectSchema = z.object({
  familyId: z.string().uuid(),
  contractorId: z.string().uuid(),
  fundId: z.string().uuid(),
  location: z.string().trim().min(3).max(200),
  contractDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  durationDays: z.number().int().min(1).max(3650),
  stages: z.array(z.object({ name: z.string().trim().min(2).max(60), amount: money })).min(1).max(20),
});
export type ProjectInput = z.infer<typeof projectSchema>;

@Injectable()
export class HousingService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccountingService) private readonly accounting: AccountingService,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
  ) {}

  // ---------- المقاولون ----------

  async contractors() {
    const { rows } = await this.db.query(
      `select c.id, c.name, c.phone, c.note, c.active,
              count(p.id) filter (where p.status = 'ACTIVE')::int as active_projects,
              count(p.id) filter (where p.status = 'DELIVERED')::int as delivered_projects
       from contractors c left join housing_projects p on p.contractor_id = c.id group by c.id order by c.name`,
    );
    return rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, note: r.note, active: r.active, activeProjects: r.active_projects, deliveredProjects: r.delivered_projects }));
  }

  async createContractor(input: z.infer<typeof contractorSchema>, actor: AuthUser) {
    const phone = input.phone?.trim() ? normalizeIraqiPhone(input.phone) : null;
    if (input.phone?.trim() && !phone) throw new BadRequestException('رقم هاتف عراقي غير صالح');
    try {
      return await this.db.tx(async (c) => {
        const { rows } = await c.query('insert into contractors (name, phone, note) values ($1,$2,$3) returning id, name', [input.name, phone, input.note ?? null]);
        await this.audit.append(c, { actorId: actor.id, action: 'contractor.create', entity: 'contractor', entityId: rows[0].id, payload: { name: input.name } });
        return rows[0];
      });
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException('مقاول بهذا الاسم موجود');
      throw err;
    }
  }

  // ---------- المشاريع ----------

  async create(input: ProjectInput, actor: AuthUser) {
    const budget = input.stages.reduce((s, x) => s + x.amount, 0);
    try {
      const id = await this.db.tx(async (c) => {
        const fam = await c.query('select status from families where id = $1', [input.familyId]);
        if (!fam.rows[0]) throw new NotFoundException('العائلة غير موجودة');
        if (fam.rows[0].status !== 'APPROVED') throw new ConflictException('لا يُبنى منزل إلا لعائلة معتمدة');
        await this.accounting.requireUnrestricted(c, input.fundId, 'لبناء المنازل');
        const { rows } = await c.query(
          `insert into housing_projects (family_id, contractor_id, fund_id, location, budget, contract_date, duration_days, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [input.familyId, input.contractorId, input.fundId, input.location, budget, input.contractDate, input.durationDays, actor.id],
        );
        for (const [i, s] of input.stages.entries()) {
          await c.query('insert into housing_stages (project_id, seq, name, amount) values ($1,$2,$3,$4)', [rows[0].id, i + 1, s.name, s.amount]);
        }
        await this.audit.append(c, { actorId: actor.id, action: 'housing.create', entity: 'housing_project', entityId: rows[0].id, payload: { familyId: input.familyId, budget, stages: input.stages.length } });
        return rows[0].id as string;
      });
      return this.detail(id);
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException('لهذه العائلة مشروع بناء قائم');
      if (err.code === '23503') throw new BadRequestException('المقاول أو الصندوق غير موجود');
      throw err;
    }
  }

  /** اعتماد المشروع يحجز ميزانيته من صندوقه. */
  async decide(id: string, approve: boolean, note: string | undefined, actor: AuthUser) {
    await this.db.tx(async (c) => {
      const { rows } = await c.query('select * from housing_projects where id = $1 for update', [id]);
      const p = rows[0];
      if (!p) throw new NotFoundException('المشروع غير موجود');
      if (p.status !== 'PENDING_APPROVAL') throw new ConflictException('فُصل في هذا المشروع من قبل');
      if (p.created_by === actor.id) throw new ForbiddenException('لا يعتمد الموظف مشروعاً أنشأه بنفسه');
      if (!approve && !note) throw new BadRequestException('يلزم ذكر سبب الرفض');
      if (approve) {
        await this.accounting.requireUnrestricted(c, p.fund_id, 'لبناء المنازل');
        await this.accounting.requireAvailable(c, p.fund_id, Number(p.budget), 'ميزانية المشروع');
      }
      await c.query('update housing_projects set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1', [id, approve ? 'ACTIVE' : 'REJECTED', actor.id, note ?? null]);
      await this.audit.append(c, { actorId: actor.id, action: approve ? 'housing.approve' : 'housing.reject', entity: 'housing_project', entityId: id, payload: { note: note ?? null, budget: Number(p.budget) } });
    });
    return this.detail(id);
  }

  private async stage(c: PoolClient, stageId: string) {
    const { rows } = await c.query(
      `select s.*, p.status as project_status, p.fund_id, p.family_id, p.id as project_id, ct.name as contractor, f.family_no
       from housing_stages s join housing_projects p on p.id = s.project_id join contractors ct on ct.id = p.contractor_id
         join families f on f.id = p.family_id
       where s.id = $1 for update of s`,
      [stageId],
    );
    if (!rows[0]) throw new NotFoundException('المرحلة غير موجودة');
    if (rows[0].project_status !== 'ACTIVE') throw new ConflictException('المشروع ليس جارياً');
    return rows[0];
  }

  /** المراحل تُنجز بترتيبها: لا تُطلب مرحلة وما قبلها لم يُصرف. */
  private async requirePreviousPaid(c: PoolClient, s: any) {
    const prev = await c.query("select 1 from housing_stages where project_id = $1 and seq < $2 and status <> 'PAID' limit 1", [s.project_id, s.seq]);
    if (prev.rowCount) throw new ConflictException('قبل هذه المرحلة مرحلة لم تُصرف دفعتها بعد');
  }

  /** طلب المقاول صرف دفعة المرحلة. يسجّله مشرف المشاريع. */
  async claim(stageId: string, note: string, actor: AuthUser) {
    const projectId = await this.db.tx(async (c) => {
      const s = await this.stage(c, stageId);
      if (s.status !== 'PLANNED') throw new ConflictException('طُلبت هذه المرحلة من قبل');
      await this.requirePreviousPaid(c, s);
      await c.query("update housing_stages set status = 'CLAIMED', claimed_at = now(), claim_note = $2 where id = $1", [stageId, note]);
      await this.audit.append(c, { actorId: actor.id, action: 'housing.claim', entity: 'housing_stage', entityId: stageId, payload: { stage: s.name, note } });
      return s.project_id as string;
    });
    return this.detail(projectId);
  }

  /** زيارة التحقق: يشهد المشرف أن المرحلة تمّت كما طُلبت. */
  async verify(stageId: string, note: string, actor: AuthUser) {
    const projectId = await this.db.tx(async (c) => {
      const s = await this.stage(c, stageId);
      if (s.status !== 'CLAIMED') throw new ConflictException(s.status === 'PLANNED' ? 'لم يطلب المقاول صرف هذه المرحلة بعد' : 'تُحقق من هذه المرحلة من قبل');
      await c.query("update housing_stages set status = 'VERIFIED', verified_by = $2, verified_at = now(), verify_note = $3 where id = $1", [stageId, actor.id, note]);
      await this.audit.append(c, { actorId: actor.id, action: 'housing.verify', entity: 'housing_stage', entityId: stageId, payload: { stage: s.name, note } });
      return s.project_id as string;
    });
    return this.detail(projectId);
  }

  /** يعيد المرحلة إلى المقاول: لم تتمّ كما طُلبت. */
  async sendBack(stageId: string, note: string, actor: AuthUser) {
    const projectId = await this.db.tx(async (c) => {
      const s = await this.stage(c, stageId);
      if (s.status !== 'CLAIMED' && s.status !== 'VERIFIED') throw new ConflictException('لا طلب قائم على هذه المرحلة');
      await c.query("update housing_stages set status = 'PLANNED', claimed_at = null, claim_note = null, verified_by = null, verified_at = null, verify_note = null where id = $1", [stageId]);
      await this.audit.append(c, { actorId: actor.id, action: 'housing.send_back', entity: 'housing_stage', entityId: stageId, payload: { stage: s.name, note } });
      return s.project_id as string;
    });
    return this.detail(projectId);
  }

  /**
   * اعتماد المرحلة يصرف دفعتها. لا يقع إلا بعد زيارة تحقق، ومن موظف غير الذي تحقق.
   * وهذا هو الطريق الوحيد إلى صرف دفعة مرحلة.
   */
  async approveStage(stageId: string, actor: AuthUser) {
    const projectId = await this.db.tx(async (c) => {
      const s = await this.stage(c, stageId);
      if (s.status === 'PAID') throw new ConflictException('صُرفت دفعة هذه المرحلة من قبل');
      if (s.status !== 'VERIFIED') throw new ConflictException('لا تُصرف دفعة مرحلة لم تُسجَّل لها زيارة تحقق');
      if (s.verified_by === actor.id) throw new ForbiddenException('لا يعتمد الصرف من سجّل زيارة التحقق بنفسه');
      await this.requirePreviousPaid(c, s);
      const entry = await this.accounting.payFromFund(c, {
        fundId: s.fund_id, amount: Number(s.amount), category: 'بناء المنازل', party: s.contractor,
        description: `دفعة ${s.name}، منزل العائلة ${s.family_no}`, actorId: actor.id,
      });
      await c.query("update housing_stages set status = 'PAID', approved_by = $2, approved_at = now(), payment_entry = $3 where id = $1", [stageId, actor.id, entry.id]);
      const left = await c.query("select 1 from housing_stages where project_id = $1 and status <> 'PAID' limit 1", [s.project_id]);
      if (!left.rowCount) await c.query("update housing_projects set status = 'DELIVERED' where id = $1", [s.project_id]);
      await this.audit.append(c, { actorId: actor.id, action: 'housing.pay', entity: 'housing_stage', entityId: stageId, payload: { stage: s.name, amount: Number(s.amount), entryNo: entry.no, delivered: !left.rowCount } });
      return s.project_id as string;
    });
    return this.detail(projectId);
  }

  async photo(stageId: string, file: { buffer: Buffer; originalname: string } | undefined, actor: AuthUser) {
    const { rows } = await this.db.query('select p.family_id from housing_stages s join housing_projects p on p.id = s.project_id where s.id = $1', [stageId]);
    if (!rows[0]) throw new NotFoundException('المرحلة غير موجودة');
    const a = await this.attachments.upload(rows[0].family_id, file, 'HOUSING_PROGRESS', undefined, actor);
    await this.db.query('update attachments set stage_id = $2 where id = $1', [a.id, stageId]);
    return { attachmentId: a.id };
  }

  async list() {
    const { rows } = await this.db.query(
      `select p.id, p.status, p.location, p.budget, p.contract_date, p.duration_days, f.family_no, h.full_name as head_name, ct.name as contractor,
              coalesce(sum(s.amount) filter (where s.status = 'PAID'), 0)::bigint as paid,
              count(s.id) filter (where s.status in ('CLAIMED', 'VERIFIED'))::int as waiting
       from housing_projects p join families f on f.id = p.family_id left join persons h on h.family_id = f.id and h.relation = 'HEAD'
         join contractors ct on ct.id = p.contractor_id left join housing_stages s on s.project_id = p.id
       group by p.id, f.family_no, h.full_name, ct.name order by p.created_at desc`,
    );
    return rows.map((r) => ({ id: r.id, status: r.status, location: r.location, budget: Number(r.budget), paid: Number(r.paid), familyNo: r.family_no, headName: r.head_name, contractor: r.contractor, waiting: r.waiting, contractDate: r.contract_date, durationDays: r.duration_days }));
  }

  async detail(id: string) {
    const { rows } = await this.db.query(
      `select p.*, f.family_no, h.full_name as head_name, ct.name as contractor, ct.phone as contractor_phone, fd.name as fund,
              cu.username as created_by_username, du.username as decided_by_username
       from housing_projects p join families f on f.id = p.family_id left join persons h on h.family_id = f.id and h.relation = 'HEAD'
         join contractors ct on ct.id = p.contractor_id join funds fd on fd.id = p.fund_id
         join users cu on cu.id = p.created_by left join users du on du.id = p.decided_by
       where p.id = $1`,
      [id],
    );
    const p = rows[0];
    if (!p) throw new NotFoundException('المشروع غير موجود');
    const stages = await this.db.query(
      `select s.*, vu.username as verified_by_username, au.username as approved_by_username, e.no as entry_no,
              (select count(*)::int from attachments a where a.stage_id = s.id and a.deleted_at is null) as photos
       from housing_stages s left join users vu on vu.id = s.verified_by left join users au on au.id = s.approved_by
         left join ledger_entries e on e.id = s.payment_entry
       where s.project_id = $1 order by s.seq`,
      [id],
    );
    const paid = stages.rows.filter((s) => s.status === 'PAID').reduce((sum, s) => sum + Number(s.amount), 0);
    const end = new Date(p.contract_date);
    end.setDate(end.getDate() + p.duration_days);
    return {
      id: p.id, status: p.status, familyId: p.family_id, familyNo: p.family_no, headName: p.head_name, location: p.location,
      contractor: p.contractor, contractorPhone: p.contractor_phone, fund: p.fund, budget: Number(p.budget), paid,
      contractDate: p.contract_date, durationDays: p.duration_days, daysLeft: Math.ceil((end.getTime() - Date.now()) / 86400000),
      createdBy: p.created_by_username, decidedBy: p.decided_by_username, decisionNote: p.decision_note,
      stages: stages.rows.map((s) => ({
        id: s.id, seq: s.seq, name: s.name, amount: Number(s.amount), share: Math.round((Number(s.amount) / Number(p.budget)) * 100), status: s.status,
        claimedAt: s.claimed_at, claimNote: s.claim_note, verifiedBy: s.verified_by_username, verifiedAt: s.verified_at, verifyNote: s.verify_note,
        approvedBy: s.approved_by_username, approvedAt: s.approved_at, entryNo: s.entry_no, photos: s.photos,
      })),
    };
  }
}
