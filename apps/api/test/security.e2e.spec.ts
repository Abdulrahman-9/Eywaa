import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { base32Decode, base32Encode, codeAt, stepAt, verifyCode } from '../src/auth/totp';
import { family, login, nationalNo, PASSWORD, sql, startApp } from './helpers';

let app: INestApplication;
const tokens: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });
const signIn = (username: string, password: string, code?: string) => api().post('/api/auth/login').send({ username, password, code });

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'researcher', 'supervisor', 'auditor', 'accountant']) tokens[u] = await login(app, u);
});
afterAll(async () => {
  await app.close();
});

describe('رموز التحقق الزمنية', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  it('تطابق متجهات RFC 6238', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(codeAt(secret, stepAt(59_000))).toBe('287082');
    expect(codeAt(secret, stepAt(1111111109_000))).toBe('081804');
    expect(codeAt(secret, stepAt(1234567890_000))).toBe('005924');
  });

  it('يقبل الخطوة المجاورة لفرق الساعات، ويرفض الرمز المستعمل والبعيد', () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    expect(verifyCode(secret, codeAt(secret, step), now, null)).toBe(step);
    expect(verifyCode(secret, codeAt(secret, step - 1), now, null)).toBe(step - 1);
    expect(verifyCode(secret, codeAt(secret, step), now, step)).toBeNull();
    expect(verifyCode(secret, codeAt(secret, step - 3), now, null)).toBeNull();
    expect(verifyCode(secret, '12345', now, null)).toBeNull();
  });
});

describe('الدخول', () => {
  it('المستخدم المجهول وكلمة المرور الخاطئة برسالة واحدة', async () => {
    const unknown = await signIn('nobody', 'whatever-password');
    const wrong = await signIn('auditor', 'whatever-password');
    expect([unknown.status, wrong.status]).toEqual([401, 401]);
    expect(unknown.body.message).toBe(wrong.body.message);
    await sql("update users set failed_logins = 0 where username = 'auditor'");
  });

  it('بعد خمس محاولات خاطئة يُقفل الحساب، ولو جاءت بعدها الكلمة الصحيحة', async () => {
    for (let i = 0; i < 5; i++) expect((await signIn('auditor', 'wrong-password-123')).status).toBe(401);
    const locked = await signIn('auditor', PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.body).toMatchObject({ code: 'LOCKED' });
    expect(locked.body.message).toContain('15 دقيقة');
    const log = await sql("select count(*)::int as n from audit_log where action = 'auth.locked'");
    expect(log.rows[0].n).toBe(1);
  });

  it('المدير يفكّ القفل، والدخول الصحيح يصفّر العدّاد', async () => {
    const id = (await sql("select id from users where username = 'auditor'")).rows[0].id;
    expect((await api().patch(`/api/users/${id}`).set(as('admin')).send({ resetAccess: true })).status).toBe(200);
    expect((await signIn('auditor', PASSWORD)).status).toBe(200);
    for (let i = 0; i < 4; i++) await signIn('auditor', 'wrong-password-123');
    expect((await signIn('auditor', PASSWORD)).status).toBe(200);
    expect((await sql("select failed_logins from users where username = 'auditor'")).rows[0].failed_logins).toBe(0);
  });
});

describe('كلمة المرور', () => {
  it('يغيّرها صاحبها بالحالية، ولا تُقبل القصيرة', async () => {
    const change = (current: string, next: string) => api().post('/api/auth/password').set(as('researcher')).send({ current, next });
    expect((await change('not-the-current', 'a-brand-new-password')).status).toBe(403);
    expect((await change(PASSWORD, 'short')).status).toBe(400);
    expect((await change(PASSWORD, PASSWORD)).status).toBe(400);
    expect((await change(PASSWORD, 'a-brand-new-password')).status).toBe(200);
    expect((await signIn('researcher', PASSWORD)).status).toBe(401);
    expect((await signIn('researcher', 'a-brand-new-password')).status).toBe(200);
  });

  it('كلمة يضعها المدير مؤقتة: يُلزم صاحبها بتغييرها، ولا تدخل سجل التدقيق', async () => {
    const id = (await sql("select id from users where username = 'supervisor'")).rows[0].id;
    await api().patch(`/api/users/${id}`).set(as('admin')).send({ password: 'temporary-password-1' });
    const first = await signIn('supervisor', 'temporary-password-1');
    expect(first.body.user.mustChangePassword).toBe(true);
    const auth = { Authorization: `Bearer ${first.body.token}` };
    await api().post('/api/auth/password').set(auth).send({ current: 'temporary-password-1', next: 'my-own-password-22' });
    expect((await api().get('/api/auth/me').set(auth)).body.mustChangePassword).toBe(false);
    const log = await sql("select payload::text as p from audit_log where action = 'user.update' order by seq desc limit 1");
    expect(log.rows[0].p).toContain('"passwordReset": true');
    expect(log.rows[0].p).not.toContain('temporary-password-1');
  });
});

