import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { AccountingService } from '../accounting/accounting.service';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { normalizeName, toAsciiDigits } from '../common/arabic';
import { Db } from '../db/db.module';
import { phone } from '../families/families.schema';
import { INSPECTION_LATE_DAYS } from '../inspections/inspections.service';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationsService } from '../notifications/notifications.service';

/** صندوق لم يُفتح منذ أكثر من هذا العدد من الأيام يُنبَّه عليه. */
export const BOX_STALE_DAYS = 30;
/** فتحٌ وُجد فيه دون هذه النسبة من المعتاد يُعلَّم للمراجعة. */
export const BOX_LOW_RATIO = 0.5;
/** لا يُقاس الفتح بمعدَّل قبل هذا العدد من الفتحات السابقة. */
export const BOX_MIN_HISTORY = 3;
/** ذمة نقدية لم يُسلَّم منها شيء منذ أكثر من هذا العدد من الأيام تُعلَّم. */
export const CUSTODY_STALE_DAYS = 7;

const money = z.number().int().max(1_000_000_000);
const short = (max: number) => z.string().trim().min(1).max(max);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const boxSchema = z.object({
  code: short(20).optional(),
  location: z.string().trim().min(2, 'اكتب موقع الصندوق').max(120),
  address: short(200).optional(),
  hostName: short(120).optional(),
  hostPhone: phone.optional(),
  fundId: z.string().uuid(),
  agentId: z.string().uuid().nullable().optional(),
  installedOn: day.optional(),
  note: short(300).optional(),
});
export const boxPatchSchema = z.object({
  location: z.string().trim().min(2).max(120).optional(),
  address: short(200).nullable().optional(),
  hostName: short(120).nullable().optional(),
  hostPhone: phone.nullable().optional(),
  fundId: z.string().uuid().optional(),
  agentId: z.string().uuid().nullable().optional(),
  note: short(300).nullable().optional(),
  status: z.enum(['ACTIVE', 'RETIRED']).optional(),
  retireNote: short(300).optional(),
});
export const collectionSchema = z.object({
  amount: money.min(0),
  collectedAt: z.string().datetime().optional(),
  /** للمحاسب: من فتح الصندوق وحمل ما فيه. */
  collectedBy: z.string().uuid().optional(),
  /** للمحاسب: فُتح في المركز أمامه فدخل النقد مباشرة. */
  direct: z.boolean().optional(),
  sealNo: short(40).optional(),
  note: short(300).optional(),
  clientOpId: z.string().uuid().optional(),
});
const donationBase = {
  donorName: z.string().trim().min(2, 'اكتب اسم المتبرع').max(120),
  donorPhone: phone.optional(),
  purpose: short(200).optional(),
  note: short(300).optional(),
  reportedAt: z.string().datetime().optional(),
  clientOpId: z.string().uuid().optional(),
};
export const donationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('CASH'), amount: money.min(1), fundId: z.string().uuid().optional(), ...donationBase }),
  z.object({ kind: z.literal('IN_KIND'), itemText: z.string().trim().min(2, 'اكتب ما تبرّع به').max(160), quantity: z.number().int().min(1).max(1_000_000), unit: short(20).optional(), ...donationBase }),
]);
export const receiveDonationSchema = z.object({
  itemId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  quantity: z.number().int().min(1).max(1_000_000),
  expiry: day.optional(),
  note: short(300).optional(),
});
export const cancelDonationSchema = z.object({ note: z.string().trim().min(3, 'يلزم ذكر السبب').max(300) });
export const listDonationsSchema = z.object({
  kind: z.enum(['CASH', 'IN_KIND']).optional(),
  status: z.enum(['REPORTED', 'RECEIVED', 'CANCELLED']).optional(),
  agentId: z.string().uuid().optional(),
});
export const ackSchema = z.object({ ok: z.boolean(), note: short(300).optional() }).refine((v) => v.ok || !!v.note, 'اكتب ما وجدتَه من فرق');
export const familyRequestSchema = z.object({
  familyNo: z.string().trim().min(2).max(20),
  reason: z.string().trim().min(5, 'اكتب ما تغيّر في حال العائلة').max(500),
});
export type BoxInput = z.infer<typeof boxSchema>;
export type BoxPatch = z.infer<typeof boxPatchSchema>;
export type CollectionInput = z.infer<typeof collectionSchema>;
export type DonationInput = z.infer<typeof donationSchema>;

const fmt = (n: number) => n.toLocaleString('en-US');
const DAY = 86_400_000;
const ANONYMOUS = normalizeName('فاعل خير');

/** ما يُكتب في سجل نشاط المتعهد عن كل فعل. ما ليس هنا يُعرض باسمه. */
const ACTIVITY: Record<string, (p: any) => string> = {
  'auth.login': () => 'دخل إلى النظام',
  'device.register': (p) => `سجّل جهازاً${p.label ? `: ${p.label}` : ''}`,
  'delivery.redeem': (p) => `سلّم عائلة${p.familyNo ? ` ${p.familyNo}` : ''}`,
  'delivery.sync': (p) => `رفع تسليماً جرى دون اتصال${p.familyNo ? ` للعائلة ${p.familyNo}` : ''}`,
  'delivery.double': (p) => `تسليم مكرَّر كُشف عند الرفع${p.familyNo ? ` للعائلة ${p.familyNo}` : ''}`,
  'grant.case': (p) => `صرف حالة بتخويل، طلب تسجيل ${p.quickNo ?? ''}`,
  'quick.create': (p) => `رفع طلب إضافة عائلة رقم ${p.no ?? ''}`,
  'reassessment.open': (p) => `طلب تعديل بيانات عائلة${p.familyNo ? ` ${p.familyNo}` : ''}`,
  'inspection.report': (p) => `رفع كشف العائلة ${p.familyNo ?? ''}: ${({ CONFIRM: 'مطابقة', RAISE: 'يوصي برفع النقاط', LOWER: 'يوصي بخفض النقاط', REMOVE: 'يطلب شطبها', UNABLE: 'تعذّر الكشف' } as Record<string, string>)[p.recommendation] ?? ''}${p.mismatches ? `، وفيها ${p.mismatches} بند غير مطابق` : ''}`,
  'box.collect': (p) => `فتح الصندوق ${p.code ?? ''} وعدّ فيه ${fmt(Number(p.amount ?? 0))}`,
  'donation.report': (p) => (p.kind === 'CASH' ? `سجّل تبرعاً نقدياً ${fmt(Number(p.amount ?? 0))} من ${p.donor ?? ''}` : `بلّغ بتبرع عيني من ${p.donor ?? ''}: ${p.quantity ?? ''} ${p.item ?? ''}`),
  'custody.receive': (p) => `سلّم المحاسبَ ${fmt(Number(p.amount ?? 0))} من ذمته، وبقي فيها ${fmt(Number(p.remaining ?? 0))}`,
  'custody.close': (p) => `أُقفلت ذمته بالعدّ: الدفتر ${fmt(Number(p.book ?? 0))} والمعدود ${fmt(Number(p.counted ?? 0))}`,
  'custody.issue': (p) => `تسلّم عهدة نقدية ${fmt(Number(p.amount ?? 0))}`,
  'goods.ack': (p) => (p.ok ? `أكّد استلام ${p.quantity ?? ''} ${p.item ?? ''}` : `بلّغ عن فرق في ${p.item ?? 'مواد حُوّلت إليه'}`),
};

