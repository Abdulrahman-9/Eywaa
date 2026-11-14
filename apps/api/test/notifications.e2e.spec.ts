import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import { chainFor, Channel, ChannelDriver, Channels, driverFromEnv, HttpGatewayDriver, render, SimulatedDriver, unknownVariables } from '../src/notifications/channels';
import { NotificationsService } from '../src/notifications/notifications.service';
import { family, login, sql, startApp } from './helpers';

let app: INestApplication;
const tokens: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });
const post = (path: string, user: string, body: any = {}) => api().post(`/api${path}`).set(as(user)).send(body);
const get = (path: string, user: string) => api().get(`/api${path}`).set(as(user));

/** مزوّد اختبار: تُحدَّد له القنوات التي تخفق. */
class FlakyDriver implements ChannelDriver {
  readonly name = 'اختبار';
  readonly live = false;
  sent: { channel: Channel; phone: string; text: string }[] = [];
  constructor(private readonly failing: Channel[]) {}
  async send(channel: Channel, phone: string, text: string) {
    if (this.failing.includes(channel)) return { ok: false, error: `${channel} down` };
    this.sent.push({ channel, phone, text });
    return { ok: true, providerRef: 'x' };
  }
}

const fams: any[] = [];
async function approvedFamily(extra: any) {
  const created = await post('/families', 'researcher', family(extra));
  return (await post(`/families/${created.body.id}/approve`, 'supervisor')).body;
}

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'researcher', 'supervisor', 'manager', 'manager2', 'distributor', 'auditor']) tokens[u] = await login(app, u);
  fams.push(await approvedFamily({ address: { mahalla: 'الجولان' } }));                              // واتساب
  fams.push(await approvedFamily({ hasWhatsapp: false, address: { mahalla: 'الجولان' } }));          // رسالة نصية
  fams.push(await approvedFamily({ prefersVoice: true, address: { mahalla: 'الشهداء' } }));          // مكالمة
  fams.push(await approvedFamily({ phone1: undefined, address: { mahalla: 'الشهداء' } }));           // بلا هاتف
});
afterAll(async () => {
  await app.close();
});

describe('القنوات والقوالب', () => {
  it('ترتيب القنوات بحسب حال العائلة', () => {
    expect(chainFor({ hasWhatsapp: true, prefersVoice: false })).toEqual(['WHATSAPP', 'SMS']);
    expect(chainFor({ hasWhatsapp: false, prefersVoice: false })).toEqual(['SMS']);
    expect(chainFor({ hasWhatsapp: true, prefersVoice: true })).toEqual(['VOICE', 'SMS']);
  });
  it('المتغيرات تُملأ، والمجهول يُكشف', () => {
    expect(render('مرحباً {الاسم}، رقمكم {رقم_العائلة}', { 'الاسم': 'سعاد', 'رقم_العائلة': '1000017' })).toBe('مرحباً سعاد، رقمكم 1000017');
    expect(render('في {النقطة}', {})).toBe('في {النقطة}');
    expect(unknownVariables('{الاسم} {العنوان} {رقم_العائلة} {شيء}')).toEqual(['العنوان', 'شيء']);
  });
});

