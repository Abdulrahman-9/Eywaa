import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { family, login, PASSWORD, sql, startApp } from './helpers';

let app: INestApplication;
const tokens: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });
const post = (path: string, user: string, body: any = {}) => api().post(`/api${path}`).set(as(user)).send(body);
const patch = (path: string, user: string, body: any = {}) => api().patch(`/api${path}`).set(as(user)).send(body);
const get = (path: string, user: string) => api().get(`/api${path}`).set(as(user));

let fund: string, fund2: string, agentId: string, agent2Id: string, box: string, familyNo: string;
const custodyOf = async (user: string) => Number((await sql(
  `select coalesce(sum(l.debit - l.credit), 0) as b from ledger_lines l join ledger_entries e on e.id = l.entry_id
   where e.status = 'POSTED' and l.account = 'CUSTODY:' || (select id from users where username = $1)`, [user])).rows[0].b);
const cashOf = async (fundId: string) => Number((await sql(
  "select coalesce(sum(l.debit - l.credit), 0) as b from ledger_lines l join ledger_entries e on e.id = l.entry_id where e.status = 'POSTED' and l.account = 'CASH' and e.fund_id = $1", [fundId])).rows[0].b);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'researcher', 'supervisor', 'manager', 'manager2', 'distributor', 'agent', 'agent2', 'auditor', 'accountant', 'accountant2', 'keeper']) tokens[u] = await login(app, u);
  fund = (await sql("select id from funds where name = 'الصندوق العام'")).rows[0].id;
  fund2 = (await post('/accounting/funds', 'accountant', { name: 'صندوق الأيتام' })).body.id;
  agentId = (await sql("select id from users where username = 'agent'")).rows[0].id;
  agent2Id = (await sql("select id from users where username = 'agent2'")).rows[0].id;
  const created = await post('/families', 'researcher', family());
  await post(`/families/${created.body.id}/approve`, 'supervisor');
  familyNo = (await sql('select family_no from families where id = $1', [created.body.id])).rows[0].family_no;
});
afterAll(async () => {
  await app.close();
});

describe('حساب المتعهد', () => {
  it('المدير وحده يضيف المتعهد، وهاتفه لازم', async () => {
    const body = { username: 'agent3', fullName: 'سعد المتعهد', password: PASSWORD, role: 'DISTRIBUTION_AGENT' };
    expect((await post('/users', 'manager', { ...body, phone: '07701234567' })).status).toBe(403);
    const noPhone = await post('/users', 'admin', body);
    expect(noPhone.status).toBe(400);
    expect(noPhone.body.message).toContain('هاتف');
    expect((await post('/users', 'admin', { ...body, phone: '123' })).status).toBe(400);
    const ok = await post('/users', 'admin', { ...body, phone: '٠٧٧٠ ١٢٣ ٤٥٦٧' });
    expect(ok.status).toBe(201);
    expect(ok.body.phone).toBe('07701234567');
    // غير المتعهد لا يُلزم بهاتف.
    expect((await post('/users', 'admin', { username: 'clerk', fullName: 'كاتب', password: PASSWORD, role: 'DISTRIBUTOR' })).status).toBe(201);
    // ولا يُنزع هاتف المتعهد.
    expect((await patch(`/users/${ok.body.id}`, 'admin', { phone: null })).status).toBe(400);
    const moved = await patch(`/users/${ok.body.id}`, 'admin', { phone: '07809998877', fullName: 'سعد حميد' });
    expect(moved.body).toMatchObject({ phone: '07809998877', fullName: 'سعد حميد' });
    await patch(`/users/${agentId}`, 'admin', { phone: '07711111111' });
  });
});

