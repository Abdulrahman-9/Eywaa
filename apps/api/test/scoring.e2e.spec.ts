import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { computeScore, Criteria, Thresholds } from '../src/scoring/formula';
import { family, login, sql, startApp, uniqueName } from './helpers';

let app: INestApplication;
const tokens: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });

const V1: Criteria = {
  income: { max: 25 }, orphans: { perUnit: 5, max: 15 }, housing: { OWNED: 0, RENTED: 10, OTHER: 12 },
  disabled: { perUnit: 6, max: 12 }, femaleHead: { max: 10 }, familySize: { perUnit: 2, above: 3, max: 10 },
  chronic: { perUnit: 4, max: 8 }, noIncome: { max: 8 },
};
const T1: Thresholds = { a: 70, b: 50, c: 30 };
const LINE = 300000;

async function approved(body: any) {
  const created = await api().post('/api/families').set(as('researcher')).send(body);
  const res = await api().post(`/api/families/${created.body.id}/approve`).set(as('supervisor')).send({});
  return res.body;
}

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'researcher', 'supervisor', 'auditor']) tokens[u] = await login(app, u);
});
afterAll(async () => {
  await app.close();
});

describe('معادلة النقاط', () => {
  const base = { members: 1, monthlyIncomeIqd: 0, orphans: 0, disabled: 0, chronic: 0, housing: null, femaleHeadNoProvider: false } as const;
  const got = (s: ReturnType<typeof computeScore>, key: string) => s.breakdown.find((l) => l.key === key)!.got;

  it('حساب يدوي: أرملة بثلاثة أيتام في إيجار بلا دخل = 25+15+10+0+10+2+0+8 = 70، فئة أ', () => {
    const s = computeScore({ ...base, members: 4, orphans: 3, housing: 'RENTED', femaleHeadNoProvider: true }, V1, T1, LINE);
    expect(s.breakdown.map((l) => l.got)).toEqual([25, 15, 10, 0, 10, 2, 0, 8]);
    expect(s).toMatchObject({ points: 70, class: 'A' });
  });

  it('حساب يدوي: أسرة من ستة في ملك، دخلها 900,000، فيها معاق ومريض = 13+0+0+6+0+6+4+0 = 29، فئة د', () => {
    const s = computeScore({ ...base, members: 6, monthlyIncomeIqd: 900000, disabled: 1, chronic: 1, housing: 'OWNED' }, V1, T1, LINE);
    expect(s.breakdown.map((l) => l.got)).toEqual([13, 0, 0, 6, 0, 6, 4, 0]);
    expect(s).toMatchObject({ points: 29, class: 'D' });
  });

  it('الدخل: نصف خط الفقر يعطي نصف الأقصى، وما بلغه أو جاوزه لا يعطي شيئاً', () => {
    expect(got(computeScore({ ...base, members: 2, monthlyIncomeIqd: 300000 }, V1, T1, LINE), 'income')).toBe(13);
    expect(got(computeScore({ ...base, members: 1, monthlyIncomeIqd: 300000 }, V1, T1, LINE), 'income')).toBe(0);
    expect(got(computeScore({ ...base, members: 1, monthlyIncomeIqd: 9000000 }, V1, T1, LINE), 'income')).toBe(0);
  });

  it('لكل معيار سقف لا يتجاوزه مهما كثر العدد', () => {
    const s = computeScore({ ...base, members: 20, orphans: 9, disabled: 9, chronic: 9 }, V1, T1, LINE);
    expect([got(s, 'orphans'), got(s, 'disabled'), got(s, 'chronic'), got(s, 'familySize')]).toEqual([15, 12, 8, 10]);
  });

  it('حدود الفئات: 70 أ، 69 ب، 50 ب، 49 ج، 30 ج، 29 د', () => {
    const cls = (points: number) => computeScore({ ...base, members: 4, orphans: 3, housing: 'RENTED', femaleHeadNoProvider: true }, V1, { a: points, b: points - 20, c: points - 40 }, LINE).class;
    expect(cls(70)).toBe('A');
    expect(cls(71)).toBe('B');
    expect(cls(91)).toBe('C');
    expect(cls(111)).toBe('D');
  });
});

