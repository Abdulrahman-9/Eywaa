import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.guard';
import { Db } from '../db/db.module';

const qty = z.number().int().min(1).max(100_000_000);
export const itemSchema = z.object({ name: z.string().trim().min(2).max(80), unit: z.string().trim().min(1).max(20) });
export const moveSchema = z.object({
  kind: z.enum(['RECEIPT', 'TRANSFER', 'RETURN', 'WASTE']),
  itemId: z.string().uuid(),
  fromWarehouseId: z.string().uuid().optional(),
  toWarehouseId: z.string().uuid().optional(),
  quantity: qty,
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  source: z.string().trim().min(1).max(120).optional(),
  donorId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  note: z.string().trim().min(1).max(300).optional(),
});
export type MoveInput = z.infer<typeof moveSchema>;
export const stocktakeSchema = z.object({
  warehouseId: z.string().uuid(),
  counts: z.array(z.object({ itemId: z.string().uuid(), counted: z.number().int().min(0).max(100_000_000) })).min(1).max(500),
  note: z.string().trim().min(3).max(300),
});
export type StocktakeInput = z.infer<typeof stocktakeSchema>;

/** قفل يجعل حركات المخزون واحدة بعد واحدة، فلا يسبق صادرٌ رصيداً لم يثبت. */
const STOCK_LOCK = 7_240_002;

