/**
 * معيار قبول الخطوة 15: يوم توزيع بعشرين جهازاً متزامناً.
 * عشرون موظفاً يسلّمون معاً لـ2,000 عائلة؛ ثم يُعرض كل رمز مرة ثانية. يُقاس الزمن، ويُتحقق ألّا تسليم مزدوج.
 * التشغيل:  pnpm jest --rootDir . --testMatch '**\/load.bench.ts' --testTimeout 600000
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { hashPassword } from '../../src/auth/password';
import { login, PASSWORD, sql, startApp } from '../helpers';

const FAMILIES = 2000;
const DEVICES = 20;

it(`${DEVICES} جهازاً يسلّمون لـ${FAMILIES} عائلة`, async () => {
  const app: INestApplication = await startApp();
  const http = app.getHttpServer();
  const [creator, approver] = (await sql("select id from users where username in ('researcher', 'supervisor') order by username")).rows.map((r) => r.id);
  await sql(
    `insert into families (family_no, status, phone1, created_by, decided_by, decided_at)
     select 'L' || g, 'APPROVED', '077' || lpad(g::text, 8, '0'), $1, $2, now() from generate_series(1, $3) g`,
    [creator, approver, FAMILIES],
  );
  await sql("insert into persons (family_id, relation, full_name, name_norm, gender) select id, 'HEAD', 'رب أسرة ' || family_no, 'رب اسره', 'M' from families");
  const hash = await hashPassword(PASSWORD);
  for (let i = 0; i < DEVICES; i++) await sql("insert into users (username, full_name, password_hash, role) values ($1, $1, $2, 'DISTRIBUTOR')", [`dev${i}`, hash]);

  const admin = { Authorization: `Bearer ${await login(app, 'admin')}` };
  const manager = { Authorization: `Bearer ${await login(app, 'manager')}` };
  const manager2 = { Authorization: `Bearer ${await login(app, 'manager2')}` };
  const programId = (await request(http).post('/api/programs').set(admin).send({ name: 'سلة', kind: 'IN_KIND', unit: 'سلة', rules: {}, amount: { type: 'FIXED', value: 1 } })).body.id;
  const points: string[] = [];
  for (const name of ['الجولان', 'الشهداء', 'النزال', 'الجغيفي']) points.push((await request(http).post('/api/points').set(manager).send({ name })).body.id);
  const camp = (await request(http).post('/api/campaigns').set(manager).send({ name: 'يوم التوزيع', programId, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: points })).body;
  expect(camp.totals).toMatchObject({ families: FAMILIES });
  await request(http).post(`/api/campaigns/${camp.id}/submit`).set(manager);
  const t0 = Date.now();
  const approved = await request(http).post(`/api/campaigns/${camp.id}/approve`).set(manager2);
  expect(approved.body).toMatchObject({ status: 'ACTIVE' });
  const approveMs = Date.now() - t0;
  const toks = (await request(http).get(`/api/campaigns/${camp.id}/tokens`).set(manager)).body as { token: string }[];
  expect(toks).toHaveLength(FAMILIES);

  const devices: { Authorization: string }[] = [];
  for (let i = 0; i < DEVICES; i++) devices.push({ Authorization: `Bearer ${await login(app, `dev${i}`)}` });

  const times: number[] = [];
  const run = async (round: number) => {
    const statuses: Record<number, number> = {};
    let next = 0;
    await Promise.all(devices.map(async (auth, d) => {
      for (;;) {
        // في الجولة الثانية كل جهاز يبدأ من موضع آخر، فيعرض رموزاً سلّمها غيره.
        const i = next++;
        if (i >= toks.length) return;
        const tok = toks[round === 1 ? i : (i + 97 * (d + 1)) % toks.length];
        const s = Date.now();
        const res = await request(http).post('/api/deliveries/redeem').set(auth)
          .send({ pointId: points[d % points.length], deviceId: `dev${d}`, locate: { token: tok.token }, receiver: { kind: 'HEAD' }, clientOpId: randomUUID() });
        if (round === 1) times.push(Date.now() - s);
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      }
    }));
    return statuses;
  };

  const s1 = Date.now();
  const first = await run(1);
  const seconds = (Date.now() - s1) / 1000;
  const second = await run(2);

  times.sort((a, b) => a - b);
  const delivered = (await sql("select count(*)::int as n from entitlements where status = 'DELIVERED'")).rows[0].n;
  const confirmations = (await sql("select count(*)::int as n from messages m join notifications n on n.id = m.notification_id where n.kind = 'DELIVERY_CONFIRMATION'")).rows[0].n;
  const audit = (await request(http).get('/api/audit/verify').set(admin)).body;
  console.log(JSON.stringify({
    devices: DEVICES, families: FAMILIES, approveAndInviteMs: approveMs,
    firstRound: first, secondRound: second, seconds: Math.round(seconds * 10) / 10, perSecond: Math.round(FAMILIES / seconds),
    msMedian: times[Math.floor(times.length / 2)], msP95: times[Math.floor(times.length * 0.95)], msMax: times[times.length - 1],
    delivered, confirmations, auditEntries: audit.entries, auditOk: audit.ok,
  }, null, 2));
  await app.close();

  expect(first).toEqual({ 200: FAMILIES });
  expect(second).toEqual({ 409: FAMILIES });
  expect(delivered).toBe(FAMILIES);
  expect(confirmations).toBe(FAMILIES);
  expect(audit.ok).toBe(true);
});