describe('صناديق التبرعات', () => {
  it('المحاسب ينشئ الصندوق ويعيّن له متعهداً', async () => {
    const body = { location: 'أسواق الجولان', address: 'شارع المستشفى', hostName: 'أبو أحمد', hostPhone: '07901112233', fundId: fund, agentId, installedOn: daysAgo(100).slice(0, 10) };
    expect((await post('/boxes', 'manager', body)).status).toBe(403);
    expect((await post('/boxes', 'agent', body)).status).toBe(403);
    expect((await post('/boxes', 'accountant', { ...body, agentId: (await sql("select id from users where username = 'distributor'")).rows[0].id })).status).toBe(400);
    const b = await post('/boxes', 'accountant', body);
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({ code: '1', location: 'أسواق الجولان', agentName: 'agent', openings: 0, total: 0, status: 'ACTIVE', stale: true, expectedNow: null });
    box = b.body.id;
    expect((await post('/boxes', 'accountant', { ...body, code: '1' })).status).toBe(409);
    const list = (await get('/boxes', 'auditor')).body;
    expect(list.summary).toMatchObject({ active: 1, stale: 1, neverOpened: 1, unassigned: 0, collectedThisMonth: 0 });
    expect(list.summary.monthly).toHaveLength(12);
    expect((await get('/boxes', 'agent')).status).toBe(403);
  });

  it('المتعهد يفتح صندوقه فيدخل ما عُدّ ذمتَه بسند قبض، ويُبلَّغ صاحب الموقع', async () => {
    const op = randomUUID();
    const c = await post(`/boxes/${box}/collections`, 'agent', { amount: 90_000, collectedAt: daysAgo(70), sealNo: 'خ-11', clientOpId: op });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ amount: 90_000, code: '1', direct: false, expected: null, low: false });
    expect(c.body.entryNo).toMatch(/^ق-/);
    expect(await custodyOf('agent')).toBe(90_000);
    expect(await cashOf(fund)).toBe(0);
    // إعادة الرفع لا تكرّر.
    expect((await post(`/boxes/${box}/collections`, 'agent', { amount: 90_000, clientOpId: op })).body.id).toBe(c.body.id);
    expect(await custodyOf('agent')).toBe(90_000);
    const entry = (await sql('select kind, status, category, custody_user, party from ledger_entries where id = $1', [c.body.entryId])).rows[0];
    expect(entry).toMatchObject({ kind: 'RECEIPT', status: 'POSTED', category: 'BOX', custody_user: agentId });
    expect(entry.party).toContain('أسواق الجولان');
    const msg = (await sql('select phone, text from messages where box_collection_id = $1', [c.body.id])).rows[0];
    expect(msg.phone).toBe('07901112233');
    expect(msg.text).toContain('90,000');
    expect(msg.text).toContain('أبو أحمد');
    // الإيراد محسوب للصندوق من ساعته ولو كان في ذمة محصِّله.
    const f = (await get('/accounting/summary', 'accountant')).body.funds.find((x: any) => x.id === fund);
    expect(f).toMatchObject({ cash: 0, custody: 90_000, available: 90_000 });
  });

  it('لا يفتح صندوقَ غيره، ولا يسجّل باسم غيره، ولا في المستقبل', async () => {
    expect((await post(`/boxes/${box}/collections`, 'agent2', { amount: 1000 })).status).toBe(403);
    expect((await post(`/boxes/${box}/collections`, 'agent', { amount: 1000, collectedBy: agent2Id })).status).toBe(403);
    expect((await post(`/boxes/${box}/collections`, 'agent', { amount: 1000, direct: true })).status).toBe(403);
    expect((await post(`/boxes/${box}/collections`, 'agent', { amount: 1000, collectedAt: new Date(Date.now() + 3_600_000).toISOString() })).status).toBe(400);
    expect((await post(`/boxes/${box}/collections`, 'manager', { amount: 1000 })).status).toBe(403);
    expect(await custodyOf('agent')).toBe(90_000);
  });

  it('الفتح الفارغ يُسجَّل بلا قيد، وما دون نصف المعتاد يُعلَّم', async () => {
    await post(`/boxes/${box}/collections`, 'agent', { amount: 60_000, collectedAt: daysAgo(40) });
    const empty = await post(`/boxes/${box}/collections`, 'agent', { amount: 0, collectedAt: daysAgo(39), note: 'فُتح قبل يوم' });
    expect(empty.body).toMatchObject({ amount: 0, entryNo: null, entryId: null });
    // ثلاث فتحات سبقت: 150,000 في 61 يوماً. بعد 39 يوماً يُنتظر نحو 95,900؛ فـ 20,000 دون نصفه.
    const low = await post(`/boxes/${box}/collections`, 'agent', { amount: 20_000 });
    expect(low.body.expected).toBeGreaterThan(90_000);
    expect(low.body.expected).toBeLessThan(100_000);
    expect(low.body.low).toBe(true);
    const b = (await get(`/boxes/${box}`, 'accountant')).body;
    expect(b).toMatchObject({ openings: 4, total: 170_000, average: 42_500, lastAmount: 20_000, lastBy: 'agent', daysSince: 0, stale: false });
    expect(b.expectedNow).toBeGreaterThan(0);
    expect(b.collections.map((x: any) => x.amount)).toEqual([20_000, 0, 60_000, 90_000]);
    expect(b.collections[0].low).toBe(true);
    expect(await custodyOf('agent')).toBe(170_000);
  });

  it('المحاسب يسجّل تحصيل متعهد، أو فتحاً في المركز يدخل النقد مباشرة', async () => {
    expect((await post(`/boxes/${box}/collections`, 'accountant', { amount: 5000 })).status).toBe(400);
    const forAgent = await post(`/boxes/${box}/collections`, 'accountant', { amount: 5000, collectedBy: agent2Id });
    expect(forAgent.status).toBe(201);
    expect(await custodyOf('agent2')).toBe(5000);
    const direct = await post(`/boxes/${box}/collections`, 'accountant', { amount: 7000, direct: true });
    expect(direct.body.direct).toBe(true);
    expect(await cashOf(fund)).toBe(7000);
    expect(await custodyOf('accountant')).toBe(0);
  });

  it('رفع الصندوق من موقعه بسبب، والمرفوع لا يُحصَّل', async () => {
    const other = (await post('/boxes', 'accountant', { location: 'صيدلية الشفاء', fundId: fund2, code: 'ش-7' })).body;
    expect(other).toMatchObject({ code: 'ش-7', agentId: null, fund: 'صندوق الأيتام' });
    expect((await patch(`/boxes/${other.id}`, 'accountant', { status: 'RETIRED' })).status).toBe(400);
    const gone = await patch(`/boxes/${other.id}`, 'accountant', { status: 'RETIRED', retireNote: 'أُغلق المحل' });
    expect(gone.body).toMatchObject({ status: 'RETIRED', retireNote: 'أُغلق المحل', stale: false });
    expect((await post(`/boxes/${other.id}/collections`, 'accountant', { amount: 100, direct: true })).status).toBe(409);
    const back = await patch(`/boxes/${other.id}`, 'accountant', { status: 'ACTIVE', agentId: agent2Id, hostName: 'د. علي' });
    expect(back.body).toMatchObject({ status: 'ACTIVE', agentName: 'agent2', hostName: 'د. علي', retireNote: null });
    expect((await patch(`/boxes/${other.id}`, 'manager', { location: 'س' })).status).toBe(403);
  });
});

