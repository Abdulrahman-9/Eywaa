import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { family, login, sql, startApp } from './helpers';

let app: INestApplication;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });
const post = (path: string, user: string, body: any = {}) => api().post(`/api${path}`).set(as(user)).send(body);
const get = (path: string, user: string) => api().get(`/api${path}`).set(as(user));

/** عائلة معتمدة سجّلها الباحث واعتمدها المشرف. */
async function approved(overrides: Record<string, any> = {}, registrar = 'researcher', approver = 'supervisor') {
  const body = family(overrides);
  const created = await post('/families', registrar, body);
  await post(`/families/${created.body.id}/approve`, approver);
  const no = (await sql('select family_no from families where id = $1', [created.body.id])).rows[0].family_no as string;
  return { id: created.body.id as string, no, body };
}
const score = async (id: string) => (await get(`/families/${id}/score`, 'supervisor')).body;
const assign = (familyIds: string[], inspectors: string[], extra: Record<string, any> = {}, user = 'supervisor') =>
  post('/inspections', user, { familyIds, inspectorIds: inspectors.map((u) => ids[u]), ...extra });
const ALL_MATCH = ['address', 'housing', 'members', 'head', 'income', 'orphans', 'health', 'phone'].map((key) => ({ key, result: 'MATCH' }));
const confirm = (extra: Record<string, any> = {}) => ({ contact: 'FAMILY', checks: ALL_MATCH, recommendation: 'CONFIRM', ...extra });

let f1: Awaited<ReturnType<typeof approved>>, f2: typeof f1, f3: typeof f1, f4: typeof f1, i1: string;

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'researcher', 'researcher2', 'supervisor', 'manager', 'manager2', 'distributor', 'agent', 'agent2', 'auditor']) {
    tokens[u] = await login(app, u);
    ids[u] = (await sql('select id from users where username = $1', [u])).rows[0].id;
  }
  f1 = await approved();
  f2 = await approved();
  f3 = await approved();
  f4 = await approved();
});
afterAll(async () => {
  await app.close();
});

describe('التكليف بالكشف', () => {
  it('المشرف يكلّف متعهداً أو اثنين، ولا يكلّف غيره ولا يُكلَّف غير متعهد أو باحث', async () => {
    expect((await assign([f1.id], ['agent'], {}, 'agent')).status).toBe(403);
    expect((await assign([f1.id], ['agent'], {}, 'manager')).status).toBe(403);
    expect((await assign([f1.id], ['distributor'])).status).toBe(400);
    expect((await assign([f1.id], ['agent', 'agent'])).status).toBe(400);
    const r = await assign([f1.id], ['agent', 'agent2'], { note: 'تحقق من نوع السكن' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ created: 1, skipped: [] });
    i1 = r.body.inspections[0].id;
    // للعائلة كشف قائم واحد.
    expect((await assign([f1.id], ['agent'])).body).toMatchObject({ created: 0, skipped: [{ familyNo: f1.no, reason: 'عليها كشف قائم' }] });
    const detail = (await get(`/inspections/${i1}`, 'auditor')).body;
    expect(detail).toMatchObject({ status: 'ASSIGNED', familyNo: f1.no, assigned: 2, submitted: 0, waiting: false, note: 'تحقق من نوع السكن', cap: 10 });
    expect(detail.reports.map((x: any) => x.inspector).sort()).toEqual(['agent', 'agent2']);
    expect(detail.family.facts).toHaveLength(8);
    expect((await get(`/inspections/${i1}`, 'agent')).status).toBe(403);
  });

  it('من سجّل العائلة لا يكشفها، والقسمة توزّع العوائل بين الكاشفين', async () => {
    expect((await assign([f2.id], ['researcher'])).body).toMatchObject({ created: 0, skipped: [{ familyNo: f2.no, reason: 'من سجّل العائلة لا يكشفها' }] });
    const split = await assign([f2.id, f3.id], ['agent', 'researcher2'], { mode: 'SPLIT' });
    expect(split.body.created).toBe(2);
    const rows = (await get('/inspections?status=ASSIGNED', 'supervisor')).body.filter((x: any) => [f2.no, f3.no].includes(x.familyNo));
    expect(rows.every((x: any) => x.assigned === 1)).toBe(true);
    expect(rows.map((x: any) => x.reports[0].inspector).sort()).toEqual(['agent', 'researcher2']);
  });

  it('حالة الكشف تظهر في جدول العوائل ويُصفّى بها', async () => {
    const all = (await get('/families', 'supervisor')).body;
    expect(all.find((x: any) => x.id === f1.id).inspection).toMatchObject({ state: 'OPEN', at: null, delta: 0 });
    expect(all.find((x: any) => x.id === f4.id).inspection.state).toBe('NONE');
    expect((await get('/families?inspection=NONE', 'supervisor')).body.map((x: any) => x.id)).toEqual([f4.id]);
    expect((await get('/families?inspection=OPEN', 'supervisor')).body).toHaveLength(3);
    expect((await get('/families?inspection=DONE', 'supervisor')).body).toHaveLength(0);
    const c = (await post('/inspections/candidates', 'supervisor', {})).body;
    expect(c.families.map((x: any) => x.familyNo)).toEqual([f4.no]);
    const byNo = (await post('/inspections/candidates', 'supervisor', { familyNos: [f1.no, '999999'] })).body;
    expect(byNo).toMatchObject({ families: [{ familyNo: f1.no, inspecting: true }], unknown: ['999999'] });
    const who = (await get('/inspections/inspectors', 'supervisor')).body;
    expect(who.find((x: any) => x.fullName === 'agent')).toMatchObject({ open: 2, done30: 0 });
    expect(who.map((x: any) => x.role).every((r: string) => ['DISTRIBUTION_AGENT', 'FIELD_RESEARCHER'].includes(r))).toBe(true);
  });
});

