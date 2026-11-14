import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { family, login, sql, startApp } from './helpers';

/** ضوابط الدفتر التي أضافتها مراجعة النظام: من يحمل مالاً لا يشهد لنفسه، والعكس لا يُخرج ما ليس موجوداً، والأرقام تتطابق. */
let app: INestApplication;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });
const post = (path: string, user: string, body: any = {}) => api().post(`/api${path}`).set(as(user)).send(body);
const get = (path: string, user: string) => api().get(`/api${path}`).set(as(user));

let fund: string;
const custodyOf = async (user: string) => Number((await sql(
  "select coalesce(sum(l.debit - l.credit), 0) as b from ledger_lines l join ledger_entries e on e.id = l.entry_id where e.status = 'POSTED' and l.account = 'CUSTODY:' || $1", [ids[user]])).rows[0].b);
const fundOf = async (id = fund) => (await get('/accounting/summary', 'accountant')).body.funds.find((f: any) => f.id === id);
const pending = async (kind: string) => (await get('/accounting/entries?status=PENDING', 'accountant')).body.filter((e: any) => e.kind === kind);

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'accountant', 'accountant2', 'distributor', 'agent', 'projects', 'projects2', 'researcher', 'supervisor', 'keeper']) {
    tokens[u] = await login(app, u);
    ids[u] = (await sql('select id from users where username = $1', [u])).rows[0].id;
  }
  fund = (await sql("select id from funds where name = 'الصندوق العام'")).rows[0].id;
  await post('/accounting/receipts', 'accountant', { fundId: fund, amount: 1_000_000, party: 'متبرع', description: 'تبرع نقدي' });
});
afterAll(async () => {
  await app.close();
});

describe('العهدة: من يحملها لا يشهد لنفسه', () => {
  it('لا يقفل العهدةَ حاملُها، ولا يسلّم المحاسب نفسه، ولا يُقيَّد عدّ على رصيد تغيّر', async () => {
    expect((await post('/accounting/custody/issue', 'accountant', { fundId: fund, userId: ids.accountant, amount: 1000 })).status).toBe(403);
    expect((await post('/accounting/custody/issue', 'accountant', { fundId: fund, userId: ids.distributor, amount: 200_000 })).status).toBe(201);
    // موظف التوزيع كان يقفل عهدته بقوله: «عددتُ 200,000» فتسقط ذمته بلا شاهد.
    expect((await post('/accounting/custody/close', 'distributor', { fundId: fund, userId: ids.distributor, counted: 200_000 })).status).toBe(403);
    expect(await custodyOf('distributor')).toBe(200_000);
    await post('/accounting/custody/issue', 'admin', { fundId: fund, userId: ids.accountant, amount: 100_000 });
    const own = await post('/accounting/custody/close', 'accountant', { fundId: fund, userId: ids.accountant, counted: 100_000 });
    expect(own.status).toBe(403);
    expect(own.body.message).toBe('لا يُقفل الموظف عهدة نفسه');
    // الطلب نفسه يُرسل مرتين: الثاني يرى رصيداً غير الذي عُدّ عليه فيُردّ.
    const stale = await post('/accounting/custody/close', 'accountant', { fundId: fund, userId: ids.distributor, counted: 200_000, expectedBook: 150_000 });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toContain('تغيّر رصيد العهدة');
    const close = await post('/accounting/custody/close', 'accountant', { fundId: fund, userId: ids.distributor, counted: 195_000, expectedBook: 200_000 });
    expect(close.body).toMatchObject({ book: 200_000, counted: 195_000, difference: -5_000 });
    const again = await post('/accounting/custody/close', 'accountant', { fundId: fund, userId: ids.distributor, counted: 5_000, expectedBook: 200_000 });
    expect(again.status).toBe(409);
    // وما دام الفرق معلّقاً فلا عدّ جديد.
    const second = await post('/accounting/custody/close', 'accountant', { fundId: fund, userId: ids.distributor, counted: 5_000 });
    expect(second.status).toBe(409);
    expect(second.body.message).toContain('فرق ينتظر الاعتماد');
    expect(await custodyOf('distributor')).toBe(5_000);
    const rec = await post('/accounting/custody/receive', 'accountant', { fundId: fund, userId: ids.distributor, amount: 1_000, expectedBook: 9_999 });
    expect(rec.status).toBe(409);
  });

  it('لا يعتمد الموظف فرقاً في ذمته هو، ولو سجّله غيره', async () => {
    const [shortage] = await pending('SHORTAGE');
    await post(`/accounting/entries/${shortage.id}/approve`, 'accountant2');
    const mine = await post('/accounting/custody/close', 'admin', { fundId: fund, userId: ids.accountant, counted: 90_000 });
    expect(mine.body.difference).toBe(-10_000);
    const own = (await pending('SHORTAGE'))[0];
    const self = await post(`/accounting/entries/${own.id}/approve`, 'accountant');
    expect(self.status).toBe(403);
    expect(self.body.message).toBe('لا يعتمد الموظف قيداً في ذمته هو');
    expect((await post(`/accounting/entries/${own.id}/approve`, 'accountant2')).body.status).toBe('POSTED');
    expect(await custodyOf('accountant')).toBe(0);
  });
});