describe('الإرسال الجماعي', () => {
  const msg = { title: 'إعلان', body: 'السلام عليكم {الاسم}. يفتح المركز أبوابه السبت. رقم العائلة: {رقم_العائلة}', audience: {} };

  it('المعاينة تعدّ المخاطَبين بقنواتهم وتعرض نموذجاً، ولا ترسل شيئاً', async () => {
    const p = await post('/notifications/preview', 'supervisor', msg);
    expect(p.body).toMatchObject({ recipients: 4, byChannel: { WHATSAPP: 1, SMS: 1, VOICE: 1, NO_PHONE: 1 }, needsApproval: false, driver: { live: false } });
    expect(p.body.sample).toContain(fams[0].members[0].fullName);
    expect(p.body.sample).not.toContain('{');
    expect((await sql('select count(*)::int as n from messages')).rows[0].n).toBe(0);
    expect((await post('/notifications/preview', 'distributor', msg)).status).toBe(403);
  });

  it('يرفض المتغير المجهول، ومتغيرات الحملة في رسالة بلا حملة', async () => {
    expect((await post('/notifications/preview', 'supervisor', { ...msg, body: 'مرحباً {العنوان} وأهلاً' })).status).toBe(400);
    expect((await post('/notifications/preview', 'supervisor', { ...msg, body: 'رمزكم {الرمز_الرقمي} للاستلام' })).status).toBe(400);
    expect((await post('/notifications/preview', 'supervisor', { ...msg, audience: { pendingOnly: true } })).status).toBe(400);
  });

  it('لكل عائلة رسالة بحال معلومة، بقناتها', async () => {
    const res = await post('/notifications', 'supervisor', msg);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'SENT', recipients: 4, byStatus: { SENT: 3, NO_PHONE: 1 }, byChannel: { WHATSAPP: 1, SMS: 1, VOICE: 1 } });
    expect(res.body.problems).toEqual([expect.objectContaining({ familyNo: fams[3].familyNo, status: 'NO_PHONE' })]);
    const mine = await get(`/families/${fams[1].id}/messages`, 'auditor');
    expect(mine.body[0]).toMatchObject({ channel: 'SMS', status: 'SENT', title: 'إعلان' });
    expect(mine.body[0].text).toContain(fams[1].familyNo);
  });

  it('الاختيار بالمحلة يحصر المخاطَبين', async () => {
    const p = await post('/notifications/preview', 'supervisor', { ...msg, audience: { mahalla: 'الجولان' } });
    expect(p.body.recipients).toBe(2);
  });

  it('إن أخفق الواتساب جُرِّبت الرسالة النصية، وإن أخفق الكل سُجِّل الإخفاق بسببه', async () => {
    const channels = app.get(Channels);
    const flaky = new FlakyDriver(['WHATSAPP']);
    channels.use(flaky);
    const res = await post('/notifications', 'supervisor', { ...msg, title: 'واتساب معطَّل', audience: { mahalla: 'الجولان' } });
    expect(res.body.byChannel).toEqual({ SMS: 2 });
    const row = await sql("select tried::text[] as tried from messages m join notifications n on n.id = m.notification_id where n.title = 'واتساب معطَّل' and m.family_id = $1", [fams[0].id]);
    expect(row.rows[0].tried).toEqual(['WHATSAPP', 'SMS']);

    channels.use(new FlakyDriver(['WHATSAPP', 'SMS', 'VOICE']));
    const dead = await post('/notifications', 'supervisor', { ...msg, title: 'الكل معطَّل', audience: { mahalla: 'الجولان' } });
    expect(dead.body.byStatus).toEqual({ FAILED: 2 });
    expect(dead.body.problems[0]).toMatchObject({ status: 'FAILED', error: 'SMS down' });
    channels.use(new SimulatedDriver());
  });

  it('ما فوق الحدّ لا يخرج حتى يعتمده موظف آخر', async () => {
    await api().put('/api/settings/bulk_message_approval_threshold').set(as('admin')).send({ value: 2 });
    const before = (await sql('select count(*)::int as n from messages')).rows[0].n;
    const res = await post('/notifications', 'manager', { ...msg, title: 'كبير' });
    expect(res.body).toMatchObject({ status: 'PENDING_APPROVAL', byStatus: {} });
    expect((await sql('select count(*)::int as n from messages')).rows[0].n).toBe(before);
    expect((await post(`/notifications/${res.body.id}/approve`, 'manager')).status).toBe(403);
    expect((await post(`/notifications/${res.body.id}/approve`, 'supervisor')).status).toBe(403);
    const ok = await post(`/notifications/${res.body.id}/approve`, 'manager2');
    expect(ok.body).toMatchObject({ status: 'SENT', byStatus: { SENT: 3, NO_PHONE: 1 } });
    expect((await post(`/notifications/${res.body.id}/approve`, 'manager2')).status).toBe(409);

    const rejected = await post('/notifications', 'manager', { ...msg, title: 'مرفوض' });
    expect((await post(`/notifications/${rejected.body.id}/reject`, 'manager2')).status).toBe(400);
    expect((await post(`/notifications/${rejected.body.id}/reject`, 'manager2', { note: 'مكرر' })).body.status).toBe('REJECTED');
    await api().put('/api/settings/bulk_message_approval_threshold').set(as('admin')).send({ value: 500 });
  });
});