/**
 * المتعهدون وصناديق التبرعات.
 * المتعهد يد المركز في الميدان: يوزّع، ويحصّل الصناديق، ويتسلّم التبرعات، ويرفع الطلبات.
 * وكل ما دخل يده مالاً قُيّد في ذمته ساعةَ دخوله، فلا يخرج من الذمة إلا بتسليم يشهد به المحاسب.
 */
@Injectable()
export class AgentsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccountingService) private readonly accounting: AccountingService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  // ---------- صناديق التبرعات ----------

  private async activeAgent(c: { query: PoolClient['query'] }, id: string) {
    const u = (await c.query("select full_name from users where id = $1 and active and role = 'DISTRIBUTION_AGENT'", [id])).rows[0];
    if (!u) throw new BadRequestException('ليس متعهداً عاملاً');
    return u.full_name as string;
  }

  private presentBox(r: any, now = Date.now()) {
    const since = r.last_at ? new Date(r.last_at).getTime() : new Date(r.installed_on).getTime();
    const daysSince = Math.max(0, Math.floor((now - since) / DAY));
    // معدَّل الصندوق في اليوم: كل ما جُمع منه مقسوماً على عمره حتى آخر فتح.
    const life = r.last_at ? Math.max(1, (new Date(r.last_at).getTime() - new Date(r.installed_on).getTime()) / DAY) : 0;
    const dailyRate = r.n >= BOX_MIN_HISTORY && life ? Number(r.total) / life : null;
    return {
      id: r.id as string, code: r.code as string, location: r.location as string, address: r.address as string | null,
      hostName: r.host_name as string | null, hostPhone: r.host_phone as string | null,
      fundId: r.fund_id as string, fund: r.fund as string, agentId: r.agent_id as string | null, agentName: r.agent_name as string | null,
      status: r.status as 'ACTIVE' | 'RETIRED', installedOn: r.installed_on, note: r.note as string | null, retiredAt: r.retired_at, retireNote: r.retire_note as string | null,
      openings: r.n as number, total: Number(r.total), average: r.n ? Math.round(Number(r.total) / r.n) : 0,
      lastOpenedAt: r.last_at, lastAmount: r.last_amount === null || r.last_amount === undefined ? null : Number(r.last_amount), lastBy: r.last_by as string | null,
      daysSince, stale: r.status === 'ACTIVE' && daysSince > BOX_STALE_DAYS,
      expectedNow: dailyRate === null ? null : Math.round(dailyRate * Math.max(1, daysSince)),
    };
  }

  private static BOX_SQL = `
    select b.*, f.name as fund, u.full_name as agent_name, s.n, s.total, s.last_at, l.amount as last_amount, l.by as last_by
    from donation_boxes b join funds f on f.id = b.fund_id left join users u on u.id = b.agent_id
      left join lateral (select count(*)::int as n, coalesce(sum(amount), 0)::bigint as total, max(collected_at) as last_at from box_collections where box_id = b.id) s on true
      left join lateral (select c.amount, cu.full_name as by from box_collections c join users cu on cu.id = c.collected_by where c.box_id = b.id order by c.collected_at desc limit 1) l on true`;

  async boxes(filter: { agentId?: string; activeOnly?: boolean } = {}) {
    const { rows } = await this.db.query(
      `${AgentsService.BOX_SQL} where ($1::uuid is null or b.agent_id = $1) and (not $2 or b.status = 'ACTIVE') order by (b.status = 'RETIRED'), s.last_at nulls first, b.code`,
      [filter.agentId ?? null, !!filter.activeOnly]);
    return rows.map((r) => this.presentBox(r));
  }

  async boxSummary() {
    const boxes = await this.boxes();
    const active = boxes.filter((b) => b.status === 'ACTIVE');
    const month = await this.db.query(
      `select coalesce(sum(amount), 0)::bigint as total, count(*)::int as n from box_collections where collected_at >= date_trunc('month', now())`);
    const monthly = await this.db.query(
      `select to_char(m, 'YYYY-MM') as month, coalesce(sum(c.amount), 0)::bigint as total, count(c.id)::int as n
       from generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') m
         left join box_collections c on date_trunc('month', c.collected_at) = m group by m order by m`);
    return {
      active: active.length, retired: boxes.length - active.length, stale: active.filter((b) => b.stale).length, neverOpened: active.filter((b) => !b.openings).length,
      unassigned: active.filter((b) => !b.agentId).length,
      collectedThisMonth: Number(month.rows[0].total), openingsThisMonth: month.rows[0].n as number,
      totalCollected: boxes.reduce((s, b) => s + b.total, 0),
      monthly: monthly.rows.map((r) => ({ month: r.month as string, total: Number(r.total), openings: r.n as number })),
      staleDays: BOX_STALE_DAYS,
    };
  }

  async box(id: string) {
    const r = (await this.db.query(`${AgentsService.BOX_SQL} where b.id = $1`, [id])).rows[0];
    if (!r) throw new NotFoundException('الصندوق غير موجود');
    return { ...this.presentBox(r), collections: await this.collections({ boxId: id }) };
  }

  async collections(filter: { boxId?: string; agentId?: string; limit?: number }) {
    const { rows } = await this.db.query(
      `select c.id, c.box_id, b.code, b.location, c.amount, c.collected_at, c.seal_no, c.note, c.direct, c.expected, cu.full_name as collector, ru.username as recorder,
              e.id as entry_id, e.no as entry_no, coalesce(ef.name, f.name) as fund
       from box_collections c join donation_boxes b on b.id = c.box_id join funds f on f.id = b.fund_id
         join users cu on cu.id = c.collected_by join users ru on ru.id = c.recorded_by left join ledger_entries e on e.id = c.entry_id
         left join funds ef on ef.id = e.fund_id
       where ($1::uuid is null or c.box_id = $1) and ($2::uuid is null or c.collected_by = $2) order by c.collected_at desc limit $3`,
      [filter.boxId ?? null, filter.agentId ?? null, filter.limit ?? 200]);
    return rows.map((r) => ({
      id: r.id as string, boxId: r.box_id as string, code: r.code as string, location: r.location as string, amount: Number(r.amount), collectedAt: r.collected_at,
      sealNo: r.seal_no as string | null, note: r.note as string | null, direct: r.direct as boolean, collector: r.collector as string, recorder: r.recorder as string,
      expected: r.expected === null ? null : Number(r.expected), low: r.expected !== null && Number(r.amount) < Number(r.expected) * BOX_LOW_RATIO,
      entryId: r.entry_id as string | null, entryNo: r.entry_no as string | null, fund: r.fund as string,
    }));
  }

  async createBox(input: BoxInput, actor: AuthUser) {
    try {
      const id = await this.db.tx(async (c) => {
        if (!(await c.query('select 1 from funds where id = $1 and active', [input.fundId])).rowCount) throw new BadRequestException('الصندوق المحاسبي غير موجود');
        if (input.agentId) await this.activeAgent(c, input.agentId);
        const code = input.code ?? String((await c.query("select nextval('donation_box_seq') as n")).rows[0].n);
        const { rows } = await c.query(
          `insert into donation_boxes (code, location, address, host_name, host_phone, fund_id, agent_id, installed_on, note, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,coalesce($8::date, current_date),$9,$10) returning id`,
          [toAsciiDigits(code), input.location, input.address ?? null, input.hostName ?? null, input.hostPhone ?? null, input.fundId, input.agentId ?? null, input.installedOn ?? null, input.note ?? null, actor.id]);
        await this.audit.append(c, { actorId: actor.id, action: 'box.create', entity: 'donation_box', entityId: rows[0].id, payload: { code, location: input.location, agentId: input.agentId ?? null } });
        return rows[0].id as string;
      });
      return this.box(id);
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException('صندوق بهذا الرقم موجود');
      throw err;
    }
  }

  async updateBox(id: string, patch: BoxPatch, actor: AuthUser) {
    await this.db.tx(async (c) => {
      const b = (await c.query('select * from donation_boxes where id = $1 for update', [id])).rows[0];
      if (!b) throw new NotFoundException('الصندوق غير موجود');
      if (patch.agentId) await this.activeAgent(c, patch.agentId);
      if (patch.fundId && !(await c.query('select 1 from funds where id = $1 and active', [patch.fundId])).rowCount) throw new BadRequestException('الصندوق المحاسبي غير موجود');
      if (patch.status === 'RETIRED' && b.status === 'ACTIVE' && !patch.retireNote) throw new BadRequestException('اذكر سبب رفع الصندوق من موقعه');
      const pick = <K extends keyof BoxPatch>(k: K, col: string) => (patch[k] === undefined ? b[col] : patch[k]);
      const status = patch.status ?? b.status;
      await c.query(
        `update donation_boxes set location = $2, address = $3, host_name = $4, host_phone = $5, fund_id = $6, agent_id = $7, note = $8, status = $9::box_status,
                retired_at = case when $9::box_status = 'RETIRED' then coalesce(retired_at, now()) else null end, retire_note = case when $9::box_status = 'RETIRED' then coalesce($10, retire_note) else null end
         where id = $1`,
        [id, pick('location', 'location'), pick('address', 'address'), pick('hostName', 'host_name'), pick('hostPhone', 'host_phone'), pick('fundId', 'fund_id'), pick('agentId', 'agent_id'), pick('note', 'note'), status, patch.retireNote ?? null]);
      await this.audit.append(c, { actorId: actor.id, action: status !== b.status ? (status === 'RETIRED' ? 'box.retire' : 'box.restore') : 'box.update', entity: 'donation_box', entityId: id, payload: { code: b.code, ...patch } });
    });
    return this.box(id);
  }

  /**
   * فتح صندوق. ما عُدّ فيه إيراد يدخل ذمة من حمله، أو نقد الصندوق إن فُتح في المركز.
   * ويُسجَّل الفتح ولو وُجد فارغاً: به يُعرف متى فُتح آخر مرة.
   * ورسالة إلى صاحب الموقع بالمبلغ: هو شاهد العدّ من خارج المركز.
   */
  async collect(boxId: string, input: CollectionInput, actor: AuthUser) {
    if (input.clientOpId) {
      const prior = (await this.db.query('select id from box_collections where client_op_id = $1', [input.clientOpId])).rows[0];
      if (prior) return this.collection(prior.id);
    }
    const at = input.collectedAt ? new Date(input.collectedAt) : new Date();
    if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('وقت الفتح في المستقبل');
    const books = actor.role === 'ADMIN' || actor.role === 'ACCOUNTANT';
    if (!books && (input.collectedBy || input.direct)) throw new ForbiddenException('المحاسب وحده يسجّل تحصيل غيره');
    if (books && !input.direct && !input.collectedBy) throw new BadRequestException('اختر من فتح الصندوق، أو علّم أنه فُتح في المركز');

    const done = await this.db.tx(async (c) => {
      const b = (await c.query('select b.*, f.name as fund from donation_boxes b join funds f on f.id = b.fund_id where b.id = $1 for update of b', [boxId])).rows[0];
      if (!b) throw new NotFoundException('الصندوق غير موجود');
      if (b.status !== 'ACTIVE') throw new ConflictException('هذا الصندوق رُفع من موقعه');
      if (!books && b.agent_id !== actor.id) throw new ForbiddenException('هذا الصندوق ليس في عهدتك');
      const holderId = input.direct ? null : books ? input.collectedBy! : actor.id;
      const collector = holderId ? (await c.query('select full_name from users where id = $1 and active', [holderId])).rows[0] : { full_name: actor.fullName };
      if (!collector) throw new BadRequestException('الموظف غير موجود');

      // المعتاد: معدَّل الصندوق في اليوم مضروباً في الأيام منذ آخر فتح.
      const prior = (await c.query('select count(*)::int as n, coalesce(sum(amount), 0)::bigint as total, max(collected_at) as last_at from box_collections where box_id = $1 and collected_at < $2', [boxId, at])).rows[0];
      let expected: number | null = null;
      if (prior.n >= BOX_MIN_HISTORY) {
        const life = Math.max(1, (new Date(prior.last_at).getTime() - new Date(b.installed_on).getTime()) / DAY);
        expected = Math.round((Number(prior.total) / life) * Math.max(1, (at.getTime() - new Date(prior.last_at).getTime()) / DAY));
      }
      const entry = input.amount > 0
        ? await this.accounting.collect(c, {
            fundId: b.fund_id, amount: input.amount, holderId, category: 'BOX', party: `صندوق ${b.code} — ${b.location}`,
            description: `تحصيل صندوق التبرعات ${b.code} (${b.location}) بيد ${collector.full_name}`, actorId: actor.id,
          })
        : null;
      const { rows } = await c.query(
        `insert into box_collections (box_id, amount, collected_at, collected_by, recorded_by, entry_id, seal_no, note, direct, expected, client_op_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [boxId, input.amount, at, holderId ?? actor.id, actor.id, entry?.id ?? null, input.sealNo ?? null, input.note ?? null, !!input.direct, expected, input.clientOpId ?? null]);
      await this.audit.append(c, {
        actorId: actor.id, action: 'box.collect', entity: 'donation_box', entityId: boxId,
        payload: { code: b.code, amount: input.amount, entry: entry?.no ?? null, expected, direct: !!input.direct, collectorId: holderId, sealNo: input.sealNo ?? null },
      });
      return { id: rows[0].id as string, box: b, collector: collector.full_name as string };
    });
    if (done.box.host_phone) {
      await this.notifications.direct('إشعار فتح صندوق تبرعات',
        `السلام عليكم${done.box.host_name ? ` ${done.box.host_name}` : ''}. فُتح صندوق التبرعات رقم ${done.box.code} عندكم وعُدّ فيه ${fmt(input.amount)} دينار بيد ${done.collector}. جزاكم الله خيراً. إن خالف هذا ما رأيتم فأبلغوا المركز.`,
        done.box.host_phone, { boxCollectionId: done.id });
    }
    return this.collection(done.id);
  }

  private async collection(id: string) {
    const { rows } = await this.db.query(
      `select c.id, c.box_id, b.code, b.location, c.amount, c.collected_at, c.expected, c.direct, e.no as entry_no, e.id as entry_id from box_collections c join donation_boxes b on b.id = c.box_id left join ledger_entries e on e.id = c.entry_id where c.id = $1`, [id]);
    const r = rows[0];
    return {
      id: r.id as string, boxId: r.box_id as string, code: r.code as string, location: r.location as string, amount: Number(r.amount), collectedAt: r.collected_at, direct: r.direct as boolean,
      expected: r.expected === null ? null : Number(r.expected), low: r.expected !== null && Number(r.amount) < Number(r.expected) * BOX_LOW_RATIO, entryNo: r.entry_no as string | null, entryId: r.entry_id as string | null,
    };
  }

  // ---------- التبرعات بيد المتعهد ----------

  /** يربط التبرع بسجل المتبرع: بالهاتف أولاً ثم بالاسم، وينشئه إن لم يكن. «فاعل خير» لا سجل له. */
  private async donorFor(c: PoolClient, name: string, phoneNo: string | null): Promise<string | null> {
    if (normalizeName(name) === ANONYMOUS) return null;
    if (phoneNo) {
      const byPhone = (await c.query('select id from donors where phone = $1 order by name limit 1', [phoneNo])).rows[0];
      if (byPhone) return byPhone.id;
    }
    const { rows } = await c.query(
      'insert into donors (name, phone) values ($1, $2) on conflict (name) do update set phone = coalesce(donors.phone, excluded.phone) returning id', [name, phoneNo]);
    return rows[0].id;
  }

  private async defaultFund(c: PoolClient): Promise<string> {
    const f = (await c.query('select id from funds where active and program_id is null order by created_at limit 1')).rows[0];
    if (!f) throw new ConflictException('لا صندوق عام تُقيَّد فيه التبرعات. ينشئه المحاسب أولاً.');
    return f.id;
  }

  /** الصناديق المحاسبية التي يختار المتعهد منها وجهة التبرع النقدي. */
  async funds() {
    const { rows } = await this.db.query('select f.id, f.name, p.name as program from funds f left join programs p on p.id = f.program_id where f.active order by (f.program_id is not null), f.created_at');
    return rows.map((r) => ({ id: r.id as string, name: r.name as string, program: r.program as string | null }));
  }

  /**
   * تبرع تسلّمه المتعهد. النقدي يدخل ذمته بسند قبض في حينه؛ والعيني بلاغ ينتظر أمين المخزن.
   * ورسالة إلى المتبرع بما سُجّل باسمه: إن سُجّل أقل مما أعطى علم.
   */
  async donate(input: DonationInput, actor: AuthUser) {
    if (input.clientOpId) {
      const prior = (await this.db.query('select id from agent_donations where client_op_id = $1', [input.clientOpId])).rows[0];
      if (prior) return this.donation(prior.id);
    }
    const at = input.reportedAt ? new Date(input.reportedAt) : new Date();
    if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('وقت التبرع في المستقبل');
    const done = await this.db.tx(async (c) => {
      const donorId = await this.donorFor(c, input.donorName, input.donorPhone ?? null);
      const no = (await c.query("select nextval('agent_donation_seq') as n")).rows[0].n as number;
      let entry: { id: string; no: string } | null = null;
      let fundId: string | null = null;
      if (input.kind === 'CASH') {
        fundId = input.fundId ?? await this.defaultFund(c);
        if (!(await c.query('select 1 from funds where id = $1 and active', [fundId])).rowCount) throw new BadRequestException('الصندوق غير موجود');
        entry = await this.accounting.collect(c, {
          fundId, amount: input.amount, holderId: actor.id, category: 'AGENT_DONATION', party: input.donorName, donorId,
          description: `تبرع نقدي بيد المتعهد ${actor.fullName}${input.purpose ? ` — ${input.purpose}` : ''}`, actorId: actor.id,
        });
      }
      const { rows } = await c.query(
        `insert into agent_donations (no, kind, agent_id, donor_name, donor_phone, donor_id, purpose, note, fund_id, amount, entry_id, item_text, quantity, unit, status, reported_at, client_op_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
        [no, input.kind, actor.id, input.donorName, input.donorPhone ?? null, donorId, input.purpose ?? null, input.note ?? null, fundId,
         input.kind === 'CASH' ? input.amount : null, entry?.id ?? null, input.kind === 'IN_KIND' ? input.itemText : null, input.kind === 'IN_KIND' ? input.quantity : null,
         input.kind === 'IN_KIND' ? input.unit ?? null : null, input.kind === 'CASH' ? 'RECEIVED' : 'REPORTED', at, input.clientOpId ?? null]);
      await this.audit.append(c, {
        actorId: actor.id, action: 'donation.report', entity: 'agent_donation', entityId: rows[0].id,
        payload: input.kind === 'CASH' ? { no, kind: 'CASH', donor: input.donorName, amount: input.amount, entry: entry!.no } : { no, kind: 'IN_KIND', donor: input.donorName, item: input.itemText, quantity: input.quantity },
      });
      return { id: rows[0].id as string, no, entryNo: entry?.no ?? null };
    });
    if (input.donorPhone) {
      const what = input.kind === 'CASH'
        ? `تبرعاً نقدياً قدره ${fmt(input.amount)} دينار، سند قبض ${done.entryNo}`
        : `تبرعاً عينياً: ${input.quantity} ${input.unit ?? ''} ${input.itemText}، بلاغ رقم ${done.no}`.replace(/\s+/g, ' ');
      await this.notifications.direct('شكر متبرع',
        `جزاكم الله خيراً ${input.donorName}. تسلّم المركز منكم ${what}، بيد متعهده ${actor.fullName}. إن خالف هذا ما قدّمتم فأبلغوا المركز.`,
        input.donorPhone, { agentDonationId: done.id });
    }
    return this.donation(done.id);
  }

  private static DONATION_SQL = `
    select d.*, u.full_name as agent_name, f.name as fund, e.no as entry_no, ru.username as received_by_username, i.name as item_name, w.name as warehouse,
           exists (select 1 from ledger_entries r where r.reverses = d.entry_id and r.status = 'POSTED') as reversed
    from agent_donations d join users u on u.id = d.agent_id left join funds f on f.id = d.fund_id left join ledger_entries e on e.id = d.entry_id
      left join users ru on ru.id = d.received_by left join stock_moves m on m.id = d.stock_move_id left join items i on i.id = m.item_id left join warehouses w on w.id = m.to_wh`;

  private presentDonation(r: any) {
    return {
      id: r.id as string, no: r.no as number, kind: r.kind as 'CASH' | 'IN_KIND', agentId: r.agent_id as string, agentName: r.agent_name as string,
      donorName: r.donor_name as string, donorPhone: r.donor_phone as string | null, donorId: r.donor_id as string | null, purpose: r.purpose as string | null, note: r.note as string | null,
      // النقدي المعكوس قيده كأنه لم يكن.
      status: (r.reversed ? 'CANCELLED' : r.status) as 'REPORTED' | 'RECEIVED' | 'CANCELLED', reportedAt: r.reported_at,
      amount: r.amount === null ? null : Number(r.amount), fundId: r.fund_id as string | null, fund: r.fund as string | null, entryId: r.entry_id as string | null, entryNo: r.entry_no as string | null,
      itemText: r.item_text as string | null, quantity: r.quantity as number | null, unit: r.unit as string | null,
      receivedQuantity: r.received_quantity as number | null, receivedItem: r.item_name as string | null, warehouse: r.warehouse as string | null,
      receivedBy: r.received_by_username as string | null, receivedAt: r.received_at, closeNote: r.close_note as string | null,
    };
  }

  private async donation(id: string) {
    const r = (await this.db.query(`${AgentsService.DONATION_SQL} where d.id = $1`, [id])).rows[0];
    if (!r) throw new NotFoundException('التبرع غير موجود');
    return this.presentDonation(r);
  }

  async donations(filter: z.infer<typeof listDonationsSchema> & { limit?: number } = {}) {
    const { rows } = await this.db.query(
      `${AgentsService.DONATION_SQL} where ($1::donation_kind is null or d.kind = $1) and ($2::donation_status is null or d.status = $2) and ($3::uuid is null or d.agent_id = $3)
       order by d.reported_at desc limit $4`, [filter.kind ?? null, filter.status ?? null, filter.agentId ?? null, filter.limit ?? 300]);
    return rows.map((r) => this.presentDonation(r));
  }

  /** أمين المخزن يستلم التبرع العيني: يدخل المخزن وارداً باسم المتبرع، بالكمية التي وجدها. */
  async receiveDonation(id: string, input: z.infer<typeof receiveDonationSchema>, actor: AuthUser) {
    await this.db.tx(async (c) => {
      const d = (await c.query('select * from agent_donations where id = $1 for update', [id])).rows[0];
      if (!d) throw new NotFoundException('التبرع غير موجود');
      if (d.kind !== 'IN_KIND') throw new ConflictException('التبرع النقدي يُستلم من ذمة المتعهد');
      if (d.status !== 'REPORTED') throw new ConflictException('فُصل في هذا البلاغ من قبل');
      if (d.agent_id === actor.id) throw new ForbiddenException('لا يستلم التبرع من بلّغ به');
      if (input.quantity !== d.quantity && !input.note) throw new BadRequestException(`المبلَّغ ${d.quantity} والمستلَم ${input.quantity}: اكتب سبب الفرق`);
      const move = await this.inventory.moveIn(c, {
        kind: 'RECEIPT', itemId: input.itemId, toWarehouseId: input.warehouseId, quantity: input.quantity, expiry: input.expiry,
        donorId: d.donor_id ?? undefined, source: d.donor_name, note: `تبرع عيني رقم ${d.no} بيد متعهد${input.note ? `: ${input.note}` : ''}`,
      } as never, actor);
      await c.query("update agent_donations set status = 'RECEIVED', stock_move_id = $2, received_quantity = $3, received_by = $4, received_at = now(), close_note = $5 where id = $1",
        [id, move.id, input.quantity, actor.id, input.note ?? null]);
      await this.audit.append(c, { actorId: actor.id, action: 'donation.receive', entity: 'agent_donation', entityId: id, payload: { no: d.no, reported: d.quantity, received: input.quantity, note: input.note ?? null } });
    }).catch((err) => {
      if (err.code === '23503') throw new BadRequestException('الصنف أو المخزن غير موجود');
      throw err;
    });
    return this.donation(id);
  }

  /** بلاغ عيني لم يصل أو سُجّل خطأً. النقدي لا يُلغى هنا: يُعكس سنده في المحاسبة. */
  async cancelDonation(id: string, note: string, actor: AuthUser) {
    await this.db.tx(async (c) => {
      const d = (await c.query('select * from agent_donations where id = $1 for update', [id])).rows[0];
      if (!d) throw new NotFoundException('التبرع غير موجود');
      if (d.kind !== 'IN_KIND') throw new ConflictException('التبرع النقدي لا يُلغى: يُعكس سند قبضه في المحاسبة');
      if (d.status !== 'REPORTED') throw new ConflictException('فُصل في هذا البلاغ من قبل');
      await c.query("update agent_donations set status = 'CANCELLED', close_note = $2, received_at = now() where id = $1", [id, note]);
      await this.audit.append(c, { actorId: actor.id, action: 'donation.cancel', entity: 'agent_donation', entityId: id, payload: { no: d.no, note } });
    });
    return this.donation(id);
  }

  // ---------- الذمة العينية ----------

  /** ما في مخزن المتعهد من مواد، وما حُوّل إليه وينتظر تأكيده. */
  async goods(agentId: string) {
    const wh = (await this.db.query('select w.id, w.name from warehouses w join distribution_points p on p.id = w.point_id where p.agent_id = $1', [agentId])).rows[0];
    if (!wh) return { warehouseId: null, balances: [], transfers: [] };
    const balances = await this.db.query(
      'select i.id, i.name, i.unit, b.quantity from stock_balances b join items i on i.id = b.item_id where b.warehouse_id = $1 and b.quantity <> 0 order by i.name', [wh.id]);
    const transfers = await this.db.query(
      `select m.id, m.kind, m.quantity, m.created_at, m.note, i.name as item, i.unit, fw.name as from_wh, tw.name as to_wh, (m.to_wh = $1) as inbound, u.username as by, c.name as campaign,
              a.ok, a.note as ack_note, a.at as ack_at
       from stock_moves m join items i on i.id = m.item_id left join warehouses fw on fw.id = m.from_wh left join warehouses tw on tw.id = m.to_wh
         join users u on u.id = m.created_by left join campaigns c on c.id = m.campaign_id left join custody_acks a on a.stock_move_id = m.id
       where m.status = 'POSTED' and m.kind in ('TRANSFER', 'RETURN', 'RECEIPT') and (m.to_wh = $1 or m.from_wh = $1) order by m.created_at desc limit 60`, [wh.id]);
    return {
      warehouseId: wh.id as string,
      balances: balances.rows.map((r) => ({ itemId: r.id as string, item: r.name as string, unit: r.unit as string, quantity: r.quantity as number })),
      transfers: transfers.rows.map((r) => ({
        id: r.id as string, kind: r.kind as string, inbound: r.inbound as boolean, item: r.item as string, unit: r.unit as string, quantity: r.quantity as number, at: r.created_at,
        from: r.from_wh as string | null, to: r.to_wh as string | null, by: r.by as string, campaign: r.campaign as string | null, note: r.note as string | null,
        // التأكيد لما حُوّل إليه من مخزن آخر؛ ما استلمه أمين المخزن في مخزنه تبرعاً لا يحتاجه.
        needsAck: r.inbound && r.kind === 'TRANSFER' && r.ok === null, ack: r.ok === null ? null : { ok: r.ok as boolean, note: r.ack_note as string | null, at: r.ack_at },
      })),
    };
  }

  /** المتعهد يشهد باستلام ما حُوّل إليه، أو يبلّغ عن فرق. شهادته لا تغيّر الرصيد: الفرق يسوّيه الجرد. */
  async ackGoods(moveId: string, input: z.infer<typeof ackSchema>, actor: AuthUser) {
    await this.db.tx(async (c) => {
      const m = (await c.query(
        `select m.id, m.quantity, i.name as item from stock_moves m join items i on i.id = m.item_id join warehouses w on w.id = m.to_wh join distribution_points p on p.id = w.point_id
         where m.id = $1 and m.kind = 'TRANSFER' and m.status = 'POSTED' and p.agent_id = $2`, [moveId, actor.id])).rows[0];
      if (!m) throw new NotFoundException('لا تحويل بهذا الرقم إلى مخزنك');
      const done = await c.query('insert into custody_acks (stock_move_id, agent_id, ok, note) values ($1,$2,$3,$4) on conflict (stock_move_id) do nothing', [moveId, actor.id, input.ok, input.note ?? null]);
      if (done.rowCount) await this.audit.append(c, { actorId: actor.id, action: 'goods.ack', entity: 'stock_move', entityId: moveId, payload: { ok: input.ok, item: m.item, quantity: m.quantity, note: input.note ?? null } });
    });
    return this.goods(actor.id);
  }

  // ---------- طلبات المتعهد ----------

  /**
   * طلب تعديل بيانات عائلة: المتعهد رأى أن حالها تغيّر، فيفتح لها إعادة تقييم يتولاها المشرف.
   * لا يعدّل هو شيئاً: التعديل بزيارة باحث واعتماد غيره.
   */
  async familyRequest(input: z.infer<typeof familyRequestSchema>, actor: AuthUser) {
    const familyNo = toAsciiDigits(input.familyNo).replace(/\D/g, '');
    const fam = (await this.db.query('select id, status from families where family_no = $1', [familyNo])).rows[0];
    if (!fam) throw new NotFoundException('لا عائلة بهذا الرقم');
    if (fam.status !== 'APPROVED') throw new ConflictException('هذه العائلة ليست معتمدة بعد');
    const open = (await this.db.query("select id from reassessments where family_id = $1 and status in ('OPEN', 'VISITED')", [fam.id])).rows[0];
    if (open) return { id: open.id as string, familyNo, already: true };
    try {
      const id = await this.db.tx(async (c) => {
        const { rows } = await c.query("insert into reassessments (family_id, source, reason, opened_by) values ($1, 'AGENT', $2, $3) returning id", [fam.id, input.reason, actor.id]);
        await this.audit.append(c, { actorId: actor.id, action: 'reassessment.open', entity: 'reassessment', entityId: rows[0].id, payload: { familyId: fam.id, familyNo, source: 'AGENT', reason: input.reason } });
        return rows[0].id as string;
      });
      return { id, familyNo, already: false };
    } catch (err: any) {
      if (err.code === '23505') return { id: null, familyNo, already: true };
      throw err;
    }
  }

  /** ما رفعه المتعهد من طلبات وما آل إليه كلٌّ منها. */
  async requests(agentId: string) {
    const quick = await this.db.query(
      `select q.id, q.no, q.head_name, q.status, q.created_at, q.close_note, f.family_no from quick_requests q left join families f on f.id = q.family_id
       where q.created_by = $1 order by q.created_at desc limit 100`, [agentId]);
    const edits = await this.db.query(
      `select r.id, r.reason, r.status, r.opened_at, r.outcome, r.close_note, f.family_no from reassessments r join families f on f.id = r.family_id
       where r.opened_by = $1 and r.source = 'AGENT' order by r.opened_at desc limit 100`, [agentId]);
    return {
      additions: quick.rows.map((r) => ({ id: r.id as string, no: r.no as number, headName: r.head_name as string, status: r.status as string, at: r.created_at, familyNo: r.family_no as string | null, note: r.close_note as string | null })),
      edits: edits.rows.map((r) => ({ id: r.id as string, familyNo: r.family_no as string, reason: r.reason as string, status: r.status as string, outcome: r.outcome as string | null, at: r.opened_at, note: r.close_note as string | null })),
    };
  }

  // ---------- متابعة المتعهدين ----------

  private static AGENT_SQL = `
    select u.id, u.full_name, u.username, u.phone, u.active, u.created_at, p.id as point_id,
      (select coalesce(sum(l.debit - l.credit), 0) from ledger_lines l join ledger_entries e on e.id = l.entry_id where e.status = 'POSTED' and l.account = 'CUSTODY:' || u.id)::bigint as custody,
      (select max(e.created_at) from ledger_entries e where e.kind = 'CUSTODY_RETURN' and e.status = 'POSTED' and e.custody_user = u.id) as last_handover,
      (select min(e.created_at) from ledger_lines l join ledger_entries e on e.id = l.entry_id where e.status = 'POSTED' and l.account = 'CUSTODY:' || u.id and l.debit > 0) as first_intake,
      (select coalesce(sum(b.quantity), 0) from stock_balances b join warehouses w on w.id = b.warehouse_id where w.point_id = p.id)::int as goods,
      (select count(*) from stock_balances b join warehouses w on w.id = b.warehouse_id where w.point_id = p.id and b.quantity > 0)::int as goods_items,
      (select count(*) from donation_boxes b where b.agent_id = u.id and b.status = 'ACTIVE')::int as boxes,
      (select count(*) from donation_boxes b where b.agent_id = u.id and b.status = 'ACTIVE'
         and coalesce((select max(collected_at) from box_collections c where c.box_id = b.id), b.installed_on) < now() - make_interval(days => ${BOX_STALE_DAYS}))::int as stale_boxes,
      (select count(*) from box_collections c where c.collected_by = u.id and c.collected_at > now() - interval '30 days')::int as collections,
      (select coalesce(sum(c.amount), 0) from box_collections c where c.collected_by = u.id and c.collected_at > now() - interval '30 days')::bigint as collected,
      (select count(*) from agent_donations d where d.agent_id = u.id and d.kind = 'CASH' and d.reported_at > now() - interval '30 days')::int as cash_donations,
      (select coalesce(sum(d.amount), 0) from agent_donations d where d.agent_id = u.id and d.kind = 'CASH' and d.reported_at > now() - interval '30 days')::bigint as cash_donated,
      (select count(*) from agent_donations d where d.agent_id = u.id and d.kind = 'IN_KIND' and d.reported_at > now() - interval '30 days')::int as kind_donations,
      (select count(*) from agent_donations d where d.agent_id = u.id and d.kind = 'IN_KIND' and d.status = 'REPORTED')::int as open_reports,
      (select count(*) from entitlements e where e.delivered_by = u.id and e.delivered_at > now() - interval '30 days')::int as deliveries,
      (select count(*) from entitlements e join campaigns c on c.id = e.campaign_id where c.status = 'ACTIVE' and e.status = 'PENDING'
         and (e.point_id = p.id or exists (select 1 from campaign_point_agents a where a.campaign_id = c.id and a.point_id = e.point_id and a.agent_id = u.id)))::int as pending_deliveries,
      (select count(*) from quick_requests q where q.created_by = u.id and q.created_at > now() - interval '30 days')::int as additions,
      (select count(*) from reassessments r where r.opened_by = u.id and r.source = 'AGENT' and r.opened_at > now() - interval '30 days')::int as edits,
      (select count(*) from stock_moves m join warehouses w on w.id = m.to_wh where w.point_id = p.id and m.kind = 'TRANSFER' and m.status = 'POSTED'
         and not exists (select 1 from custody_acks a where a.stock_move_id = m.id))::int as unacked,
      (select count(*) from custody_acks a where a.agent_id = u.id and not a.ok)::int as disputes,
      (select count(*) from inspection_reports r where r.inspector_id = u.id and r.submitted_at > now() - interval '30 days')::int as inspections,
      (select count(*) from inspection_reports r join inspections i on i.id = r.inspection_id where r.inspector_id = u.id and r.submitted_at is null and i.status = 'ASSIGNED')::int as pending_inspections,
      (select count(*) from inspection_reports r join inspections i on i.id = r.inspection_id where r.inspector_id = u.id and r.submitted_at is null and i.status = 'ASSIGNED'
         and i.requested_at < now() - make_interval(days => ${INSPECTION_LATE_DAYS}))::int as late_inspections,
      (select max(at) from audit_log where actor_id = u.id) as last_activity
    from users u left join distribution_points p on p.agent_id = u.id where u.role = 'DISTRIBUTION_AGENT'`;

  private presentAgent(r: any, now = Date.now()) {
    const custody = Number(r.custody);
    const since = r.last_handover ?? r.first_intake;
    const custodyDays = custody > 0 && since ? Math.floor((now - new Date(since).getTime()) / DAY) : null;
    const alerts: string[] = [];
    if (!r.phone) alerts.push('لا رقم هاتف له');
    if (!r.point_id) alerts.push('لا نقطة توزيع له');
    if (custodyDays !== null && custodyDays > CUSTODY_STALE_DAYS) alerts.push(`في ذمته ${fmt(custody)} منذ ${custodyDays} يوماً دون تسليم`);
    if (custody < 0) alerts.push('ذمته سالبة: سُلّم منه أكثر مما قُيّد عليه');
    if (r.stale_boxes) alerts.push(`${r.stale_boxes} من صناديقه لم يُفتح منذ أكثر من ${BOX_STALE_DAYS} يوماً`);
    if (r.unacked) alerts.push(`${r.unacked} تحويل مخزني لم يؤكد استلامه`);
    if (r.disputes) alerts.push(`${r.disputes} بلاغ فرق في مواد حُوّلت إليه`);
    if (r.open_reports) alerts.push(`${r.open_reports} تبرع عيني بلّغ به ولم يُستلم`);
    if (r.late_inspections) alerts.push(`${r.late_inspections} كشف كُلّف به منذ أكثر من ${INSPECTION_LATE_DAYS} أيام ولم يرفعه`);
    return {
      id: r.id as string, fullName: r.full_name as string, username: r.username as string, phone: r.phone as string | null, active: r.active as boolean, since: r.created_at, pointId: r.point_id as string | null,
      custody, custodyDays, lastHandover: r.last_handover, goods: r.goods as number, goodsItems: r.goods_items as number,
      boxes: r.boxes as number, staleBoxes: r.stale_boxes as number, pendingInspections: r.pending_inspections as number, pendingDeliveries: r.pending_deliveries as number, openReports: r.open_reports as number, unacked: r.unacked as number, disputes: r.disputes as number,
      last30: {
        deliveries: r.deliveries as number, collections: r.collections as number, collected: Number(r.collected), cashDonations: r.cash_donations as number, cashDonated: Number(r.cash_donated),
        inKindDonations: r.kind_donations as number, additions: r.additions as number, edits: r.edits as number, inspections: r.inspections as number,
      },
      lastActivity: r.last_activity, alerts,
    };
  }

  async overview() {
    const { rows } = await this.db.query(`${AgentsService.AGENT_SQL} order by u.active desc, u.full_name`);
    const agents = rows.map((r) => this.presentAgent(r));
    const working = agents.filter((a) => a.active);
    return {
      agents,
      totals: {
        agents: working.length, custody: working.reduce((s, a) => s + a.custody, 0), withAlerts: working.filter((a) => a.alerts.length).length,
        openReports: agents.reduce((s, a) => s + a.openReports, 0), deliveries30: agents.reduce((s, a) => s + a.last30.deliveries, 0),
        collected30: agents.reduce((s, a) => s + a.last30.collected + a.last30.cashDonated, 0),
      },
      limits: { custodyStaleDays: CUSTODY_STALE_DAYS, boxStaleDays: BOX_STALE_DAYS },
    };
  }

  private async timeline(agentId: string, limit: number) {
    // ما فعله هو، وما فُعل في ذمته: تحصيل سجّله المحاسب باسمه، واستلام ذمته وإقفالها.
    const { rows } = await this.db.query(
      `select seq, at, action, payload from audit_log
       where actor_id = $1 or (action = 'box.collect' and payload->>'collectorId' = $1::text) or (action in ('custody.receive', 'custody.close', 'custody.issue') and payload->>'userId' = $1::text)
       order by seq desc limit $2`, [agentId, limit]);
    return rows.map((r) => ({ id: String(r.seq), at: r.at, action: r.action as string, text: (ACTIVITY[r.action] ?? (() => r.action as string))(r.payload ?? {}) }));
  }

  private async campaignsOf(agentId: string) {
    const { rows } = await this.db.query(
      `select c.id, c.name, c.status, c.unit, c.ends_on, dp.name as point, (dp.agent_id is null) as lead,
              count(e.id)::int as families, count(e.id) filter (where e.status = 'DELIVERED')::int as delivered, max(e.delivered_at) as last_delivery
       from entitlements e join campaigns c on c.id = e.campaign_id join distribution_points dp on dp.id = e.point_id
       where c.status in ('ACTIVE', 'CLOSED') and (dp.agent_id = $1 or exists (select 1 from campaign_point_agents a where a.campaign_id = c.id and a.point_id = dp.id and a.agent_id = $1))
       group by c.id, dp.id order by c.created_at desc limit 20`, [agentId]);
    return rows.map((r) => ({ campaignId: r.id as string, name: r.name as string, status: r.status as string, unit: r.unit as string, endsOn: r.ends_on, point: r.point as string, lead: r.lead as boolean, families: r.families as number, delivered: r.delivered as number, lastDelivery: r.last_delivery }));
  }

  /** ملف المتعهد كاملاً: ذمته النقدية والعينية، صناديقه، تبرعاته، حملاته، طلباته، وسجل نشاطه. */
  async detail(id: string) {
    const r = (await this.db.query(`${AgentsService.AGENT_SQL} and u.id = $1`, [id])).rows[0];
    if (!r) throw new NotFoundException('المتعهد غير موجود');
    const [custody, goods, boxes, collections, donations, campaigns, requests, timeline] = await Promise.all([
      this.accounting.custodyStatement(id), this.goods(id), this.boxes({ agentId: id }), this.collections({ agentId: id, limit: 60 }),
      this.donations({ agentId: id, limit: 60 }), this.campaignsOf(id), this.requests(id), this.timeline(id, 120),
    ]);
    return { ...this.presentAgent(r), custodyStatement: custody, goodsDetail: goods, boxList: boxes, collections, donations, campaigns, requests, timeline };
  }

  /** ما يحمله تطبيق المتعهد: ذمته، صناديقه، وما يختار منه. يُجلب مرة عند المزامنة ويعمل به دون اتصال. */
  async mine(actor: AuthUser) {
    const [me, custody, goods, boxes, donations, requests, funds] = await Promise.all([
      this.db.query('select phone from users where id = $1', [actor.id]), this.accounting.custodyStatement(actor.id, 40), this.goods(actor.id),
      this.boxes({ agentId: actor.id, activeOnly: true }), this.donations({ agentId: actor.id, limit: 40 }), this.requests(actor.id), this.funds(),
    ]);
    return { phone: me.rows[0]?.phone as string | null, custody, goods, boxes, donations, requests, funds, at: new Date().toISOString() };
  }
}
