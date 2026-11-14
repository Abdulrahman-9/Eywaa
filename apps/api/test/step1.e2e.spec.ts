import { INestApplication } from '@nestjs/common';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { family, login, nationalNo, sql, startApp } from './helpers';

let app: INestApplication;
const tokens: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });
const create = async (body: any = family(), user = 'researcher') =>
  (await api().post('/api/families').set(as(user)).send(body)).body;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-fake-image-body-0123456789')]);
const PDF = Buffer.from('%PDF-1.7\n%fake pdf body for tests\n%%EOF');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'researcher', 'researcher2', 'supervisor', 'distributor', 'auditor']) {
    tokens[u] = await login(app, u);
  }
});
afterAll(async () => {
  await app.close();
});

describe('الإعدادات وخط الفقر', () => {
  it('القيمة الابتدائية 300,000 دينار', async () => {
    const res = await api().get('/api/settings').set(as('researcher'));
    expect(res.body.find((s: any) => s.key === 'poverty_line_iqd').value).toBe(300000);
  });

  it('ملف العائلة يحسب دخل الفرد ويقارنه بخط الفقر', async () => {
    const f = family({ incomes: [{ kind: 'PENSION', amountIqd: 500000 }] });
    f.members.push({ relation: 'SON', fullName: 'ولد أول', gender: 'M', documents: [] });
    const below = await create(f);
    expect(below).toMatchObject({ perCapitaIncomeIqd: 250000, povertyLineIqd: 300000, belowPovertyLine: true });
    const above = await create(family({ incomes: [{ kind: 'SALARY', amountIqd: 900000 }] }));
    expect(above.belowPovertyLine).toBe(false);
  });

  it('المدير وحده يغيّره، والتغيير مؤرَّخ ويسري فوراً', async () => {
    const denied = await api().put('/api/settings/poverty_line_iqd').set(as('supervisor')).send({ value: 1 });
    expect(denied.status).toBe(403);
    const bad = await api().put('/api/settings/poverty_line_iqd').set(as('admin')).send({ value: -5 });
    expect(bad.status).toBe(400);
    const unknown = await api().put('/api/settings/nope').set(as('admin')).send({ value: 5 });
    expect(unknown.status).toBe(404);

    const f = await create(family({ incomes: [{ kind: 'WORK', amountIqd: 320000 }] }));
    expect(f.belowPovertyLine).toBe(false);
    const ok = await api().put('/api/settings/poverty_line_iqd').set(as('admin')).send({ value: 350000 });
    expect(ok.status).toBe(200);
    const again = await api().get(`/api/families/${f.id}`).set(as('auditor'));
    expect(again.body).toMatchObject({ povertyLineIqd: 350000, belowPovertyLine: true });

    const history = await api().get('/api/settings/poverty_line_iqd/history').set(as('auditor'));
    expect(history.body[0]).toMatchObject({ oldValue: 300000, newValue: 350000, changedBy: 'admin' });
    await api().put('/api/settings/poverty_line_iqd').set(as('admin')).send({ value: 300000 });
  });
});