describe('تقرير الكاشف', () => {
  it('يرى ما كُلّف به وحده، بصورة العائلة ليطابق، وبلا أرقام وثائق', async () => {
    const mine = (await get('/inspections/mine', 'agent')).body;
    expect(mine.pending.map((x: any) => x.family.familyNo).sort()).toEqual([f1.no, f2.no].sort());
    const task = mine.pending.find((x: any) => x.id === i1);
    expect(task).toMatchObject({ note: 'تحقق من نوع السكن', partner: 'agent2', late: false });
    expect(task.family.facts.map((x: any) => x.key)).toEqual(['address', 'housing', 'members', 'head', 'income', 'orphans', 'health', 'phone']);
    expect(task.family.facts.find((x: any) => x.key === 'housing').recorded).toBe('إيجار');
    expect(task.family.facts.find((x: any) => x.key === 'members').recorded).toBe('فرد واحد');
    expect(task.family.facts.find((x: any) => x.key === 'income').recorded).toBe('لا دخل مسجَّل');
    expect(task.family.facts.find((x: any) => x.key === 'head').recorded).toBe('أرملة');
    expect(task.family.members[0]).toMatchObject({ relation: 'رب الأسرة', isOrphan: false });
    expect(JSON.stringify(mine)).not.toContain(f1.body.members[0].documents[0].number);
    expect((await get('/inspections/mine', 'distributor')).status).toBe(403);
    expect((await get('/inspections/mine', 'researcher')).body.pending).toEqual([]);
  });

  it('يرفض التقرير الناقص: غير مطابق بلا بيان، وتوصية بلا سبب، ومطابقة بلا تحقق', async () => {
    const send = (body: any, user = 'agent') => post(`/inspections/${i1}/report`, user, body);
    expect((await send(confirm({ checks: [{ key: 'housing', result: 'MISMATCH' }] }))).body.message).toContain('نوع السكن');
    expect((await send(confirm({ recommendation: 'RAISE' }))).status).toBe(400);
    expect((await send(confirm({ recommendation: 'REMOVE' }))).body.message).toContain('الشطب');
    expect((await send(confirm({ checks: [] }))).body.message).toContain('لم تتحقق');
    expect((await send(confirm({ contact: 'NONE' }))).body.message).toContain('تعذّر');
    expect((await send(confirm({ visitedAt: new Date(Date.now() + 3_600_000).toISOString() }))).status).toBe(400);
    expect((await send(confirm(), 'researcher2')).status).toBe(403);
    expect((await send(confirm(), 'supervisor')).status).toBe(403);
  });

  it('كلٌّ يرفع تقريره مستقلاً، وإعادة الرفع لا تكرّر', async () => {
    const op = randomUUID();
    const body = { contact: 'FAMILY', notes: 'البيت متهالك والأثاث قليل', recommendation: 'CONFIRM', clientOpId: op,
      checks: [...ALL_MATCH.filter((c) => c.key !== 'phone'), { key: 'phone', result: 'MISMATCH', found: 'تغيّر الرقم إلى 07809990000' }] };
    const r = await post(`/inspections/${i1}/report`, 'agent', body);
    expect(r.status).toBe(200);
    // الكاشف يرى تقريره وحده.
    expect(r.body).toMatchObject({ status: 'ASSIGNED', familyNo: f1.no, report: { inspector: 'agent', recommendation: 'CONFIRM', mismatches: 1 } });
    expect(r.body.reports).toBeUndefined();
    expect((await post(`/inspections/${i1}/report`, 'agent', body)).status).toBe(200);
    expect((await post(`/inspections/${i1}/report`, 'agent', { ...body, clientOpId: randomUUID() })).status).toBe(409);
    let d = (await get(`/inspections/${i1}`, 'supervisor')).body;
    expect(d).toMatchObject({ status: 'ASSIGNED', submitted: 1, assigned: 2, waiting: true, agreement: null });
    const phone = d.reports.find((x: any) => x.inspector === 'agent').checks.find((c: any) => c.key === 'phone');
    expect(phone).toMatchObject({ label: 'الهاتف', recorded: f1.body.phone1, result: 'MISMATCH', found: 'تغيّر الرقم إلى 07809990000' });
    expect((await get('/inspections?status=WAITING', 'supervisor')).body.map((x: any) => x.id)).toEqual([i1]);
    expect((await get('/inspections/mine', 'agent')).body.pending.map((x: any) => x.id)).not.toContain(i1);

    const second = await post(`/inspections/${i1}/report`, 'agent2', { contact: 'FAMILY', checks: ALL_MATCH, recommendation: 'RAISE', reason: 'مريضة طريحة الفراش ولا معيل لها' });
    expect(second.status).toBe(200);
    d = (await get(`/inspections/${i1}`, 'supervisor')).body;
    expect(d).toMatchObject({ status: 'SUBMITTED', submitted: 2, waiting: true, agreement: 'DISAGREE' });
  });
});