describe('تبرعات بيد المتعهد', () => {
  let cashId: string, kindId: string, item: string, main: string;

  it('النقدي يدخل ذمته بسند باسم المتبرع، ويُشكر المتبرع بالمبلغ المسجَّل', async () => {
    const before = await custodyOf('agent');
    expect((await post('/agent-donations', 'manager', { kind: 'CASH', donorName: 'حاتم', amount: 1000 })).status).toBe(403);
    expect((await post('/agent-donations', 'agent', { kind: 'CASH', donorName: 'حاتم', amount: 0 })).status).toBe(400);
    const op = randomUUID();
    const d = await post('/agent-donations', 'agent', { kind: 'CASH', donorName: 'حاتم عبد الله', donorPhone: '07905556677', amount: 250_000, purpose: 'كفالة يتيم', clientOpId: op });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ kind: 'CASH', status: 'RECEIVED', amount: 250_000, fund: 'الصندوق العام', donorName: 'حاتم عبد الله', agentName: 'agent' });
    cashId = d.body.id;
    expect((await post('/agent-donations', 'agent', { kind: 'CASH', donorName: 'حاتم عبد الله', amount: 250_000, clientOpId: op })).body.id).toBe(cashId);
    expect(await custodyOf('agent')).toBe(before + 250_000);
    const entry = (await sql('select e.kind, e.category, e.party, d.name as donor from ledger_entries e join donors d on d.id = e.donor_id where e.id = $1', [d.body.entryId])).rows[0];
    expect(entry).toMatchObject({ kind: 'RECEIPT', category: 'AGENT_DONATION', party: 'حاتم عبد الله', donor: 'حاتم عبد الله' });
    const msg = (await sql('select phone, text from messages where agent_donation_id = $1', [cashId])).rows[0];
    expect(msg.phone).toBe('07905556677');
    expect(msg.text).toContain('250,000');
    expect(msg.text).toContain(d.body.entryNo);
    // المتبرع نفسه بهاتفه ولو كُتب اسمه بغير ما سبق؛ وفي صندوق يختاره.
    const again = await post('/agent-donations', 'agent', { kind: 'CASH', donorName: 'ابو علي حاتم', donorPhone: '07905556677', amount: 50_000, fundId: fund2 });
    expect(again.body).toMatchObject({ donorId: d.body.donorId, fund: 'صندوق الأيتام' });
    // وفاعل الخير لا سجل له.
    const anon = await post('/agent-donations', 'agent', { kind: 'CASH', donorName: 'فاعل خير', amount: 10_000 });
    expect(anon.body.donorId).toBeNull();
    expect((await sql('select count(*)::int as n from donors')).rows[0].n).toBe(1);
    const donor = (await get('/donors', 'accountant')).body.find((x: any) => x.id === d.body.donorId);
    expect(donor.cash).toBe(300_000);
  });

  it('العيني بلاغ ينتظر أمين المخزن، يستلمه بما وجد', async () => {
    const d = await post('/agent-donations', 'agent', { kind: 'IN_KIND', donorName: 'مطحنة الفرات', itemText: 'طحين صفر', quantity: 40, unit: 'كيس' });
    expect(d.body).toMatchObject({ kind: 'IN_KIND', status: 'REPORTED', quantity: 40, unit: 'كيس', amount: null, entryNo: null });
    kindId = d.body.id;
    item = (await post('/inventory/items', 'keeper', { name: 'طحين', unit: 'كيس' })).body.id;
    main = (await get('/inventory/stock', 'keeper')).body.warehouses.find((w: any) => w.main).id;
    const open = (await get('/agent-donations?kind=IN_KIND&status=REPORTED', 'keeper')).body;
    expect(open.map((x: any) => x.id)).toEqual([kindId]);
    expect((await post(`/agent-donations/${kindId}/receive`, 'accountant', { itemId: item, warehouseId: main, quantity: 40 })).status).toBe(403);
    const short = await post(`/agent-donations/${kindId}/receive`, 'keeper', { itemId: item, warehouseId: main, quantity: 38 });
    expect(short.status).toBe(400);
    expect(short.body.message).toContain('المبلَّغ 40 والمستلَم 38');
    const ok = await post(`/agent-donations/${kindId}/receive`, 'keeper', { itemId: item, warehouseId: main, quantity: 38, note: 'كيسان ممزقان' });
    expect(ok.body).toMatchObject({ status: 'RECEIVED', receivedQuantity: 38, receivedItem: 'طحين', receivedBy: 'keeper', closeNote: 'كيسان ممزقان' });
    const stock = (await get('/inventory/stock', 'keeper')).body.items.find((x: any) => x.id === item);
    expect(stock.main).toBe(38);
    const move = (await sql('select m.source, d.name from stock_moves m join donors d on d.id = m.donor_id where m.id = (select stock_move_id from agent_donations where id = $1)', [kindId])).rows[0];
    expect(move).toMatchObject({ source: 'مطحنة الفرات', name: 'مطحنة الفرات' });
    expect((await post(`/agent-donations/${kindId}/receive`, 'keeper', { itemId: item, warehouseId: main, quantity: 40 })).status).toBe(409);
  });

  it('البلاغ العيني يُلغى بسبب، والنقدي لا يُلغى بل يُعكس سنده', async () => {
    const d = (await post('/agent-donations', 'agent', { kind: 'IN_KIND', donorName: 'فاعل خير', itemText: 'بطانيات', quantity: 10 })).body;
    expect((await post(`/agent-donations/${d.id}/cancel`, 'manager', {})).status).toBe(400);
    expect((await post(`/agent-donations/${d.id}/cancel`, 'manager', { note: 'عدل المتبرع عن تبرعه' })).body.status).toBe('CANCELLED');
    expect((await post(`/agent-donations/${cashId}/cancel`, 'manager', { note: 'خطأ في المبلغ' })).status).toBe(409);
    const before = await custodyOf('agent');
    const entryId = (await sql('select entry_id from agent_donations where id = $1', [cashId])).rows[0].entry_id;
    const rev = await post(`/accounting/entries/${entryId}/reverse`, 'accountant', { reason: 'سُجّل مرتين' });
    await post(`/accounting/entries/${rev.body.id}/approve`, 'accountant2');
    expect(await custodyOf('agent')).toBe(before - 250_000);
    const list = (await get(`/agent-donations?agentId=${agentId}`, 'auditor')).body;
    expect(list.find((x: any) => x.id === cashId).status).toBe('CANCELLED');
    // أعيده ليبقى الحساب على ما تتوقعه الاختبارات التالية.
    await post('/agent-donations', 'agent', { kind: 'CASH', donorName: 'حاتم عبد الله', amount: 250_000 });
  });
});

