import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { family, login, sql, startApp } from './helpers';

let app: INestApplication;
const tokens: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });
const post = (path: string, user: string, body: any = {}) => api().post(`/api${path}`).set(as(user)).send(body);
const get = (path: string, user: string) => api().get(`/api${path}`).set(as(user));

let item: string, main: string, wh1: string, wh2: string, p1: string, p2: string;
const stockOf = async (wh: string) => (await get('/inventory/stock', 'keeper')).body.items.find((i: any) => i.id === item).byWarehouse[wh];
const move = (body: any, user = 'keeper') => post('/inventory/moves', user, { itemId: item, ...body });

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'researcher', 'supervisor', 'manager', 'manager2', 'distributor', 'keeper', 'keeper2', 'auditor']) tokens[u] = await login(app, u);
  p1 = (await post('/points', 'manager', { name: 'الجولان' })).body.id;
  p2 = (await post('/points', 'manager', { name: 'الشهداء' })).body.id;
  item = (await post('/inventory/items', 'keeper', { name: 'سلة غذائية', unit: 'سلة' })).body.id;
  const whs = (await get('/inventory/stock', 'keeper')).body.warehouses;
  main = whs.find((w: any) => w.main).id;
  wh1 = whs.find((w: any) => w.pointId === p1).id;
  wh2 = whs.find((w: any) => w.pointId === p2).id;
});
afterAll(async () => {
  await app.close();
});

describe('حركات المخزون', () => {
  it('الوارد يدخل المخزن الرئيس بصلاحيته ومصدره', async () => {
    expect((await move({ kind: 'RECEIPT', toWarehouseId: main, quantity: 100, expiry: '2099-06-01', source: 'متبرع 14' }, 'manager')).status).toBe(403);
    const res = await move({ kind: 'RECEIPT', toWarehouseId: main, quantity: 100, expiry: '2099-06-01', source: 'متبرع 14' });
    expect(res.body.status).toBe('POSTED');
    const stock = (await get('/inventory/stock', 'auditor')).body.items[0];
    expect(stock).toMatchObject({ name: 'سلة غذائية', main: 100, atPoints: 0 });
    expect(String(stock.nearestExpiry)).toContain('2099');
    expect((await post('/inventory/items', 'keeper', { name: 'سلة غذائية', unit: 'سلة' })).status).toBe(409);
  });

  it('التحويل ينقل بين مخزنين، ولا يخرج ما ليس في الرصيد', async () => {
    expect((await move({ kind: 'TRANSFER', fromWarehouseId: main, toWarehouseId: wh1, quantity: 30 })).status).toBe(201);
    expect([await stockOf(main), await stockOf(wh1)]).toEqual([70, 30]);
    const over = await move({ kind: 'TRANSFER', fromWarehouseId: main, toWarehouseId: wh2, quantity: 71 });
    expect(over.status).toBe(409);
    expect(over.body.message).toContain('في المخزن 70 والمطلوب 71');
    expect(await stockOf(main)).toBe(70);
  });

  it('يرفض الحركة التي لا توافق جهتُها نوعَها', async () => {
    expect((await move({ kind: 'RECEIPT', fromWarehouseId: main, quantity: 1 })).status).toBe(400);
    expect((await move({ kind: 'TRANSFER', fromWarehouseId: main, toWarehouseId: main, quantity: 1 })).status).toBe(400);
    expect((await move({ kind: 'WASTE', fromWarehouseId: main, quantity: 1 })).status).toBe(400);
    expect((await move({ kind: 'RECEIPT', toWarehouseId: randomUUID(), quantity: 1 })).status).toBe(400);
  });

  it('عند تحويلين متزامنين يتجاوز مجموعهما الرصيد ينجح واحد', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => move({ kind: 'TRANSFER', fromWarehouseId: main, toWarehouseId: wh2, quantity: 40 })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect([await stockOf(main), await stockOf(wh2)]).toEqual([30, 40]);
  });

  it('التالف لا يُخصم حتى يعتمده موظف آخر', async () => {
    const waste = await move({ kind: 'WASTE', fromWarehouseId: main, quantity: 5, note: 'علب منتفخة، بمحضر' });
    expect(waste.body.status).toBe('PENDING');
    expect(await stockOf(main)).toBe(30);
    expect((await get('/inventory/stock', 'keeper')).body.pendingMoves).toBe(1);
    expect((await post(`/inventory/moves/${waste.body.id}/approve`, 'keeper')).status).toBe(403);
    expect((await post(`/inventory/moves/${waste.body.id}/approve`, 'keeper2')).body.status).toBe('POSTED');
    expect(await stockOf(main)).toBe(25);
    const rejected = await move({ kind: 'WASTE', fromWarehouseId: main, quantity: 5, note: 'تالف آخر' });
    expect((await post(`/inventory/moves/${rejected.body.id}/reject`, 'keeper2')).status).toBe(400);
    await post(`/inventory/moves/${rejected.body.id}/reject`, 'keeper2', { note: 'بلا محضر' });
    expect(await stockOf(main)).toBe(25);
  });

  it('الجرد: الفرق بين العدّ والدفتر يصير تسوية تنتظر الاعتماد', async () => {
    const same = await post('/inventory/stocktake', 'keeper', { warehouseId: main, counts: [{ itemId: item, counted: 25 }], note: 'جرد نهاية الشهر' });
    expect(same.body.differences).toEqual([]);
    const take = await post('/inventory/stocktake', 'keeper', { warehouseId: main, counts: [{ itemId: item, counted: 22 }], note: 'جرد نهاية الشهر' });
    expect(take.body.differences).toEqual([{ itemId: item, book: 25, counted: 22, diff: -3 }]);
    expect(await stockOf(main)).toBe(25);
    const pending = (await get('/inventory/moves?status=PENDING', 'keeper2')).body;
    expect(pending[0]).toMatchObject({ kind: 'ADJUST', quantity: 3, from: 'المخزن الرئيس' });
    await post(`/inventory/moves/${pending[0].id}/approve`, 'keeper2');
    expect(await stockOf(main)).toBe(22);
  });
});