describe('العكس: لا يُخرج ما ليس موجوداً', () => {
  it('سند قبض دخل ذمة متعهد ثم سُلّم لا يُعكس، والعكس المرفوض لا يمنع عكساً بعده', async () => {
    const d = await post('/agent-donations', 'agent', { kind: 'CASH', donorName: 'حاتم عبد الله', amount: 50_000 });
    expect(await custodyOf('agent')).toBe(50_000);
    await post('/accounting/custody/receive', 'accountant', { fundId: fund, userId: ids.agent, amount: 50_000 });
    const rev = await post(`/accounting/entries/${d.body.entryId}/reverse`, 'accountant', { reason: 'سُجّل مرتين' });
    expect(rev.status).toBe(201);
    // كان يُعتمد فتصير ذمة المتعهد سالبة 50,000.
    const no = await post(`/accounting/entries/${rev.body.id}/approve`, 'accountant2');
    expect(no.status).toBe(409);
    expect(no.body.message).toContain('ذمة من تسلّم المبلغ');
    expect(await custodyOf('agent')).toBe(0);
    await post(`/accounting/entries/${rev.body.id}/reject`, 'accountant2', { note: 'المبلغ سُلّم' });
    // كان القيد المرفوض يحجز «عكس هذا السند» إلى الأبد.
    const later = await post(`/accounting/entries/${d.body.entryId}/reverse`, 'accountant', { reason: 'محاولة ثانية بعد الرفض' });
    expect(later.status).toBe(201);
    expect((await post(`/accounting/entries/${d.body.entryId}/reverse`, 'accountant', { reason: 'وثالثة' })).status).toBe(409);
    await post(`/accounting/entries/${later.body.id}/reject`, 'accountant2', { note: 'كما سبق' });
  });

  it('سند قبض صُرف ماله لا يُعكس: نقد الصندوق لا ينزل تحت الصفر', async () => {
    const r = await post('/accounting/receipts', 'accountant', { fundId: fund, amount: 300_000, party: 'متبرع ثانٍ', description: 'تبرع' });
    const cash = (await fundOf()).cash;
    const pay = await post('/accounting/payments', 'accountant', { fundId: fund, amount: cash - 100_000, party: 'تاجر', description: 'مشتريات', category: 'مشتريات مواد' });
    await post(`/accounting/entries/${pay.body.id}/approve`, 'accountant2');
    expect((await fundOf()).cash).toBe(100_000);
    const rev = await post(`/accounting/entries/${r.body.id}/reverse`, 'accountant', { reason: 'ردّ التبرع' });
    const no = await post(`/accounting/entries/${rev.body.id}/approve`, 'accountant2');
    expect(no.status).toBe(409);
    expect(no.body.message).toContain('نقد الصندوق فيه 100,000');
    await post(`/accounting/entries/${rev.body.id}/reject`, 'accountant2', { note: 'صُرف' });
  });

  it('الملخص وكشف الحساب يوافقان الدفتر بعد العكس', async () => {
    const before = (await get('/accounting/summary', 'accountant')).body;
    const r = await post('/accounting/receipts', 'accountant', { fundId: fund, amount: 40_000, party: 'متبرع ثالث', description: 'يُعكس' });
    expect((await get('/accounting/summary', 'accountant')).body.receivedThisMonth).toBe(before.receivedThisMonth + 40_000);
    const rev = await post(`/accounting/entries/${r.body.id}/reverse`, 'accountant', { reason: 'خطأ في الصندوق' });
    await post(`/accounting/entries/${rev.body.id}/approve`, 'accountant2');
    const after = (await get('/accounting/summary', 'accountant')).body;
    expect(after.receivedThisMonth).toBe(before.receivedThisMonth);
    const tb = (await get('/accounting/trial-balance', 'accountant')).body;
    const income = tb.lines.filter((l: any) => l.account === 'الإيرادات والتبرعات').reduce((s: number, l: any) => s - l.balance, 0);
    const spent = tb.lines.filter((l: any) => l.account.startsWith('مصروف')).reduce((s: number, l: any) => s + l.balance, 0);
    // كل ما في هذا الاختبار وقع هذا الشهر: فالملخص هو الميزان.
    expect(after.receivedThisMonth).toBe(income);
    expect(after.spentThisMonth).toBe(spent);
    const st = (await get(`/accounting/funds/${fund}/statement`, 'accountant')).body;
    expect(st.income.reduce((s: number, g: any) => s + g.amount, 0)).toBe(income);
    expect(st.spending.reduce((s: number, g: any) => s + g.amount, 0)).toBe(spent);
    expect(st.spending.map((g: any) => g.category).sort()).toEqual(['عجز العهد', 'مشتريات مواد']);
  });
});