describe('قرار المدير وأثره', () => {
  it('لا يعتمده كاشف ولا من سجّل العائلة، ولا يُعتمد بلا أثر محدَّد', async () => {
    const decide = (body: any, user = 'supervisor') => post(`/inspections/${i1}/decide`, user, body);
    expect((await decide({ decision: 'APPROVE', effect: 'NONE' }, 'agent')).status).toBe(403);
    expect((await decide({ decision: 'APPROVE', effect: 'NONE' }, 'manager')).status).toBe(403);
    expect((await decide({ decision: 'APPROVE' })).status).toBe(400);
    expect((await decide({ decision: 'APPROVE', effect: 'RAISE' })).body.message).toContain('عدد النقاط');
    expect((await decide({ decision: 'APPROVE', effect: 'RAISE', points: 11 })).body.message).toContain('أقصى ما يغيّره الكشف 10');
    expect((await decide({ decision: 'REJECT' })).status).toBe(400);
    // عائلة سجّلها المشرف: لا يعتمد كشفها هو.
    const own = await approved({}, 'supervisor', 'admin');
    const ins = (await assign([own.id], ['agent'], {}, 'admin')).body.inspections[0].id;
    await post(`/inspections/${ins}/report`, 'agent', confirm());
    const self = await post(`/inspections/${ins}/decide`, 'supervisor', { decision: 'APPROVE', effect: 'NONE' });
    expect(self.status).toBe(403);
    expect(self.body.message).toContain('من سجّلها');
    expect((await post(`/inspections/${ins}/decide`, 'admin', { decision: 'APPROVE', effect: 'NONE' })).body).toMatchObject({ status: 'APPROVED', effect: 'NONE', points: null, deltaAfter: 0 });
  });

  it('رفع النقاط: تعديل يُضاف إلى مجموع المعادلة ويظهر في تفسير النقاط', async () => {
    const before = await score(f1.id);
    expect(before).toMatchObject({ points: 53, class: 'B', base: 53, adjustment: 0 });
    // أوصى أحد الكاشفَين بالرفع، فلا يلزم القرارَ سبب.
    const d = await post(`/inspections/${i1}/decide`, 'supervisor', { decision: 'APPROVE', effect: 'RAISE', points: 5 });
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ status: 'APPROVED', effect: 'RAISED', points: 5, deltaBefore: 0, deltaAfter: 5, pointsBefore: 53, pointsAfter: 58, classBefore: 'B', classAfter: 'B', decidedBy: 'supervisor' });
    expect(await score(f1.id)).toMatchObject({ points: 58, base: 53, adjustment: 5 });
    expect((await post(`/inspections/${i1}/decide`, 'supervisor', { decision: 'APPROVE', effect: 'NONE' })).status).toBe(409);
    const row = (await get('/families?inspection=DONE', 'supervisor')).body.find((x: any) => x.id === f1.id);
    expect(row).toMatchObject({ score: { points: 58, class: 'B' }, inspection: { state: 'DONE', delta: 5 } });
    expect(row.inspection.at).toBeTruthy();
    const fam = (await get(`/families/${f1.id}`, 'supervisor')).body;
    expect(fam).toMatchObject({ inspectionDelta: 5, removal: null });
    expect(fam.inspectedAt).toBeTruthy();
    // إعادة حساب النقاط كلها تحفظ التعديل.
    await sql('delete from family_scores where family_id = $1', [f1.id]);
    const { ScoringService } = await import('../src/scoring/scoring.service');
    await app.get(ScoringService).recomputeAll();
    expect(await score(f1.id)).toMatchObject({ points: 58, adjustment: 5 });
  });

  it('قرار يخالف توصية الكاشف يلزمه سبب، وقد ينقل العائلة إلى فئة أخرى', async () => {
    const mine = (await get('/inspections/mine', 'agent')).body.pending.find((x: any) => x.family.familyNo === f2.no)
      ?? (await get('/inspections/mine', 'researcher2')).body.pending.find((x: any) => x.family.familyNo === f2.no);
    const who = (await get(`/inspections/${mine.id}`, 'supervisor')).body.reports[0].inspector;
    await post(`/inspections/${mine.id}/report`, who, confirm());
    const bare = await post(`/inspections/${mine.id}/decide`, 'supervisor', { decision: 'APPROVE', effect: 'LOWER', points: 5 });
    expect(bare.status).toBe(400);
    expect(bare.body.message).toContain('يخالف توصية الكاشف');
    const d = await post(`/inspections/${mine.id}/decide`, 'supervisor', { decision: 'APPROVE', effect: 'LOWER', points: 5, note: 'تبيّن أن لها راتباً لم يُسجَّل، ويُصحَّح السجل' });
    expect(d.body).toMatchObject({ effect: 'LOWERED', points: 5, deltaAfter: -5, pointsBefore: 53, pointsAfter: 48, classBefore: 'B', classAfter: 'C' });
    expect(await score(f2.id)).toMatchObject({ points: 48, class: 'C', base: 53, adjustment: -5 });
  });

  it('لتعديل الكشف حدّ لا يُتجاوز ولو تكرّر الكشف، والحدّ بيد المدير', async () => {
    const again = (await assign([f1.id], ['agent'])).body.inspections[0].id;
    await post(`/inspections/${again}/report`, 'agent', confirm({ recommendation: 'RAISE', reason: 'ساءت حالها بعد وفاة ابنها' }));
    // عليها +5 والحدّ 10: طلب 8 يرفعها 5 فقط.
    const d = await post(`/inspections/${again}/decide`, 'supervisor', { decision: 'APPROVE', effect: 'RAISE', points: 8 });
    expect(d.body).toMatchObject({ effect: 'RAISED', points: 5, deltaBefore: 5, deltaAfter: 10, pointsAfter: 63 });
    const third = (await assign([f1.id], ['agent'])).body.inspections[0].id;
    await post(`/inspections/${third}/report`, 'agent', confirm({ recommendation: 'RAISE', reason: 'ما زالت على حالها' }));
    const full = await post(`/inspections/${third}/decide`, 'supervisor', { decision: 'APPROVE', effect: 'RAISE', points: 1 });
    expect(full.status).toBe(409);
    expect(full.body.message).toContain('بلغ تعديل الكشف على هذه العائلة حدّه (+10)');
    // يُعتمد بلا أثر: الكاشف أوصى بالرفع، فالمخالفة تلزمها علّة.
    expect((await post(`/inspections/${third}/decide`, 'supervisor', { decision: 'APPROVE', effect: 'NONE' })).status).toBe(400);
    expect((await post(`/inspections/${third}/decide`, 'supervisor', { decision: 'APPROVE', effect: 'NONE', note: 'بلغت الحدّ' })).body.effect).toBe('NONE');

    expect((await api().put('/api/settings/inspection_max_delta').set(as('supervisor')).send({ value: 3 })).status).toBe(403);
    expect((await api().put('/api/settings/inspection_max_delta').set(as('admin')).send({ value: 3 })).status).toBe(200);
    expect((await get(`/inspections/${third}`, 'supervisor')).body.cap).toBe(3);
    await api().put('/api/settings/inspection_max_delta').set(as('admin')).send({ value: 10 });
  });

  it('الكشف المردود والمتعذّر لا يجعلان العائلة مكشوفة، والتكليف يُلغى بسبب', async () => {
    const task = (await get('/inspections?status=ASSIGNED', 'supervisor')).body.find((x: any) => x.familyNo === f3.no);
    const who = task.reports[0].inspector;
    // لم يُرفع تقرير: لا يُفصل فيه.
    expect((await post(`/inspections/${task.id}/decide`, 'supervisor', { decision: 'REJECT', note: 'تأخر' })).status).toBe(409);
    await post(`/inspections/${task.id}/report`, who, { contact: 'NONE', checks: [], recommendation: 'UNABLE', reason: 'الدار مغلقة ولم يعرفهم الجيران' });
    const asIf = await post(`/inspections/${task.id}/decide`, 'supervisor', { decision: 'APPROVE', effect: 'NONE', note: 'لا بأس' });
    expect(asIf.status).toBe(409);
    expect(asIf.body.message).toContain('تعذّر الكشف');
    const rejected = await post(`/inspections/${task.id}/decide`, 'supervisor', { decision: 'REJECT', note: 'يُعاد التكليف بعد الاتصال بهم' });
    expect(rejected.body).toMatchObject({ status: 'REJECTED', effect: null, decisionNote: 'يُعاد التكليف بعد الاتصال بهم' });
    expect((await get('/families', 'supervisor')).body.find((x: any) => x.id === f3.id).inspection.state).toBe('NONE');
    // وما آل إليه يصل الكاشف.
    const recent = (await get('/inspections/mine', who)).body.recent.find((x: any) => x.id === task.id);
    expect(recent).toMatchObject({ status: 'REJECTED', recommendation: 'UNABLE', decisionNote: 'يُعاد التكليف بعد الاتصال بهم' });

    const next = (await assign([f3.id], ['agent2'])).body.inspections[0].id;
    expect((await post(`/inspections/${next}/cancel`, 'supervisor', {})).status).toBe(400);
    expect((await post(`/inspections/${next}/cancel`, 'manager', { note: 'سافر المتعهد' })).status).toBe(403);
    expect((await post(`/inspections/${next}/cancel`, 'supervisor', { note: 'سافر المتعهد' })).body.status).toBe('CANCELLED');
    expect((await get('/inspections/mine', 'agent2')).body.pending.map((x: any) => x.id)).not.toContain(next);
    const late = await post(`/inspections/${next}/report`, 'agent2', confirm());
    expect(late.status).toBe(409);
    expect(late.body.message).toBe('أُلغي هذا التكليف');
  });
});

