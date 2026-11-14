/**
 * معيار قبول الخطوة 4: إعادة حساب نقاط 10,000 عائلة في أقل من دقيقة،
 * ومطابقة ناتج النظام لحساب مستقل في عيّنة من 50 عائلة.
 * التشغيل:  pnpm jest --rootDir . --testMatch '**\/scoring.bench.ts' --testTimeout 300000
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { computeScore } from '../../src/scoring/formula';
import { login, sql, startApp } from '../helpers';

const N = 10000;

it(`إعادة حساب ${N} عائلة`, async () => {
  const app: INestApplication = await startApp();
  const admin = await login(app, 'admin');
  const [creator, approver] = (await sql("select id from users where username in ('researcher', 'supervisor') order by username")).rows.map((r) => r.id);

  // عوائل معتمدة تُدرَج مباشرة في القاعدة بقيم متنوعة (الإدراج عبر الواجهة قيس في معيار الخطوة 1).
  await sql(
    `insert into families (id, family_no, status, tags, housing, created_by, decided_by, decided_at)
     select gen_random_uuid(), 'B' || g, 'APPROVED',
            case when g % 3 = 0 then '{WIDOW,ORPHANS}'::family_tag[] when g % 7 = 0 then '{DIVORCED}'::family_tag[] else '{NEEDY}'::family_tag[] end,
            (array['OWNED','RENTED','OTHER'])[1 + g % 3]::housing_type, $1, $2, now()
     from generate_series(1, $3) g`,
    [creator, approver, N],
  );
  await sql(
    `insert into persons (family_id, relation, full_name, name_norm, gender, is_orphan, disability, chronic_illness, status)
     select f.id, case when m = 1 then 'HEAD' else 'SON' end::person_relation, 'فرد ' || m, 'فرد', 'M',
            m > 1 and f.family_no::text ~ '[05]$' and m <= 4,
            case when (substr(f.family_no, 2)::int + m) % 11 = 0 then 'حركية' end,
            case when (substr(f.family_no, 2)::int + m) % 9 = 0 then 'سكري' end,
            case when m = 9 then 'DECEASED' else 'ACTIVE' end::person_status
     from families f cross join generate_series(1, 9) m
     where m <= 1 + substr(f.family_no, 2)::int % 9`,
  );
  await sql(
    `insert into income_sources (family_id, kind, amount_iqd)
     select id, 'WORK', (substr(family_no, 2)::int % 13) * 100000 from families where substr(family_no, 2)::int % 4 <> 0`,
  );

  const res = await request(app.getHttpServer()).put('/api/settings/poverty_line_iqd').set({ Authorization: `Bearer ${admin}` }).send({ value: 280000 });
  expect(res.body.recomputed).toBe(N);

  const t0 = Date.now();
  await sql('delete from family_scores');
  const again = await request(app.getHttpServer()).put('/api/settings/poverty_line_iqd').set({ Authorization: `Bearer ${admin}` }).send({ value: 300000 });
  const ms = Date.now() - t0;
  expect(again.body.recomputed).toBe(N);

  // حساب مستقل للعيّنة: الوقائع تُقرأ بطريق آخر (فرداً فرداً)، ثم تُقابَل بما حفظه النظام.
  const active = (await sql("select criteria, thresholds from scoring_versions where status = 'ACTIVE'")).rows[0];
  const sample = (await sql('select f.id, f.housing, f.tags::text[] as tags, s.points, s.class from families f join family_scores s on s.family_id = f.id order by f.family_no limit 50 offset 137')).rows;
  let matched = 0;
  for (const f of sample) {
    const people = (await sql("select is_orphan, disability, chronic_illness from persons where family_id = $1 and status = 'ACTIVE'", [f.id])).rows;
    const income = (await sql('select coalesce(sum(amount_iqd), 0)::int as n from income_sources where family_id = $1', [f.id])).rows[0].n;
    const expected = computeScore({
      members: people.length, monthlyIncomeIqd: income, housing: f.housing,
      orphans: people.filter((p) => p.is_orphan).length,
      disabled: people.filter((p) => p.disability !== null).length,
      chronic: people.filter((p) => p.chronic_illness !== null).length,
      femaleHeadNoProvider: f.tags.some((t: string) => ['WIDOW', 'DIVORCED', 'UNMARRIED'].includes(t)),
    }, active.criteria, active.thresholds, 300000);
    if (expected.points === f.points && expected.class === f.class) matched++;
  }
  const classes = (await sql('select class, count(*)::int n from family_scores group by class order by class')).rows;
  console.log(JSON.stringify({ families: N, recomputeMs: ms, sampleMatched: `${matched}/50`, classes }, null, 2));
  await app.close();

  expect(ms).toBeLessThan(60000);
  expect(matched).toBe(50);
});
