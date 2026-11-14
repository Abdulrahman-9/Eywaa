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

let campaignId: string, fixed: string, agentPoint: string, agent2Point: string, toks: any[];
const redeem = (token: string, pointId: string, user: string) =>
  post('/deliveries/redeem', user, { pointId, deviceId: `dev-${user}`, locate: { token }, receiver: { kind: 'HEAD' }, clientOpId: randomUUID() });

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'researcher', 'supervisor', 'manager', 'manager2', 'distributor', 'agent', 'agent2', 'auditor']) tokens[u] = await login(app, u);
  for (let i = 0; i < 9; i++) {
    const created = await post('/families', 'researcher', family());
    await post(`/families/${created.body.id}/approve`, 'supervisor');
  }
});
afterAll(async () => {
  await app.close();
});

describe('المتعهدون', () => {
  it('لكل متعهد نقطة واحدة باسمه، يُنشئها مدير التوزيع', async () => {
    const agents = (await get('/agents', 'manager')).body;
    expect(agents.map((a: any) => a.username).sort()).toEqual(['agent', 'agent2']);
    expect(agents.every((a: any) => a.pointId === null)).toBe(true);
    expect((await get('/agents', 'agent')).status).toBe(403);
    const a = agents.find((x: any) => x.username === 'agent');
    const p = await post(`/agents/${a.id}/point`, 'manager');
    expect(p.body).toMatchObject({ agentId: a.id, active: true });
    expect(p.body.name).toContain('المتعهد');
    agentPoint = p.body.id;
    expect((await post(`/agents/${a.id}/point`, 'manager')).body.id).toBe(agentPoint);
    agent2Point = (await post(`/agents/${agents.find((x: any) => x.username === 'agent2').id}/point`, 'manager')).body.id;
    const notAgent = (await sql("select id from users where username = 'distributor'")).rows[0].id;
    expect((await post(`/agents/${notAgent}/point`, 'manager')).status).toBe(400);
  });

  it('الحملة تقسم العوائل على النقطة الثابتة والمتعهدَين، وكلٌّ يرى حصته وحدها', async () => {
    fixed = (await post('/points', 'manager', { name: 'المركز' })).body.id;
    const programId = (await post('/programs', 'admin', { name: 'لحوم الصدقات', kind: 'IN_KIND', unit: 'كغم', rules: {}, amount: { type: 'FIXED', value: 2 } })).body.id;
    const c = await post('/campaigns', 'manager', { name: 'لحوم الجمعة', programId, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [fixed, agentPoint, agent2Point] });
    campaignId = c.body.id;
    await post(`/campaigns/${campaignId}/submit`, 'manager');
    await post(`/campaigns/${campaignId}/approve`, 'manager2');
    toks = (await get(`/campaigns/${campaignId}/tokens`, 'manager')).body;
    const detail = (await get(`/campaigns/${campaignId}`, 'manager')).body;
    expect(detail.points.map((p: any) => p.assigned)).toEqual([3, 3, 3]);
    expect(detail.points.filter((p: any) => p.agentName).length).toBe(2);

    const mine = (await get('/agent/assignments', 'agent')).body;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ campaignId, pointId: agentPoint, families: 3, delivered: 0, quantity: 6, unit: 'كغم' });
    expect((await get('/agent/assignments', 'distributor')).status).toBe(403);
    // المتعهد لا يدخل لوحة الإدارة: لا قائمة حملات ولا عوائل.
    expect((await get('/campaigns', 'agent')).status).toBe(403);
    expect((await get('/families', 'agent')).status).toBe(403);
  });

  it('بيان المتعهد حصته وحدها، ولا يأخذ بيان نقطة غيره', async () => {
    const m = await get(`/campaigns/${campaignId}/manifest?pointId=${agentPoint}`, 'agent');
    expect(m.status).toBe(200);
    expect(m.body.entries).toHaveLength(3);
    expect((await get(`/campaigns/${campaignId}/manifest?pointId=${agent2Point}`, 'agent')).status).toBe(403);
    expect((await get(`/campaigns/${campaignId}/manifest?pointId=${fixed}`, 'agent')).status).toBe(403);
  });

  it('المتعهد يسلّم من حصته، ولا يسلّم لعائلة من حصة غيره ولو كان متصلاً', async () => {
    const own = toks.find((t) => t.point.includes('المتعهد') && t.point === (toks.find((x) => x.entitlementId) && t.point));
    const mineToks = toks.filter((t) => t.point !== 'المركز');
    const m = (await get(`/campaigns/${campaignId}/manifest?pointId=${agentPoint}`, 'agent')).body;
    const ids = new Set(m.entries.map((e: any) => e.id));
    const inQuota = toks.find((t) => ids.has(t.entitlementId));
    const outQuota = toks.find((t) => !ids.has(t.entitlementId) && t.point !== 'المركز');
    const atCenter = toks.find((t) => t.point === 'المركز');
    expect(own ?? mineToks[0]).toBeTruthy();

    expect((await redeem(inQuota.token, agentPoint, 'agent')).status).toBe(200);
    for (const t of [outQuota, atCenter]) {
      const r = await redeem(t.token, agentPoint, 'agent');
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: 'NOT_THIS_DEVICE', message: 'لا تسلّم: هذه العائلة ليست من حصتك' });
    }
    // ولا يعمل من نقطة غيره.
    expect((await redeem(outQuota.token, agent2Point, 'agent')).status).toBe(403);
    // والموظف في النقطة الثابتة يسلّم لأي عائلة والجهاز متصل، كما كان.
    expect((await redeem(outQuota.token, fixed, 'distributor')).status).toBe(200);
    expect((await get('/agent/assignments', 'agent')).body[0].delivered).toBe(1);
  });

  it('مزامنة المتعهد من هاتفه المنقطع: من نقطته فقط', async () => {
    const m = (await get(`/campaigns/${campaignId}/manifest?pointId=${agentPoint}`, 'agent')).body;
    const pending = m.entries.filter((e: any) => e.status === 'PENDING');
    const items = pending.map((e: any) => ({ entitlementId: e.id, deliveredAt: new Date().toISOString(), clientOpId: randomUUID(), receiver: 'HEAD', receiverName: e.headName }));
    expect((await post('/deliveries/sync', 'agent', { pointId: agent2Point, deviceId: 'phone', items })).status).toBe(403);
    const ok = await post('/deliveries/sync', 'agent', { pointId: agentPoint, deviceId: 'phone', items });
    expect(ok.body.applied).toBe(pending.length);
    const detail = (await get(`/campaigns/${campaignId}`, 'manager')).body;
    const row = detail.points.find((p: any) => p.id === agentPoint);
    expect(row).toMatchObject({ assigned: 3, delivered: 3 });
  });
});

