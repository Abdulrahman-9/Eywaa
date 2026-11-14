import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AccountingService } from '../accounting/accounting.service';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { Db } from '../db/db.module';
import { NotificationsService } from '../notifications/notifications.service';

export const createPayoutSchema = z.object({
  campaignId: z.string().uuid(),
  method: z.enum(['TRANSFER', 'WALLET']),
  provider: z.string().trim().min(2).max(80),
  entitlementIds: z.array(z.string().uuid()).min(1).max(5000),
  note: z.string().trim().min(1).max(300).optional(),
});
export type CreatePayoutInput = z.infer<typeof createPayoutSchema>;
export const approvePayoutSchema = z.object({ reference: z.string().trim().min(3, 'يلزم مرجع التنفيذ من المصرف أو شركة المحفظة').max(80) });
export const rejectPayoutSchema = z.object({ note: z.string().trim().min(3, 'يلزم ذكر السبب') });

const METHOD_AR = { TRANSFER: 'حوالة', WALLET: 'محفظة إلكترونية' } as const;

/**
 * الصرف بالحوالة والمحفظة. الطريق: كشف دفع يُنشأ من مستحقي حملة مالية جارية، يُنزَّل ملفاً
 * يُنفَّذ به الدفع خارج النظام، ثم يعتمده موظف آخر بمرجع التنفيذ؛ عندها يُعدّ كل استحقاق فيه مسلَّماً
 * ويُقيَّد المبلغ على صندوق الحملة بقيد واحد. ما دام الكشف معلّقاً لا يُصرف لأصحابه نقداً.
 */