@Injectable()
export class InventoryService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async items() {
    return (await this.db.query('select id, name, unit, active from items order by name')).rows;
  }

  async createItem(input: z.infer<typeof itemSchema>, actor: AuthUser) {
    try {
      return await this.db.tx(async (c) => {
        const { rows } = await c.query('insert into items (name, unit) values ($1, $2) returning id, name, unit, active', [input.name, input.unit]);
        await this.audit.append(c, { actorId: actor.id, action: 'item.create', entity: 'item', entityId: rows[0].id, payload: input });
        return rows[0];
      });
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException('صنف بهذا الاسم موجود');
      throw err;
    }
  }

  /** المخازن: الرئيس، ومخزن لكل نقطة توزيع يُنشأ عند أول حاجة إليه. */
  async warehouses() {
    await this.db.query(
      `insert into warehouses (name, point_id) select 'مخزن ' || p.name, p.id from distribution_points p
       where not exists (select 1 from warehouses w where w.point_id = p.id) on conflict do nothing`,
    );
    const { rows } = await this.db.query('select id, name, point_id from warehouses order by (point_id is not null), name');
    return rows.map((r) => ({ id: r.id, name: r.name, pointId: r.point_id, main: r.point_id === null }));
  }

  private async balance(c: PoolClient, warehouseId: string, itemId: string): Promise<number> {
    const { rows } = await c.query('select quantity from stock_balances where warehouse_id = $1 and item_id = $2', [warehouseId, itemId]);
    return rows[0]?.quantity ?? 0;
  }

  async move(input: MoveInput, actor: AuthUser) {
    const from = input.fromWarehouseId ?? null;
    const to = input.toWarehouseId ?? null;
    const shapes: Record<string, boolean> = {
      RECEIPT: !from && !!to, WASTE: !!from && !to, TRANSFER: !!from && !!to && from !== to, RETURN: !!from && !!to && from !== to,
    };
    if (!shapes[input.kind]) throw new BadRequestException('جهة الحركة لا توافق نوعها');
    if (input.kind === 'WASTE' && !input.note) throw new BadRequestException('يلزم ذكر سبب التلف');
    // التالف يُخرج مالاً بلا مستلم، فلا يثبت حتى يعتمده موظف آخر.
    const status = input.kind === 'WASTE' ? 'PENDING' : 'POSTED';
    return this.db.tx(async (c) => {
      await c.query('select pg_advisory_xact_lock($1)', [STOCK_LOCK]);
      if (from) {
        const have = await this.balance(c, from, input.itemId);
        if (have < input.quantity) throw new ConflictException(`الرصيد لا يكفي: في المخزن ${have} والمطلوب ${input.quantity}`);
      }
      const { rows } = await c.query(
        `insert into stock_moves (kind, status, item_id, from_wh, to_wh, quantity, expiry, source, campaign_id, note, created_by, donor_id)
         values ($1,$2,$3,$4,$5,$6,$7,coalesce($8, (select name from donors where id = $12)),$9,$10,$11,$12) returning id`,
        [input.kind, status, input.itemId, from, to, input.quantity, input.expiry ?? null, input.source ?? null, input.campaignId ?? null, input.note ?? null, actor.id, input.kind === 'RECEIPT' ? input.donorId ?? null : null],
      );
      await this.audit.append(c, { actorId: actor.id, action: `stock.${input.kind.toLowerCase()}`, entity: 'stock_move', entityId: rows[0].id, payload: input });
      return { id: rows[0].id as string, status };
    }).catch((err) => {
      if (err.code === '23503') throw new BadRequestException('الصنف أو المخزن أو الحملة غير موجود');
      throw err;
    });
  }

  /** الجرد: ما عُدَّ يُقابَل بالدفتر، وكل فرق يصير تسوية تنتظر اعتماد موظف آخر. */
  async stocktake(input: StocktakeInput, actor: AuthUser) {
    return this.db.tx(async (c) => {
      await c.query('select pg_advisory_xact_lock($1)', [STOCK_LOCK]);
      const diffs: { itemId: string; book: number; counted: number; diff: number }[] = [];
      for (const line of input.counts) {
        const book = await this.balance(c, input.warehouseId, line.itemId);
        const diff = line.counted - book;
        if (diff === 0) continue;
        diffs.push({ itemId: line.itemId, book, counted: line.counted, diff });
        await c.query(
          `insert into stock_moves (kind, status, item_id, from_wh, to_wh, quantity, note, created_by)
           values ('ADJUST', 'PENDING', $1, $2, $3, $4, $5, $6)`,
          [line.itemId, diff < 0 ? input.warehouseId : null, diff > 0 ? input.warehouseId : null, Math.abs(diff), `جرد: ${input.note} (الدفتر ${book}، العدّ ${line.counted})`, actor.id],
        );
      }
      await this.audit.append(c, { actorId: actor.id, action: 'stock.stocktake', entity: 'warehouse', entityId: input.warehouseId, payload: { note: input.note, lines: input.counts.length, diffs } });
      return { counted: input.counts.length, differences: diffs };
    });
  }

  async decide(id: string, approve: boolean, note: string | undefined, actor: AuthUser) {
    return this.db.tx(async (c) => {
      await c.query('select pg_advisory_xact_lock($1)', [STOCK_LOCK]);
      const { rows } = await c.query('select * from stock_moves where id = $1 for update', [id]);
      const m = rows[0];
      if (!m) throw new NotFoundException('الحركة غير موجودة');
      if (m.status !== 'PENDING') throw new ConflictException('فُصل في هذه الحركة من قبل');
      if (m.created_by === actor.id) throw new ForbiddenException('لا يعتمد الموظف حركة سجّلها بنفسه');
      if (!approve && !note) throw new BadRequestException('يلزم ذكر سبب الرفض');
      if (approve && m.from_wh) {
        const have = await this.balance(c, m.from_wh, m.item_id);
        if (have < m.quantity) throw new ConflictException(`الرصيد لا يكفي: في المخزن ${have} والمطلوب ${m.quantity}`);
      }
      await c.query('update stock_moves set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1', [id, approve ? 'POSTED' : 'REJECTED', actor.id, note ?? null]);
      await this.audit.append(c, { actorId: actor.id, action: approve ? 'stock.approve' : 'stock.reject', entity: 'stock_move', entityId: id, payload: { kind: m.kind, quantity: m.quantity, note: note ?? null } });
      return { id, status: approve ? 'POSTED' : 'REJECTED' };
    });
  }

  /**
   * يخصم ما سُلِّم من مخزن النقطة التي سُلِّم فيها. يُسجَّل ولو لم يكفِ الرصيد:
   * الواقع أن البضاعة خرجت، والنقص يظهر في المطابقة ولا يُخفى.
   */
  async issueForDelivery(c: PoolClient, e: { id: string; campaignId: string; programId: string; pointId: string; quantity: number; actorId: string }) {
    const item = (await c.query('select item_id from programs where id = $1', [e.programId])).rows[0]?.item_id;
    if (!item) return;
    let wh = (await c.query('select id from warehouses where point_id = $1', [e.pointId])).rows[0]?.id;
    if (!wh) {
      wh = (await c.query("insert into warehouses (name, point_id) select 'مخزن ' || name, id from distribution_points where id = $1 on conflict (point_id) do update set name = excluded.name returning id", [e.pointId])).rows[0].id;
    }
    await c.query(
      `insert into stock_moves (kind, item_id, from_wh, quantity, campaign_id, entitlement_id, created_by)
       values ('ISSUE', $1, $2, $3, $4, $5, $6) on conflict (entitlement_id) do nothing`,
      [item, wh, e.quantity, e.campaignId, e.id, e.actorId],
    );
  }

  async stock() {
    const warehouses = await this.warehouses();
    const [items, balances, pending, expiry] = await Promise.all([
      this.db.query('select id, name, unit from items where active order by name'),
      this.db.query('select warehouse_id, item_id, quantity from stock_balances'),
      this.db.query("select count(*)::int as n from stock_moves where status = 'PENDING'"),
      this.db.query("select item_id, min(expiry) as nearest from stock_moves where kind = 'RECEIPT' and status = 'POSTED' and expiry >= current_date group by item_id"),
    ]);
    const bal = new Map(balances.rows.map((b) => [`${b.warehouse_id}:${b.item_id}`, b.quantity as number]));
    const exp = new Map(expiry.rows.map((e) => [e.item_id, e.nearest]));
    return {
      warehouses,
      pendingMoves: pending.rows[0].n,
      items: items.rows.map((i) => {
        const byWarehouse = Object.fromEntries(warehouses.map((w) => [w.id, bal.get(`${w.id}:${i.id}`) ?? 0]));
        return {
          id: i.id, name: i.name, unit: i.unit, byWarehouse,
          main: byWarehouse[warehouses.find((w) => w.main)!.id] ?? 0,
          atPoints: warehouses.filter((w) => !w.main).reduce((s, w) => s + byWarehouse[w.id], 0),
          // أقرب صلاحية مسجَّلة في وارد لم ينتهِ؛ تقريب، إذ لا تُتتبَّع الدفعات عند الصرف.
          nearestExpiry: exp.get(i.id) ?? null,
        };
      }),
    };
  }

  async moves(status?: string) {
    const { rows } = await this.db.query(
      `select m.id, m.kind, m.status, m.quantity, m.expiry, m.source, m.note, m.created_at, i.name as item, i.unit,
              fw.name as from_name, tw.name as to_name, u.username, c.name as campaign
       from stock_moves m join items i on i.id = m.item_id left join warehouses fw on fw.id = m.from_wh left join warehouses tw on tw.id = m.to_wh
         join users u on u.id = m.created_by left join campaigns c on c.id = m.campaign_id
       where m.kind <> 'ISSUE' and ($1::move_status is null or m.status = $1)
       order by m.created_at desc limit 100`,
      [status ?? null],
    );
    return rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, quantity: r.quantity, expiry: r.expiry, source: r.source, note: r.note, createdAt: r.created_at, item: r.item, unit: r.unit, from: r.from_name, to: r.to_name, by: r.username, campaign: r.campaign }));
  }

  /** مطابقة الحملة: ما خرج إلى النقطة = ما سُلِّم بالرموز + ما رجع + ما بقي فيها. كل فرق يظهر. */
  async reconcile(campaignId: string) {
    const camp = (await this.db.query('select c.name, c.unit, p.item_id, i.name as item from campaigns c join programs p on p.id = c.program_id left join items i on i.id = p.item_id where c.id = $1', [campaignId])).rows[0];
    if (!camp) throw new NotFoundException('الحملة غير موجودة');
    if (!camp.item_id) return { campaign: camp.name, item: null, points: [], difference: 0 };
    const { rows } = await this.db.query(
      `select dp.id, dp.name,
              coalesce((select sum(m.quantity) from stock_moves m where m.campaign_id = $1 and m.kind = 'TRANSFER' and m.status = 'POSTED' and m.to_wh = w.id), 0)::int as sent,
              coalesce((select sum(m.quantity) from stock_moves m where m.campaign_id = $1 and m.kind = 'RETURN' and m.status = 'POSTED' and m.from_wh = w.id), 0)::int as returned,
              coalesce((select sum(e.quantity) from entitlements e where e.campaign_id = $1 and e.status = 'DELIVERED' and e.delivered_point = dp.id), 0)::int as delivered,
              coalesce((select sum(e.quantity) from entitlements e where e.campaign_id = $1 and e.point_id = dp.id and e.status <> 'CANCELLED'), 0)::int as needed
       from distribution_points dp left join warehouses w on w.point_id = dp.id
       where exists (select 1 from entitlements e where e.campaign_id = $1 and (e.point_id = dp.id or e.delivered_point = dp.id))
       order by dp.name`,
      [campaignId],
    );
    const points = rows.map((r) => {
      const remaining = r.sent - r.delivered - r.returned;
      return { pointId: r.id, point: r.name, needed: r.needed, sent: r.sent, delivered: r.delivered, returned: r.returned, remaining: Math.max(remaining, 0), shortage: Math.max(-remaining, 0) };
    });
    return { campaign: camp.name, item: camp.item, unit: camp.unit, points, shortage: points.reduce((s, p) => s + p.shortage, 0) };
  }
}
