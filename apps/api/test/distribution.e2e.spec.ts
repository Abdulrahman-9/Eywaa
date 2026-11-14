import { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
import request from 'supertest';
import { checkOffline, checkOfflineCode, LocalDelivery, Manifest } from '../src/distribution/offline';
import { TokenSigner, verifyToken } from '../src/distribution/token';
import { family, login, sql, startApp, uniqueName } from './helpers';

let app: INestApplication;
const tokens: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });
const post = (path: string, user: string, body: any = {}) => api().post(`/api${path}`).set(as(user)).send(body);
const get = (path: string, user: string) => api().get(`/api${path}`).set(as(user));

let programId: string, p1: string, p2: string;
const families: any[] = [];

async function approvedFamily(extra: any = {}) {
  const created = await post('/families', 'researcher', family({ housing: 'RENTED', ...extra }));
  return (await post(`/families/${created.body.id}/approve`, 'supervisor')).body;
}
async function activeCampaign(name: string, pointIds = [p1, p2], endsOn = '2099-12-31') {
  const c = await post('/campaigns', 'manager', { name, programId, startsOn: '2026-01-01', endsOn, pointIds });
  if (c.status !== 201) throw new Error(JSON.stringify(c.body));
  await post(`/campaigns/${c.body.id}/submit`, 'manager');
  await post(`/campaigns/${c.body.id}/approve`, 'manager2');
  const toks = (await get(`/campaigns/${c.body.id}/tokens`, 'manager')).body as any[];
  return { id: c.body.id as string, toks };
}
const redeem = (token: string, pointId: string, user = 'distributor', receiver: any = { kind: 'HEAD' }, clientOpId = randomUUID()) =>
  post('/deliveries/redeem', user, { pointId, deviceId: `dev-${user}`, locate: { token }, receiver, clientOpId });

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'researcher', 'supervisor', 'manager', 'manager2', 'distributor', 'distributor2', 'auditor']) tokens[u] = await login(app, u);
  for (let i = 0; i < 8; i++) families.push(await approvedFamily(i === 0 ? { proxies: [{ fullName: 'وكيل مسجَّل', relation: 'الأخ' }] } : {}));
  programId = (await post('/programs', 'admin', { name: 'سلة', kind: 'IN_KIND', unit: 'سلة', rules: {}, amount: { type: 'FIXED', value: 2 }, minGapDays: 25 })).body.id;
  p1 = (await post('/points', 'manager', { name: 'الجولان' })).body.id;
  p2 = (await post('/points', 'manager', { name: 'الشهداء' })).body.id;
});
afterAll(async () => {
  await app.close();
});

describe('رمز الاستلام', () => {
  const signer = new TokenSigner(randomBytes(32).toString('base64'));
  const payload = { e: randomUUID(), c: randomUUID(), p: randomUUID(), f: '1000017', q: 2, x: 4102444800 };
  const token = signer.issue(payload);

  it('يُتحقق منه بالمفتاح العام وحده', () => {
    expect(verifyToken(token, signer.publicKeyB64)).toEqual(payload);
    expect(token.length).toBeLessThan(400);
  });

  it('يُرفض 100% من الرموز المعبوث بها: 500 تغيير في خانة واحدة', () => {
    let accepted = 0;
    for (let i = 0; i < 500; i++) {
      const pos = 3 + Math.floor(Math.random() * (token.length - 3));
      const ch = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[Math.floor(Math.random() * 64)];
      const forged = token.slice(0, pos) + ch + token.slice(pos + 1);
      if (forged === token) continue;
      const out = verifyToken(forged, signer.publicKeyB64);
      // تغيير لا يمسّ البايتات (بتات الحشو في آخر base64) لا يغيّر الحمولة ولا التوقيع، فليس تزويراً.
      if (out && JSON.stringify(out) !== JSON.stringify(payload)) accepted++;
    }
    expect(accepted).toBe(0);
  });

  it('يُرفض المقدار المضخَّم بتوقيع قديم، والرمز الموقَّع بمفتاح آخر، وما ليس رمزاً', () => {
    const [v, , sig] = token.split('.');
    const inflated = `${v}.${Buffer.from(JSON.stringify({ ...payload, q: 99 })).toString('base64url')}.${sig}`;
    expect(verifyToken(inflated, signer.publicKeyB64)).toBeNull();
    const other = new TokenSigner(randomBytes(32).toString('base64'));
    expect(verifyToken(other.issue(payload), signer.publicKeyB64)).toBeNull();
    for (const junk of ['', 'E1..', 'hello', 'E2.' + token.slice(3), token + 'x.y']) expect(verifyToken(junk, signer.publicKeyB64)).toBeNull();
  });
});