describe('رسائل النظام مع الحملة', () => {
  let campaignId: string, toks: any[], pointId: string;

  it('اعتماد الحملة يرسل لكل عائلة دعوتها برمزها الرقمي', async () => {
    const programId = (await post('/programs', 'admin', { name: 'سلة', kind: 'IN_KIND', unit: 'سلة', rules: {}, amount: { type: 'FIXED', value: 1 } })).body.id;
    pointId = (await post('/points', 'manager', { name: 'الجولان' })).body.id;
    const c = await post('/campaigns', 'manager', { name: 'سلة الشهر', programId, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [pointId] });
    campaignId = c.body.id;
    await post(`/campaigns/${campaignId}/submit`, 'manager');
    await post(`/campaigns/${campaignId}/approve`, 'manager2');
    toks = (await get(`/campaigns/${campaignId}/tokens`, 'manager')).body;

    const invite = (await get('/notifications', 'auditor')).body.find((n: any) => n.kind === 'CAMPAIGN_INVITE');
    expect(invite).toMatchObject({ title: 'دعوة الاستلام: سلة الشهر', recipients: 4, sent: 3, noPhone: 1 });
    const t = toks.find((x) => x.familyNo === fams[0].familyNo);
    const text = (await get(`/families/${fams[0].id}/messages`, 'auditor')).body[0].text;
    expect(text).toContain(t.code);
    expect(text).toContain('نقطة الجولان');
    expect(text).toContain('1 سلة');
    expect(text).not.toContain('{');
  });

  it('التذكير يذهب إلى من لم يستلم فقط، والتسليم يرسل تأكيداً يسمّي المستلم', async () => {
    const t = toks.find((x) => x.familyNo === fams[0].familyNo);
    await post('/deliveries/redeem', 'distributor', { pointId, deviceId: 'd1', locate: { token: t.token }, receiver: { kind: 'HEAD' }, clientOpId: randomUUID() });
    const confirmation = (await get(`/families/${fams[0].id}/messages`, 'auditor')).body[0];
    expect(confirmation.kind).toBe('DELIVERY_CONFIRMATION');
    expect(confirmation.text).toContain('استُلمت مستحقاتكم (1 سلة) من نقطة الجولان');
    expect(confirmation.text).toContain(`رب الأسرة ${fams[0].members[0].fullName}`);
    expect(confirmation.text).toContain('إن لم تستلموها فراجعوا المركز فوراً');

    const reminder = await post('/notifications/preview', 'manager', {
      title: 'تذكير', body: 'تذكير: مستحقاتكم في {النقطة} حتى {آخر_موعد}. الرمز: {الرمز_الرقمي}', audience: { campaignId, pendingOnly: true },
    });
    expect(reminder.body.recipients).toBe(3);
  });

  it('للتسليم الواحد رسالة تأكيد واحدة', async () => {
    const n = await sql("select count(*)::int as n from messages m join notifications x on x.id = m.notification_id where x.kind = 'DELIVERY_CONFIRMATION' and m.family_id = $1", [fams[0].id]);
    expect(n.rows[0].n).toBe(1);
  });
});

