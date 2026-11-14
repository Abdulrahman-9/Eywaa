import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { codeAt, stepAt } from '../src/auth/totp';
import { PASSWORD, startApp } from './helpers';

/** ضوابط تُضبط من بيئة النشر: إلزام المدير والمحاسب بالتحقق بعاملين، وكبح المحاولات من العنوان الواحد. */
let app: INestApplication;
const api = () => request(app.getHttpServer());
const signIn = (username: string, password: string, code?: string) => api().post('/api/auth/login').send({ username, password, code });

beforeAll(async () => {
  process.env.REQUIRE_TOTP = '1';
  process.env.LOGIN_FAILS_PER_IP = '6';
  app = await startApp();
});
afterAll(async () => {
  delete process.env.REQUIRE_TOTP;
  delete process.env.LOGIN_FAILS_PER_IP;
  await app.close();
});

describe('إلزام التحقق بعاملين', () => {
  it('المحاسب لا يُفتح له شيء حتى يفعّله، وغير أدوار المال لا يُلزم', async () => {
    const token = (await signIn('accountant', PASSWORD)).body.token;
    const auth = { Authorization: `Bearer ${token}` };
    const blocked = await api().get('/api/accounting/summary').set(auth);
    expect([blocked.status, blocked.body.code]).toEqual([403, 'TOTP_SETUP_REQUIRED']);
    expect((await api().get('/api/auth/me').set(auth)).body).toMatchObject({ totpRequired: true, totpEnabled: false });

    const setup = await api().post('/api/auth/totp/setup').set(auth);
    expect(setup.status).toBe(200);
    expect((await api().post('/api/auth/totp/enable').set(auth).send({ code: codeAt(setup.body.secret, stepAt(Date.now()) - 1) })).status).toBe(200);
    expect((await api().get('/api/accounting/summary').set(auth)).status).toBe(200);

    const researcher = (await signIn('researcher', PASSWORD)).body.token;
    expect((await api().get('/api/families').set({ Authorization: `Bearer ${researcher}` })).status).toBe(200);
  });
});

describe('كبح العنوان الواحد', () => {
  it('من يجرّب أسماء كثيرة من اتصال واحد يُردّ بعد الحدّ، ولو جاء بعدها بالصحيح', async () => {
    for (let i = 0; i < 6; i++) expect((await signIn(`nobody${i}`, 'some-password-123')).status).toBe(401);
    const stopped = await signIn('auditor', PASSWORD);
    expect([stopped.status, stopped.body.code]).toEqual([429, 'THROTTLED']);
  });
});
