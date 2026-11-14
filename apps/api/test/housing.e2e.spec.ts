import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { family, login, sql, startApp } from './helpers';

let app: INestApplication;
const tokens: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });
const post = (path: string, user: string, body: any = {}) => api().post(`/api${path}`).set(as(user)).send(body);
const get = (path: string, user: string) => api().get(`/api${path}`).set(as(user));

let fundId: string, contractorId: string, familyId: string, projectId: string;
const fund = async () => (await get('/accounting/summary', 'accountant')).body.funds.find((f: any) => f.id === fundId);
const stages = async () => (await get(`/housing/projects/${projectId}`, 'auditor')).body.stages;
const STAGES = [{ name: 'الأساس', amount: 6_000_000 }, { name: 'الهيكل والسقف', amount: 12_000_000 }, { name: 'التشطيب والتسليم', amount: 6_000_000 }];

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'researcher', 'supervisor', 'accountant', 'accountant2', 'projects', 'projects2', 'auditor', 'manager']) tokens[u] = await login(app, u);
  const f = await post('/families', 'researcher', family({ housing: 'OTHER' }));
  familyId = (await post(`/families/${f.body.id}/approve`, 'supervisor')).body.id;
  fundId = (await post('/accounting/funds', 'accountant', { name: 'صندوق بناء المنازل' })).body.id;
  contractorId = (await post('/housing/contractors', 'projects', { name: 'جاسم محمد خلف الجميلي', phone: '07708841120' })).body.id;
});
afterAll(async () => {
  await app.close();
});