describe('المرفقات', () => {
  const upload = (familyId: string, buf: Buffer, name: string, fields: Record<string, string>, user = 'researcher') => {
    let req = api().post(`/api/families/${familyId}/attachments`).set(as(user)).attach('file', buf, name);
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req;
  };

  it('يرفع صورة و PDF، ويربط المرفق بفرد، ويعرضه برابط مؤقت', async () => {
    const f = await create();
    const photo = await upload(f.id, JPEG, 'صورة رب الأسرة.jpg', { category: 'PHOTO', personId: f.members[0].id });
    expect(photo.status).toBe(201);
    expect(photo.body).toMatchObject({ mime: 'image/jpeg', category: 'PHOTO', originalName: 'صورة رب الأسرة.jpg' });
    expect((await upload(f.id, PDF, 'form.pdf', { category: 'PAPER_FORM' })).body.mime).toBe('application/pdf');
    expect((await upload(f.id, PNG, 'id.png', { category: 'IDENTITY' })).status).toBe(201);

    const list = await api().get(`/api/families/${f.id}/attachments`).set(as('auditor'));
    expect(list.body).toHaveLength(3);

    const link = await api().post(`/api/attachments/${photo.body.id}/link`).set(as('supervisor'));
    expect(link.status).toBe(201);
    const file = await api().get(link.body.url).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(file.body, JPEG)).toBe(0);
  });

  it('النوع يُعرف من المحتوى: ملف تنفيذي باسم صورة يُرفض، وصورة باسم مضلِّل تُقبل بنوعها الحق', async () => {
    const f = await create();
    const exe = await upload(f.id, Buffer.from('MZ\x90\x00 this is not an image at all'), 'photo.jpg', { category: 'PHOTO' });
    expect(exe.status).toBe(400);
    const html = await upload(f.id, Buffer.from('<html><script>alert(1)</script></html>'), 'doc.pdf', { category: 'OTHER' });
    expect(html.status).toBe(400);
    const renamed = await upload(f.id, PDF, 'تقرير.exe', { category: 'MEDICAL' });
    expect(renamed.body.mime).toBe('application/pdf');
    expect((await api().get(`/api/families/${f.id}/attachments`).set(as('auditor'))).body).toHaveLength(1);
  });

  it('يرفض ما فوق 10 ميغابايت، والتصنيف المجهول، وفرداً من عائلة أخرى', async () => {
    const f = await create();
    const other = await create();
    const big = Buffer.concat([JPEG, Buffer.alloc(10 * 1024 * 1024)]);
    expect((await upload(f.id, big, 'big.jpg', { category: 'PHOTO' })).status).toBe(413);
    expect((await upload(f.id, JPEG, 'a.jpg', { category: 'SELFIE' })).status).toBe(400);
    expect((await upload(f.id, JPEG, 'a.jpg', { category: 'PHOTO', personId: other.members[0].id })).status).toBe(400);
    expect((await upload(f.id, JPEG, 'a.jpg', { category: 'PHOTO' }, 'distributor')).status).toBe(403);
  });

  it('الملف على القرص مشفّر، واسمه لا يدخل في مساره', async () => {
    const f = await create();
    const marker = Buffer.from('SECRET-MARKER-IN-FILE-BODY');
    await upload(f.id, Buffer.concat([JPEG, marker]), '../../etc/passwd.jpg', { category: 'IDENTITY' });
    const dir = join(process.env.STORAGE_DIR!, f.id);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(readFileSync(join(dir, files[0])).includes(marker)).toBe(false);
  });

  it('الرابط المعبوث به أو المنتهي لا يفتح الملف، والاطلاع يُسجَّل', async () => {
    const f = await create();
    const a = (await upload(f.id, JPEG, 'a.jpg', { category: 'IDENTITY' })).body;
    const b = (await upload(f.id, PDF, 'b.pdf', { category: 'OTHER' })).body;
    const link = (await api().post(`/api/attachments/${a.id}/link`).set(as('auditor'))).body.url as string;
    const [, exp, sig] = link.split('/').pop()!.split('.');

    expect((await api().get(`/api/files/${b.id}.${exp}.${sig}`)).status).toBe(403);
    expect((await api().get(`/api/files/${a.id}.${Number(exp) + 9999}.${sig}`)).status).toBe(403);
    expect((await api().get(`/api/files/${a.id}.${exp}.AAAA`)).status).toBe(403);
    expect((await api().get('/api/files/garbage')).status).toBe(403);

    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60 * 1000;
    try {
      expect((await api().get(link)).status).toBe(403);
    } finally {
      Date.now = realNow;
    }

    const log = await api().get('/api/audit').query({ limit: 1 }).set(as('auditor'));
    expect(log.body[0]).toMatchObject({ action: 'attachment.view', actor: 'auditor', entity_id: a.id });
  });

  it('الحذف يحجب المرفق ورابطه ويبقى أثره', async () => {
    const f = await create();
    const a = (await upload(f.id, JPEG, 'a.jpg', { category: 'PHOTO' })).body;
    const link = (await api().post(`/api/attachments/${a.id}/link`).set(as('supervisor'))).body.url;
    expect((await api().delete(`/api/attachments/${a.id}`).set(as('researcher'))).status).toBe(403);
    expect((await api().delete(`/api/attachments/${a.id}`).set(as('supervisor'))).status).toBe(200);
    expect((await api().get(link)).status).toBe(404);
    expect((await api().get(`/api/families/${f.id}/attachments`).set(as('auditor'))).body).toHaveLength(0);
    const row = await sql('select deleted_by is not null as kept from attachments where id = $1', [a.id]);
    expect(row.rows[0].kept).toBe(true);
  });
});