describe('ذمة المتعهد', () => {
  it('المحاسب يستلم من ذمته جزءاً فيدخل نقد الصندوق ويبقى الباقي', async () => {
    const book = (await get(`/accounting/custody/${agentId}/statement`, 'accountant')).body;
    expect(book.balance).toBe(await custodyOf('agent'));
    const inFund = book.funds.find((f: any) => f.fundId === fund).balance;
    expect(inFund).toBe(170_000 + 250_000 + 10_000);
    expect(book.lines[0].balance).toBe(book.balance);

    expect((await post('/accounting/custody/receive', 'manager', { fundId: fund, userId: agentId, amount: 1000 })).status).toBe(403);
    expect((await post('/accounting/custody/receive', 'agent', { fundId: fund, userId: agentId, amount: 1000 })).status).toBe(403);
    const over = await post('/accounting/custody/receive', 'accountant', { fundId: fund, userId: agentId, amount: inFund + 1 });
    expect(over.status).toBe(409);
    const cash = await cashOf(fund);
    const r = await post('/accounting/custody/receive', 'accountant', { fundId: fund, userId: agentId, amount: 300_000, note: 'تسليم الخميس' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ book: inFund, remaining: inFund - 300_000 });
    expect(await cashOf(fund)).toBe(cash + 300_000);
    expect(await custodyOf('agent')).toBe(book.balance - 300_000);
    // من يحمل ذمة لا يستلمها من نفسه.
    await post(`/boxes/${box}/collections`, 'accountant', { amount: 2000, collectedBy: (await sql("select id from users where username = 'accountant'")).rows[0].id });
    const self = await post('/accounting/custody/receive', 'accountant', { fundId: fund, userId: (await sql("select id from users where username = 'accountant'")).rows[0].id, amount: 2000 });
    expect(self.status).toBe(403);
  });

  it('كشف حساب الصندوق برصيد جارٍ، ومصادر إيراده، وسند يُطبع', async () => {
    const st = (await get(`/accounting/funds/${fund}/statement`, 'auditor')).body;
    expect(st.closing).toBe(await cashOf(fund));
    expect(st.opening).toBe(0);
    expect(st.lines[st.lines.length - 1].balance).toBe(st.closing);
    expect(st.received - st.paid).toBe(st.closing);
    expect(st.custody).toBeGreaterThan(0);
    const box = st.income.find((x: any) => x.category === 'BOX');
    expect(box.amount).toBe(170_000 + 5000 + 7000 + 2000);
    // المعكوس خرج من الإيراد.
    expect(st.income.find((x: any) => x.category === 'AGENT_DONATION').amount).toBe(250_000 + 10_000);
    const future = (await get(`/accounting/funds/${fund}/statement?from=2099-01-01`, 'auditor')).body;
    expect(future).toMatchObject({ opening: st.closing, closing: st.closing, lines: [] });
    const v = (await get(`/accounting/entries/${st.lines[0].id}`, 'auditor')).body;
    expect(v.lines).toHaveLength(2);
    expect(v.lines.reduce((s: number, l: any) => s + l.debit - l.credit, 0)).toBe(0);
    expect((await get(`/accounting/funds/${fund}/statement`, 'agent')).status).toBe(403);
  });
});