describe('دورة الحملة', () => {
  let campaignId: string;

  it('المسودة تأخذ المستحقين من قواعد البرنامج وتوزّعهم على النقاط', async () => {
    expect((await post('/campaigns', 'distributor', { name: 'حملة', programId, startsOn: '2026-01-01', endsOn: '2099-01-01', pointIds: [p1] })).status).toBe(403);
    const c = await post('/campaigns', 'manager', { name: 'حملة الدورة', programId, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [p1, p2] });
    expect(c.status).toBe(201);
    campaignId = c.body.id;
    expect(c.body).toMatchObject({ status: 'DRAFT', totals: { families: 8, quantity: 16, delivered: 0 } });
    expect(c.body.points.map((p: any) => p.assigned)).toEqual([4, 4]);
    expect((await get(`/campaigns/${campaignId}/tokens`, 'manager')).status).toBe(409);
  });

  it('لا تصدر الرموز قبل اعتماد موظف آخر', async () => {
    expect((await post(`/campaigns/${campaignId}/approve`, 'manager2')).status).toBe(409);
    await post(`/campaigns/${campaignId}/submit`, 'manager');
    expect((await post(`/campaigns/${campaignId}/approve`, 'manager')).status).toBe(403);
    const ok = await post(`/campaigns/${campaignId}/approve`, 'manager2');
    expect(ok.body).toMatchObject({ status: 'ACTIVE', decidedBy: 'manager2' });
    const toks = await get(`/campaigns/${campaignId}/tokens`, 'manager');
    expect(toks.body).toHaveLength(8);
    expect(toks.body[0].code).toMatch(/^\d{8}$/);
    expect((await get(`/campaigns/${campaignId}/tokens`, 'distributor')).status).toBe(403);
    const log = await get('/audit?limit=1', 'auditor');
    expect(log.body[0]).toMatchObject({ action: 'campaign.tokens_export', actor: 'manager' });
  });

  it('لا تدخل العائلة حملتين قائمتين للبرنامج نفسه', async () => {
    const again = await post('/campaigns', 'manager', { name: 'حملة ثانية', programId, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [p1] });
    expect(again.status).toBe(409);
    await post(`/campaigns/${campaignId}/close`, 'manager');
  });
});

