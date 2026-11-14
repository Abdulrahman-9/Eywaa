import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { Channel, ChannelDriver, Channels, SimulatedDriver } from '../src/notifications/channels';
import { family, login, sql, startApp } from './helpers';

let app: INestApplication;
const tokens: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });
const post = (path: string, user: string, body: any = {}) => api().post(`/api${path}`).set(as(user)).send(body);
const get = (path: string, user: string) => api().get(`/api${path}`).set(as(user));

let programId: string, pointA: string, pointB: string;
/** العوائل بترتيب إنشائها، ومعها نقاطها بعد الاعتماد. */
const fams: { id: string; familyNo: string; members: number; points: number; mahalla: string }[] = [];
const preview = async (selection: any = {}) => (await post('/campaigns/preview', 'manager', { programId, selection })).body;
const nos = (p: any) => p.families.map((f: any) => f.familyNo);
const base = () => ({ programId, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [pointA, pointB] });

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'researcher', 'supervisor', 'manager', 'manager2', 'distributor']) tokens[u] = await login(app, u);
  // ثماني عوائل تختلف في العدد والدخل والمحلة وتاريخ التسجيل. الثالثة بلا واتساب، والرابعة بلا هاتف.
  const spec = [
    [1, 0, 'الجولان'], [2, 100_000, 'الجولان'], [3, 0, 'الشهداء'], [4, 900_000, 'الشهداء'],
    [5, 0, 'النزال'], [6, 300_000, 'النزال'], [7, 0, 'الجولان'], [8, 2_000_000, 'الشهداء'],
  ] as const;
  for (const [i, [members, income, mahalla]] of spec.entries()) {
    const f = family({ address: { mahalla }, incomes: income ? [{ kind: 'WORK', amountIqd: income }] : [], ...(i === 2 ? { hasWhatsapp: false } : {}), ...(i === 3 ? { phone1: undefined } : {}) });
    for (let k = 1; k < members; k++) f.members.push({ relation: 'SON', fullName: `ولد ${k} من ${i}`, gender: 'M', documents: [] });
    const created = await post('/families', 'researcher', f);
    const ok = await post(`/families/${created.body.id}/approve`, 'supervisor');
    // التسجيل متباعد: الأولى قبل ثمانية أشهر، والأخيرة هذا الشهر.
    await sql("update families set created_at = now() - make_interval(months => $2) where id = $1", [ok.body.id, 8 - i]);
    fams.push({ id: ok.body.id, familyNo: ok.body.familyNo, members, points: ok.body.score.points, mahalla });
  }
  programId = (await post('/programs', 'admin', {
    name: 'لحوم الأضاحي', kind: 'IN_KIND', unit: 'كغم', rules: {}, minGapDays: 300,
    amount: { type: 'BY_SIZE', tiers: [{ upTo: 3, value: 2 }, { upTo: 6, value: 3 }, { upTo: null, value: 5 }] },
  })).body.id;
  pointA = (await post('/points', 'manager', { name: 'الجامع الكبير' })).body.id;
  pointB = (await post('/points', 'manager', { name: 'المدرسة' })).body.id;
});
afterAll(async () => {
  await app.close();
});

