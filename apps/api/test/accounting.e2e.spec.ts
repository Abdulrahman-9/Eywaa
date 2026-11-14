import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { family, login, sql, startApp, uniqueName } from './helpers';

let app: INestApplication;
const tokens: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });
const post = (path: string, user: string, body: any = {}) => api().post(`/api${path}`).set(as(user)).send(body);
const get = (path: string, user: string) => api().get(`/api${path}`).set(as(user));

let general: string;
const fundOf = async (id: string) => (await get('/accounting/summary', 'accountant')).body.funds.find((f: any) => f.id === id);
const balanced = async () => (await get('/accounting/trial-balance', 'auditor')).body;

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'researcher', 'supervisor', 'manager', 'manager2', 'distributor', 'distributor2', 'accountant', 'accountant2', 'auditor']) tokens[u] = await login(app, u);
  general = (await get('/accounting/summary', 'accountant')).body.funds[0].id;
});
afterAll(async () => {
  await app.close();
});

describe('السندات', () => {
  it('سند القبض يثبت فوراً ويزيد نقد الصندوق', async () => {
    expect((await post('/accounting/receipts', 'manager', { fundId: general, amount: 1, party: 'x', description: 'xx' })).status).toBe(403);
    const r = await post('/accounting/receipts', 'accountant', { fundId: general, amount: 5_000_000, party: 'متبرع 31', description: 'تبرع نقدي غير مقيَّد' });
    expect(r.body).toMatchObject({ no: 'ق-1', status: 'POSTED' });
    expect(await fundOf(general)).toMatchObject({ cash: 5_000_000, custody: 0, available: 5_000_000 });
  });

  it('سند الصرف لا يثبت ولا ينقص النقد حتى يعتمده موظف آخر', async () => {
    const p = await post('/accounting/payments', 'accountant', { fundId: general, amount: 960_000, party: 'تاجر الجملة', description: 'شراء 320 عبوة زيت', category: 'مشتريات' });
    expect(p.body).toMatchObject({ no: 'ص-1', status: 'PENDING' });
    expect((await fundOf(general)).cash).toBe(5_000_000);
    expect((await post(`/accounting/entries/${p.body.id}/approve`, 'accountant')).status).toBe(403);
    expect((await post(`/accounting/entries/${p.body.id}/approve`, 'accountant2')).body.status).toBe('POSTED');
    expect((await fundOf(general)).cash).toBe(4_040_000);
    expect((await post(`/accounting/entries/${p.body.id}/approve`, 'accountant2')).status).toBe(409);
  });

  it('لا يُعتمد صرف يتجاوز نقد الصندوق', async () => {
    const p = await post('/accounting/payments', 'accountant', { fundId: general, amount: 9_000_000, party: 'مورّد', description: 'شراء كبير', category: 'مشتريات' });
    const res = await post(`/accounting/entries/${p.body.id}/approve`, 'accountant2');
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('فيه 4,040,000 والمطلوب 9,000,000');
    expect((await post(`/accounting/entries/${p.body.id}/reject`, 'accountant2')).status).toBe(400);
    await post(`/accounting/entries/${p.body.id}/reject`, 'accountant2', { note: 'لا رصيد' });
    expect((await fundOf(general)).cash).toBe(4_040_000);
  });

  it('القيد لا يُحذف: يُعكس بقيد مقابل يعتمده غير طالبه', async () => {
    const r = await post('/accounting/receipts', 'accountant', { fundId: general, amount: 250_000, party: 'متبرع 7', description: 'سُجّل خطأً مرتين' });
    await expect(sql('delete from ledger_lines where entry_id = $1', [r.body.id])).rejects.toThrow(/append-only/);
    await expect(sql('update ledger_lines set debit = 1 where entry_id = $1 and debit > 0', [r.body.id])).rejects.toThrow(/append-only/);
    const rev = await post(`/accounting/entries/${r.body.id}/reverse`, 'accountant', { reason: 'قيد مكرر' });
    expect(rev.body.status).toBe('PENDING');
    expect((await fundOf(general)).cash).toBe(4_290_000);
    expect((await post(`/accounting/entries/${r.body.id}/reverse`, 'accountant', { reason: 'مرة ثانية' })).status).toBe(409);
    await post(`/accounting/entries/${rev.body.id}/approve`, 'accountant2');
    expect((await fundOf(general)).cash).toBe(4_040_000);
    const listed = (await get('/accounting/entries', 'auditor')).body.find((e: any) => e.id === r.body.id);
    expect(listed.reversed).toBe(true);
  });

  it('الصندوق المقيَّد ببرنامج لا يُصرف منه بسند عام', async () => {
    const programId = (await post('/programs', 'admin', { name: 'كفالة الأيتام', kind: 'MONEY', unit: 'دينار', rules: { hasOrphans: true }, amount: { type: 'PER_ORPHAN', value: 50_000 } })).body.id;
    const orphans = (await post('/accounting/funds', 'accountant', { name: 'صندوق كفالة الأيتام', programId })).body.id;
    await post('/accounting/receipts', 'accountant', { fundId: orphans, amount: 1_000_000, party: 'متبرع 22', description: 'لكفالة الأيتام' });
    const p = await post('/accounting/payments', 'accountant', { fundId: orphans, amount: 100_000, party: 'مورّد', description: 'قرطاسية', category: 'مصاريف إدارية' });
    expect(p.status).toBe(409);
    expect(p.body.message).toContain('مقيَّد ببرنامجه');
    expect((await fundOf(orphans)).cash).toBe(1_000_000);
  });

  it('ميزان المراجعة متوازن', async () => {
    const tb = await balanced();
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.lines.find((l: any) => l.account === 'مصروف: مشتريات').balance).toBe(960_000);
  });
});

