import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { chainFor, Channel, ChannelDriver, Channels, render, SimulatedDriver, unknownVariables } from '../src/notifications/channels';
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