describe('مشروع بناء منزل', () => {
  const body = () => ({ familyId, contractorId, fundId, location: 'النزال، قرب الجامع', contractDate: '2026-09-01', durationDays: 120, stages: STAGES });

  it('الميزانية مجموع المراحل، والمشروع ينتظر اعتماد موظف آخر', async () => {
    expect((await post('/housing/projects', 'manager', body())).status).toBe(403);
    const found = await get(`/families?status=APPROVED&q=${(await get(`/families/${familyId}`, 'projects')).body.familyNo}`, 'projects');
    expect(found.body.map((f: any) => f.id)).toEqual([familyId]);
    const p = await post('/housing/projects', 'projects', body());
    expect(p.status).toBe(201);
    projectId = p.body.id;
    expect(p.body).toMatchObject({ status: 'PENDING_APPROVAL', budget: 24_000_000, paid: 0, contractor: 'جاسم محمد خلف الجميلي' });
    expect(p.body.stages.map((s: any) => s.share)).toEqual([25, 50, 25]);
    expect((await post('/housing/projects', 'projects', body())).status).toBe(409);
    expect((await post(`/housing/projects/${projectId}/approve`, 'projects')).status).toBe(403);
  });

  it('لا يُعتمد مشروع لا يكفيه صندوقه، والاعتماد يحجز ميزانيته', async () => {
    await post('/accounting/receipts', 'accountant', { fundId, amount: 20_000_000, party: 'متبرع 9', description: 'لبناء المنازل' });
    const short = await post(`/housing/projects/${projectId}/approve`, 'projects2');
    expect(short.status).toBe(409);
    expect(short.body.message).toContain('المتاح فيه 20,000,000 والمطلوب 24,000,000');
    await post('/accounting/receipts', 'accountant', { fundId, amount: 10_000_000, party: 'متبرع 9', description: 'تتمة' });
    expect((await post(`/housing/projects/${projectId}/approve`, 'projects2')).body.status).toBe('ACTIVE');
    expect(await fund()).toMatchObject({ cash: 30_000_000, reserved: 24_000_000, available: 6_000_000 });
  });

  it('لا تُصرف دفعة مرحلة لم تُطلب، ولا مرحلة لم تُسجَّل لها زيارة تحقق', async () => {
    const [s1] = await stages();
    const early = await post(`/housing/stages/${s1.id}/approve`, 'projects2');
    expect(early.status).toBe(409);
    expect(early.body.message).toBe('لا تُصرف دفعة مرحلة لم تُسجَّل لها زيارة تحقق');
    expect((await post(`/housing/stages/${s1.id}/verify`, 'projects', { note: 'زرت الموقع' })).status).toBe(409);
    expect((await post(`/housing/stages/${s1.id}/claim`, 'projects', {})).status).toBe(400);
    await post(`/housing/stages/${s1.id}/claim`, 'projects', { note: 'قال المتعهد إن الأساس تمّ' });
    expect((await post(`/housing/stages/${s1.id}/approve`, 'projects2')).status).toBe(409);
    expect((await fund()).cash).toBe(30_000_000);
  });

  it('من سجّل زيارة التحقق لا يعتمد الصرف، وقيد القاعدة نفسه يمنعه', async () => {
    const [s1] = await stages();
    await post(`/housing/stages/${s1.id}/verify`, 'projects', { note: 'زرت الموقع: الأساس مصبوب ومطابق' });
    expect((await post(`/housing/stages/${s1.id}/approve`, 'projects')).status).toBe(403);
    await expect(sql("update housing_stages set status = 'PAID', approved_by = verified_by where id = $1", [s1.id])).rejects.toThrow(/paid_needs_two/);
    await expect(sql("update housing_stages set status = 'PAID' where id = $1", [s1.id])).rejects.toThrow(/paid_needs_two/);
    expect((await fund()).cash).toBe(30_000_000);
  });

  it('اعتماد موظف آخر يصرف الدفعة بقيد محاسبي من صندوق المشروع', async () => {
    const [s1] = await stages();
    const paid = await post(`/housing/stages/${s1.id}/approve`, 'accountant2');
    expect(paid.status).toBe(200);
    const stage = paid.body.stages[0];
    expect(stage).toMatchObject({ status: 'PAID', verifiedBy: 'projects', approvedBy: 'accountant2' });
    expect(stage.entryNo).toMatch(/^ص-/);
    expect(paid.body.paid).toBe(6_000_000);
    expect(await fund()).toMatchObject({ cash: 24_000_000, reserved: 18_000_000, available: 6_000_000 });
    // دفعة المرحلة قيّدها المشروع: لا تُعكس من الدفتر وحده، وإلا بقي المشروع يقول «صُرفت» والدفتر يقول «لم تُصرف».
    const stageEntry = (await sql('select payment_entry from housing_stages where id = $1', [s1.id])).rows[0].payment_entry;
    const rev = await post(`/accounting/entries/${stageEntry}/reverse`, 'accountant', { reason: 'سُجّلت خطأً' });
    expect(rev.status).toBe(409);
    expect(rev.body.message).toContain('دفعة مرحلة بناء');
    expect((await post(`/housing/stages/${s1.id}/approve`, 'accountant2')).status).toBe(409);
    const entry = (await get('/accounting/entries', 'auditor')).body.find((e: any) => e.no === stage.entryNo);
    expect(entry).toMatchObject({ kind: 'PAYMENT', status: 'POSTED', amount: 6_000_000, party: 'جاسم محمد خلف الجميلي' });
    expect(entry.description).toContain('دفعة الأساس');
  });

  it('المراحل بترتيبها: لا تُطلب الثالثة والثانية لم تُصرف', async () => {
    const [, s2, s3] = await stages();
    const skip = await post(`/housing/stages/${s3.id}/claim`, 'projects', { note: 'يريد المتعهد دفعة التشطيب' });
    expect(skip.status).toBe(409);
    expect((await post(`/housing/stages/${s2.id}/claim`, 'projects', { note: 'رفع المتعهد صور الهيكل' })).status).toBe(200);
  });

  it('المرحلة التي لم تتمّ تُعاد إلى المتعهد، وصورها تُرفق بملف العائلة', async () => {
    const [, s2] = await stages();
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-site')]);
    expect((await api().post(`/api/housing/stages/${s2.id}/photos`).set(as('projects')).attach('file', jpeg, 'roof.jpg')).status).toBe(201);
    await post(`/housing/stages/${s2.id}/verify`, 'projects', { note: 'الهيكل قائم' });
    const back = await post(`/housing/stages/${s2.id}/send-back`, 'projects2', { note: 'السقف لم يُصبّ' });
    expect(back.body.stages[1]).toMatchObject({ status: 'PLANNED', verifiedBy: null, photos: 1 });
    expect((await post(`/housing/stages/${s2.id}/approve`, 'projects2')).status).toBe(409);
    const att = (await get(`/families/${familyId}/attachments`, 'auditor')).body;
    expect(att.find((a: any) => a.category === 'HOUSING_PROGRESS')).toBeTruthy();
  });

  it('لا تُصرف دفعة يتجاوزها نقد الصندوق، وبصرف الأخيرة يُسلَّم المنزل', async () => {
    const pay = async (index: number) => {
      const s = (await stages())[index];
      await post(`/housing/stages/${s.id}/claim`, 'projects', { note: 'طلب المتعهد' });
      await post(`/housing/stages/${s.id}/verify`, 'projects', { note: 'زرت الموقع وتحققت' });
      return post(`/housing/stages/${s.id}/approve`, 'projects2');
    };
    // نقد الصندوق 24,000,000؛ يُخرَج منه 15,000,000 في عهدة فلا يبقى ما يكفي دفعة الهيكل.
    const cashier = (await sql("select id from users where username = 'manager'")).rows[0].id;
    await post('/accounting/custody/issue', 'accountant', { fundId, userId: cashier, amount: 15_000_000 });
    const blocked = await pay(1);
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toContain('نقد الصندوق لا يكفي');
    expect((await stages())[1].status).toBe('VERIFIED');
    await post('/accounting/custody/close', 'accountant', { fundId, userId: cashier, counted: 15_000_000 });

    const s2 = (await stages())[1];
    expect((await post(`/housing/stages/${s2.id}/approve`, 'projects2')).body.paid).toBe(18_000_000);
    const done = await pay(2);
    expect(done.body).toMatchObject({ status: 'DELIVERED', paid: 24_000_000 });
    expect(await fund()).toMatchObject({ cash: 6_000_000, reserved: 0, available: 6_000_000 });
    const tb = (await get('/accounting/trial-balance', 'auditor')).body;
    expect(tb.balanced).toBe(true);
    expect(tb.lines.find((l: any) => l.account === 'مصروف: بناء المنازل').balance).toBe(24_000_000);
    expect((await get('/housing/contractors', 'auditor')).body[0]).toMatchObject({ activeProjects: 0, deliveredProjects: 1 });
    expect((await get('/audit/verify', 'auditor')).body.ok).toBe(true);
  });
});