describe('التسليم والجهاز متصل', () => {
  let camp: { id: string; toks: any[] };
  beforeAll(async () => { camp = await activeCampaign('حملة التسليم'); });
  const tokenOf = (f: any) => camp.toks.find((t) => t.familyNo === f.familyNo);

  it('الفحص يعرض المستلمين المخوَّلين ولا يغيّر شيئاً', async () => {
    const t = tokenOf(families[0]);
    const res = await post('/deliveries/check', 'distributor', { pointId: p1, deviceId: 'd1', locate: { token: t.token } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ familyNo: families[0].familyNo, quantity: 2, unit: 'سلة' });
    expect(res.body.receivers.map((r: any) => r.kind)).toEqual(['HEAD', 'PROXY']);
    expect((await get(`/campaigns/${camp.id}`, 'manager')).body.totals.delivered).toBe(0);
    expect((await post('/deliveries/check', 'researcher', { pointId: p1, deviceId: 'd1', locate: { token: t.token } })).status).toBe(403);
  });

  it('لا يستلم إلا رب الأسرة أو وكيل مسجَّل لهذه العائلة', async () => {
    const t = tokenOf(families[0]);
    const proxyOfOther = randomUUID();
    expect((await redeem(t.token, p1, 'distributor', { kind: 'PROXY', proxyId: proxyOfOther })).status).toBe(403);
    const check = await post('/deliveries/check', 'distributor', { pointId: p1, deviceId: 'd1', locate: { token: t.token } });
    const proxyId = check.body.receivers.find((r: any) => r.kind === 'PROXY').proxyId;
    const ok = await redeem(t.token, p1, 'distributor', { kind: 'PROXY', proxyId });
    expect(ok.body).toMatchObject({ receiver: 'PROXY', receiverName: 'وكيل مسجَّل', point: 'الجولان', mode: 'ONLINE' });
  });

  it('الرمز يُقبل في أي نقطة والجهاز متصل، ثم يُرفض في الجميع ويُعرض من استلم', async () => {
    const t = tokenOf(families[1]);
    const otherPoint = t.point === 'الجولان' ? p2 : p1;
    expect((await redeem(t.token, otherPoint)).status).toBe(200);
    for (const point of [p1, p2]) {
      const again = await redeem(t.token, point, 'distributor2');
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ code: 'ALREADY_DELIVERED', message: 'لا تسلّم: هذا الرمز استُعمل من قبل' });
      expect(again.body.details).toMatchObject({ familyNo: families[1].familyNo, receiverName: families[1].members[0].fullName });
    }
    const detail = (await get(`/campaigns/${camp.id}`, 'manager')).body;
    const mine = detail.incidents.filter((i: any) => i.familyNo === families[1].familyNo);
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({ kind: 'ALREADY_DELIVERED', by: 'distributor2' });
  });

  it('ثمانية أجهزة تعرض الرمز نفسه في لحظة واحدة: يسلّم واحد فقط', async () => {
    const t = tokenOf(families[2]);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => redeem(t.token, i % 2 ? p1 : p2, i % 2 ? 'distributor' : 'distributor2')));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
    const n = await sql("select count(*)::int as n from entitlements where id = $1 and status = 'DELIVERED'", [t.entitlementId]);
    expect(n.rows[0].n).toBe(1);
  });

  it('إعادة إرسال العملية نفسها بعد انقطاع لا تُعدّ تسليماً ثانياً ولا بلاغاً', async () => {
    const t = tokenOf(families[3]);
    const op = randomUUID();
    const a = await redeem(t.token, p1, 'distributor', { kind: 'HEAD' }, op);
    const b = await redeem(t.token, p1, 'distributor', { kind: 'HEAD' }, op);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body.deliveredAt).toBe(a.body.deliveredAt);
  });

  it('الرمز الرقمي للرسائل النصية: يُقبل مع رقم العائلة، ويُرفض الخاطئ', async () => {
    const t = tokenOf(families[4]);
    const wrong = await post('/deliveries/redeem', 'distributor', { pointId: p1, deviceId: 'd1', clientOpId: randomUUID(), receiver: { kind: 'HEAD' }, locate: { campaignId: camp.id, familyNo: t.familyNo, code: '00000000' === t.code ? '11111111' : '00000000' } });
    expect(wrong.body.code).toBe('BAD_CODE');
    const hindi = t.code.replace(/\d/g, (d: string) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
    const ok = await post('/deliveries/redeem', 'distributor', { pointId: p1, deviceId: 'd1', clientOpId: randomUUID(), receiver: { kind: 'HEAD' }, locate: { campaignId: camp.id, familyNo: t.familyNo, code: hindi } });
    expect(ok.status).toBe(200);
  });

  it('الرمز المزوَّر يُرفض ويُسجَّل', async () => {
    const t = tokenOf(families[5]);
    const [v, body, sig] = t.token.split('.');
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    const inflated = `${v}.${Buffer.from(JSON.stringify({ ...p, q: 50 })).toString('base64url')}.${sig}`;
    const res = await redeem(inflated, p1);
    expect(res.body.code).toBe('BAD_SIGNATURE');
    const forgedByOtherKey = new TokenSigner(randomBytes(32).toString('base64')).issue(p);
    expect((await redeem(forgedByOtherKey, p1)).body.code).toBe('BAD_SIGNATURE');
    expect((await sql("select count(*)::int as n from delivery_incidents where kind = 'BAD_SIGNATURE'")).rows[0].n).toBe(2);
  });

  it('صورة التسليم تُرفق بملف العائلة وتُربط بالاستحقاق', async () => {
    const t = tokenOf(families[3]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-proof')]);
    const res = await api().post(`/api/deliveries/${t.entitlementId}/proof`).set(as('distributor')).attach('file', jpeg, 'proof.jpg');
    expect(res.status).toBe(201);
    const list = await get(`/families/${families[3].id}/deliveries`, 'auditor');
    expect(list.body[0]).toMatchObject({ status: 'DELIVERED', quantity: 2, proofAttachmentId: res.body.attachmentId });
    expect((await api().post(`/api/deliveries/${tokenOf(families[6]).entitlementId}/proof`).set(as('distributor')).attach('file', jpeg, 'p.jpg')).status).toBe(404);
  });

  it('الإقفال يلغي ما لم يُستلم، فلا يُقبل رمزه بعد', async () => {
    const closed = await post(`/campaigns/${camp.id}/close`, 'manager');
    expect(closed.body.status).toBe('CLOSED');
    const res = await redeem(tokenOf(families[6]).token, p1);
    expect(res.body.code).toBe('NOT_ACTIVE');
  });

  it('أقل فاصل بين عطاءين: من استلم قريباً لا يدخل الحملة التالية', async () => {
    const next = await post('/campaigns', 'manager', { name: 'الحملة التالية', programId, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [p1] });
    // استلم في الحملة السابقة خمس عوائل (0 إلى 4)؛ فيبقى ثلاث.
    expect(next.body.totals.families).toBe(3);
    await post(`/campaigns/${next.body.id}/cancel`, 'manager', { note: 'اختبار' });
  });

  it('حملة انتهت مدتها ترفض رموزها', async () => {
    const c = await activeCampaign('حملة منتهية', [p1], '2099-12-31');
    await sql("update campaigns set ends_on = current_date - 1, starts_on = current_date - 5 where id = $1", [c.id]);
    const res = await redeem(c.toks[0].token, p1);
    expect(res.body.code).toBe('EXPIRED');
    await post(`/campaigns/${c.id}/close`, 'manager');
  });
});