describe('الذمة العينية', () => {
  it('ما حُوّل إلى مخزن المتعهد يؤكد استلامه أو يبلّغ عن فرق فيه', async () => {
    await post(`/agents/${agentId}/point`, 'manager');
    const stock = (await get('/inventory/stock', 'keeper')).body;
    const main = stock.warehouses.find((w: any) => w.main).id;
    const item = stock.items[0].id;
    const mine = (await get('/agent/me', 'agent')).body;
    expect(mine.goods).toMatchObject({ balances: [], transfers: [] });
    const wh = mine.goods.warehouseId ?? (await get('/inventory/stock', 'keeper')).body.warehouses.find((w: any) => w.name.includes('المتعهد')).id;
    const t1 = (await post('/inventory/moves', 'keeper', { kind: 'TRANSFER', itemId: item, fromWarehouseId: main, toWarehouseId: wh, quantity: 20 })).body.id;
    const t2 = (await post('/inventory/moves', 'keeper', { kind: 'TRANSFER', itemId: item, fromWarehouseId: main, toWarehouseId: wh, quantity: 5 })).body.id;
    const goods = (await get('/agent/me', 'agent')).body.goods;
    expect(goods.balances).toEqual([expect.objectContaining({ item: 'طحين', quantity: 25 })]);
    expect(goods.transfers.filter((t: any) => t.needsAck)).toHaveLength(2);

    expect((await post(`/agent/goods/${t1}/ack`, 'agent2', { ok: true })).status).toBe(404);
    expect((await post(`/agent/goods/${t2}/ack`, 'agent', { ok: false })).status).toBe(400);
    await post(`/agent/goods/${t1}/ack`, 'agent', { ok: true });
    const after = (await post(`/agent/goods/${t2}/ack`, 'agent', { ok: false, note: 'وصلت أربعة لا خمسة' })).body;
    expect(after.transfers.filter((t: any) => t.needsAck)).toHaveLength(0);
    expect(after.transfers.find((t: any) => t.id === t2).ack).toMatchObject({ ok: false, note: 'وصلت أربعة لا خمسة' });
    // الشهادة لا تُبدَّل بعد أدائها.
    await post(`/agent/goods/${t2}/ack`, 'agent', { ok: true });
    expect((await sql('select ok from custody_acks where stock_move_id = $1', [t2])).rows[0].ok).toBe(false);
  });
});