describe('الصرف النقدي في التوزيع والعهدة', () => {
  let campaignId: string, toks: any[], fundId: string, pointId: string, distributorId: string;

  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      const f = family();
      f.members.push({ relation: 'SON', fullName: uniqueName(8800 + i), gender: 'M', isOrphan: true, documents: [] });
      const created = await post('/families', 'researcher', f);
      await post(`/families/${created.body.id}/approve`, 'supervisor');
    }
    fundId = (await get('/accounting/summary', 'accountant')).body.funds.find((f: any) => f.name === 'صندوق كفالة الأيتام').id;
    pointId = (await post('/points', 'manager', { name: 'الجولان' })).body.id;
    distributorId = (await sql("select id from users where username = 'distributor'")).rows[0].id;
  });

  it('الحملة المالية يلزمها صندوق يوافق برنامجها وفيه ما يكفيها', async () => {
    const programId = (await sql("select id from programs where name = 'كفالة الأيتام'")).rows[0].id;
    const base = { name: 'كفالة تشرين', programId, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [pointId] };
    expect((await post('/campaigns', 'manager', base)).status).toBe(400);

    // صندوق مقيَّد ببرنامج آخر يُرفض عند الاعتماد.
    const otherProgram = (await post('/programs', 'admin', { name: 'مساعدة شهرية', kind: 'MONEY', unit: 'دينار', rules: {}, amount: { type: 'FIXED', value: 1000 } })).body.id;
    const otherFund = (await post('/accounting/funds', 'accountant', { name: 'صندوق المساعدة الشهرية', programId: otherProgram })).body.id;
    await post('/accounting/receipts', 'accountant', { fundId: otherFund, amount: 10_000_000, party: 'متبرع', description: 'للمساعدة الشهرية' });
    const wrong = await post('/campaigns', 'manager', { ...base, fundId: otherFund });
    await post(`/campaigns/${wrong.body.id}/submit`, 'manager');
    const refused = await post(`/campaigns/${wrong.body.id}/approve`, 'manager2');
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain('مقيَّد ببرنامج آخر');
    await post(`/campaigns/${wrong.body.id}/cancel`, 'manager', { note: 'صندوق خاطئ' });

    // الصندوق الصحيح فيه 1,000,000 والحملة 150,000: تُعتمد ويُحجز مبلغها.
    const c = await post('/campaigns', 'manager', { ...base, fundId });
    campaignId = c.body.id;
    expect(c.body.totals).toMatchObject({ families: 3, quantity: 150_000 });
    await post(`/campaigns/${campaignId}/submit`, 'manager');
    expect((await post(`/campaigns/${campaignId}/approve`, 'manager2')).body.status).toBe('ACTIVE');
    expect(await fundOf(fundId)).toMatchObject({ cash: 1_000_000, reserved: 150_000, available: 850_000 });
    toks = (await get(`/campaigns/${campaignId}/tokens`, 'manager')).body;
  });

  it('المحجوز لحملة جارية لا تأخذه حملة أخرى', async () => {
    await sql("update campaigns set status = 'CLOSED' where id = $1", [campaignId]);
    await sql("update entitlements set status = 'CANCELLED' where campaign_id = $1", [campaignId]);
    const programId = (await sql("select id from programs where name = 'كفالة الأيتام'")).rows[0].id;
    await sql("update programs set amount = '{\"type\":\"PER_ORPHAN\",\"value\":300000}' where id = $1", [programId]);
    const a = await post('/campaigns', 'manager', { name: 'كبيرة أولى', programId, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [pointId], fundId });
    await post(`/campaigns/${a.body.id}/submit`, 'manager');
    expect((await post(`/campaigns/${a.body.id}/approve`, 'manager2')).body.status).toBe('ACTIVE');   // 900,000 من 1,000,000
    expect((await fundOf(fundId)).available).toBe(100_000);
    await sql("update campaigns set status = 'CLOSED' where id = $1", [a.body.id]);
    await sql("update entitlements set status = 'CANCELLED' where campaign_id = $1", [a.body.id]);
    await sql("update programs set amount = '{\"type\":\"PER_ORPHAN\",\"value\":50000}' where id = $1", [programId]);
    await sql("update campaigns set status = 'ACTIVE' where id = $1", [campaignId]);
    await sql("update entitlements set status = 'PENDING' where campaign_id = $1", [campaignId]);
  });

  it('العهدة تخرج من نقد الصندوق إلى أمين الصندوق، ولا تتجاوزه', async () => {
    const over = await post('/accounting/custody/issue', 'accountant', { fundId, userId: distributorId, amount: 2_000_000 });
    expect(over.status).toBe(409);
    expect((await post('/accounting/custody/issue', 'accountant', { fundId, userId: distributorId, amount: 200_000 })).status).toBe(201);
    expect(await fundOf(fundId)).toMatchObject({ cash: 800_000, custody: 200_000 });
    expect((await get('/accounting/custody', 'auditor')).body).toEqual([expect.objectContaining({ username: 'distributor', balance: 200_000 })]);
  });

  it('كل صرف بالرمز له قيد واحد من عهدة مسلِّمه', async () => {
    const redeem = (t: any, op = randomUUID()) => post('/deliveries/redeem', 'distributor', { pointId, deviceId: 'd1', locate: { token: t.token }, receiver: { kind: 'HEAD' }, clientOpId: op });
    const op = randomUUID();
    expect((await redeem(toks[0], op)).status).toBe(200);
    await redeem(toks[0], op);
    await redeem(toks[0]);
    expect((await redeem(toks[1])).status).toBe(200);
    const n = await sql("select count(*)::int as n, sum(amount)::int as total from ledger_entries where kind = 'DISBURSEMENT'");
    expect(n.rows[0]).toEqual({ n: 2, total: 100_000 });
    expect(await fundOf(fundId)).toMatchObject({ cash: 800_000, custody: 100_000, reserved: 50_000 });
    expect((await balanced()).balanced).toBe(true);
  });

  it('إقفال العهدة: العدّ المطابق يرجع كله، والعجز قيد ينتظر اعتماد غيره', async () => {
    expect((await post('/accounting/custody/close', 'distributor2', { fundId, userId: distributorId, counted: 1 })).status).toBe(403);
    const close = await post('/accounting/custody/close', 'distributor', { fundId, counted: 95_000 });
    expect(close.body).toMatchObject({ book: 100_000, counted: 95_000, difference: -5_000 });
    expect(close.body.pendingEntry).toMatch(/^ي-/);
    // ما عُدَّ رجع إلى الصندوق، والعجز باقٍ في ذمة الأمين حتى يُعتمد.
    expect(await fundOf(fundId)).toMatchObject({ cash: 895_000, custody: 5_000 });
    const shortage = (await get('/accounting/entries?status=PENDING', 'accountant')).body.find((e: any) => e.kind === 'SHORTAGE');
    expect(shortage.amount).toBe(5_000);
    await post(`/accounting/entries/${shortage.id}/approve`, 'accountant');
    expect(await fundOf(fundId)).toMatchObject({ cash: 895_000, custody: 0 });
    const tb = await balanced();
    expect(tb.balanced).toBe(true);
    expect(tb.lines.find((l: any) => l.account === 'مصروف: عجز العهد').balance).toBe(5_000);
    expect(tb.lines.find((l: any) => l.account === 'مصروف: مساعدات').balance).toBe(100_000);
  });

  it('صرف يتجاوز العهدة يُسجَّل ولا يُخفى: العهدة تصير سالبة', async () => {
    await post('/deliveries/redeem', 'distributor', { pointId, deviceId: 'd1', locate: { token: toks[2].token }, receiver: { kind: 'HEAD' }, clientOpId: randomUUID() });
    expect((await get('/accounting/custody', 'auditor')).body).toEqual([expect.objectContaining({ username: 'distributor', balance: -50_000 })]);
    expect((await balanced()).balanced).toBe(true);
    expect((await get('/audit/verify', 'auditor')).body.ok).toBe(true);
  });
});