describe('الشطب بالكشف', () => {
  let campaignId: string, token: string, point: string;

  it('الكاشف يطلب الشطب بسبب، فإن اعتُمد شُطبت العائلة وسقط ما بقي لها', async () => {
    point = (await post('/points', 'manager', { name: 'المركز' })).body.id;
    const programId = (await post('/programs', 'admin', { name: 'سلة شهرية', kind: 'IN_KIND', unit: 'سلة', rules: {}, amount: { type: 'FIXED', value: 1 } })).body.id;
    campaignId = (await post('/campaigns', 'manager', { name: 'سلة الشهر', programId, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [point], selection: { include: [f4.no], manualOnly: true } })).body.id;
    await post(`/campaigns/${campaignId}/submit`, 'manager');
    await post(`/campaigns/${campaignId}/approve`, 'manager2');
    token = (await get(`/campaigns/${campaignId}/tokens`, 'manager')).body.find((t: any) => t.familyNo === f4.no).token;

    const ins = (await assign([f4.id], ['agent'])).body.inspections[0].id;
    await post(`/inspections/${ins}/report`, 'agent', { contact: 'OTHERS', checks: [{ key: 'address', result: 'MISMATCH', found: 'انتقلوا إلى بغداد منذ سنة' }], recommendation: 'REMOVE', reason: 'انتقلت العائلة خارج المدينة' });
    const d = await post(`/inspections/${ins}/decide`, 'supervisor', { decision: 'APPROVE', effect: 'REMOVE' });
    expect(d.body).toMatchObject({ status: 'APPROVED', effect: 'REMOVED', pointsBefore: 53, pointsAfter: null, familyStatus: 'REMOVED' });
    const fam = (await get(`/families/${f4.id}`, 'supervisor')).body;
    expect(fam).toMatchObject({ status: 'REMOVED', score: null, removal: { by: 'supervisor' } });
    expect(fam.removal.note).toContain('انتقلت العائلة خارج المدينة');
    expect(fam.removal.note).toContain('كشف ميداني رقم');
    expect(await score(f4.id)).toEqual({});
    expect((await get('/families?status=REMOVED', 'supervisor')).body.map((x: any) => x.id)).toEqual([f4.id]);
    // استحقاقها في الحملة الجارية أُلغي: رمزها لا يُصرف.
    const redeem = await post('/deliveries/redeem', 'distributor', { pointId: point, deviceId: 'd1', locate: { token }, receiver: { kind: 'HEAD' }, clientOpId: randomUUID() });
    expect(redeem.status).toBe(409);
    expect(redeem.body.message).toContain('أُلغي هذا الاستحقاق');
    // ولا يُكلَّف بكشفها ولا يُعدَّل سجلها.
    expect((await assign([f4.id], ['agent'])).body.skipped[0].reason).toBe('مرفوضة أو مشطوبة');
  });

  it('المشطوبة تبقى وثائقها محجوزة: تسجيلها ثانيةً يُكشف', async () => {
    const again = await post('/families', 'researcher2', family({ members: f4.body.members }));
    expect(again.status).toBe(409);
    expect(again.body.conflicts[0]).toMatchObject({ familyNo: f4.no, familyStatus: 'REMOVED' });
  });

  it('تُعاد بسبب، ولا يعيدها من شطبها', async () => {
    expect((await post(`/families/${f4.id}/restore`, 'supervisor', { note: 'عادوا إلى المدينة' })).status).toBe(403);
    expect((await post(`/families/${f4.id}/restore`, 'admin', {})).status).toBe(400);
    expect((await post(`/families/${f4.id}/restore`, 'researcher', { note: 'عادوا' })).status).toBe(403);
    const back = await post(`/families/${f4.id}/restore`, 'admin', { note: 'عادوا إلى المدينة' });
    expect(back.body).toMatchObject({ status: 'APPROVED', removal: null, score: { points: 53, class: 'B' } });
    expect((await post(`/families/${f1.id}/restore`, 'admin', { note: 'ليست مشطوبة' })).status).toBe(409);
  });

  it('العائلة التي لم تُعتمد بعد: الشطب يرفض سجلها، والرفع يسري عند اعتمادها', async () => {
    const pending = await post('/families', 'researcher', family());
    const a = (await assign([pending.body.id], ['agent'])).body.inspections[0].id;
    await post(`/inspections/${a}/report`, 'agent', { contact: 'OTHERS', checks: [], recommendation: 'REMOVE', reason: 'لا وجود لها في العنوان' });
    expect((await post(`/inspections/${a}/decide`, 'supervisor', { decision: 'APPROVE', effect: 'REMOVE' })).body).toMatchObject({ effect: 'REMOVED', pointsBefore: null, familyStatus: 'REJECTED' });
    expect((await get(`/families/${pending.body.id}`, 'supervisor')).body.decisionNote).toContain('لا وجود لها في العنوان');

    const other = await post('/families', 'researcher', family());
    const b = (await assign([other.body.id], ['agent'])).body.inspections[0].id;
    await post(`/inspections/${b}/report`, 'agent', confirm({ recommendation: 'RAISE', reason: 'تسكن في هيكل بلا سقف' }));
    expect((await post(`/inspections/${b}/decide`, 'supervisor', { decision: 'APPROVE', effect: 'RAISE', points: 7 })).body).toMatchObject({ effect: 'RAISED', points: 7, pointsBefore: null, pointsAfter: null, deltaAfter: 7 });
    await post(`/families/${other.body.id}/approve`, 'supervisor');
    expect(await score(other.body.id)).toMatchObject({ points: 60, base: 53, adjustment: 7 });
  });
});

