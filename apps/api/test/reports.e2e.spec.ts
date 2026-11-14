import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { toCsv } from '../src/reports/reports.service';
import { family, login, sql, startApp, uniqueName } from './helpers';

let app: INestApplication;
const tokens: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });
const post = (path: string, user: string, body: any = {}) => api().post(`/api${path}`).set(as(user)).send(body);
const get = (path: string, user: string) => api().get(`/api${path}`).set(as(user));

let d22: string, d5: string, fundId: string, campaignId: string;
const fams: any[] = [];

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'researcher', 'supervisor', 'manager', 'manager2', 'distributor', 'accountant', 'accountant2', 'keeper', 'auditor']) tokens[u] = await login(app, u);
  for (let i = 0; i < 4; i++) {
    const f = family({ address: { mahalla: 'الجولان' } });
    f.members.push({ relation: 'SON', fullName: uniqueName(6600 + i), gender: 'M', isOrphan: true, documents: [] });
    const created = await post('/families', 'researcher', f);
    fams.push((await post(`/families/${created.body.id}/approve`, 'supervisor')).body);
  }
});
afterAll(async () => {
  await app.close();
});

describe('CSV', () => {
  it('يبدأ بعلامة BOM، ويحمي من الصيغ، ويضاعف علامات التنصيص', () => {
    const csv = toCsv(['الاسم', 'ملاحظة'], [['سعاد "أم علي"', '=HYPERLINK("http://x")'], ['+9647701234567', null]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"سعاد ""أم علي"""');
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain(`"'+9647701234567",""`);
  });
});

describe('المتبرعون', () => {
  it('التبرع النقدي سند قبض منسوب إلى متبرعه', async () => {
    expect((await post('/donors', 'manager', { name: 'متبرع' })).status).toBe(403);
    d22 = (await post('/donors', 'accountant', { name: 'متبرع 22', phone: '07701112233' })).body.id;
    d5 = (await post('/donors', 'accountant', { name: 'متبرع 5' })).body.id;
    expect((await post('/donors', 'accountant', { name: 'متبرع 22' })).status).toBe(409);

    const programId = (await post('/programs', 'admin', { name: 'كفالة الأيتام', kind: 'MONEY', unit: 'دينار', rules: { hasOrphans: true }, amount: { type: 'PER_ORPHAN', value: 50_000 } })).body.id;
    fundId = (await post('/accounting/funds', 'accountant', { name: 'صندوق كفالة الأيتام', programId })).body.id;
    const r = await post('/accounting/receipts', 'accountant', { fundId, amount: 600_000, description: 'لكفالة الأيتام', donorId: d22 });
    expect(r.status).toBe(201);
    await post('/accounting/receipts', 'accountant', { fundId, amount: 200_000, description: 'لكفالة الأيتام', donorId: d5 });
    expect((await post('/accounting/receipts', 'accountant', { fundId, amount: 1, description: 'بلا مصدر' })).status).toBe(400);
    expect((await post('/accounting/receipts', 'accountant', { fundId, amount: 1, description: 'متبرع مجهول', donorId: randomUUID() })).status).toBe(400);
    const list = (await get('/donors', 'auditor')).body;
    expect(list.find((d: any) => d.id === d22)).toMatchObject({ cash: 600_000, inKindReceipts: 0 });
    const entry = (await get('/accounting/entries', 'auditor')).body.find((e: any) => e.id === r.body.id);
    expect(entry.party).toBe('متبرع 22');
  });

  it('تقرير المتبرع: نصيبه مما صُرف بالتناسب مع حصته من وارد الصندوق', async () => {
    const programId = (await sql("select id from programs where name = 'كفالة الأيتام'")).rows[0].id;
    const pointId = (await post('/points', 'manager', { name: 'الجولان' })).body.id;
    const c = await post('/campaigns', 'manager', { name: 'كفالة الشهر', programId, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [pointId], fundId });
    campaignId = c.body.id;
    await post(`/campaigns/${campaignId}/submit`, 'manager');
    await post(`/campaigns/${campaignId}/approve`, 'manager2');
    const toks = (await get(`/campaigns/${campaignId}/tokens`, 'manager')).body;
    const distributorId = (await sql("select id from users where username = 'distributor'")).rows[0].id;
    await post('/accounting/custody/issue', 'accountant', { fundId, userId: distributorId, amount: 200_000 });
    for (const t of toks.slice(0, 3)) await post('/deliveries/redeem', 'distributor', { pointId, deviceId: 'd1', locate: { token: t.token }, receiver: { kind: 'HEAD' }, clientOpId: randomUUID() });

    // وارد الصندوق 800,000: لمتبرع 22 منه 75%. صُرف 150,000: نصيبه 112,500.
    const r = (await get(`/donors/${d22}/report`, 'auditor')).body;
    expect(r).toMatchObject({ totalGiven: 600_000, totalSpentShare: 112_500 });
    expect(r.cash[0]).toMatchObject({ fund: 'صندوق كفالة الأيتام', restrictedTo: 'كفالة الأيتام', given: 600_000, sharePercent: 75, fundSpent: 150_000, spentShare: 112_500, familiesServedByFund: 3 });
    const other = (await get(`/donors/${d5}/report`, 'auditor')).body;
    expect(other.totalSpentShare).toBe(37_500);
    expect(r.totalSpentShare + other.totalSpentShare).toBe(150_000);
    expect(JSON.stringify(r)).not.toContain(fams[0].members[0].fullName);
    expect((await get(`/donors/${d22}/report`, 'manager')).status).toBe(403);
  });

  it('التبرع العيني وارد مخزن منسوب إلى متبرعه، ويظهر ما وُزِّع منه', async () => {
    const item = (await post('/inventory/items', 'keeper', { name: 'طحين 10 كغم', unit: 'كيس' })).body.id;
    const main = (await get('/inventory/stock', 'keeper')).body.warehouses.find((w: any) => w.main).id;
    await post('/inventory/moves', 'keeper', { kind: 'RECEIPT', itemId: item, toWarehouseId: main, quantity: 300, donorId: d5 });
    const move = (await get('/inventory/moves', 'keeper')).body[0];
    expect(move.source).toBe('متبرع 5');
    const r = (await get(`/donors/${d5}/report`, 'auditor')).body;
    expect(r.inKind).toEqual([{ item: 'طحين 10 كغم', unit: 'كيس', quantity: 300, distributedShare: 0 }]);
    expect((await get('/donors', 'auditor')).body.find((d: any) => d.id === d5).inKindReceipts).toBe(1);
  });
});

describe('التقارير', () => {
  it('الشهري: اثنا عشر شهراً، والشهر الجاري فيه من استلم', async () => {
    const m = (await get('/reports/monthly', 'auditor')).body;
    expect(m).toHaveLength(12);
    expect(m[11]).toMatchObject({ families: 3, deliveries: 3 });
    expect(m[0].families).toBe(0);
  });

  it('كشف العوائل يُصدَّر بالعربية، ويُسجَّل باسم مصدّره', async () => {
    expect((await get('/reports/families.csv', 'distributor')).status).toBe(403);
    const res = await get('/reports/families.csv?status=APPROVED', 'supervisor');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toContain('"رقم العائلة","رب الأسرة","الحال","الفئة"');
    expect(lines).toHaveLength(5);
    expect(res.text).toContain(`"${fams[0].familyNo}"`);
    expect(res.text).toContain('"معتمد"');
    const log = (await get('/audit?limit=1', 'auditor')).body[0];
    expect(log).toMatchObject({ action: 'report.export', actor: 'supervisor', payload: { status: 'APPROVED', rows: 4 } });
  });

  it('كشف التسليم لحملة: من استلم ومن لم يستلم', async () => {
    const res = await get(`/reports/campaign/${campaignId}.csv`, 'manager');
    const lines = res.text.trim().split('\r\n');
    expect(lines).toHaveLength(5);
    expect(lines.filter((l) => l.includes('"استلم"'))).toHaveLength(3);
    expect(lines.filter((l) => l.includes('"لم يستلم"'))).toHaveLength(1);
    expect(lines[1]).toContain('"رب الأسرة"');
    expect(lines[1]).toContain('"distributor"');
  });

  it('تقادم التقييم: ملف لم يُمسّ منذ سنة يظهر، والتعديل المعتمَد يُخرجه', async () => {
    expect((await get('/reports/stale?months=12', 'auditor')).body).toEqual([]);
    await sql("update families set decided_at = now() - interval '14 months' where id = any($1)", [[fams[0].id, fams[1].id]]);
    const stale = (await get('/reports/stale?months=12', 'auditor')).body;
    expect(stale.map((s: any) => s.familyNo).sort()).toEqual([fams[0].familyNo, fams[1].familyNo].sort());
    const req = await post(`/families/${fams[0].id}/changes`, 'researcher', { type: 'UPDATE_FAMILY', payload: { housing: 'OWNED' }, reason: 'إعادة تقييم' });
    await post(`/changes/${req.body.id}/approve`, 'supervisor');
    expect((await get('/reports/stale?months=12', 'auditor')).body.map((s: any) => s.familyNo)).toEqual([fams[1].familyNo]);
  });

  it('عمليات الموظفين في مدة، من سجل التدقيق', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(new Date());
    const staff = (await get(`/reports/staff?from=${today}&to=${today}`, 'auditor')).body;
    const d = staff.find((s: any) => s.username === 'distributor');
    expect(d.actions['delivery.redeem']).toBe(3);
    expect(staff.find((s: any) => s.username === 'researcher').actions['family.create']).toBe(4);
    expect((await get('/reports/staff?from=2020-01-01&to=2020-01-31', 'auditor')).body).toEqual([]);
    expect((await get(`/reports/staff?from=${today}&to=${today}`, 'manager')).status).toBe(403);
  });
});
