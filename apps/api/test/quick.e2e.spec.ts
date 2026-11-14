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

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'researcher', 'researcher2', 'supervisor', 'distributor', 'accountant', 'auditor']) tokens[u] = await login(app, u);
});
afterAll(async () => {
  await app.close();
});

describe('طلب التسجيل السريع', () => {
  let id: string, registered: any;

  it('يكفيه الاسم، ويأخذ رقماً، وإعادة إرساله من هاتف انقطع لا تكرّره', async () => {
    expect((await post('/quick-requests', 'accountant', { headName: 'فلان بن فلان' })).status).toBe(403);
    expect((await post('/quick-requests', 'distributor', { headName: 'ع' })).status).toBe(400);
    const op = randomUUID();
    const body = { headName: 'جبار كاظم حسون الشمري', clientOpId: op };
    const res = await post('/quick-requests', 'distributor', body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ headName: 'جبار كاظم حسون الشمري', status: 'NEW', phone: null, membersCount: null, createdBy: 'distributor', source: 'STAFF' });
    expect(res.body.no).toBeGreaterThan(0);
    id = res.body.id;
    expect((await post('/quick-requests', 'distributor', body)).body.id).toBe(id);
    expect((await get('/quick-requests', 'supervisor')).body).toHaveLength(1);
    expect((await get('/quick-requests', 'distributor')).status).toBe(403);
  });

  it('المطابقة بالاسم والهاتف: من يشبهه في العوائل والطلبات يظهر مع الطلب', async () => {
    const f = family({ phone1: '07705550001' });
    f.members[0].fullName = 'سلمى حاتم مزهر الدليمي';
    registered = (await post('/families', 'researcher', f)).body;
    const similar = await post('/quick-requests', 'researcher', { headName: 'سلمي حاتم مزهر الدليمى', mahalla: 'الجولان', membersCount: 5 });
    expect(similar.body.matches.families[0]).toMatchObject({ familyNo: registered.familyNo, samePhone: false });
    expect(similar.body.matches.families[0].score).toBeGreaterThan(0.9);
    const phone = await post('/quick-requests', 'researcher', { headName: 'اسم لا يشبه أحداً', phone: '0770 555 0001' });
    expect(phone.body.matches.families[0]).toMatchObject({ familyNo: registered.familyNo, samePhone: true });
    const twice = await post('/quick-requests', 'researcher', { headName: 'جبار كاظم حسون الشمري' });
    expect(twice.body.matches.requests[0]).toMatchObject({ name: 'جبار كاظم حسون الشمري' });
    expect((await get(`/quick-requests/${id}`, 'supervisor')).body.matches.requests).toHaveLength(1);
    expect((await post('/quick-requests', 'researcher', { headName: 'شخص جديد تماماً' })).body.matches).toEqual({ families: [], requests: [] });
  });

  it('الطريق الأول: دعوة برسالة. بلا هاتف لا يُدعى', async () => {
    const noPhone = await post(`/quick-requests/${id}/invite`, 'supervisor');
    expect(noPhone.status).toBe(400);
    expect(noPhone.body.message).toContain('أسند زيارته إلى باحث');
    const withPhone = (await post('/quick-requests', 'researcher', { headName: 'ناظم عبود راضي الجنابي', phone: '07709990002' })).body;
    expect((await post(`/quick-requests/${withPhone.id}/invite`, 'researcher')).status).toBe(403);
    const invited = await post(`/quick-requests/${withPhone.id}/invite`, 'supervisor');
    expect(invited.body.status).toBe('INVITED');
    const msg = (await sql('select phone, text, status, family_id from messages where quick_request_id = $1', [withPhone.id])).rows[0];
    expect(msg).toMatchObject({ phone: '07709990002', status: 'SENT', family_id: null });
    expect(msg.text).toContain('ناظم عبود راضي الجنابي');
    expect(msg.text).toContain(`برقم ${withPhone.no}`);
  });

  it('الطريق الثاني: إسناد زيارة لباحث، فتظهر في قائمته', async () => {
    const r2 = (await sql("select id from users where username = 'researcher2'")).rows[0].id;
    const d = (await sql("select id from users where username = 'distributor'")).rows[0].id;
    expect((await post(`/quick-requests/${id}/assign`, 'supervisor', { userId: d })).status).toBe(400);
    const res = await post(`/quick-requests/${id}/assign`, 'supervisor', { userId: r2 });
    expect(res.body).toMatchObject({ status: 'VISIT_ASSIGNED', assignedTo: 'researcher2' });
    expect((await get('/quick-requests?mine=true', 'researcher2')).body.map((x: any) => x.id)).toEqual([id]);
    expect((await get('/quick-requests?mine=true', 'researcher')).body).toEqual([]);
  });

  it('الاستكمال: استمارة كاملة تُغلق الطلب بعائلتها، وتمرّ بكشف التكرار', async () => {
    const f = family({ quickRequestId: id });
    f.members[0].fullName = 'جبار كاظم حسون الشمري';
    const created = await post('/families', 'researcher2', f);
    expect(created.status).toBe(201);
    const done = (await get(`/quick-requests/${id}`, 'supervisor')).body;
    expect(done).toMatchObject({ status: 'COMPLETED', familyNo: created.body.familyNo });
    expect(done.matches).toEqual({ families: [], requests: [] });
    // طلب أُغلق لا يُستكمل به مرة ثانية، ولا يُدعى ولا يُصرف.
    expect((await post('/families', 'researcher2', family({ quickRequestId: id }))).status).toBe(409);
    expect((await post(`/quick-requests/${id}/dismiss`, 'supervisor', { note: 'بعد الإغلاق' })).status).toBe(409);
    expect((await get('/quick-requests?status=COMPLETED', 'auditor')).body.map((x: any) => x.id)).toEqual([id]);
  });

  it('استمارة يرفضها كشف التكرار لا تُغلق الطلب', async () => {
    const q = (await post('/quick-requests', 'researcher', { headName: 'مكرر الوثيقة للتجربة' })).body;
    const dup = family({ quickRequestId: q.id });
    dup.members[0].documents = registered.members[0].documents.length ? [{ type: 'NATIONAL_CARD', number: '199900000001' }] : [];
    const first = family();
    first.members[0].documents = [{ type: 'NATIONAL_CARD', number: '199900000001' }];
    await post('/families', 'researcher', first);
    expect((await post('/families', 'researcher', dup)).status).toBe(409);
    expect((await get(`/quick-requests/${q.id}`, 'supervisor')).body.status).toBe('NEW');
  });

  it('الصرف بسببه، والبحث بالاسم ورقم الطلب، والسلسلة سليمة', async () => {
    const q = (await post('/quick-requests', 'researcher', { headName: 'طلب يُصرف للتجربة' })).body;
    expect((await post(`/quick-requests/${q.id}/dismiss`, 'supervisor', {})).status).toBe(400);
    expect((await post(`/quick-requests/${q.id}/dismiss`, 'supervisor', { note: 'مسجَّل سلفاً باسم زوجته' })).body).toMatchObject({ status: 'DISMISSED', closeNote: 'مسجَّل سلفاً باسم زوجته' });
    expect((await get(`/quick-requests?q=${encodeURIComponent('ناظم عبود')}`, 'supervisor')).body).toHaveLength(1);
    expect((await get(`/quick-requests?status=DISMISSED&q=${q.no}`, 'supervisor')).body.map((x: any) => x.id)).toEqual([q.id]);
    expect((await get('/audit/verify', 'auditor')).body.ok).toBe(true);
  });
});