describe('مطابقة الصادر بالمسلَّم', () => {
  let campaignId: string, toks: any[];

  beforeAll(async () => {
    for (let i = 0; i < 6; i++) {
      const f = await post('/families', 'researcher', family());
      await post(`/families/${f.body.id}/approve`, 'supervisor');
    }
    const programId = (await post('/programs', 'admin', { name: 'السلة', kind: 'IN_KIND', unit: 'سلة', rules: {}, amount: { type: 'FIXED', value: 2 }, itemId: item })).body.id;
    const c = await post('/campaigns', 'manager', { name: 'حملة المطابقة', programId, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [p1, p2] });
    campaignId = c.body.id;
    await post(`/campaigns/${campaignId}/submit`, 'manager');
    await post(`/campaigns/${campaignId}/approve`, 'manager2');
    toks = (await get(`/campaigns/${campaignId}/tokens`, 'manager')).body;
    // رصيد النقطتين قبل الحملة: 30 و40. يُخصَّص للحملة 6 في كل نقطة بتحويل موسوم بها.
    await move({ kind: 'RETURN', fromWarehouseId: wh1, toWarehouseId: main, quantity: 30 });
    await move({ kind: 'RETURN', fromWarehouseId: wh2, toWarehouseId: main, quantity: 40 });
    await move({ kind: 'TRANSFER', fromWarehouseId: main, toWarehouseId: wh1, quantity: 6, campaignId });
    await move({ kind: 'TRANSFER', fromWarehouseId: main, toWarehouseId: wh2, quantity: 6, campaignId });
  });
  const deliver = (t: any, pointId: string) =>
    post('/deliveries/redeem', 'distributor', { pointId, deviceId: 'd1', locate: { token: t.token }, receiver: { kind: 'HEAD' }, clientOpId: randomUUID() });

  it('كل تسليم يخصم من مخزن نقطته مرة واحدة', async () => {
    const atP1 = toks.filter((t) => t.point === 'الجولان');
    await deliver(atP1[0], p1);
    await deliver(atP1[1], p1);
    await deliver(atP1[1], p1);
    expect(await stockOf(wh1)).toBe(2);
    const r = (await get(`/inventory/reconcile/${campaignId}`, 'auditor')).body;
    expect(r.points.find((p: any) => p.point === 'الجولان')).toMatchObject({ needed: 6, sent: 6, delivered: 4, returned: 0, remaining: 2, shortage: 0 });
    expect(r.shortage).toBe(0);
  });

  it('الراجع يدخل في المطابقة، وما سُلِّم فوق ما أُرسل يظهر نقصاً ولا يُخفى', async () => {
    await move({ kind: 'RETURN', fromWarehouseId: wh2, toWarehouseId: main, quantity: 4, campaignId });
    const atP2 = toks.filter((t) => t.point === 'الشهداء');
    for (const t of atP2) await deliver(t, p2);
    const r = (await get(`/inventory/reconcile/${campaignId}`, 'auditor')).body;
    // أُرسل 6 ورجع 4، وسُلِّم 6: نقص 4.
    expect(r.points.find((p: any) => p.point === 'الشهداء')).toMatchObject({ sent: 6, returned: 4, delivered: 6, remaining: 0, shortage: 4 });
    expect(r.shortage).toBe(4);
    expect(await stockOf(wh2)).toBe(-4);
  });

  it('حركة التسليم مرتبطة باستحقاقها، والسلسلة سليمة', async () => {
    const n = await sql("select count(*)::int as n, count(distinct entitlement_id)::int as d from stock_moves where kind = 'ISSUE'");
    expect(n.rows[0]).toEqual({ n: 5, d: 5 });
    expect((await get('/audit/verify', 'auditor')).body.ok).toBe(true);
  });
});
