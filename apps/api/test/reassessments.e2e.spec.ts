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

let fam: any, other: any, researcher2: string;

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'researcher', 'researcher2', 'supervisor', 'distributor', 'auditor']) tokens[u] = await login(app, u);
  const make = async (extra: any = {}) => {
    const created = await post('/families', 'researcher', family(extra));
    return (await post(`/families/${created.body.id}/approve`, 'supervisor')).body;
  };
  fam = await make({ incomes: [{ kind: 'WORK', amountIqd: 100_000 }] });
  other = await make();
  researcher2 = (await sql("select id from users where username = 'researcher2'")).rows[0].id;
});
afterAll(async () => {
  await app.close();
});

describe('إعادة التقييم عند الطلب', () => {
  let id: string;

  it('تُفتح لعائلة معتمدة بسبب ومصدر، وللعائلة طلب قائم واحد', async () => {
    expect((await post('/reassessments', 'distributor', { familyId: fam.id, source: 'FAMILY', reason: 'طلبت العائلة' })).status).toBe(403);
    expect((await post('/reassessments', 'supervisor', { familyId: fam.id, source: 'FAMILY', reason: '' })).status).toBe(400);
    const pending = await post('/families', 'researcher', family());
    expect((await post('/reassessments', 'supervisor', { familyId: pending.body.id, source: 'STAFF', reason: 'تجربة' })).status).toBe(409);
    expect((await post('/reassessments', 'supervisor', { familyId: fam.id, source: 'STAFF', reason: 'تجربة', assignedTo: (await sql("select id from users where username = 'distributor'")).rows[0].id })).status).toBe(400);

    const res = await post('/reassessments', 'supervisor', { familyId: fam.id, source: 'FAMILY', reason: 'توفي معيلها وانقطع دخلها', assignedTo: researcher2 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'OPEN', source: 'FAMILY', familyNo: fam.familyNo, assignedTo: 'researcher2', openedBy: 'supervisor' });
    id = res.body.id;
    expect((await post('/reassessments', 'researcher', { familyId: fam.id, source: 'STAFF', reason: 'مرة ثانية' })).status).toBe(409);
  });

  it('الباحث يرى ما عليه زيارته: المسند إليه وغير المسند إلى أحد', async () => {
    await post('/reassessments', 'supervisor', { familyId: other.id, source: 'STAFF', reason: 'مضى على تقييمها عامان' });
    const mine = (await get('/reassessments?mine=true', 'researcher2')).body;
    expect(mine.map((r: any) => r.familyNo).sort()).toEqual([fam.familyNo, other.familyNo].sort());
    expect(mine[0]).toHaveProperty('phone');
    const others = (await get('/reassessments?mine=true', 'researcher')).body;
    expect(others.map((r: any) => r.familyNo)).toEqual([other.familyNo]);
  });

  it('الزيارة يسجّلها المسند إليه لا باحث غيره، ولا تُغلق قبلها', async () => {
    expect((await post(`/reassessments/${id}/close`, 'supervisor')).status).toBe(409);
    expect((await post(`/reassessments/${id}/visit`, 'researcher', { findings: 'زرتُ الدار ورأيتُ حالها', outcome: 'CHANGED' })).status).toBe(403);
    expect((await post(`/reassessments/${id}/visit`, 'researcher2', { findings: 'قصير', outcome: 'CHANGED' })).status).toBe(400);
    const op = randomUUID();
    const visit = { findings: 'المعيل توفي في أيلول. لا دخل للعائلة الآن، والدار إيجار.', outcome: 'CHANGED', clientOpId: op, visitedAt: new Date(Date.now() - 3600_000).toISOString() };
    const res = await post(`/reassessments/${id}/visit`, 'researcher2', visit);
    expect(res.body).toMatchObject({ status: 'VISITED', visitedBy: 'researcher2', outcome: 'CHANGED' });
    // إعادة الرفع من هاتف انقطع اتصاله لا تكرّر ولا تُرفض.
    const again = await post(`/reassessments/${id}/visit`, 'researcher2', visit);
    expect(again.status).toBe(200);
    expect(again.body.visitedAt).toBe(res.body.visitedAt);
    expect((await post(`/reassessments/${id}/cancel`, 'supervisor', { note: 'لا حاجة' })).status).toBe(409);
  });

  it('لا تُغلق وطلب تعديلها معلّق، ولا يغلقها من زار', async () => {
    const change = await post(`/families/${fam.id}/changes`, 'researcher2', { type: 'SET_INCOMES', payload: { incomes: [] }, reason: 'انقطع الدخل بوفاة المعيل' });
    expect(change.status).toBe(201);
    const blocked = await post(`/reassessments/${id}/close`, 'supervisor');
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toContain('طلب تعديل معلّق');
    await post(`/changes/${change.body.id}/approve`, 'supervisor');

    // مشرف زار بنفسه لا يغلق زيارته.
    const own = (await get(`/reassessments?familyId=${other.id}`, 'supervisor')).body[0];
    await post(`/reassessments/${own.id}/visit`, 'supervisor', { findings: 'زرتُها بنفسي ولم يتغيّر من حالها شيء.', outcome: 'NO_CHANGE' });
    expect((await post(`/reassessments/${own.id}/close`, 'supervisor')).status).toBe(403);
    expect((await post(`/reassessments/${own.id}/close`, 'admin', { note: 'مطابق' })).body.status).toBe('CLOSED');
  });

  it('الإغلاق يعتمد الزيارة، وتخرج العائلة من تقرير التقادم', async () => {
    await sql("update families set decided_at = now() - interval '3 years' where id = $1", [fam.id]);
    await sql("update change_requests set decided_at = now() - interval '2 years' where family_id = $1", [fam.id]);
    const stale = () => get('/reports/stale?months=12', 'supervisor');
    expect((await stale()).body.some((r: any) => r.familyNo === fam.familyNo)).toBe(true);

    const res = await post(`/reassessments/${id}/close`, 'supervisor', { note: 'اعتُمدت الزيارة' });
    expect(res.body).toMatchObject({ status: 'CLOSED', closedBy: 'supervisor' });
    expect((await stale()).body.some((r: any) => r.familyNo === fam.familyNo)).toBe(false);
    expect((await post(`/reassessments/${id}/close`, 'admin')).status).toBe(409);
    // أُغلق القديم، فيُفتح جديد.
    const next = await post('/reassessments', 'researcher', { familyId: fam.id, source: 'FAMILY', reason: 'طلب جديد بعد عام' });
    expect(next.status).toBe(201);
    expect((await post(`/reassessments/${next.body.id}/cancel`, 'researcher', { note: 'x' })).status).toBe(403);
    expect((await post(`/reassessments/${next.body.id}/cancel`, 'supervisor', { note: 'فُتح خطأً' })).body.status).toBe('CANCELLED');
  });

  it('العدّاد في الرئيسية، والسجل في التدقيق، والسلسلة سليمة', async () => {
    const o = (await get('/stats/overview', 'supervisor')).body;
    expect(o.visitedReassessments).toBe(0);
    const actions = (await sql("select action, count(*)::int as n from audit_log where action like 'reassessment.%' group by action order by action")).rows;
    expect(actions).toEqual([
      { action: 'reassessment.cancel', n: 1 }, { action: 'reassessment.close', n: 2 }, { action: 'reassessment.open', n: 3 }, { action: 'reassessment.visit', n: 2 },
    ]);
    expect((await get('/audit/verify', 'auditor')).body.ok).toBe(true);
  });
});