describe('التخويل الاستثنائي لغير المسجَّلين', () => {
  let grantId: string, agentId: string;
  const add = (body: any, user = 'agent', id = grantId) => post(`/grants/${id}/cases`, user, { clientOpId: randomUUID(), ...body });

  beforeAll(async () => {
    agentId = (await sql("select id from users where username = 'agent'")).rows[0].id;
  });

  it('يصدره مدير التوزيع لمتعهد في الحملة، بسقف ومدة وسبب؛ ولا تخويلان قائمان معاً', async () => {
    const body = { agentId, maxCases: 3, perCase: 2, hours: 6, reason: 'تأخر الوقت وبقي لحم لا يحتمل' };
    expect((await post(`/campaigns/${campaignId}/grants`, 'agent', body)).status).toBe(403);
    expect((await post(`/campaigns/${campaignId}/grants`, 'manager', { ...body, reason: '' })).status).toBe(400);
    const notInCampaign = (await sql("select id from users where username = 'distributor'")).rows[0].id;
    expect((await post(`/campaigns/${campaignId}/grants`, 'manager', { ...body, agentId: notInCampaign })).status).toBe(400);
    const g = await post(`/campaigns/${campaignId}/grants`, 'manager', body);
    expect(g.status).toBe(201);
    expect(g.body).toMatchObject({ state: 'ACTIVE', maxCases: 3, perCase: 2, used: 0, remaining: 3, createdBy: 'manager', cases: [] });
    grantId = g.body.id;
    expect((await post(`/campaigns/${campaignId}/grants`, 'manager', body)).status).toBe(409);
    expect((await get('/agent/grants', 'agent')).body.map((x: any) => x.id)).toEqual([grantId]);
    expect((await get('/agent/grants', 'agent2')).body).toEqual([]);
  });

  it('الحالة يكفيها الاسم، وتصير طلب تسجيل سريع موسوماً بالتخويل', async () => {
    expect((await add({ headName: '' })).status).toBe(400);
    expect((await add({ headName: 'عابر سبيل بلا تخويل' }, 'agent2')).status).toBe(403);
    const op = randomUUID();
    const res = await post(`/grants/${grantId}/cases`, 'agent', { headName: 'حمزة عدنان فاضل الزيدي', clientOpId: op });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ headName: 'حمزة عدنان فاضل الزيدي', quantity: 2, warnings: [], by: 'agent', quickStatus: 'NEW' });
    // إعادة الرفع من هاتف انقطع لا تكرّر الحالة ولا تأكل من السقف.
    expect((await post(`/grants/${grantId}/cases`, 'agent', { headName: 'حمزة عدنان فاضل الزيدي', clientOpId: op })).body.id).toBe(res.body.id);
    expect((await get(`/campaigns/${campaignId}/grants`, 'manager')).body[0]).toMatchObject({ used: 1, remaining: 2 });
    const q = (await get(`/quick-requests/${res.body.quickRequestId}`, 'supervisor')).body;
    expect(q).toMatchObject({ source: 'EMERGENCY', campaignName: 'لحوم الجمعة', headName: 'حمزة عدنان فاضل الزيدي' });
  });

  it('الاسم نفسه لا يُصرف له مرتين في الحملة، ولو كُتب بإملاء آخر أو عند متعهد آخر', async () => {
    const again = await add({ headName: 'حمزه عدنان فاضل الزيدى' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'ALREADY_SERVED' });
    expect(again.body.message).toContain('صُرف في هذه الحملة');
    const a2 = (await sql("select id from users where username = 'agent2'")).rows[0].id;
    const g2 = (await post(`/campaigns/${campaignId}/grants`, 'manager2', { agentId: a2, maxCases: 5, perCase: 2, hours: 2, reason: 'نقطة ثانية للفائض' })).body.id;
    expect((await add({ headName: 'حمزة عدنان فاضل الزيدي' }, 'agent2', g2)).body.code).toBe('ALREADY_SERVED');
    // والهاتف نفسه باسم آخر كذلك.
    await add({ headName: 'نزار قيس مهند الطائي', phone: '07708880001' });
    expect((await add({ headName: 'اسم مستعار لا يشبه', phone: '0770 888 0001' })).body.code).toBe('ALREADY_SERVED');
  });

  it('المسجَّل الذي له رمز في الحملة لا يُصرف له بالتخويل؛ والمسجَّل خارجها يُصرف له بتنبيه', async () => {
    const inCampaign = toks[0];
    const refused = await add({ headName: inCampaign.headName });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('HAS_ENTITLEMENT');
    expect(refused.body.message).toContain(inCampaign.familyNo);

    const f = family();
    f.members[0].fullName = 'رياض محسن علوان الخفاجي';
    const outside = (await post('/families', 'researcher', f)).body;
    const warned = await add({ headName: 'رياض محسن علوان الخفاجي' });
    expect(warned.status).toBe(201);
    expect(warned.body.warnings).toEqual([`يشبه مسجَّلاً: العائلة ${outside.familyNo}`]);
  });

  it('السقف لا يُتجاوز، والمنتهي والمسحوب لا يُصرف بهما، وحالة الهاتف المنقطع تُقاس بوقتها', async () => {
    // صُرفت 3 (حمزة، نزار، رياض): استُنفد.
    const full = await add({ headName: 'رابع فوق السقف للتجربة' });
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('GRANT_FULL');

    const a2 = (await sql("select id from users where username = 'agent2'")).rows[0].id;
    const g2 = (await get(`/campaigns/${campaignId}/grants`, 'manager')).body.find((g: any) => g.agentId === a2);
    // انتهت مدته قبل دقيقة.
    await sql("update emergency_grants set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' where id = $1", [g2.id]);
    expect((await add({ headName: 'بعد انتهاء المدة للتجربة' }, 'agent2', g2.id)).body.code).toBe('GRANT_CLOSED');
    // لكن حالة وقعت قبل الانتهاء والهاتف منقطع، ورُفعت بعده: تُقبل بوقتها.
    const late = await add({ headName: 'وقعت قبل الانتهاء ورُفعت بعده', deliveredAt: new Date(Date.now() - 10 * 60_000).toISOString() }, 'agent2', g2.id);
    expect(late.status).toBe(201);
    expect(late.body.warnings).toEqual(['رُفعت بعد انتهاء التخويل أو سحبه، بوقت يقوله الهاتف']);
    expect((await get('/agent/grants', 'agent2')).body).toEqual([]);
    expect((await get(`/grants/${g2.id}/revoke`, 'manager')).status).toBe(404);
    expect((await post(`/grants/${g2.id}/revoke`, 'manager', {})).status).toBe(400);
    expect((await post(`/grants/${g2.id}/revoke`, 'manager', { note: 'انتهى التوزيع' })).body.state).toBe('REVOKED');
    expect((await add({ headName: 'بعد السحب للتجربة' }, 'agent2', g2.id)).body.code).toBe('GRANT_CLOSED');
  });

  it('من صُرف له بتخويل في حملة سابقة ولم يُستكمل تسجيله: يُصرف له ثانية بتنبيه', async () => {
    const programId = (await sql("select id from programs where name = 'لحوم الصدقات'")).rows[0].id;
    await sql('update programs set min_gap_days = 0 where id = $1', [programId]);
    await post(`/campaigns/${campaignId}/close`, 'manager');
    for (let i = 0; i < 2; i++) { const c = await post('/families', 'researcher', family()); await post(`/families/${c.body.id}/approve`, 'supervisor'); }
    const c2 = await post('/campaigns', 'manager', { name: 'لحوم الجمعة التالية', programId, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [agentPoint] });
    await post(`/campaigns/${c2.body.id}/submit`, 'manager');
    await post(`/campaigns/${c2.body.id}/approve`, 'manager2');
    const g = (await post(`/campaigns/${c2.body.id}/grants`, 'manager', { agentId, maxCases: 2, perCase: 2, hours: 1, reason: 'فائض بعد المغرب' })).body;
    const res = await add({ headName: 'حمزة عدنان فاضل الزيدي' }, 'agent', g.id);
    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual(['صُرف له بتخويل من قبل 1 مرة ولم يُستكمل تسجيله']);
  });

  it('المدير يرى التخويل بحالاته وتنبيهاتها، والتخويل لا يصدر لحملة مالية، والسلسلة سليمة', async () => {
    const all = (await get(`/campaigns/${campaignId}/grants`, 'auditor')).body;
    const mine = all.find((g: any) => g.id === grantId);
    expect(mine.cases).toHaveLength(3);
    expect(mine.cases.filter((c: any) => c.warnings.length)).toHaveLength(1);
    expect(mine.state).toBe('EXPIRED');
    const money = (await post('/programs', 'admin', { name: 'نقدي', kind: 'MONEY', unit: 'دينار', rules: {}, amount: { type: 'FIXED', value: 1000 } })).body.id;
    const fund = (await post('/accounting/funds', 'admin', { name: 'صندوق نقدي', programId: money })).body.id;
    await post('/accounting/receipts', 'admin', { fundId: fund, amount: 1_000_000, party: 'متبرع', description: 'تجربة' });
    const c = await post('/campaigns', 'manager', { name: 'نقدية', programId: money, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [agentPoint], fundId: fund });
    await post(`/campaigns/${c.body.id}/submit`, 'manager');
    await post(`/campaigns/${c.body.id}/approve`, 'manager2');
    const refused = await post(`/campaigns/${c.body.id}/grants`, 'manager', { agentId, maxCases: 1, perCase: 1000, hours: 1, reason: 'تجربة مالية' });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain('العينية');
    expect((await get('/audit/verify', 'auditor')).body.ok).toBe(true);
  });
});
