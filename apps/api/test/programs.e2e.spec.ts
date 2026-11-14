import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { amountSchema, failures, quantity, rulesSchema } from '../src/programs/rules';
import { family, login, startApp, uniqueName } from './helpers';

let app: INestApplication;
const tokens: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });

async function approved(body: any) {
  const created = await api().post('/api/families').set(as('researcher')).send(body);
  return (await api().post(`/api/families/${created.body.id}/approve`).set(as('supervisor')).send({})).body;
}
const kids = (n: number, orphan: boolean, seed: number) =>
  Array.from({ length: n }, (_, i) => ({ relation: 'SON', fullName: uniqueName(seed + i), gender: 'M', isOrphan: orphan, documents: [] }));

let widow: any, big: any, comfortable: any;

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'researcher', 'supervisor', 'auditor', 'distributor']) tokens[u] = await login(app, u);
  const w = family({ tags: ['WIDOW', 'ORPHANS'], housing: 'RENTED' });
  w.members.push(...kids(3, true, 7000));
  widow = await approved(w);                                   // 4 أفراد، 3 أيتام، 70 نقطة: أ
  const b = family({ tags: ['NEEDY'], housing: 'RENTED', incomes: [{ kind: 'WORK', amountIqd: 400000 }] });
  b.members.push(...kids(8, false, 7100));
  big = await approved(b);                                     // 9 أفراد، دخل الفرد 44,444
  comfortable = await approved(family({ tags: ['NEEDY'], housing: 'OWNED', incomes: [{ kind: 'SALARY', amountIqd: 900000 }] })); // فرد واحد فوق الخط
});
afterAll(async () => {
  await app.close();
});

describe('قواعد الاستحقاق', () => {
  const facts = { class: 'B' as const, members: 5, orphans: 2, disabled: 0, monthlyIncomeIqd: 500000, housing: 'RENTED' as const, tags: ['WIDOW'] };

  it('الشروط تجتمع: يُذكر كل سبب لعدم الاستحقاق', () => {
    expect(failures({}, facts, 300000)).toEqual([]);
    expect(failures({ classes: ['A', 'B'], belowPovertyLine: true, hasOrphans: true, tagsAny: ['WIDOW', 'DIVORCED'] }, facts, 300000)).toEqual([]);
    expect(failures({ classes: ['A'], hasDisabled: true, housingIn: ['OWNED'], minMembers: 6 }, facts, 300000)).toHaveLength(4);
    expect(failures({ belowPovertyLine: true }, { ...facts, monthlyIncomeIqd: 1500000 }, 300000)).toEqual(['دخل الفرد ليس دون خط الفقر']);
    expect(failures({ classes: ['A'] }, { ...facts, class: null }, 300000)[0]).toContain('غير محسوبة');
  });

  it('المقدار: ثابت، ولكل فرد بسقف، ولكل يتيم، وبشرائح الحجم', () => {
    expect(quantity({ type: 'FIXED', value: 150000 }, facts)).toBe(150000);
    expect(quantity({ type: 'PER_MEMBER', value: 1, max: 4 }, facts)).toBe(4);
    expect(quantity({ type: 'PER_ORPHAN', value: 50000 }, facts)).toBe(100000);
    const tiers = { type: 'BY_SIZE' as const, tiers: [{ upTo: 4, value: 1 }, { upTo: 8, value: 2 }, { upTo: null, value: 3 }] };
    expect([4, 5, 8, 9].map((members) => quantity(tiers, { ...facts, members }))).toEqual([1, 2, 2, 3]);
  });

  it('يرفض الشروط المجهولة والشرائح المختلّة', () => {
    expect(rulesSchema.safeParse({ unknownRule: 1 }).success).toBe(false);
    expect(rulesSchema.safeParse({ classes: [] }).success).toBe(false);
    expect(amountSchema.safeParse({ type: 'BY_SIZE', tiers: [{ upTo: 8, value: 1 }, { upTo: 4, value: 2 }, { upTo: null, value: 3 }] }).success).toBe(false);
    expect(amountSchema.safeParse({ type: 'BY_SIZE', tiers: [{ upTo: 4, value: 1 }] }).success).toBe(false);
  });
});