describe('التسليم دون اتصال', () => {
  let camp: { id: string; toks: any[] };
  const manifests: Manifest[] = [];
  const stores: LocalDelivery[][] = [];
  const now = Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    // تُمحى التسليمات السابقة ليدخل الجميع هذه الحملة.
    await sql("update entitlements set status = 'CANCELLED', delivered_at = null, delivered_by = null, receiver = null where status = 'DELIVERED'");
    camp = await activeCampaign('حملة دون اتصال');
    // أربعة أجهزة: شبّاكان في كل نقطة.
    for (const pointId of [p1, p2]) {
      for (const lane of [1, 2]) {
        manifests.push((await get(`/campaigns/${camp.id}/manifest?pointId=${pointId}&lane=${lane}&lanes=2`, 'distributor')).body);
        stores.push([]);
      }
    }
  });

  it('بيانات الأجهزة تقتسم الاستحقاقات: كلٌّ في جهاز واحد لا غير', () => {
    const all = manifests.flatMap((m) => m.entries.map((e) => e.id));
    expect(all).toHaveLength(8);
    expect(new Set(all).size).toBe(8);
    expect(manifests.every((m) => m.entries.every((e) => e.receivers[0].kind === 'HEAD'))).toBe(true);
  });

  it('أربعة أجهزة منقطعة: كل رمز يقبله جهاز واحد، ولو عُرض على الأربعة مرتين', () => {
    for (const t of camp.toks) {
      let accepted = 0;
      for (let round = 0; round < 2; round++) {
        manifests.forEach((m, d) => {
          const res = checkOffline(t.token, m, stores[d], now);
          if (res.ok) {
            accepted++;
            stores[d].push({ entitlementId: res.entry.id, deliveredAt: new Date().toISOString(), receiver: 'HEAD', receiverName: res.entry.receivers[0].name, clientOpId: randomUUID(), proof: { token: t.token } });
          }
        });
      }
      expect(accepted).toBe(1);
    }
    expect(stores.flat()).toHaveLength(8);
  });

  it('الجهاز المنقطع يرفض رمز غير نقطته، والمزوَّر، والمنتهي، ورمز حملة أخرى', () => {
    const t = camp.toks[0];
    const reasons = manifests.map((m) => { const r = checkOffline(t.token, m, [], now); return r.ok ? 'OK' : r.reason; });
    expect(reasons.filter((r) => r === 'OK')).toHaveLength(1);
    expect(reasons.filter((r) => r === 'NOT_THIS_DEVICE')).toHaveLength(3);
    const home = manifests[reasons.indexOf('OK')];
    expect(checkOffline(t.token.slice(0, -4) + 'AAAA', home, [], now)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(checkOffline(t.token, home, [], home.endsAt + 1)).toEqual({ ok: false, reason: 'EXPIRED' });
    expect(checkOffline(t.token, { ...home, campaignId: randomUUID() }, [], now)).toEqual({ ok: false, reason: 'OTHER_CAMPAIGN' });
  });

  it('الرمز الرقمي يُتحقَّق منه والجهاز منقطع: يقبله جهازه وحده، والخاطئ ورقم غير البيان بجواب واحد', () => {
    const t = camp.toks[0];
    const d = manifests.findIndex((m) => m.entries.some((e) => e.id === t.entitlementId));
    // البرهان في البيان ستة عشر بتاً فقط: لا يُستخرج منه الرمز ولو جُرّبت الأرقام كلها، وبصمة الرمز الكاملة لا تغادر الخادم.
    expect(manifests[d].entries.every((e) => typeof e.codeCheck === 'string' && /^[0-9a-f]{4}$/.test(e.codeCheck) && !('codeHash' in e))).toBe(true);
    // في المخزن المحلي تسليمه السابق بالرمز المصوَّر، فيُرفض مكرَّراً.
    expect(checkOfflineCode(t.familyNo, t.code, manifests[d], stores[d], now)).toEqual({ ok: false, reason: 'ALREADY_DELIVERED' });
    const fresh = checkOfflineCode(t.familyNo, t.code, manifests[d], [], now);
    expect(fresh.ok && fresh.entry.id).toBe(t.entitlementId);
    const wrong = String((Number(t.code) + 1) % 100000000).padStart(8, '0');
    expect(checkOfflineCode(t.familyNo, wrong, manifests[d], [], now)).toEqual({ ok: false, reason: 'BAD_CODE' });
    expect(checkOfflineCode('0000000', t.code, manifests[d], [], now)).toEqual({ ok: false, reason: 'BAD_CODE' });
    const other = manifests[(d + 1) % 4];
    expect(checkOfflineCode(t.familyNo, t.code, other, [], now)).toEqual({ ok: false, reason: 'BAD_CODE' });
    expect(checkOfflineCode(t.familyNo, t.code, manifests[d], [], manifests[d].endsAt + 1)).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('المزامنة ترفع ما سُلِّم، وإعادتها لا تكرّر', async () => {
    const d = 0;
    const body = { pointId: manifests[d].pointId, deviceId: 'offline-0', items: stores[d] };
    const first = await post('/deliveries/sync', 'distributor', body);
    expect(first.body).toMatchObject({ applied: stores[d].length, conflicts: 0 });
    const again = await post('/deliveries/sync', 'distributor', body);
    expect(again.body.applied).toBe(0);
    expect(again.body.results.every((r: any) => r.result === 'ALREADY_SYNCED')).toBe(true);
    const detail = (await get(`/campaigns/${camp.id}`, 'manager')).body;
    expect(detail.totals.delivered).toBe(stores[d].length);
    expect(detail.recent[0].mode).toBe('OFFLINE');
  });

  it('رمز سُلِّم بالاتصال ثم سلّمه جهاز منقطع ببيان قديم: يُكشف عند المزامنة ويُرفع بلاغاً بالاسم والجهاز', async () => {
    const d = 1;
    const victim = stores[d][0];
    const tok = camp.toks.find((t) => t.entitlementId === victim.entitlementId);
    // قبل أن يزامن الجهاز المنقطع، استُلم بالرمز نفسه في نقطة متصلة.
    expect((await redeem(tok.token, p2, 'distributor2')).status).toBe(200);
    const res = await post('/deliveries/sync', 'distributor', { pointId: manifests[d].pointId, deviceId: 'offline-1', items: stores[d] });
    expect(res.body.conflicts).toBe(1);
    expect(res.body.applied).toBe(stores[d].length - 1);
    const conflict = res.body.results.find((r: any) => r.result === 'CONFLICT');
    expect(conflict.details.first).toMatchObject({ mode: 'ONLINE', point: 'الشهداء' });
    const incidents = (await get(`/campaigns/${camp.id}`, 'manager')).body.incidents.filter((i: any) => i.kind === 'DOUBLE_DELIVERY');
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ by: 'distributor', deviceId: 'offline-1', familyNo: tok.familyNo });
    // التسليم الأول باقٍ كما هو.
    const row = await sql('select mode, device_id from entitlements where id = $1', [victim.entitlementId]);
    expect(row.rows[0]).toMatchObject({ mode: 'ONLINE', device_id: 'dev-distributor2' });
  });

  it('ما ادّعاه الجهاز بلا برهان من رمز العائلة لا يُسجَّل، ويُرفع بلاغاً باسم صاحبه', async () => {
    const d = 2;
    const sync = (items: any[]) => post('/deliveries/sync', 'distributor', { pointId: manifests[d].pointId, deviceId: 'offline-2', items });
    const bare = stores[d].map(({ proof, ...rest }) => ({ ...rest, clientOpId: randomUUID() }));
    const none = await sync(bare);
    expect(none.body).toMatchObject({ applied: 0, rejected: bare.length });
    expect(none.body.results.every((r: any) => r.result === 'REJECTED' && r.reason === 'NO_PROOF')).toBe(true);
    // رمز عائلة أخرى لا ينفع، ولا رمز رقمي خاطئ.
    const other = camp.toks.find((t) => t.entitlementId !== bare[0].entitlementId);
    const forged = await sync([{ ...bare[0], clientOpId: randomUUID(), proof: { token: other.token } }, { ...bare[0], clientOpId: randomUUID(), proof: { code: '00000000' } }]);
    expect(forged.body.results.map((r: any) => r.reason)).toEqual(['NO_PROOF', 'NO_PROOF']);
    const still = await sql('select status from entitlements where id = any($1)', [bare.map((b) => b.entitlementId)]);
    expect(still.rows.every((r) => r.status === 'PENDING')).toBe(true);
    const inc = await sql("select details from delivery_incidents where kind = 'UNPROVEN_OFFLINE' and device_id = 'offline-2'");
    expect(inc.rows.map((r) => r.details.proof).sort()).toEqual([...bare.map(() => 'NONE'), 'BAD_CODE', 'BAD_TOKEN'].sort());
    const alert = (await get(`/campaigns/${camp.id}/alerts`, 'manager')).body.find((a: any) => a.kind === 'UNPROVEN_OFFLINE');
    expect(alert).toMatchObject({ severity: 'HIGH', who: 'distributor' });
    // وبالرمز الرقمي الصحيح، أو بالرمز المصوَّر، يُسجَّل.
    const first = camp.toks.find((t) => t.entitlementId === stores[d][0].entitlementId);
    const ok = await sync([{ ...stores[d][0], proof: { code: first.code } }, ...stores[d].slice(1)]);
    expect(ok.body).toMatchObject({ applied: stores[d].length, rejected: 0 });
  });

  it('ساعة جهاز مختلّة، واستحقاق أُلغي، وحملة أُقفلت قبل المزامنة: لكلٍّ حكمه وبلاغه', async () => {
    const d = 3;
    const sync = (items: any[]) => post('/deliveries/sync', 'distributor', { pointId: manifests[d].pointId, deviceId: 'offline-3', items });
    const [a, b] = stores[d];
    // ساعة الجهاز عند 1970: يُسجَّل بوقت وصوله ويُرفع بلاغ، فلا يُحتال بها على فاصل البرنامج ولا على إنذارات الليل.
    const old = await sync([{ ...a, deliveredAt: '1970-01-01T00:00:00.000Z' }]);
    expect(old.body.applied).toBe(1);
    const rec = (await sql('select delivered_at from entitlements where id = $1', [a.entitlementId])).rows[0];
    expect(Date.now() - new Date(rec.delivered_at).getTime()).toBeLessThan(60_000);
    expect((await sql("select count(*)::int as n from delivery_incidents where kind = 'BAD_CLOCK' and entitlement_id = $1", [a.entitlementId])).rows[0].n).toBe(1);
    // استحقاق أُلغي والجهاز منقطع لا يدري: لا يُسجَّل، ويُرفع بلاغ.
    await sql("update entitlements set status = 'CANCELLED' where id = $1", [b.entitlementId]);
    const gone = await sync([b]);
    expect(gone.body.results[0]).toMatchObject({ result: 'REJECTED', reason: 'CANCELLED' });
    expect((await sql('select status from entitlements where id = $1', [b.entitlementId])).rows[0].status).toBe('CANCELLED');
    // والحملة أُقفلت قبل أن يزامن: يُحال إلى مدير التوزيع.
    expect((await post(`/campaigns/${camp.id}/close`, 'manager')).status).toBe(200);
    const late = await sync([{ ...b, clientOpId: randomUUID() }]);
    expect(late.body.results[0]).toMatchObject({ result: 'REJECTED', reason: 'CAMPAIGN_CLOSED' });
    // بند مجهول وبند فاسد لا يوقفان ما معهما.
    const mixed = await sync([{ ...b, clientOpId: randomUUID(), entitlementId: randomUUID() }, { ...a }]);
    expect(mixed.body.results.map((r: any) => r.result)).toEqual(['UNKNOWN', 'ALREADY_SYNCED']);
  });

  it('سلسلة التدقيق سليمة، ولكل تسليم سطر', async () => {
    expect((await get('/audit/verify', 'auditor')).body.ok).toBe(true);
    const n = await sql("select count(*)::int as n from audit_log where action in ('delivery.redeem', 'delivery.sync')");
    const delivered = await sql("select count(*)::int as n from entitlements where client_op_id is not null");
    expect(n.rows[0].n).toBeGreaterThanOrEqual(delivered.rows[0].n);
  });
});