describe('اختيار عوائل الحملة', () => {
  it('بلا تصفية: كل مستحقي البرنامج، والمقدار بحسب عدد الأفراد', async () => {
    expect((await post('/campaigns/preview', 'distributor', { programId, selection: {} })).status).toBe(403);
    const p = await preview();
    expect(p.funnel).toEqual({ eligible: 8, available: 8, filtered: 8, afterExclude: 8, capped: 8, manual: 0, final: 8 });
    // 3 عوائل × 2 + 3 × 3 + 2 × 5
    expect(p.quantity).toBe(25);
    expect(p.unit).toBe('كغم');
    expect(p.mahallas).toEqual(['الجولان', 'الشهداء', 'النزال']);
  });

  it('التصفية بعدد الأفراد، والمحلة، وتاريخ التسجيل، والنقاط: كلٌّ يضيّق', async () => {
    expect(nos(await preview({ membersMin: 5 })).sort()).toEqual(fams.filter((f) => f.members >= 5).map((f) => f.familyNo).sort());
    expect(nos(await preview({ membersMin: 3, membersMax: 6 }))).toHaveLength(4);
    expect(nos(await preview({ mahallas: ['النزال'] })).sort()).toEqual(fams.filter((f) => f.mahalla === 'النزال').map((f) => f.familyNo).sort());
    const day = (months: number) => new Date(Date.now() - months * 30.5 * 86400000).toISOString().slice(0, 10);
    // من سُجّل قبل أكثر من خمسة أشهر ونصف: الثلاث الأُوَل.
    expect(nos(await preview({ registeredTo: day(5.5) })).sort()).toEqual(fams.slice(0, 3).map((f) => f.familyNo).sort());
    expect(nos(await preview({ registeredFrom: day(1.5) })).sort()).toEqual(fams.slice(7).map((f) => f.familyNo).sort());
    const median = [...fams].sort((a, b) => b.points - a.points)[3].points;
    expect(nos(await preview({ minPoints: median })).sort()).toEqual(fams.filter((f) => f.points >= median).map((f) => f.familyNo).sort());
    expect((await preview({ mahallas: ['الجولان'], membersMin: 7 })).funnel.filtered).toBe(1);
    expect((await post('/campaigns/preview', 'manager', { programId, selection: { nope: 1 } })).status).toBe(400);
  });

  it('الترتيب والسقف: الأعلى نقاطاً يدخل أولاً، وسقف المقدار يقف عند من لا يسعه', async () => {
    const byPoints = [...fams].sort((a, b) => b.points - a.points || a.familyNo.localeCompare(b.familyNo));
    const top3 = await preview({ order: 'POINTS', limit: 3 });
    expect(nos(top3)).toEqual(byPoints.slice(0, 3).map((f) => f.familyNo));
    expect(top3.funnel).toMatchObject({ filtered: 8, capped: 3, final: 3 });

    const oldest = await preview({ order: 'OLDEST', limit: 2 });
    expect(nos(oldest)).toEqual([fams[0].familyNo, fams[1].familyNo]);
    const biggest = await preview({ order: 'MEMBERS', limit: 1 });
    expect(nos(biggest)).toEqual([fams[7].familyNo]);

    // الأكبر عدداً أولاً: 5 + 5 + 3 = 13، والتالية (3) لا يسعها سقف 15... بل يسعها: 16 > 15 فتقف.
    const capped = await preview({ order: 'MEMBERS', maxQuantity: 15 });
    expect(capped.quantity).toBe(13);
    expect(capped.funnel.capped).toBe(3);
  });

  it('اليدوي: يُستثنى بالرقم ويُضاف بالرقم، ومن لا يستحق لا يدخل ولو أُضيف', async () => {
    const out = await preview({ membersMin: 5, exclude: [fams[7].familyNo] });
    expect(nos(out).sort()).toEqual(fams.slice(4, 7).map((f) => f.familyNo).sort());
    expect(out.funnel).toMatchObject({ filtered: 4, afterExclude: 3 });

    const plus = await preview({ membersMin: 7, include: [fams[0].familyNo] });
    expect(plus.funnel).toMatchObject({ capped: 2, manual: 1, final: 3 });
    expect(plus.families.find((f: any) => f.familyNo === fams[0].familyNo).manual).toBe(true);

    const pending = await post('/families', 'researcher', family());
    const bad = await preview({ manualOnly: true, include: [fams[1].familyNo, pending.body.familyNo, '9999999'] });
    expect(nos(bad)).toEqual([fams[1].familyNo]);
    expect(bad.rejected).toEqual([
      { familyNo: pending.body.familyNo, reason: 'لا عائلة معتمدة بهذا الرقم' }, { familyNo: '9999999', reason: 'لا عائلة معتمدة بهذا الرقم' },
    ]);
    const refused = await post('/campaigns', 'manager', { ...base(), name: 'يدوية خاطئة', selection: { manualOnly: true, include: ['9999999'] } });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain('9999999');
    expect((await post('/campaigns', 'manager', { ...base(), name: 'لا أحد', selection: { membersMin: 40 } })).status).toBe(409);
  });
});

