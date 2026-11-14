/**
 * معيار قبول الخطوة 10: تنبيه لـ10,000 عائلة يخرج كاملاً، ولكل رسالة حال معلومة.
 * (بمزوّد المحاكاة: يقيس النظام لا شبكة المزوّد.)
 * التشغيل:  pnpm jest --rootDir . --testMatch '**\/notify.bench.ts' --testTimeout 300000
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { login, sql, startApp } from '../helpers';

const N = 10000;

it(`تنبيه لـ${N} عائلة`, async () => {
  const app: INestApplication = await startApp();
  const admin = await login(app, 'admin');
  const [creator, approver] = (await sql("select id from users where username in ('researcher', 'supervisor') order by username")).rows.map((r) => r.id);
  await sql(
    `insert into families (family_no, status, phone1, has_whatsapp, prefers_voice, created_by, decided_by, decided_at)
     select 'N' || g, 'APPROVED', case when g % 50 = 0 then null else '077' || lpad(g::text, 8, '0') end, g % 7 <> 0, g % 31 = 0, $1, $2, now()
     from generate_series(1, $3) g`,
    [creator, approver, N],
  );
  await sql("insert into persons (family_id, relation, full_name, name_norm, gender) select id, 'HEAD', 'رب أسرة ' || family_no, 'رب اسره', 'M' from families");
  const auth = { Authorization: `Bearer ${admin}` };
  await request(app.getHttpServer()).put('/api/settings/bulk_message_approval_threshold').set(auth).send({ value: 1000000 });

  const t0 = Date.now();
  const res = await request(app.getHttpServer()).post('/api/notifications').set(auth)
    .send({ title: 'إعلان عام', body: 'السلام عليكم {الاسم}. رقم العائلة: {رقم_العائلة}', audience: {} });
  const ms = Date.now() - t0;
  const total = Object.values(res.body.byStatus as Record<string, number>).reduce((a, b) => a + b, 0);
  const distinct = (await sql('select count(distinct family_id)::int as n from messages')).rows[0].n;
  console.log(JSON.stringify({ families: N, ms, byStatus: res.body.byStatus, byChannel: res.body.byChannel, distinctFamilies: distinct }, null, 2));
  await app.close();

  expect(res.status).toBe(201);
  expect(total).toBe(N);
  expect(distinct).toBe(N);
});