describe('أرقام الكشف', () => {
  it('كم كُشف، وكم غيّر الكشف، وكم اتفق الكاشفان', async () => {
    expect((await get('/inspections/summary', 'agent')).status).toBe(403);
    const s = (await get('/inspections/summary', 'auditor')).body;
    // سبع عوائل قائمة (المرفوضة خارج العدّ)، كُشف منها أربع: f1 وf2 وما سجّله المشرف وما اعتُمد بعد الرفع.
    expect(s.families).toMatchObject({ total: 6, inspected: 4, never: 2, open: 0, raisedNow: 2, loweredNow: 1 });
    expect(s.inspectedPercent).toBe(66.7);
    // المعتمدة: بلا أثر 2 (ما سجّله المشرف، والثالث على f1)، رفع 3، خفض 1، شطب 2.
    expect(s.decided).toMatchObject({ approved: 8, rejected: 1, none: 2, raised: 3, lowered: 1, removed: 2 });
    expect(s.changedPercent).toBe(75);
    expect(s.double).toMatchObject({ total: 1, agreed: 0, agreedPercent: 0 });
    expect(s.reports.submitted).toBe(10);
    expect(s.reports.withMismatch).toBe(2);
    expect(s).toMatchObject({ waiting: 0, assigned: 0, late: 0, cap: 10, lateDays: 7 });
    const history = (await get(`/inspections?familyId=${f1.id}`, 'supervisor')).body;
    expect(history.map((x: any) => x.effect)).toEqual(['NONE', 'RAISED', 'RAISED']);
  });

  it('التكليف المتأخر يُعلَّم، وكشوف المتعهد تظهر في ملفه', async () => {
    const late = (await assign([f3.id], ['agent'])).body.inspections[0].id;
    await sql("update inspections set requested_at = now() - interval '9 days' where id = $1", [late]);
    expect((await get('/inspections/summary', 'supervisor')).body).toMatchObject({ assigned: 1, late: 1, oldestDays: 9 });
    expect((await get(`/inspections/${late}`, 'supervisor')).body.late).toBe(true);
    expect((await get('/inspections/mine', 'agent')).body.pending.find((x: any) => x.id === late).late).toBe(true);
    const a = (await get('/agents/overview', 'manager')).body.agents.find((x: any) => x.username === 'agent');
    expect(a).toMatchObject({ pendingInspections: 1 });
    expect(a.last30.inspections).toBeGreaterThanOrEqual(6);
    expect(a.alerts.some((t: string) => t.includes('كشف كُلّف به منذ أكثر من 7 أيام ولم يرفعه'))).toBe(true);
    const detail = (await get(`/agents/${ids.agent}`, 'manager')).body;
    expect(detail.timeline.some((t: any) => t.text.includes(`رفع كشف العائلة ${f4.no}: يطلب شطبها، وفيها 1 بند غير مطابق`))).toBe(true);
  });
});