describe('حساب النقاط في النظام', () => {
  let widow: any;

  it('لا نقاط قبل الاعتماد، وتُحسب عنده، وتطابق الحساب اليدوي', async () => {
    const body = family({ tags: ['WIDOW', 'ORPHANS'], housing: 'RENTED' });
    for (let i = 0; i < 3; i++) body.members.push({ relation: 'SON', fullName: uniqueName(9000 + i), gender: 'M', isOrphan: true, documents: [] });
    const created = await api().post('/api/families').set(as('researcher')).send(body);
    expect(created.body.score).toBeNull();
    widow = (await api().post(`/api/families/${created.body.id}/approve`).set(as('supervisor')).send({})).body;
    expect(widow.score).toEqual({ points: 70, class: 'A' });
    const detail = await api().get(`/api/families/${widow.id}/score`).set(as('auditor'));
    expect(detail.body).toMatchObject({ version: 1, points: 70, class: 'A' });
    expect(detail.body.breakdown.find((l: any) => l.key === 'orphans')).toMatchObject({ got: 15, max: 15, label: 'الأيتام' });
  });

  it('تعديل معتمَد على العائلة يعيد نقاطها', async () => {
    const req = await api().post(`/api/families/${widow.id}/changes`).set(as('researcher'))
      .send({ type: 'SET_INCOMES', payload: { incomes: [{ kind: 'PENSION', amountIqd: 600000 }] }, reason: 'صدر لها راتب تقاعدي' });
    expect((await api().get(`/api/families/${widow.id}`).set(as('auditor'))).body.score.points).toBe(70);
    await api().post(`/api/changes/${req.body.id}/approve`).set(as('supervisor')).send({});
    // دخل الفرد 150,000 = نصف الخط: 13 بدل 25، ويسقط معيار «لا دخل»: 70 - 12 - 8 = 50
    expect((await api().get(`/api/families/${widow.id}`).set(as('auditor'))).body.score).toEqual({ points: 50, class: 'B' });
  });

  it('تغيير خط الفقر يعيد نقاط العوائل كلها', async () => {
    const res = await api().put('/api/settings/poverty_line_iqd').set(as('admin')).send({ value: 150000 });
    expect(res.body.recomputed).toBeGreaterThan(0);
    // دخل الفرد 150,000 صار عند الخط: لا نقاط للدخل = 37
    expect((await api().get(`/api/families/${widow.id}`).set(as('auditor'))).body.score).toEqual({ points: 37, class: 'C' });
    await api().put('/api/settings/poverty_line_iqd').set(as('admin')).send({ value: 300000 });
    expect((await api().get(`/api/families/${widow.id}`).set(as('auditor'))).body.score.points).toBe(50);
  });

  it('الرفض يمحو النقاط، والقائمة تصفّي بالفئة', async () => {
    const byClass = await api().get('/api/families').query({ class: 'B' }).set(as('auditor'));
    expect(byClass.body.map((f: any) => f.id)).toContain(widow.id);
    expect(byClass.body.every((f: any) => f.score.class === 'B')).toBe(true);
  });
});