describe('طلبات التعديل', () => {
  const ask = (familyId: string, type: string, payload: any, user = 'researcher', reason = 'تحديث بطلب العائلة') =>
    api().post(`/api/families/${familyId}/changes`).set(as(user)).send({ type, payload, reason });
  const decide = (id: string, verb: 'approve' | 'reject', user = 'supervisor', body: any = {}) =>
    api().post(`/api/changes/${id}/${verb}`).set(as(user)).send(body);
  const read = async (id: string) => (await api().get(`/api/families/${id}`).set(as('auditor'))).body;

  it('التعديل لا يسري قبل اعتماده، ولا يعتمده طالبه', async () => {
    const f = await create();
    const req = await ask(f.id, 'UPDATE_FAMILY', { phone1: '07809998877', housing: 'OWNED', landmark: null });
    expect(req.status).toBe(201);
    expect(req.body.status).toBe('PENDING');
    expect((await read(f.id)).phone1).toBe(f.phone1);

    expect((await decide(req.body.id, 'approve', 'researcher')).status).toBe(403);
    const self = await ask(f.id, 'UPDATE_FAMILY', { notes: 'ملاحظة' }, 'supervisor');
    expect((await decide(self.body.id, 'approve', 'supervisor')).status).toBe(403);

    const ok = await decide(req.body.id, 'approve');
    expect(ok.body).toMatchObject({ status: 'APPROVED', decidedBy: 'supervisor' });
    const after = await read(f.id);
    expect(after).toMatchObject({ phone1: '07809998877', housing: 'OWNED' });
    expect(after.address.landmark).toBeNull();
    expect(after.address.mahalla).toBe('الجولان');

    expect((await decide(req.body.id, 'approve')).status).toBe(409);
    const log = await api().get('/api/audit').query({ limit: 1 }).set(as('auditor'));
    expect(log.body[0].payload.before).toMatchObject({ phone1: f.phone1, housing: 'RENTED' });
  });

  it('يلزم سبب للطلب وسبب للرفض، والمرفوض لا يغيّر شيئاً', async () => {
    const f = await create();
    expect((await ask(f.id, 'UPDATE_FAMILY', { housing: 'OWNED' }, 'researcher', '')).status).toBe(400);
    expect((await ask(f.id, 'UPDATE_FAMILY', {})).status).toBe(400);
    expect((await ask(f.id, 'UPDATE_FAMILY', { phone1: '123' })).status).toBe(400);
    const req = await ask(f.id, 'UPDATE_FAMILY', { housing: 'OWNED' });
    expect((await decide(req.body.id, 'reject')).status).toBe(400);
    expect((await decide(req.body.id, 'reject', 'supervisor', { note: 'لا دليل' })).body.status).toBe('REJECTED');
    expect((await read(f.id)).housing).toBe('RENTED');
  });

  it('تعديل الدخل يغيّر موقع العائلة من خط الفقر', async () => {
    const f = await create(family({ incomes: [{ kind: 'SALARY', amountIqd: 900000 }] }));
    const req = await ask(f.id, 'SET_INCOMES', { incomes: [{ kind: 'SOCIAL_WELFARE', amountIqd: 125000 }] });
    await decide(req.body.id, 'approve');
    expect(await read(f.id)).toMatchObject({ monthlyIncomeIqd: 125000, belowPovertyLine: true });
  });

  it('ولادة ووفاة: العدد يتبع الأفراد', async () => {
    const f = await create();
    const birth = await ask(f.id, 'ADD_MEMBER', {
      member: { relation: 'DAUGHTER', fullName: 'مولودة جديدة', gender: 'F', birthDate: '2026-10-01', documents: [] },
    });
    await decide(birth.body.id, 'approve');
    let now = await read(f.id);
    expect(now.counts).toEqual({ members: 2, males: 0, females: 2 });

    const secondHead = await ask(f.id, 'ADD_MEMBER', {
      member: { relation: 'HEAD', fullName: 'رب أسرة ثانٍ', gender: 'M', documents: [] },
    });
    expect(secondHead.status).toBe(400);

    const baby = now.members.find((m: any) => m.fullName === 'مولودة جديدة');
    const death = await ask(f.id, 'UPDATE_MEMBER', { personId: baby.id, status: 'DECEASED' });
    await decide(death.body.id, 'approve');
    now = await read(f.id);
    expect(now.counts.members).toBe(1);

    const foreign = await create();
    expect((await ask(f.id, 'UPDATE_MEMBER', { personId: foreign.members[0].id, isOrphan: true })).status).toBe(400);
  });

  it('من حدّث هويته القديمة تُضاف بطاقته الوطنية إلى سجله، فيُمنع بها وبالقديمة', async () => {
    const civil = { type: 'CIVIL_ID', number: '0077123', register: '501', page: '12' };
    const f0 = family();
    f0.members[0].documents = [civil];
    const f = await create(f0);
    const card = nationalNo();

    const req = await ask(f.id, 'ADD_DOCUMENT', { personId: f.members[0].id, document: { type: 'NATIONAL_CARD', number: card } });
    expect(req.status).toBe(201);
    expect(JSON.stringify(req.body)).not.toContain(card);
    await decide(req.body.id, 'approve');
    expect((await read(f.id)).members[0].documents).toHaveLength(2);

    const byCard = family();
    byCard.members[0].documents = [{ type: 'NATIONAL_CARD', number: card }];
    expect((await api().post('/api/families').set(as('researcher')).send(byCard)).status).toBe(409);
    const byCivil = family();
    byCivil.members[0].documents = [civil];
    expect((await api().post('/api/families').set(as('researcher')).send(byCivil)).status).toBe(409);
  });

  it('وثيقة مسجَّلة لغيره تُرفض عند الطلب، وعند الاعتماد إن سُجّلت بينهما', async () => {
    const taken = nationalNo();
    const owner = family();
    owner.members[0].documents = [{ type: 'NATIONAL_CARD', number: taken }];
    await create(owner);
    const f = await create();
    const atRequest = await ask(f.id, 'ADD_DOCUMENT', { personId: f.members[0].id, document: { type: 'NATIONAL_CARD', number: taken } });
    expect(atRequest.status).toBe(409);

    const racing = nationalNo();
    const req = await ask(f.id, 'ADD_DOCUMENT', { personId: f.members[0].id, document: { type: 'NATIONAL_CARD', number: racing } });
    const late = family();
    late.members[0].documents = [{ type: 'NATIONAL_CARD', number: racing }];
    await create(late);
    expect((await decide(req.body.id, 'approve')).status).toBe(409);
    const still = await api().get('/api/changes').query({ familyId: f.id, status: 'PENDING' }).set(as('auditor'));
    expect(still.body.map((r: any) => r.id)).toContain(req.body.id);
  });

  it('تبديل الوكلاء يعطّل السابقين ولا يحذفهم', async () => {
    const f = await create(family({ proxies: [{ fullName: 'وكيل قديم' }] }));
    const req = await ask(f.id, 'SET_PROXIES', { proxies: [{ fullName: 'وكيل جديد', phone: '07701234567' }] });
    await decide(req.body.id, 'approve');
    const proxies = (await read(f.id)).proxies;
    expect(proxies.find((p: any) => p.fullName === 'وكيل قديم').active).toBe(false);
    expect(proxies.find((p: any) => p.fullName === 'وكيل جديد').active).toBe(true);
  });

  it('السجل المرفوض لا يُعدَّل، وسلسلة التدقيق سليمة بعد كل ما سبق', async () => {
    const f = await create();
    await api().post(`/api/families/${f.id}/reject`).set(as('supervisor')).send({ note: 'خارج النطاق' });
    expect((await ask(f.id, 'UPDATE_FAMILY', { housing: 'OWNED' })).status).toBe(409);
    expect((await api().get('/api/audit/verify').set(as('auditor'))).body.ok).toBe(true);
  });
});