describe('صورة رب الأسرة عند الشبّاك', () => {
  it('إن رُفعت صورته الشخصية عادت مع التحقق برابط مؤقت يفتحها، والاطلاع يُسجَّل', async () => {
    const f = await approvedFamily();
    const camp = await activeCampaign('حملة الصورة');
    const tok = camp.toks.find((t: any) => t.familyNo === f.familyNo);
    const check = () => post('/deliveries/check', 'distributor', { pointId: p1, deviceId: 'd1', locate: { token: tok.token } });
    expect((await check()).body.headPhotoUrl).toBeNull();

    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-head-photo-0123456789')]);
    // صورة غير مربوطة برب الأسرة، ووثيقة هوية له: لا تُعرضان.
    await api().post(`/api/families/${f.id}/attachments`).set(as('researcher')).field('category', 'PHOTO').attach('file', jpeg, 'house.jpg');
    await api().post(`/api/families/${f.id}/attachments`).set(as('researcher')).field('category', 'IDENTITY').field('personId', f.members[0].id).attach('file', jpeg, 'id.jpg');
    expect((await check()).body.headPhotoUrl).toBeNull();
    await api().post(`/api/families/${f.id}/attachments`).set(as('researcher')).field('category', 'PHOTO').field('personId', f.members[0].id).attach('file', jpeg, 'face.jpg');

    const before = (await sql("select count(*)::int as n from audit_log where action = 'attachment.view'")).rows[0].n;
    const res = await check();
    expect(res.body.headPhotoUrl).toMatch(/^\/api\/files\//);
    const img = await api().get(res.body.headPhotoUrl);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/jpeg');
    expect((await sql("select count(*)::int as n from audit_log where action = 'attachment.view'")).rows[0].n).toBe(before + 1);
  });
});

describe('المتابعة اليومية وإنذارات الاحتيال', () => {
  let camp: { id: string; toks: any[] };
  const alerts = async () => (await get(`/campaigns/${camp.id}/alerts`, 'manager')).body as any[];
  const kinds = async () => (await alerts()).map((a) => a.kind);

  beforeAll(async () => {
    await sql("update entitlements set status = 'CANCELLED', delivered_at = null, delivered_by = null, receiver = null where status in ('DELIVERED', 'PENDING')");
    for (let i = 0; i < 4; i++) await approvedFamily({ proxies: [{ fullName: `وكيل ${i}` }] });
    camp = await activeCampaign('حملة المراقبة');
  });

  it('حملة بلا مخالفات: لا إنذار، واللوحة اليومية فارغة', async () => {
    expect(await alerts()).toEqual([]);
    const d = (await get(`/campaigns/${camp.id}/daily`, 'distributor')).body;
    expect(d).toMatchObject({ delivered: 0, days: [] });
    expect(d.families).toBe(camp.toks.length);
    expect((await get(`/campaigns/${camp.id}/alerts`, 'distributor')).status).toBe(403);
  });

  it('اللوحة اليومية: ما سُلِّم كل يوم لكل نقطة، والتراكم والنسبة', async () => {
    for (const t of camp.toks.slice(0, 3)) expect((await redeem(t.token, p1)).status).toBe(200);
    // تسليم من الثلاثة وقع أمس.
    await sql("update entitlements set delivered_at = delivered_at - interval '1 day' where id = $1", [camp.toks[0].entitlementId]);
    const d = (await get(`/campaigns/${camp.id}/daily`, 'manager')).body;
    expect(d.days).toHaveLength(2);
    expect(d.days.map((x: any) => [x.delivered, x.cumulative])).toEqual([[1, 1], [2, 3]]);
    expect(d.days[1].points).toMatchObject([{ point: 'الجولان', delivered: 2 }]);
    expect(d.days[1].percent).toBe(Math.round((3 / camp.toks.length) * 100));
    expect(d).toMatchObject({ delivered: 3, remaining: camp.toks.length - 3 });
  });

  it('الرمز المستعمل يُعرض ثلاث مرات: إنذار باسم من عُرض أمامهم، وفي نقطتين: إنذار ثانٍ', async () => {
    const t = camp.toks[0];
    await redeem(t.token, p1);
    await redeem(t.token, p1);
    expect(await kinds()).toEqual([]);
    await redeem(t.token, p2, 'distributor2');
    const a = await alerts();
    const rep = a.find((x) => x.kind === 'REPEATED_TOKEN');
    expect(rep).toMatchObject({ severity: 'MEDIUM', familyNo: t.familyNo, title: 'رمز مستعمل عُرض 3 مرات' });
    expect(rep.who).toContain('distributor2');
    expect(a.find((x) => x.kind === 'MULTI_POINT').detail).toContain('الجولان');
  });

  it('خمسة رموز خاطئة من جهاز واحد في عشر دقائق: إنذار عالٍ؛ وأربعة لا تكفي', async () => {
    const bad = (n: number) => post('/deliveries/check', 'distributor2', { pointId: p2, deviceId: 'phone-x', locate: { campaignId: camp.id, familyNo: camp.toks[5].familyNo, code: String(10000000 + n) } });
    for (let i = 0; i < 4; i++) await bad(i);
    expect(await kinds()).not.toContain('BAD_BURST');
    await bad(4);
    const b = (await alerts()).find((x) => x.kind === 'BAD_BURST');
    expect(b).toMatchObject({ severity: 'HIGH', who: 'distributor2' });
    expect(b.detail).toContain('phone-x');
    // العالي يتقدّم القائمة.
    expect((await alerts())[0].severity).toBe('HIGH');
  });

  it('خمسة رموز خاطئة متباعدة في الزمن ليست إنذاراً', async () => {
    await sql("update delivery_incidents set at = at - (row_number * interval '11 minutes') from (select id, row_number() over (order by at) from delivery_incidents where device_id = 'phone-x') r where r.id = delivery_incidents.id");
    expect(await kinds()).not.toContain('BAD_BURST');
  });

  it('تسليم في جوف الليل، واستلام بالوكالة فوق المعتاد: إنذاران باسم الموظف', async () => {
    await sql("update entitlements set delivered_at = date_trunc('day', now() at time zone 'Asia/Baghdad') at time zone 'Asia/Baghdad' + interval '2 hours' where id = $1", [camp.toks[1].entitlementId]);
    const night = (await alerts()).find((x) => x.kind === 'OFF_HOURS');
    expect(night).toMatchObject({ who: 'distributor' });
    expect(night.detail).toContain('1 تسليماً');
    // عشرة تسليمات لموظف، سبعة منها بيد وكلاء؛ وزميله لا وكالة عنده.
    await sql("update entitlements set status = 'DELIVERED', delivered_at = now(), delivered_by = (select id from users where username = 'distributor2'), receiver = 'HEAD', receiver_name = 'x', mode = 'ONLINE' where campaign_id = $1 and status = 'PENDING'", [camp.id]);
    const mine = (await sql("select count(*)::int as n from entitlements e join users u on u.id = e.delivered_by where e.campaign_id = $1 and u.username = 'distributor2'", [camp.id])).rows[0].n;
    if (mine >= 10) {
      await sql("update entitlements set receiver = 'PROXY' where id in (select e.id from entitlements e join users u on u.id = e.delivered_by where e.campaign_id = $1 and u.username = 'distributor2' limit $2)", [camp.id, Math.ceil(mine * 0.7)]);
      const p = (await alerts()).find((x) => x.kind === 'PROXY_HEAVY');
      expect(p).toMatchObject({ who: 'distributor2' });
      expect(p.detail).toMatch(/بيد وكلاء \(\d+%\)/);
    }
  });

  it('الحملات الجارية التي فيها إنذارات تُعدّ للشارة', async () => {
    const open = (await get('/campaign-alerts', 'manager')).body;
    const row = open.find((c: any) => c.campaignId === camp.id);
    expect(row.alerts).toBeGreaterThanOrEqual(3);
    expect(row).toHaveProperty('high');
  });
});

describe('ما أضافته المراجعة إلى التوزيع', () => {
  let campId: string, toks: any[];

  it('من عدّل مسودة غيره أو أرسلها لا يعتمدها', async () => {
    await sql("update entitlements set status = 'CANCELLED', delivered_at = null, delivered_by = null, receiver = null where status in ('DELIVERED', 'PENDING')");
    const body = { name: 'حملة الاعتماد المزدوج', programId, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [p1] };
    const c = await post('/campaigns', 'manager', body);
    expect(c.status).toBe(201);
    campId = c.body.id;
    // مدير ثانٍ يعدّل المسودة ثم يرسلها: صار من أصحابها، فلا يعتمد عمل يده.
    expect((await api().put(`/api/campaigns/${campId}`).set(as('manager2')).send({ ...body, name: 'حملة عدّلها غير منشئها' })).status).toBe(200);
    expect((await post(`/campaigns/${campId}/submit`, 'manager2')).status).toBe(200);
    expect((await post(`/campaigns/${campId}/approve`, 'manager2')).status).toBe(403);
    expect((await post(`/campaigns/${campId}/approve`, 'manager')).status).toBe(403);
    expect((await post(`/campaigns/${campId}/approve`, 'admin')).status).toBe(200);
    toks = (await get(`/campaigns/${campId}/tokens`, 'manager')).body;
  });

  it('عائلة لا تدخل حملتين قائمتين للبرنامج نفسه ولو أُنشئتا في اللحظة نفسها', async () => {
    await approvedFamily();
    const body = (name: string) => ({ name, programId, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [p2] });
    const both = await Promise.all([post('/campaigns', 'manager', body('متسابقة أولى')), post('/campaigns', 'manager2', body('متسابقة ثانية'))]);
    const made = both.filter((r) => r.status === 201);
    expect(made.length).toBeGreaterThanOrEqual(1);
    const twice = await sql(
      `select count(*)::int as n from (select e.family_id from entitlements e join campaigns c on c.id = e.campaign_id
         where c.program_id = $1 and e.status = 'PENDING' and c.status in ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE') group by e.family_id having count(*) > 1) x`, [programId]);
    expect(twice.rows[0].n).toBe(0);
    for (const r of made) await post(`/campaigns/${r.body.id}/cancel`, 'manager', { note: 'تجربة السباق' });
  });

  it('الرمز الرقمي لا يُخمَّن بلا حدّ: خمس محاولات خاطئة على رقم العائلة، ثم لا يبقى إلا الرمز المصوَّر', async () => {
    const t = toks[0];
    const guess = (code: string, user = 'distributor') => post('/deliveries/check', user, { pointId: p1, deviceId: 'd1', locate: { campaignId: campId, familyNo: t.familyNo, code } });
    for (let i = 0; i < 5; i++) expect((await guess(String(20000000 + i))).body.code).toBe('BAD_CODE');
    const locked = await guess(t.code);
    expect([locked.status, locked.body.code]).toEqual([429, 'CODE_LOCKED']);
    // الحدّ على رقم العائلة: لا يتجاوزه تبديل الموظف.
    expect((await guess(t.code, 'distributor2')).status).toBe(429);
    expect((await post('/deliveries/check', 'distributor', { pointId: p1, deviceId: 'd1', locate: { token: t.token } })).status).toBeLessThan(300);
  });

  it('نقطة مختلَقة تُرفض بخطأ إدخال لا بخطأ خادم، والطلب المكرَّر بمعرّفه لا يُعدّ عرضاً ثانياً للرمز', async () => {
    const t = toks[1];
    const ghost = await post('/deliveries/check', 'distributor', { pointId: randomUUID(), deviceId: 'd1', locate: { token: t.token } });
    expect(ghost.status).toBe(400);
    const op = randomUUID();
    const pair = await Promise.all([redeem(t.token, p1, 'distributor', { kind: 'HEAD' }, op), redeem(t.token, p1, 'distributor', { kind: 'HEAD' }, op)]);
    expect(pair.map((r) => r.status < 300)).toEqual([true, true]);
    expect(pair[0].body.entitlementId).toBe(pair[1].body.entitlementId);
    expect((await sql("select count(*)::int as n from delivery_incidents where kind = 'ALREADY_DELIVERED' and entitlement_id = $1", [t.entitlementId])).rows[0].n).toBe(0);
  });

  it('صورة الإثبات يرفعها من سلّم أو مدير، لا موظف آخر', async () => {
    const t = toks[1];
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-proof-0123456789')]);
    const upload = (user: string) => api().post(`/api/deliveries/${t.entitlementId}/proof`).set(as(user)).attach('file', jpeg, 'proof.jpg');
    expect((await upload('distributor2')).status).toBe(403);
    expect((await upload('distributor')).status).toBeLessThan(300);
  });
});
