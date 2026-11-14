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

let campaignId: string, fundId: string, pointId: string, toks: any[], candidates: any[];
const fund = async () => (await get('/accounting/summary', 'accountant')).body.funds.find((f: any) => f.id === fundId);
const redeem = (token: string, user = 'distributor') =>
  post('/deliveries/redeem', user, { pointId, deviceId: 'desk-1', locate: { token }, clientOpId: randomUUID(), receiver: { kind: 'HEAD' } });

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'researcher', 'supervisor', 'manager', 'manager2', 'distributor', 'accountant', 'accountant2', 'auditor']) tokens[u] = await login(app, u);
  // ست عوائل، إحداها بلا هاتف.
  for (let i = 0; i < 6; i++) {
    const created = await post('/families', 'researcher', family(i === 5 ? { phone1: undefined } : {}));
    await post(`/families/${created.body.id}/approve`, 'supervisor');
  }
  const programId = (await post('/programs', 'admin', { name: 'مساعدة نقدية', kind: 'MONEY', unit: 'دينار', rules: {}, amount: { type: 'FIXED', value: 100_000 } })).body.id;
  fundId = (await post('/accounting/funds', 'accountant', { name: 'صندوق المساعدة النقدية', programId })).body.id;
  await post('/accounting/receipts', 'accountant', { fundId, amount: 1_000_000, party: 'متبرع', description: 'للمساعدة النقدية' });
  pointId = (await post('/points', 'manager', { name: 'المركز' })).body.id;
  const c = await post('/campaigns', 'manager', { name: 'مساعدة تشرين', programId, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [pointId], fundId });
  campaignId = c.body.id;
  await post(`/campaigns/${campaignId}/submit`, 'manager');
  await post(`/campaigns/${campaignId}/approve`, 'manager2');
  toks = (await get(`/campaigns/${campaignId}/tokens`, 'manager')).body;
});
afterAll(async () => {
  await app.close();
});