describe('مسؤول النقطة في الحملة', () => {
  it('متعهد يتولى نقطة ثابتة في حملة فتصير عوائلها حصته', async () => {
    for (let i = 0; i < 3; i++) {
      const f = await post('/families', 'researcher', family());
      await post(`/families/${f.body.id}/approve`, 'supervisor');
    }
    const fixed = (await post('/points', 'manager', { name: 'جامع الفرقان' })).body.id;
    const own = (await post(`/agents/${agentId}/point`, 'manager')).body.id;
    const programId = (await post('/programs', 'admin', { name: 'لحوم الأضاحي', kind: 'IN_KIND', unit: 'كغم', rules: {}, amount: { type: 'FIXED', value: 2 } })).body.id;
    const camp = (await post('/campaigns', 'manager', { name: 'أضاحي العيد', programId, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [fixed, own] })).body.id;
    await post(`/campaigns/${camp}/submit`, 'manager');
    await post(`/campaigns/${camp}/approve`, 'manager2');

    expect((await get(`/campaigns/${camp}/manifest?pointId=${fixed}`, 'agent2')).status).toBe(403);
    expect((await post(`/campaigns/${camp}/points/${fixed}/lead`, 'agent', { agentId: agent2Id })).status).toBe(403);
    expect((await post(`/campaigns/${camp}/points/${own}/lead`, 'manager', { agentId: agent2Id })).status).toBe(409);
    expect((await post(`/campaigns/${camp}/points/${fixed}/lead`, 'manager', { agentId: (await sql("select id from users where username = 'distributor'")).rows[0].id })).status).toBe(400);
    const set = await post(`/campaigns/${camp}/points/${fixed}/lead`, 'manager', { agentId: agent2Id });
    expect(set.body.points.find((p: any) => p.id === fixed)).toMatchObject({ leadId: agent2Id, leadName: 'agent2' });

    const mine = (await get('/agent/assignments', 'agent2')).body;
    expect(mine).toEqual([expect.objectContaining({ campaignId: camp, pointId: fixed, families: 2 })]);
    const m = (await get(`/campaigns/${camp}/manifest?pointId=${fixed}`, 'agent2')).body;
    expect(m.entries).toHaveLength(2);
    const toks = (await get(`/campaigns/${camp}/tokens`, 'manager')).body;
    const ids = new Set(m.entries.map((e: any) => e.id));
    const inQuota = toks.find((t: any) => ids.has(t.entitlementId));
    const outQuota = toks.find((t: any) => !ids.has(t.entitlementId));
    const redeem = (token: string) => post('/deliveries/redeem', 'agent2', { pointId: fixed, deviceId: 'phone-2', locate: { token }, receiver: { kind: 'HEAD' }, clientOpId: randomUUID() });
    expect((await redeem(inQuota.token)).status).toBe(200);
    expect((await redeem(outQuota.token)).status).toBe(409);

    // يُرفع عنه فلا يعود يعمل منها.
    await post(`/campaigns/${camp}/points/${fixed}/lead`, 'manager', { agentId: null });
    expect((await get(`/campaigns/${camp}/manifest?pointId=${fixed}`, 'agent2')).status).toBe(403);
    expect((await get('/agent/assignments', 'agent2')).body).toEqual([]);
  });
});