@Injectable()
export class PayoutsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccountingService) private readonly accounting: AccountingService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  private async moneyCampaign(q: { query: Db['query'] }, id: string, lock = false) {
    const { rows } = await q.query(
      `select c.id, c.name, c.status, c.fund_id, c.unit, p.kind from campaigns c join programs p on p.id = c.program_id where c.id = $1${lock ? ' for share of c' : ''}`, [id]);
    const c = rows[0];
    if (!c) throw new NotFoundException('الحملة غير موجودة');
    if (c.kind !== 'MONEY' || !c.fund_id) throw new BadRequestException('كشف الدفع للحملات المالية وحدها');
    if (c.status !== 'ACTIVE') throw new ConflictException('الحملة ليست جارية');
    return c;
  }

  /** من يصلح للكشف: استحقاقات الحملة التي لم تُصرف ولم تدخل كشفاً قائماً. */
  async candidates(campaignId: string) {
    await this.moneyCampaign(this.db, campaignId);
    const { rows } = await this.db.query(
      `select e.id, e.quantity, f.family_no, f.phone1, h.full_name, dp.name as point
       from entitlements e join families f on f.id = e.family_id left join persons h on h.family_id = f.id and h.relation = 'HEAD'
         join distribution_points dp on dp.id = e.point_id
       where e.campaign_id = $1 and e.status = 'PENDING'
         and not exists (select 1 from payout_items i where i.entitlement_id = e.id and i.active)
       order by e.serial`, [campaignId]);
    return rows.map((r) => ({ entitlementId: r.id, familyNo: r.family_no, headName: r.full_name, phone: r.phone1 as string | null, amount: r.quantity, point: r.point }));
  }

  async create(input: CreatePayoutInput, actor: AuthUser) {
    const ids = [...new Set(input.entitlementIds)];
    try {
      const id = await this.db.tx(async (c) => {
        await this.moneyCampaign(c, input.campaignId, true);
        const { rows } = await c.query(
          `select e.id, e.quantity, e.status, f.family_no, f.phone1, h.full_name
           from entitlements e join families f on f.id = e.family_id left join persons h on h.family_id = f.id and h.relation = 'HEAD'
           where e.id = any($1) and e.campaign_id = $2 order by e.serial for no key update of e`, [ids, input.campaignId]);
        if (rows.length !== ids.length) throw new BadRequestException('في الكشف استحقاق ليس من هذه الحملة');
        const taken = rows.filter((r) => r.status !== 'PENDING');
        if (taken.length) throw new ConflictException(`${taken.length} من المختارين صُرف له أو أُلغي استحقاقه: ${taken.slice(0, 5).map((r) => r.family_no).join('، ')}`);
        const noPhone = rows.filter((r) => !r.phone1);
        // رقم الهاتف هو رقم المحفظة، وبه يُعرَّف المستلم عند مكتب الحوالة.
        if (noPhone.length) throw new BadRequestException(`${noPhone.length} من المختارين بلا رقم هاتف: ${noPhone.slice(0, 5).map((r) => r.family_no).join('، ')}`);
        const total = rows.reduce((s, r) => s + r.quantity, 0);
        const batch = await c.query(
          'insert into payout_batches (campaign_id, method, provider, total, items, note, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id, no',
          [input.campaignId, input.method, input.provider, total, rows.length, input.note ?? null, actor.id]);
        await c.query(
          `insert into payout_items (batch_id, entitlement_id, family_no, recipient, account, amount)
           select $1, * from unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::int[])`,
          [batch.rows[0].id, rows.map((r) => r.id), rows.map((r) => r.family_no), rows.map((r) => r.full_name ?? r.family_no), rows.map((r) => r.phone1), rows.map((r) => r.quantity)]);
        await this.audit.append(c, { actorId: actor.id, action: 'payout.create', entity: 'payout', entityId: batch.rows[0].id,
          payload: { no: batch.rows[0].no, campaignId: input.campaignId, method: input.method, provider: input.provider, items: rows.length, total } });
        return batch.rows[0].id as string;
      });
      return this.get(id);
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException('بعض المختارين في كشف دفع آخر لم يُفصل فيه');
      throw err;
    }
  }

  async list(campaignId: string) {
    const { rows } = await this.db.query(`${SELECT} where b.campaign_id = $1 order by b.no desc`, [campaignId]);
    return rows.map(present);
  }

  async get(id: string) {
    const { rows } = await this.db.query(`${SELECT} where b.id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException('كشف الدفع غير موجود');
    const items = await this.db.query('select entitlement_id, family_no, recipient, account, amount, paid, skip_reason from payout_items where batch_id = $1 order by family_no', [id]);
    return { ...present(rows[0]), lines: items.rows.map((i) => ({ entitlementId: i.entitlement_id, familyNo: i.family_no, recipient: i.recipient, account: i.account, amount: i.amount, paid: i.paid as boolean | null, skipReason: i.skip_reason as string | null })) };
  }

  /** ملف يُسلَّم لمكتب الحوالة أو يُرفع إلى بوّابة المحفظة. تنزيله يُسجَّل: فيه أسماء وأرقام. */
  async csv(id: string, actor: AuthUser) {
    const b = await this.get(id);
    await this.db.tx((c) => this.audit.append(c, { actorId: actor.id, action: 'payout.export', entity: 'payout', entityId: id, payload: { no: b.no, rows: b.lines.length } }));
    const cell = (v: unknown) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    // الصفر الأول من رقم الهاتف يسقط في Excel إن قُرئ عدداً؛ فيُكتب نصاً.
    const lines = [['الاسم', 'رقم العائلة', b.method === 'WALLET' ? 'رقم المحفظة' : 'رقم الهاتف', 'المبلغ (دينار)'], ...b.lines.map((l) => [l.recipient, l.familyNo, `="${l.account}"`, l.amount])];
    return { name: `كشف-دفع-${b.no}`, csv: '﻿' + lines.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n' };
  }

  async approve(id: string, reference: string, actor: AuthUser) {
    const paid = await this.db.tx(async (c) => {
      const b = (await c.query('select * from payout_batches where id = $1 for update', [id])).rows[0];
      if (!b) throw new NotFoundException('كشف الدفع غير موجود');
      if (b.status !== 'PENDING_APPROVAL') throw new ConflictException('فُصل في هذا الكشف من قبل');
      if (b.created_by === actor.id) throw new ForbiddenException('لا يعتمد الكشفَ من أنشأه');
      const camp = (await c.query('select name, fund_id, status from campaigns where id = $1', [b.campaign_id])).rows[0];
      const items = (await c.query(
        `select i.entitlement_id, i.amount, i.recipient, e.status, e.family_id from payout_items i join entitlements e on e.id = i.entitlement_id
         where i.batch_id = $1 order by i.entitlement_id for no key update of e`, [id])).rows;
      // من استلم نقداً بين إنشاء الكشف واعتماده (جهاز منقطع زامن) لا يُدفع له ثانية.
      const due = items.filter((i) => i.status === 'PENDING');
      const skipped = items.filter((i) => i.status !== 'PENDING');
      if (!due.length) throw new ConflictException('لم يبقَ في الكشف من يُدفع له: كلهم صُرف لهم أو أُلغيت استحقاقاتهم. ارفض الكشف.');
      const total = due.reduce((s, i) => s + i.amount, 0);
      const entry = await this.accounting.payFromFund(c, {
        fundId: camp.fund_id, amount: total, category: 'مساعدات', party: b.provider, actorId: actor.id,
        description: `${camp.name}: كشف دفع ${b.no} (${METHOD_AR[b.method as keyof typeof METHOD_AR]}، ${due.length} عائلة)، مرجع ${reference}`,
      });
      await c.query(
        `update entitlements set status = 'DELIVERED', delivered_at = now(), delivered_by = $2, mode = 'TRANSFER', receiver = 'HEAD', receiver_name = i.recipient
         from payout_items i where i.batch_id = $1 and i.entitlement_id = entitlements.id and entitlements.id = any($3)`,
        [id, actor.id, due.map((i) => i.entitlement_id)]);
      await c.query('update payout_items set paid = true where batch_id = $1 and entitlement_id = any($2)', [id, due.map((i) => i.entitlement_id)]);
      if (skipped.length) {
        await c.query(
          `update payout_items i set paid = false, active = false, skip_reason = case e.status when 'DELIVERED' then 'استلم نقداً قبل اعتماد الكشف' else 'أُلغي استحقاقه' end
           from entitlements e where e.id = i.entitlement_id and i.batch_id = $1 and i.entitlement_id = any($2)`, [id, skipped.map((i) => i.entitlement_id)]);
      }
      await c.query(
        `update payout_batches set status = 'PAID', reference = $2, decided_by = $3, decided_at = now(), paid_total = $4, paid_items = $5, entry_id = $6 where id = $1`,
        [id, reference, actor.id, total, due.length, (entry as { id: string }).id]);
      await this.audit.append(c, { actorId: actor.id, action: 'payout.approve', entity: 'payout', entityId: id,
        payload: { no: b.no, reference, paid: due.length, total, skipped: skipped.length } });
      return { due, provider: b.provider as string, method: b.method as keyof typeof METHOD_AR, unit: 'دينار' };
    });
    // رسالة لكل عائلة: إن لم يصلها المال علمت أن النظام عدّها مستلِمة.
    for (const i of paid.due) {
      const body = `السلام عليكم {الاسم}. حُوّلت مستحقاتكم (${i.amount.toLocaleString('en-US')} دينار) ${paid.method === 'WALLET' ? 'إلى محفظتكم' : 'بحوالة'} عبر ${paid.provider}، مرجعها ${reference}. إن لم تصلكم فراجعوا المركز. رقم العائلة: {رقم_العائلة}`;
      await this.notifications.system('DELIVERY_CONFIRMATION', 'تأكيد التحويل', body, {}, i.family_id);
    }
    return this.get(id);
  }

  async reject(id: string, note: string, actor: AuthUser) {
    await this.db.tx(async (c) => {
      const b = (await c.query('select * from payout_batches where id = $1 for update', [id])).rows[0];
      if (!b) throw new NotFoundException('كشف الدفع غير موجود');
      if (b.status !== 'PENDING_APPROVAL') throw new ConflictException('فُصل في هذا الكشف من قبل');
      await c.query("update payout_batches set status = 'REJECTED', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1", [id, actor.id, note]);
      // تتحرر الاستحقاقات: تُصرف نقداً أو تدخل كشفاً آخر.
      await c.query('update payout_items set active = false, paid = false, skip_reason = $2 where batch_id = $1', [id, 'رُفض الكشف']);
      await this.audit.append(c, { actorId: actor.id, action: 'payout.reject', entity: 'payout', entityId: id, payload: { no: b.no, note } });
    });
    return this.get(id);
  }
}

const SELECT = `
  select b.*, cu.username as created_by_username, du.username as decided_by_username
  from payout_batches b join users cu on cu.id = b.created_by left join users du on du.id = b.decided_by`;

function present(r: any) {
  return {
    id: r.id as string, no: r.no as number, campaignId: r.campaign_id as string, method: r.method as 'TRANSFER' | 'WALLET', provider: r.provider as string, status: r.status as string,
    total: Number(r.total), items: r.items as number, paidTotal: r.paid_total === null ? null : Number(r.paid_total), paidItems: r.paid_items as number | null,
    reference: r.reference as string | null, note: r.note as string | null, createdBy: r.created_by_username as string, createdAt: r.created_at,
    decidedBy: r.decided_by_username as string | null, decidedAt: r.decided_at, decisionNote: r.decision_note as string | null,
  };
}