describe('طابور الإرسال مع مزوّد حقيقي (بوّابة HTTP)', () => {
  let gateway: Server, url: string, service: NotificationsService;
  const received: { auth?: string; channel: Channel; to: string; text: string }[] = [];
  /** ما تجيب به البوّابة عن كل طلب: حالة HTTP وجسم. */
  let reply: (req: { channel: Channel; to: string }, n: number) => { status: number; body: any } = () => ({ status: 200, body: { id: 'x' } });
  const queue = (title: string) => sql(
    "select m.status, m.attempts, m.error, m.provider_ref, m.channel, m.tried::text[] as tried, m.next_attempt_at from messages m join notifications n on n.id = m.notification_id where n.title = $1 order by m.family_id", [title]);
  const due = (title: string) => sql("update messages m set next_attempt_at = now() from notifications n where n.id = m.notification_id and n.title = $1 and m.status = 'QUEUED'", [title]);
  const sendTo = (title: string, mahalla: string) => post('/notifications', 'supervisor', { title, body: 'تنبيه إلى {الاسم}', audience: { mahalla } });
  const body = (req: IncomingMessage) => new Promise<string>((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });

  beforeAll(async () => {
    gateway = createServer(async (req, res) => {
      const msg = JSON.parse(await body(req));
      received.push({ auth: req.headers.authorization, ...msg });
      const r = reply(msg, received.length);
      res.writeHead(r.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(r.body));
    });
    await new Promise<void>((ok) => gateway.listen(0, '127.0.0.1', ok));
    url = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/send`;
    service = app.get(NotificationsService);
    app.get(Channels).use(new HttpGatewayDriver(url, 'gw-secret', ['SMS', 'WHATSAPP']));
    await api().put('/api/settings/bulk_message_approval_threshold').set(as('admin')).send({ value: 500 });
    for (let i = 0; i < 20; i++) await approvedFamily({ hasWhatsapp: false, address: { mahalla: 'الطابور' } });
    await approvedFamily({ hasWhatsapp: false, address: { mahalla: 'المنفرد' } });
  });
  afterAll(async () => {
    app.get(Channels).use(new SimulatedDriver());
    await new Promise((ok) => gateway.close(ok));
  });
  beforeEach(() => { received.length = 0; reply = (_m, n) => ({ status: 200, body: { id: `gw-${n}` } }); });

  it('بلا إعداد يبقى المزوّد محاكاة، وبالعنوان والرمز يصير بوّابة حقيقية', () => {
    expect(driverFromEnv({}).live).toBe(false);
    expect(driverFromEnv({ MSG_GATEWAY_URL: url }).live).toBe(false);
    const live = driverFromEnv({ MSG_GATEWAY_URL: url, MSG_GATEWAY_TOKEN: 't', MSG_GATEWAY_CHANNELS: 'sms, whatsapp' });
    expect(live.live).toBe(true);
    expect(live.name).toContain('127.0.0.1');
  });

  it('الرسائل تُكتب في الطابور ولا تخرج في الطلب نفسه، ثم يرسلها العامل بقدر حدّه', async () => {
    const res = await sendTo('طابور أول', 'الطابور');
    expect(res.body.byStatus).toEqual({ QUEUED: 20 });
    expect(received).toHaveLength(0);
    expect((await get('/notifications', 'supervisor')).body.find((n: any) => n.title === 'طابور أول')).toMatchObject({ sent: 0, queued: 20 });

    expect(await service.processQueue(5)).toBe(5);
    expect(received).toHaveLength(5);
    expect(received[0]).toMatchObject({ auth: 'Bearer gw-secret', channel: 'SMS' });
    expect(received[0].to).toMatch(/^\+?9647\d{9}$|^07\d{9}$/);
    expect(received[0].text).toContain('تنبيه إلى ');
    while ((await service.processQueue(7)) > 0);
    expect(received).toHaveLength(20);
    expect(new Set(received.map((r) => r.to)).size).toBe(20);
    const rows = (await queue('طابور أول')).rows;
    expect(rows.every((r) => r.status === 'SENT' && r.attempts === 1 && r.provider_ref.startsWith('gw-') && r.next_attempt_at === null)).toBe(true);
  });

  it('عاملان يسحبان في لحظة واحدة: لا رسالة تخرج مرتين', async () => {
    await sendTo('طابور متزامن', 'الطابور');
    const taken = await Promise.all([service.processQueue(20), service.processQueue(20), service.processQueue(20)]);
    expect(taken.reduce((a, b) => a + b, 0)).toBe(20);
    expect(received).toHaveLength(20);
    expect(new Set(received.map((r) => r.to)).size).toBe(20);
  });

  it('العطل العابر (503) يعيد الرسالة إلى الطابور بمهلة، ثم تخرج مرة واحدة', async () => {
    reply = () => ({ status: 503, body: { error: 'overloaded' } });
    await sendTo('عطل عابر', 'المنفرد');
    expect(await service.processQueue(10)).toBe(1);
    let [m] = (await queue('عطل عابر')).rows;
    expect(m).toMatchObject({ status: 'QUEUED', attempts: 1, error: 'overloaded' });
    const wait = (new Date(m.next_attempt_at).getTime() - Date.now()) / 1000;
    expect(wait).toBeGreaterThan(40);
    expect(wait).toBeLessThan(70);
    // لم يحن وقتها: لا تُسحب.
    expect(await service.processQueue(10)).toBe(0);

    reply = () => ({ status: 200, body: { id: 'gw-late' } });
    await due('عطل عابر');
    expect(await service.processQueue(10)).toBe(1);
    [m] = (await queue('عطل عابر')).rows;
    expect(m).toMatchObject({ status: 'SENT', attempts: 2, provider_ref: 'gw-late', error: null });
    expect(received).toHaveLength(2);
  });

  it('بعد أربع محاولات عابرة تُعدّ مخفقة، والمهلة تطول: دقيقة ثم خمس ثم ثلاثون', async () => {
    reply = () => ({ status: 429, body: { message: 'slow down' } });
    await sendTo('عطل دائم', 'المنفرد');
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      await due('عطل دائم');
      await service.processQueue(10);
      const [m] = (await queue('عطل دائم')).rows;
      if (m.status === 'QUEUED') waits.push(Math.round((new Date(m.next_attempt_at).getTime() - Date.now()) / 60000));
    }
    expect(waits).toEqual([1, 5, 30]);
    const [m] = (await queue('عطل دائم')).rows;
    expect(m).toMatchObject({ status: 'FAILED', attempts: 4, error: 'slow down', next_attempt_at: null });
    expect(received).toHaveLength(4);
    expect(await service.processQueue(10)).toBe(0);
  });

  it('الرفض النهائي (400) لا يُعاد، وسببه يُحفظ ويظهر للمرسل', async () => {
    reply = () => ({ status: 400, body: { error: 'رقم غير صالح' } });
    const res = await sendTo('رفض نهائي', 'المنفرد');
    await service.processQueue(10);
    const [m] = (await queue('رفض نهائي')).rows;
    expect(m).toMatchObject({ status: 'FAILED', attempts: 1, error: 'رقم غير صالح' });
    const detail = await get(`/notifications/${res.body.id}`, 'supervisor');
    expect(detail.body.problems[0]).toMatchObject({ status: 'FAILED', error: 'رقم غير صالح' });
    expect(received).toHaveLength(1);
  });

  it('رسالة أخذها خادم ثم مات ترجع إلى الطابور بعد انقضاء الإعارة', async () => {
    await sendTo('إعارة', 'المنفرد');
    // خادم سحبها ومات قبل أن يرسل: المحاولة عُدّت والموعد أُجّل عشر دقائق.
    await sql("update messages m set attempts = 1, next_attempt_at = now() + interval '10 minutes' from notifications n where n.id = m.notification_id and n.title = 'إعارة'");
    expect(await service.processQueue(10)).toBe(0);
    await due('إعارة');
    expect(await service.processQueue(10)).toBe(1);
    expect((await queue('إعارة')).rows[0]).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  it('إشعار المزوّد بالتسليم والقراءة: بسرّه وحده، والحال لا ترجع إلى الوراء', async () => {
    reply = () => ({ status: 200, body: { id: 'gw-status-1' } });
    await sendTo('إشعار', 'المنفرد');
    await service.processQueue(10);
    const call = (secret: string | undefined, b: any) => { const r = api().post('/api/notifications/provider-status'); return (secret ? r.set('X-Gateway-Secret', secret) : r).send(b); };

    expect((await call('anything', { id: 'gw-status-1', status: 'delivered' })).status).toBe(404);   // السرّ لم يُضبط
    process.env.MSG_CALLBACK_SECRET = 'cb-secret';
    expect((await call(undefined, { id: 'gw-status-1', status: 'delivered' })).status).toBe(404);
    expect((await call('wrong', { id: 'gw-status-1', status: 'delivered' })).status).toBe(404);
    expect((await queue('إشعار')).rows[0].status).toBe('SENT');

    expect((await call('cb-secret', { id: 'gw-status-1', status: 'delivered' })).body).toEqual({ ok: true, known: true });
    expect((await queue('إشعار')).rows[0].status).toBe('DELIVERED');
    expect((await call('cb-secret', { id: 'gw-status-1', status: 'read' })).body.known).toBe(true);
    expect((await call('cb-secret', { id: 'gw-status-1', status: 'delivered' })).body.known).toBe(false);
    expect((await call('cb-secret', { id: 'gw-status-1', status: 'failed' })).body.known).toBe(false);
    expect((await queue('إشعار')).rows[0].status).toBe('READ');
    expect((await call('cb-secret', { id: 'no-such', status: 'read' })).body).toEqual({ ok: true, known: false });
    expect((await call('cb-secret', { id: 'gw-status-1', status: 'opened' })).status).toBe(400);
    delete process.env.MSG_CALLBACK_SECRET;
  });

  it('البوّابة التي لا تُبلَغ عطل عابر لا إخفاق', async () => {
    app.get(Channels).use(new HttpGatewayDriver('http://127.0.0.1:1/send', 't', ['SMS'], 500));
    await sendTo('لا تُبلَغ', 'المنفرد');
    await service.processQueue(10);
    const [m] = (await queue('لا تُبلَغ')).rows;
    expect(m.status).toBe('QUEUED');
    expect(m.error).toContain('تعذّر بلوغ المزوّد');
    app.get(Channels).use(new HttpGatewayDriver(url, 'gw-secret', ['SMS', 'WHATSAPP']));
  });
});