describe('طلبات المتعهد', () => {
  it('يرفع طلب إضافة عائلة، وطلب تعديل عائلة برقمها', async () => {
    const q = await post('/quick-requests', 'agent', { headName: 'كريم جبار سلمان', mahalla: 'الجولان', note: 'أرملة وخمسة أيتام' });
    expect(q.status).toBe(201);
    expect((await post('/agent/family-requests', 'agent', { familyNo: '99999', reason: 'توفي رب الأسرة' })).status).toBe(404);
    expect((await post('/agent/family-requests', 'agent', { familyNo, reason: 'قصير' })).status).toBe(400);
    expect((await post('/agent/family-requests', 'manager', { familyNo, reason: 'توفي رب الأسرة' })).status).toBe(403);
    const r = await post('/agent/family-requests', 'agent', { familyNo, reason: 'توفي رب الأسرة وانتقلت العائلة' });
    expect(r.body).toMatchObject({ familyNo, already: false });
    // للعائلة طلب قائم واحد: الثاني لا يُكرَّر ولا يُرفض.
    expect((await post('/agent/family-requests', 'agent2', { familyNo, reason: 'تغيّر عنوانهم إلى حي آخر' })).body).toMatchObject({ already: true, id: r.body.id });
    const open = (await get('/reassessments?status=OPEN', 'supervisor')).body;
    expect(open.find((x: any) => x.id === r.body.id)).toMatchObject({ source: 'AGENT', reason: 'توفي رب الأسرة وانتقلت العائلة' });

    const mine = (await get('/agent/me', 'agent')).body;
    expect(mine.requests.additions[0]).toMatchObject({ headName: 'كريم جبار سلمان', status: 'NEW' });
    expect(mine.requests.edits[0]).toMatchObject({ familyNo, status: 'OPEN' });
    expect(mine.phone).toBe('07711111111');
    expect(mine.boxes.map((b: any) => b.code)).toEqual(['1']);
    expect(mine.funds.map((f: any) => f.name)).toEqual(['الصندوق العام', 'صندوق الأيتام']);
    expect(mine.custody.balance).toBe(await custodyOf('agent'));
    expect((await get('/agent/me', 'manager')).status).toBe(403);
  });
});