describe('إصدارات المعادلة', () => {
  const draft = { criteria: { ...V1, orphans: { perUnit: 5, max: 20 }, familySize: { perUnit: 2, above: 3, max: 5 } }, thresholds: T1 };
  let poor: any;

  it('المحاكاة تبيّن الأثر ولا تغيّر شيئاً', async () => {
    const body = family({ tags: ['ORPHANS', 'WIDOW'], housing: 'RENTED' });
    for (let i = 0; i < 4; i++) body.members.push({ relation: 'DAUGHTER', fullName: uniqueName(9100 + i), gender: 'F', isOrphan: true, documents: [] });
    poor = await approved(body);
    // 25 + 15 + 10 + 10 + (5-3)*2 + 8 = 72
    expect(poor.score).toEqual({ points: 72, class: 'A' });

    const sim = await api().post('/api/scoring/simulate').set(as('admin')).send({ criteria: V1, thresholds: { a: 80, b: 60, c: 40 } });
    expect(sim.status).toBe(200);
    expect(sim.body.transitions['A>B']).toBeGreaterThanOrEqual(1);
    expect(sim.body.affected.find((a: any) => a.familyId === poor.id)).toMatchObject({ from: 'A', to: 'B', oldPoints: 72, newPoints: 72 });
    expect((await api().get(`/api/families/${poor.id}`).set(as('auditor'))).body.score).toEqual({ points: 72, class: 'A' });
    expect((await api().get('/api/scoring').set(as('auditor'))).body.active.version).toBe(1);
  });

  it('يرفض المعادلة الباطلة', async () => {
    const bad = (body: any) => api().post('/api/scoring/versions').set(as('admin')).send(body);
    expect((await bad({ criteria: V1, thresholds: { a: 30, b: 50, c: 70 } })).status).toBe(400);
    expect((await bad({ criteria: { ...V1, income: { max: -1 } }, thresholds: T1 })).status).toBe(400);
    expect((await bad({ criteria: V1, thresholds: { a: 101, b: 50, c: 30 } })).status).toBe(400);
    expect((await api().post('/api/scoring/versions').set(as('supervisor')).send(draft)).status).toBe(403);
  });

  it('الإصدار المقترح لا يسري حتى يعتمده غير مقترحه، وعندها تُعاد النقاط كلها', async () => {
    const proposed = await api().post('/api/scoring/versions').set(as('admin')).send({ ...draft, note: 'رفع وزن الأيتام' });
    expect(proposed.body).toEqual({ version: 2 });
    expect((await api().post('/api/scoring/versions').set(as('admin')).send(draft)).status).toBe(409);
    expect((await api().get(`/api/families/${poor.id}`).set(as('auditor'))).body.score.points).toBe(72);

    expect((await api().post('/api/scoring/versions/2/approve').set(as('admin')).send({})).status).toBe(403);
    const ok = await api().post('/api/scoring/versions/2/approve').set(as('supervisor')).send({});
    expect(ok.body).toMatchObject({ version: 2, status: 'ACTIVE' });
    expect(ok.body.recomputed).toBeGreaterThanOrEqual(2);
    // 4 أيتام × 5 = 20 بدل 15 (+5)، وحجم الأسرة 4 بدل 4 (السقف 5): 72 + 5 = 77
    expect((await api().get(`/api/families/${poor.id}/score`).set(as('auditor'))).body).toMatchObject({ version: 2, points: 77 });

    const overview = (await api().get('/api/scoring').set(as('auditor'))).body;
    expect(overview.active.version).toBe(2);
    expect(overview.history.find((v: any) => v.version === 1).status).toBe('RETIRED');
    expect(overview.pending).toBeNull();
    await expect(sql("update scoring_versions set status = 'ACTIVE' where version = 1")).rejects.toThrow(/one_active_scoring/);
  });

  it('الرفض يلزمه سبب ولا يغيّر الساري', async () => {
    await api().post('/api/scoring/versions').set(as('admin')).send({ criteria: V1, thresholds: T1 });
    expect((await api().post('/api/scoring/versions/3/reject').set(as('supervisor')).send({})).status).toBe(400);
    const rejected = await api().post('/api/scoring/versions/3/reject').set(as('supervisor')).send({ note: 'لا حاجة للرجوع' });
    expect(rejected.body.status).toBe('REJECTED');
    expect((await api().get('/api/scoring').set(as('auditor'))).body.active.version).toBe(2);
    expect((await api().get('/api/audit/verify').set(as('auditor'))).body.ok).toBe(true);
  });
});