describe('التحقق بعاملين', () => {
  let secret: string;
  const auth = () => as('accountant');

  it('لا يُفعَّل حتى يثبت صاحبه برمز صحيح', async () => {
    const setup = await api().post('/api/auth/totp/setup').set(auth());
    secret = setup.body.secret;
    expect(setup.body.uri).toContain(`otpauth://totp/Eywaa:accountant?secret=${secret}`);
    expect((await api().post('/api/auth/totp/enable').set(auth()).send({ code: '000000' })).status).toBe(403);
    expect((await signIn('accountant', PASSWORD)).status).toBe(200);
    const stored = await sql("select totp_secret_enc from users where username = 'accountant'");
    expect(stored.rows[0].totp_secret_enc).not.toContain(secret);
    // يُفعَّل برمز الخطوة السابقة، لتبقى الحالية صالحة للدخول بعده.
    expect((await api().post('/api/auth/totp/enable').set(auth()).send({ code: codeAt(secret, stepAt(Date.now()) - 1) })).status).toBe(200);
  });

  it('الدخول يطلب الرمز، ويرفض الخاطئ، ولا يقبل الرمز نفسه مرتين', async () => {
    const noCode = await signIn('accountant', PASSWORD);
    expect(noCode.status).toBe(401);
    expect(noCode.body.code).toBe('TOTP_REQUIRED');
    expect((await signIn('accountant', PASSWORD, '000000')).body.code).toBe('TOTP_INVALID');
    const code = codeAt(secret, stepAt(Date.now()));
    const ok = await signIn('accountant', PASSWORD, code);
    expect(ok.status).toBe(200);
    expect(ok.body.user.totpEnabled).toBe(true);
    expect((await signIn('accountant', PASSWORD, code)).body.code).toBe('TOTP_INVALID');
    // كلمة المرور الخاطئة لا تكشف أن الحساب محميّ برمز.
    expect((await signIn('accountant', 'wrong-password-123', code)).body.code).toBeUndefined();
  });

  it('يعطّله صاحبه بكلمة مروره', async () => {
    expect((await api().post('/api/auth/totp/disable').set(auth()).send({ password: 'wrong' })).status).toBe(403);
    expect((await api().post('/api/auth/totp/disable').set(auth()).send({ password: PASSWORD })).status).toBe(200);
    await sql("update users set failed_logins = 0, locked_until = null where username = 'accountant'");
    expect((await signIn('accountant', PASSWORD)).status).toBe(200);
  });
});

describe('حماية البيانات', () => {
  it('رقم الوثيقة في طلب تعديل معلَّق محفوظ مشفّراً', async () => {
    tokens.researcher = (await signIn('researcher', 'a-brand-new-password')).body.token;
    const f = await api().post('/api/families').set(as('researcher')).send(family());
    const card = nationalNo();
    const req = await api().post(`/api/families/${f.body.id}/changes`).set(as('researcher'))
      .send({ type: 'ADD_DOCUMENT', payload: { personId: f.body.members[0].id, document: { type: 'NATIONAL_CARD', number: card } }, reason: 'حدّث هويته' });
    expect(req.status).toBe(201);
    expect(req.body.payload.document.number).toBe(`********${card.slice(-4)}`);
    const stored = await sql('select payload::text as p from change_requests where id = $1', [req.body.id]);
    expect(stored.rows[0].p).not.toContain(card);
    expect(stored.rows[0].p).toContain('numberEnc');

    tokens.supervisor = (await signIn('supervisor', 'my-own-password-22')).body.token;
    expect((await api().post(`/api/changes/${req.body.id}/approve`).set(as('supervisor')).send({})).status).toBe(200);
    const hit = await api().post('/api/families/lookup/document').set(as('researcher')).send({ type: 'NATIONAL_CARD', number: card });
    expect(hit.body.found).toBe(true);
  });

  it('لا رقم وثيقة كاملاً في سجل التدقيق كله', async () => {
    const numbers = await sql('select number_enc from person_documents limit 1');
    expect(numbers.rows[0].number_enc).not.toMatch(/^\d+$/);
    const leaks = await sql("select count(*)::int as n from audit_log where payload::text ~ '\\d{12}'");
    expect(leaks.rows[0].n).toBe(0);
  });

  it('السلسلة سليمة بعد كل ما سبق', async () => {
    tokens.auditor = (await signIn('auditor', PASSWORD)).body.token;
    expect((await api().get('/api/audit/verify').set(as('auditor'))).body.ok).toBe(true);
  });
});