describe('متابعة المتعهدين', () => {
  it('لكل متعهد ملخص بذمته ونشاطه وما يستوجب النظر', async () => {
    expect((await get('/agents/overview', 'agent')).status).toBe(403);
    expect((await get('/agents/overview', 'distributor')).status).toBe(403);
    const o = (await get('/agents/overview', 'auditor')).body;
    expect(o.agents.map((a: any) => a.username).sort()).toEqual(['agent', 'agent2', 'agent3']);
    const a = o.agents.find((x: any) => x.username === 'agent');
    expect(a).toMatchObject({ phone: '07711111111', custody: await custodyOf('agent'), boxes: 1, staleBoxes: 0, goods: 25, goodsItems: 1, unacked: 0, disputes: 1, openReports: 0 });
    expect(a.last30).toMatchObject({ collections: 1, collected: 20_000, cashDonations: 4, inKindDonations: 2, additions: 1, edits: 1 });
    expect(a.alerts.some((t: string) => t.includes('بلاغ فرق'))).toBe(true);
    const a3 = o.agents.find((x: any) => x.username === 'agent3');
    expect(a3.alerts).toContain('لا نقطة توزيع له');
    expect(o.totals.agents).toBe(3);
    expect(o.totals.custody).toBe(a.custody + (await custodyOf('agent2')));
  });

  it('ذمة لم يُسلَّم منها منذ أكثر من أسبوع تُعلَّم', async () => {
    await sql("update ledger_entries set created_at = now() - interval '12 days' where custody_user = $1", [agent2Id]);
    const a2 = (await get('/agents/overview', 'manager')).body.agents.find((x: any) => x.username === 'agent2');
    expect(a2.custodyDays).toBe(12);
    expect(a2.alerts.some((t: string) => t.includes('منذ 12 يوماً دون تسليم'))).toBe(true);
    // والصندوق الذي لم يُفتح منذ أكثر من ثلاثين يوماً يُعدّ عليه.
    expect(a2.staleBoxes).toBe(0);
    await sql("update donation_boxes set installed_on = current_date - 45 where agent_id = $1", [agent2Id]);
    expect((await get('/agents/overview', 'manager')).body.agents.find((x: any) => x.username === 'agent2').staleBoxes).toBe(1);
  });

  it('ملف المتعهد: كشف ذمته وصناديقه وتبرعاته وحملاته وسجل نشاطه', async () => {
    const d = (await get(`/agents/${agentId}`, 'accountant')).body;
    expect(d.custodyStatement.balance).toBe(d.custody);
    expect(d.boxList).toHaveLength(1);
    expect(d.collections.length).toBeGreaterThanOrEqual(4);
    expect(d.donations.length).toBe(6);
    expect(d.campaigns[0]).toMatchObject({ name: 'أضاحي العيد', lead: false });
    expect(d.requests.edits).toHaveLength(1);
    const texts = d.timeline.map((t: any) => t.text);
    expect(texts.some((t: string) => t.startsWith('فتح الصندوق 1 وعدّ فيه 20,000'))).toBe(true);
    expect(texts.some((t: string) => t.includes('سجّل تبرعاً نقدياً 250,000 من حاتم عبد الله'))).toBe(true);
    expect(texts.some((t: string) => t.startsWith('سلّم المحاسبَ 300,000 من ذمته'))).toBe(true);
    expect(texts.some((t: string) => t.includes('بلّغ عن فرق في طحين'))).toBe(true);
    expect(texts.some((t: string) => t.includes('طلب تعديل بيانات عائلة'))).toBe(true);
    // وما سجّله المحاسب باسم متعهد يظهر في ملف ذلك المتعهد.
    const d2 = (await get(`/agents/${agent2Id}`, 'manager')).body;
    expect(d2.timeline.some((t: any) => t.text.startsWith('فتح الصندوق 1 وعدّ فيه 5,000'))).toBe(true);
    expect((await get(`/agents/${agentId}`, 'agent')).status).toBe(403);
    expect((await get(`/agents/${randomUUID()}`, 'manager')).status).toBe(404);
  });
});