describe('البرامج', () => {
  const basket = {
    name: 'السلة الغذائية الشهرية', kind: 'IN_KIND', unit: 'سلة', minGapDays: 25,
    rules: { classes: ['A', 'B', 'C'], belowPovertyLine: true },
    amount: { type: 'BY_SIZE', tiers: [{ upTo: 4, value: 1 }, { upTo: 8, value: 2 }, { upTo: null, value: 3 }] },
  };
  let basketId: string;

  it('المدير ينشئ برنامجاً من غير تعديل برمجي، ويُحسب مستحقوه ومقاديرهم', async () => {
    expect((await api().post('/api/programs').set(as('supervisor')).send(basket)).status).toBe(403);
    const created = await api().post('/api/programs').set(as('admin')).send(basket);
    expect(created.status).toBe(201);
    basketId = created.body.id;
    expect((await api().post('/api/programs').set(as('admin')).send(basket)).status).toBe(409);
    expect((await api().post('/api/programs').set(as('admin')).send({ ...basket, name: 'باطل', rules: { nope: true } })).status).toBe(400);

    const e = await api().get(`/api/programs/${basketId}/eligible`).set(as('auditor'));
    const byId = Object.fromEntries(e.body.sample.map((x: any) => [x.familyId, x.quantity]));
    expect(byId[widow.id]).toBe(1);        // 4 أفراد: سلة
    expect(byId[big.id]).toBe(3);          // 9 أفراد: ثلاث
    expect(byId[comfortable.id]).toBeUndefined();
    expect(e.body).toMatchObject({ families: 2, quantity: 4, unit: 'سلة' });
  });

  it('كفالة الأيتام: مبلغ لكل يتيم، لمن فيها يتيم فقط', async () => {
    const p = await api().post('/api/programs').set(as('admin')).send({
      name: 'كفالة الأيتام', kind: 'MONEY', unit: 'دينار', rules: { hasOrphans: true }, amount: { type: 'PER_ORPHAN', value: 50000 },
    });
    const e = await api().get(`/api/programs/${p.body.id}/eligible`).set(as('auditor'));
    expect(e.body).toMatchObject({ families: 1, quantity: 150000 });
    const list = await api().get('/api/programs').set(as('auditor'));
    expect(list.body.find((x: any) => x.name === 'كفالة الأيتام')).toMatchObject({ eligibleFamilies: 1, eligibleQuantity: 150000 });
  });

  it('ملف العائلة: ما تستحقه، وسبب ما لا تستحقه', async () => {
    const w = await api().get(`/api/families/${widow.id}/entitlements`).set(as('researcher'));
    expect(w.body.find((x: any) => x.name === 'كفالة الأيتام')).toMatchObject({ eligible: true, quantity: 150000 });
    const c = await api().get(`/api/families/${comfortable.id}/entitlements`).set(as('researcher'));
    const basketLine = c.body.find((x: any) => x.name === basket.name);
    expect(basketLine.eligible).toBe(false);
    expect(basketLine.reasons).toEqual(expect.arrayContaining(['دخل الفرد ليس دون خط الفقر']));
    expect(c.body.find((x: any) => x.name === 'كفالة الأيتام').reasons).toEqual(['لا يتيم فيها']);
  });

  it('المعاينة تحسب أثر شروط لم تُحفظ، والتعديل يسري ويُسجَّل', async () => {
    const preview = await api().post('/api/programs/preview').set(as('admin')).send({ rules: { classes: ['A'] }, amount: { type: 'FIXED', value: 1 } });
    expect(preview.body).toEqual({ families: 1, quantity: 1 });
    const updated = await api().put(`/api/programs/${basketId}`).set(as('admin')).send({ ...basket, rules: { classes: ['A'] } });
    expect(updated.status).toBe(200);
    expect((await api().get(`/api/programs/${basketId}/eligible`).set(as('auditor'))).body.families).toBe(1);
    const log = await api().get('/api/audit').query({ limit: 1 }).set(as('auditor'));
    expect(log.body[0].action).toBe('program.update');
    expect(log.body[0].payload.before.rules).toEqual({ classes: ['A', 'B', 'C'], belowPovertyLine: true });
  });

  it('البرنامج المعطَّل لا يظهر في استحقاق العوائل', async () => {
    await api().put(`/api/programs/${basketId}`).set(as('admin')).send({ ...basket, active: false });
    const w = await api().get(`/api/families/${widow.id}/entitlements`).set(as('researcher'));
    expect(w.body.find((x: any) => x.name === basket.name)).toBeUndefined();
    expect((await api().get('/api/programs').set(as('distributor'))).status).toBe(403);
  });
});