describe('تحضير الحملة والاستعلام عنها', () => {
  let id: string;

  it('تُنشأ بالاختيار نفسه الذي عُرض، ويُحفظ معها كيف اختيرت', async () => {
    const selection = { order: 'POINTS', membersMin: 2, limit: 5, exclude: [fams[7].familyNo] };
    const expected = nos(await preview(selection));
    const c = await post('/campaigns', 'manager', { ...base(), name: 'أضاحي 2026', selection });
    expect(c.status).toBe(201);
    id = c.body.id;
    expect(c.body.totals.families).toBe(5);
    expect(c.body.selection).toMatchObject({ order: 'POINTS', membersMin: 2, limit: 5 });
    const list = (await get(`/campaigns/${id}/families`, 'manager')).body;
    expect(list.total).toBe(5);
    expect(list.rows.map((r: any) => r.familyNo)).toEqual(expected);
    expect(list.rows.every((r: any) => r.status === 'PENDING')).toBe(true);
    const log = await sql("select payload from audit_log where action = 'campaign.create' order by seq desc limit 1");
    expect(log.rows[0].payload.funnel).toMatchObject({ eligible: 8, final: 5 });
  });

  it('من دخل مسودة لا يدخل حملة أخرى للبرنامج نفسه', async () => {
    const p = await preview();
    expect(p.funnel).toMatchObject({ eligible: 8, available: 3 });
  });

  it('المسودة تُعدَّل باليد: تُضاف عائلة مستحقة وتُحذف أخرى بسببها، ولا يُعدَّل بعد الإرسال', async () => {
    expect((await post(`/campaigns/${id}/families`, 'distributor', { familyNo: fams[0].familyNo })).status).toBe(403);
    const inside = (await get(`/campaigns/${id}/families`, 'manager')).body.rows;
    expect((await post(`/campaigns/${id}/families`, 'manager', { familyNo: inside[0].familyNo })).body.message).toBe('العائلة في الحملة أصلاً');
    expect((await post(`/campaigns/${id}/families`, 'manager', { familyNo: '9999999' })).body.message).toContain('لا عائلة معتمدة بهذا الرقم');
    const added = await post(`/campaigns/${id}/families`, 'manager', { familyNo: fams[7].familyNo });
    expect(added.body.totals.families).toBe(6);
    // النقطتان متساويتان: 3 و3.
    expect(added.body.points.map((p: any) => p.assigned).sort()).toEqual([3, 3]);

    const del = (ent: string, body: any) => api().delete(`/api/campaigns/${id}/families/${ent}`).set(as('manager')).send(body);
    expect((await del(inside[0].entitlementId, {})).status).toBe(400);
    const removed = await del(inside[0].entitlementId, { note: 'انتقلت إلى محافظة أخرى' });
    expect(removed.body.totals.families).toBe(5);
    expect((await del(randomUUID(), { note: 'ليست فيها' })).status).toBe(404);

    await post(`/campaigns/${id}/submit`, 'manager');
    expect((await post(`/campaigns/${id}/families`, 'manager', { familyNo: inside[0].familyNo })).status).toBe(409);
    expect((await del(inside[1].entitlementId, { note: 'بعد الإرسال' })).status).toBe(409);
  });

  it('الدعوة: صورة الرمز لمن له واتساب، والرمز الرقمي في النص للجميع، ومن لا هاتف له يظهر', async () => {
    process.env.PUBLIC_BASE_URL = 'https://eywaa.example.org/';
    const sent: { channel: Channel; phone: string; text: string; imageUrl?: string }[] = [];
    const capture: ChannelDriver = { name: 'التقاط', live: false, async send(channel, phone, text, imageUrl) { sent.push({ channel, phone, text, imageUrl }); return { ok: true, providerRef: `c-${sent.length}` }; } };
    app.get(Channels).use(capture);
    expect((await post(`/campaigns/${id}/approve`, 'manager2')).body.status).toBe('ACTIVE');
    app.get(Channels).use(new SimulatedDriver());
    delete process.env.PUBLIC_BASE_URL;

    const rows = (await get(`/campaigns/${id}/families`, 'manager')).body.rows;
    const withPhone = rows.filter((r: any) => r.hasPhone).length;
    expect(sent).toHaveLength(withPhone);
    const wa = sent.filter((m) => m.channel === 'WHATSAPP');
    const sms = sent.filter((m) => m.channel === 'SMS');
    expect(wa.length).toBeGreaterThan(0);
    expect(wa.every((m) => /^https:\/\/eywaa\.example\.org\/api\/qr\/[0-9a-f-]{36}\.\d+\.[\w-]+\.png$/.test(m.imageUrl ?? ''))).toBe(true);
    expect(sms.every((m) => m.imageUrl === undefined)).toBe(true);
    // الرمز الرقمي في نص كل رسالة: هو ما يكفي صاحب الرسالة النصية.
    expect(sent.every((m) => /أحضروا هذا الرمز: \d{8}/.test(m.text) && m.text.includes('كغم'))).toBe(true);
    if (rows.some((r: any) => r.familyNo === fams[2].familyNo)) expect(sms).toHaveLength(1);
    const noPhone = await sql("select count(*)::int as n from messages m join notifications n on n.id = m.notification_id where n.campaign_id = $1 and m.status = 'NO_PHONE'", [id]);
    expect(noPhone.rows[0].n).toBe(rows.length - withPhone);

    // الصورة نفسها: PNG يُفتح بالرابط الموقَّع وحده، ويُحجب بعد التسليم.
    const path = new URL(wa[0].imageUrl!).pathname;
    const img = await api().get(path).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect((img.body as Buffer).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect((img.body as Buffer).length).toBeGreaterThan(2000);
    expect((await api().get(path.replace(/\.[\w-]+\.png$/, '.AAAAAAAA.png'))).status).toBe(404);

    const entId = path.split('/').pop()!.split('.')[0];
    const tok = (await get(`/campaigns/${id}/tokens`, 'manager')).body.find((t: any) => t.entitlementId === entId);
    expect((await post('/deliveries/redeem', 'distributor', { pointId: pointA, deviceId: 'd1', locate: { token: tok.token }, receiver: { kind: 'HEAD' }, clientOpId: randomUUID() })).status).toBe(200);
    expect((await api().get(path)).status).toBe(410);
  });

  it('الاستعلام عن حال الحملة: بالاسم أو الرقم، وبالحال، وبالنقطة', async () => {
    const all = (await get(`/campaigns/${id}/families`, 'distributor')).body;
    expect(all.total).toBe(5);
    const delivered = (await get(`/campaigns/${id}/families?status=DELIVERED`, 'manager')).body;
    expect(delivered.total).toBe(1);
    expect(delivered.rows[0]).toMatchObject({ status: 'DELIVERED', receiver: 'HEAD', mode: 'ONLINE', by: 'distributor', deliveredPoint: 'الجامع الكبير' });
    expect((await get(`/campaigns/${id}/families?status=PENDING`, 'manager')).body.total).toBe(4);
    const one = (await get(`/campaigns/${id}/families?q=${all.rows[2].familyNo}`, 'manager')).body;
    expect(one.rows.map((r: any) => r.familyNo)).toEqual([all.rows[2].familyNo]);
    const byName = (await get(`/campaigns/${id}/families?q=${encodeURIComponent(all.rows[1].headName.split(' ')[0])}`, 'manager')).body;
    expect(byName.rows.some((r: any) => r.familyNo === all.rows[1].familyNo)).toBe(true);
    const atA = (await get(`/campaigns/${id}/families?pointId=${pointA}`, 'manager')).body.total;
    const atB = (await get(`/campaigns/${id}/families?pointId=${pointB}`, 'manager')).body.total;
    expect(atA + atB).toBe(5);
    expect((await get(`/campaigns/${id}/families?limit=2&offset=4`, 'manager')).body.rows).toHaveLength(1);
  });

  it('بعد الإقفال تبقى الحملة وعوائلها للرجوع إليها، ومن لم يستلم مُلغى استحقاقه', async () => {
    await post(`/campaigns/${id}/close`, 'manager');
    const row = (await get('/campaigns', 'manager')).body.find((c: any) => c.id === id);
    expect(row).toMatchObject({ status: 'CLOSED', families: 5, delivered: 1, kind: 'IN_KIND' });
    expect(row.closedAt).toBeTruthy();
    expect((await get(`/campaigns/${id}/families?status=CANCELLED`, 'manager')).body.total).toBe(4);
    expect((await get(`/campaigns/${id}`, 'manager')).body.selection.order).toBe('POINTS');
    expect((await get('/audit/verify', 'admin')).body.ok).toBe(true);
  });
});