describe('كشف الدفع بالحوالة والمحفظة', () => {
  let batchId: string;

  it('المرشحون مستحقو الحملة الذين لم يُصرف لهم، ومن لا هاتف له لا يدخل كشفاً', async () => {
    expect((await get(`/campaigns/${campaignId}/payout-candidates`, 'distributor')).status).toBe(403);
    candidates = (await get(`/campaigns/${campaignId}/payout-candidates`, 'accountant')).body;
    expect(candidates).toHaveLength(6);
    const noPhone = candidates.find((c) => !c.phone);
    expect(noPhone).toBeTruthy();
    const bad = await post('/payouts', 'accountant', { campaignId, method: 'WALLET', provider: 'زين كاش', entitlementIds: [noPhone.entitlementId] });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain('بلا رقم هاتف');
  });

  it('الكشف يُنشأ معلّقاً: لا يُعدّ أحد مستلِماً، ولا ينقص الصندوق', async () => {
    const chosen = candidates.filter((c) => c.phone).slice(0, 4).map((c) => c.entitlementId);
    const res = await post('/payouts', 'accountant', { campaignId, method: 'WALLET', provider: 'زين كاش', entitlementIds: chosen });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'PENDING_APPROVAL', items: 4, total: 400_000, createdBy: 'accountant' });
    expect(res.body.lines).toHaveLength(4);
    batchId = res.body.id;
    expect(await fund()).toMatchObject({ cash: 1_000_000, reserved: 600_000 });
    expect((await get(`/campaigns/${campaignId}`, 'manager')).body.totals.delivered).toBe(0);
    expect((await get(`/campaigns/${campaignId}/payout-candidates`, 'accountant')).body).toHaveLength(2);
  });

  it('من في كشف معلّق لا يدخل كشفاً آخر، ولا يُصرف له نقداً', async () => {
    const line = (await get(`/payouts/${batchId}`, 'accountant')).body.lines[0];
    const again = await post('/payouts', 'accountant2', { campaignId, method: 'TRANSFER', provider: 'مكتب الصيرفة', entitlementIds: [line.entitlementId] });
    expect(again.status).toBe(409);
    const tok = toks.find((t) => t.entitlementId === line.entitlementId);
    const cash = await redeem(tok.token);
    expect(cash.status).toBe(409);
    expect(cash.body).toMatchObject({ code: 'IN_PAYOUT' });
    expect(cash.body.message).toContain('كشف الدفع رقم');
  });

  it('ملف الدفع فيه الاسم والرقم والمبلغ، ورقم الهاتف يحفظ صفره، وتنزيله يُسجَّل', async () => {
    const res = await get(`/payouts/${batchId}/file.csv`, 'accountant');
    expect(res.status).toBe(200);
    const rows = res.text.replace('﻿', '').trim().split('\r\n');
    expect(rows[0]).toBe('"الاسم","رقم العائلة","رقم المحفظة","المبلغ (دينار)"');
    expect(rows).toHaveLength(5);
    expect(rows[1]).toMatch(/,"=""0770\d{7}""","100000"$/);
    const log = await sql("select count(*)::int as n from audit_log where action = 'payout.export'");
    expect(log.rows[0].n).toBe(1);
  });

  it('لا يعتمده من أنشأه، ولا يُعتمد بلا مرجع التنفيذ', async () => {
    expect((await post(`/payouts/${batchId}/approve`, 'accountant', { reference: 'ZC-1' })).status).toBe(403);
    expect((await post(`/payouts/${batchId}/approve`, 'manager', { reference: 'ZC-1' })).status).toBe(403);
    expect((await post(`/payouts/${batchId}/approve`, 'accountant2', {})).status).toBe(400);
  });

  it('من استلم نقداً من جهاز منقطع قبل الاعتماد لا يُدفع له ثانية', async () => {
    const line = (await get(`/payouts/${batchId}`, 'accountant')).body.lines[3];
    const synced = await post('/deliveries/sync', 'distributor', { pointId, deviceId: 'phone-1', items: [
      { entitlementId: line.entitlementId, deliveredAt: new Date().toISOString(), clientOpId: randomUUID(), receiver: 'HEAD', receiverName: line.recipient,
        proof: { token: toks.find((t) => t.entitlementId === line.entitlementId).token } },
    ] });
    expect(synced.body.applied).toBe(1);
    // والحملة لا تُقفل وكشف دفعها معلّق: لو أُقفلت لبقي ما نُفّذ عند المزوّد بلا قيد.
    const close = await post(`/campaigns/${campaignId}/close`, 'manager');
    expect(close.status).toBe(409);
    expect(close.body.message).toContain('كشف دفع');
  });

  it('الاعتماد بمرجعه يعدّ الباقين مستلِمين، ويقيّد المبلغ على الصندوق قيداً واحداً، ويُبلغ كل عائلة', async () => {
    const before = (await sql("select count(*)::int as n from notifications where title = 'تأكيد التحويل'")).rows[0].n;
    const res = await post(`/payouts/${batchId}/approve`, 'accountant2', { reference: 'ZC-2026-0042' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'PAID', paidItems: 3, paidTotal: 300_000, reference: 'ZC-2026-0042', decidedBy: 'accountant2' });
    expect(res.body.lines.filter((l: any) => l.paid === true)).toHaveLength(3);
    expect(res.body.lines.find((l: any) => l.paid === false).skipReason).toBe('استلم نقداً قبل اعتماد الكشف');

    const d = (await get(`/campaigns/${campaignId}`, 'manager')).body;
    expect(d.totals.delivered).toBe(4);
    expect(d.recent.filter((r: any) => r.mode === 'TRANSFER')).toHaveLength(3);
    // النقد نقص 300,000 بالتحويل؛ والمئة ألف النقدية من عهدة الموزّع لا من نقد الصندوق.
    expect(await fund()).toMatchObject({ cash: 700_000, reserved: 200_000 });
    const entries = await sql("select amount, description from ledger_entries where description like '%كشف دفع%'");
    expect(entries.rows).toHaveLength(1);
    expect(Number(entries.rows[0].amount)).toBe(300_000);
    expect(entries.rows[0].description).toContain('ZC-2026-0042');
    const after = (await sql("select count(*)::int as n from notifications where title = 'تأكيد التحويل'")).rows[0].n;
    expect(after - before).toBe(3);
    const tb = (await get('/accounting/trial-balance', 'auditor')).body;
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it('المدفوع له بالتحويل يُرفض رمزه عند الشبّاك، ولا يُعتمد الكشف مرتين', async () => {
    const paid = (await get(`/payouts/${batchId}`, 'auditor')).body.lines.find((l: any) => l.paid);
    const tok = toks.find((t) => t.entitlementId === paid.entitlementId);
    const cash = await redeem(tok.token);
    expect(cash.status).toBe(409);
    expect(cash.body.code).toBe('ALREADY_DELIVERED');
    expect((await post(`/payouts/${batchId}/approve`, 'accountant2', { reference: 'ZC-2' })).status).toBe(409);
  });

  it('الكشف المرفوض يحرّر أصحابه: يُصرف لهم نقداً أو يدخلون كشفاً آخر', async () => {
    const left = (await get(`/campaigns/${campaignId}/payout-candidates`, 'accountant')).body.filter((c: any) => c.phone);
    expect(left).toHaveLength(1);
    const b = await post('/payouts', 'manager', { campaignId, method: 'TRANSFER', provider: 'مكتب الصيرفة', entitlementIds: [left[0].entitlementId] });
    expect(b.status).toBe(201);
    expect((await post(`/payouts/${b.body.id}/reject`, 'accountant', {})).status).toBe(400);
    const rejected = await post(`/payouts/${b.body.id}/reject`, 'accountant', { note: 'المكتب مغلق هذا الأسبوع' });
    expect(rejected.body).toMatchObject({ status: 'REJECTED', decisionNote: 'المكتب مغلق هذا الأسبوع' });
    const tok = toks.find((t) => t.entitlementId === left[0].entitlementId);
    expect((await redeem(tok.token)).status).toBe(200);
  });

  it('لا كشف دفع لحملة عينية، ولا يتجاوز الدفع نقد الصندوق', async () => {
    const inKind = (await post('/programs', 'admin', { name: 'سلة', kind: 'IN_KIND', unit: 'سلة', rules: {}, amount: { type: 'FIXED', value: 1 } })).body.id;
    const c = await post('/campaigns', 'manager', { name: 'سلة', programId: inKind, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [pointId] });
    await post(`/campaigns/${c.body.id}/submit`, 'manager');
    await post(`/campaigns/${c.body.id}/approve`, 'manager2');
    expect((await get(`/campaigns/${c.body.id}/payout-candidates`, 'accountant')).status).toBe(400);

    // النقد كله يخرج عهدة، فلا يبقى في الصندوق ما يُحوَّل منه.
    const last = (await get(`/campaigns/${campaignId}/payout-candidates`, 'accountant')).body;
    await sql("update families set phone1 = '07701112223' where family_no = $1", [last[0].familyNo]);
    const b = await post('/payouts', 'accountant', { campaignId, method: 'WALLET', provider: 'زين كاش', entitlementIds: [last[0].entitlementId] });
    const distributorId = (await sql("select id from users where username = 'distributor'")).rows[0].id;
    const cash = (await fund()).cash;
    expect((await post('/accounting/custody/issue', 'accountant', { fundId, userId: distributorId, amount: cash })).status).toBe(201);
    const refused = await post(`/payouts/${b.body.id}/approve`, 'accountant2', { reference: 'ZC-9' });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain('نقد الصندوق لا يكفي');
    expect((await get(`/payouts/${b.body.id}`, 'auditor')).body.status).toBe('PENDING_APPROVAL');
  });

  it('اسم يبدأ بعلامة صيغة لا يُنفَّذ في ملف الدفع', async () => {
    const evil = family();
    evil.members[0].fullName = "=HYPERLINK(\"http://x\",\"اضغط\")";
    const created = await post('/families', 'researcher', evil);
    await post(`/families/${created.body.id}/approve`, 'supervisor');
    const programId = (await sql("select id from programs where name = 'مساعدة نقدية'")).rows[0].id;
    await post('/accounting/receipts', 'accountant', { fundId, amount: 500_000, party: 'متبرع', description: 'زيادة' });
    const c = await post('/campaigns', 'manager', { name: 'حملة الصيغة', programId, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [pointId], fundId });
    await post(`/campaigns/${c.body.id}/submit`, 'manager');
    expect((await post(`/campaigns/${c.body.id}/approve`, 'manager2')).body.status).toBe('ACTIVE');
    const cand = (await get(`/campaigns/${c.body.id}/payout-candidates`, 'accountant')).body.find((x: any) => x.headName.startsWith('='));
    expect(cand).toBeTruthy();
    const b = await post('/payouts', 'accountant', { campaignId: c.body.id, method: 'WALLET', provider: 'زين كاش', entitlementIds: [cand.entitlementId] });
    const file = await get(`/payouts/${b.body.id}/file.csv`, 'accountant');
    const row = file.text.trim().split('\r\n')[1];
    expect(row.startsWith('"\'=HYPERLINK(')).toBe(true);
  });

  it('سلسلة التدقيق سليمة', async () => {
    expect((await get('/audit/verify', 'auditor')).body.ok).toBe(true);
  });
});