describe('الصناديق: المحجوز والمقيَّد', () => {
  let building: string, restricted: string, familyId: string, contractorId: string;
  const project = (fundId: string) => ({ familyId, contractorId, fundId, location: 'النزال', contractDate: '2026-09-01', durationDays: 90, stages: [{ name: 'الأساس', amount: 12_000_000 }, { name: 'الهيكل', amount: 12_000_000 }] });

  it('الصندوق المقيَّد ببرنامج لا يُبنى منه', async () => {
    const f = await post('/families', 'researcher', family({ housing: 'OTHER' }));
    familyId = (await post(`/families/${f.body.id}/approve`, 'supervisor')).body.id;
    contractorId = (await post('/housing/contractors', 'projects', { name: 'جاسم محمد خلف الجميلي', phone: '07708841120' })).body.id;
    const programId = (await post('/programs', 'admin', { name: 'كفالة الأيتام', kind: 'MONEY', unit: 'دينار', rules: {}, amount: { type: 'FIXED', value: 50_000 } })).body.id;
    restricted = (await post('/accounting/funds', 'accountant', { name: 'صندوق الأيتام', programId })).body.id;
    await post('/accounting/receipts', 'accountant', { fundId: restricted, amount: 30_000_000, party: 'كافل', description: 'كفالات' });
    const no = await post('/housing/projects', 'projects', project(restricted));
    expect(no.status).toBe(409);
    expect(no.body.message).toContain('مقيَّد ببرنامج «كفالة الأيتام»');
  });

  it('سند الصرف لا يأكل ما حُجز لمنزل يُبنى', async () => {
    building = (await post('/accounting/funds', 'accountant', { name: 'صندوق البناء' })).body.id;
    await post('/accounting/receipts', 'accountant', { fundId: building, amount: 30_000_000, party: 'متبرع', description: 'للبناء' });
    const p = await post('/housing/projects', 'projects', project(building));
    expect((await post(`/housing/projects/${p.body.id}/approve`, 'projects2')).body.status).toBe('ACTIVE');
    expect(await fundOf(building)).toMatchObject({ cash: 30_000_000, reserved: 24_000_000, available: 6_000_000 });
    const big = await post('/accounting/payments', 'accountant', { fundId: building, amount: 10_000_000, party: 'تاجر', description: 'مواد', category: 'مشتريات مواد' });
    // كان يُعتمد لأن النقد 30 مليوناً، فيصير المتاح سالباً والمنزل بلا تمويل.
    const no = await post(`/accounting/entries/${big.body.id}/approve`, 'accountant2');
    expect(no.status).toBe(409);
    expect(no.body.message).toContain('24,000,000 محجوزة');
    const ok = await post('/accounting/payments', 'accountant', { fundId: building, amount: 6_000_000, party: 'تاجر', description: 'مواد', category: 'مشتريات مواد' });
    expect((await post(`/accounting/entries/${ok.body.id}/approve`, 'accountant2')).body.status).toBe('POSTED');
    expect(await fundOf(building)).toMatchObject({ cash: 24_000_000, available: 0 });
  });
});

describe('القاعدة نفسها تمنع العبث بالدفتر', () => {
  it('القيد لا يُبدَّل مبلغه ولا يُحذف ولا يُفرَّغ جدوله، ولو بأمر مباشر على القاعدة', async () => {
    await expect(sql('update ledger_entries set amount = amount + 1 where id = (select id from ledger_entries limit 1)')).rejects.toThrow(/immutable/);
    await expect(sql('update ledger_entries set fund_id = $1 where id = (select id from ledger_entries limit 1)', [fund])).resolves.toBeDefined();
    await expect(sql("update ledger_entries set status = 'REJECTED' where status = 'POSTED'")).rejects.toThrow(/keeps its status/);
    await expect(sql('delete from ledger_entries where id = (select id from ledger_entries limit 1)')).rejects.toThrow();
    await expect(sql('truncate ledger_entries cascade')).rejects.toThrow(/never truncated/);
    await expect(sql('truncate audit_log')).rejects.toThrow(/append-only/);
  });
});

describe('الجرد', () => {
  it('لا جرد ثانٍ لصنف له تسوية تنتظر الاعتماد', async () => {
    const item = (await post('/inventory/items', 'keeper', { name: 'سلة غذائية', unit: 'سلة' })).body.id;
    const main = (await get('/inventory/stock', 'keeper')).body.warehouses.find((w: any) => w.main).id;
    await post('/inventory/moves', 'keeper', { kind: 'RECEIPT', itemId: item, toWarehouseId: main, quantity: 25, source: 'متبرع' });
    const take = await post('/inventory/stocktake', 'keeper', { warehouseId: main, counts: [{ itemId: item, counted: 22 }], note: 'جرد الشهر' });
    expect(take.body.differences).toHaveLength(1);
    // كان يُنشئ تسوية ثانية للفرق نفسه، فإن اعتُمدتا خُصم مرتين.
    const again = await post('/inventory/stocktake', 'keeper', { warehouseId: main, counts: [{ itemId: item, counted: 22 }], note: 'جرد الشهر' });
    expect(again.status).toBe(409);
    expect(again.body.message).toContain('تسوية جرد تنتظر الاعتماد');
  });
});
