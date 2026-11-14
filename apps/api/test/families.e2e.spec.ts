import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { family, login, nationalNo, sql, startApp } from './helpers';

let app: INestApplication;
const tokens: Record<string, string> = {};

const api = () => request(app.getHttpServer());
const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });
const create = (body: any, user = 'researcher') => api().post('/api/families').set(as(user)).send(body);

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'researcher', 'researcher2', 'supervisor', 'distributor', 'auditor']) {
    tokens[u] = await login(app, u);
  }
});
afterAll(async () => {
  await app.close();
});

describe('الدخول والصلاحيات', () => {
  it('يرفض من لم يسجّل دخوله', async () => {
    expect((await api().get('/api/families')).status).toBe(401);
  });
  it('يرفض كلمة المرور الخاطئة', async () => {
    const res = await api().post('/api/auth/login').send({ username: 'admin', password: 'wrong-password-here' });
    expect(res.status).toBe(401);
  });
  it('يمنع موظف التوزيع من تسجيل العوائل', async () => {
    expect((await create(family(), 'distributor')).status).toBe(403);
  });
  it('يمنع غير المدير من إدارة المستخدمين', async () => {
    expect((await api().get('/api/users').set(as('supervisor'))).status).toBe(403);
  });
  it('تعطيل الحساب يسري فوراً على الجلسة القائمة', async () => {
    const created = await api().post('/api/users').set(as('admin'))
      .send({ username: 'temp.user', fullName: 'موظف مؤقت', password: 'correct-horse-battery', role: 'AUDITOR' });
    expect(created.status).toBe(201);
    const token = await login(app, 'temp.user');
    expect((await api().get('/api/auth/me').set({ Authorization: `Bearer ${token}` })).status).toBe(200);
    await api().patch(`/api/users/${created.body.id}`).set(as('admin')).send({ active: false });
    expect((await api().get('/api/auth/me').set({ Authorization: `Bearer ${token}` })).status).toBe(401);
  });
});

describe('تسجيل العائلة', () => {
  it('يسجّل ويحسب الأعداد من الأفراد ويحجب أرقام الوثائق', async () => {
    const no = nationalNo();
    const res = await create(
      family({
        rationCard: { number: 'RC-555001', center: 'مركز الفلوجة' },
        members: [
          { relation: 'HEAD', fullName: 'سعاد كريم عبد الله الدليمي', motherName: 'فاطمة علي', gender: 'F', birthDate: '1975-03-10', documents: [{ type: 'NATIONAL_CARD', number: no }] },
          { relation: 'SON', fullName: 'عمر ياسين محمود الدليمي', gender: 'M', birthDate: '2012-01-01', isOrphan: true, documents: [] },
          { relation: 'DAUGHTER', fullName: 'نور ياسين محمود الدليمي', gender: 'F', birthDate: '2015-01-01', isOrphan: true, documents: [] },
          { relation: 'SPOUSE', status: 'DECEASED', fullName: 'ياسين محمود حسن الدليمي', gender: 'M', documents: [] },
        ],
        incomes: [{ kind: 'PENSION', amountIqd: 250000 }, { kind: 'SOCIAL_WELFARE', amountIqd: 125000 }],
        proxies: [{ fullName: 'كريم عبد الله', phone: '+9647801112233', relation: 'الأب' }],
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING_APPROVAL');
    expect(res.body.familyNo).toMatch(/^\d{7}$/);
    expect(res.body.counts).toEqual({ members: 3, males: 1, females: 2 });
    expect(res.body.tags).toEqual(['WIDOW']);
    const listed = await api().get('/api/families').query({ q: res.body.familyNo }).set(as('auditor'));
    expect(listed.body[0].tags).toEqual(['WIDOW']);
    expect(res.body.monthlyIncomeIqd).toBe(375000);
    expect(res.body.members[0].documents[0].numberMasked).toBe(`********${no.slice(-4)}`);
    expect(res.body.rationCard.numberMasked).toBe('****5001');
    expect(res.body.proxies[0].phone).toBe('07801112233');
    expect(res.body.membersWithoutDocument).toHaveLength(2);
    expect(JSON.stringify(res.body)).not.toContain(no);

    const stored = await sql('select number_enc, key_hash from person_documents');
    expect(stored.rows.every((r) => !r.number_enc.includes(no) && !r.key_hash.includes(no))).toBe(true);
  });

  it('يرفض الاستمارة بلا رب أسرة أو برب أسرة بلا وثيقة', async () => {
    const noHead = await create(family({ members: [{ relation: 'SON', fullName: 'علي حسن', gender: 'M', documents: [] }] }));
    expect(noHead.status).toBe(400);
    const noDoc = await create(family({ members: [{ relation: 'HEAD', fullName: 'علي حسن', gender: 'M', documents: [] }] }));
    expect(noDoc.status).toBe(400);
  });

  it('يرفض البطاقة الوطنية إن لم تكن 12 خانة، والهاتف غير العراقي', async () => {
    const f = family();
    f.members[0].documents = [{ type: 'NATIONAL_CARD', number: '12345' }];
    expect((await create(f)).status).toBe(400);
    expect((await create(family({ phone1: '12345' }))).status).toBe(400);
  });
});

describe('منع التكرار القطعي', () => {
  it('يمنع البطاقة الوطنية نفسها ولو كانت لفرد غير رب الأسرة، ويدلّ على السجل القائم', async () => {
    const childNo = nationalNo();
    const first = family();
    first.members.push({ relation: 'SON', fullName: 'طفل أول', gender: 'M', documents: [{ type: 'NATIONAL_CARD', number: childNo }] } as any);
    const a = await create(first);
    expect(a.status).toBe(201);

    const second = family();
    second.members.push({ relation: 'SON', fullName: 'اسم آخر تماماً', gender: 'M', documents: [{ type: 'NATIONAL_CARD', number: childNo }] } as any);
    const b = await create(second, 'researcher2');
    expect(b.status).toBe(409);
    expect(b.body.conflicts).toEqual([
      expect.objectContaining({ kind: 'DOCUMENT', memberIndex: 1, familyNo: a.body.familyNo, personName: 'طفل أول' }),
    ]);
    const count = await sql('select count(*)::int as n from persons where full_name = $1', ['اسم آخر تماماً']);
    expect(count.rows[0].n).toBe(0);
  });

  it('يكشف الرقم نفسه مكتوباً بالأرقام الهندية أو بفواصل', async () => {
    const a = family();
    a.members[0].documents = [{ type: 'NATIONAL_CARD', number: '198600001234' }];
    expect((await create(a)).status).toBe(201);
    const b = family();
    b.members[0].documents = [{ type: 'NATIONAL_CARD', number: '١٩٨٦-٠٠٠٠-١٢٣٤' }];
    expect((await create(b)).status).toBe(409);
  });

  it('هوية الأحوال القديمة: الفرادة بالرقم والسجل والصفحة معاً', async () => {
    const civil = { type: 'CIVIL_ID', number: '00456789', register: '112', page: '34' };
    const a = family();
    a.members[0].documents = [civil, { type: 'NATIONALITY_CERT', number: '778899', portfolio: '1205' }] as any;
    expect((await create(a)).status).toBe(201);

    const same = family();
    same.members[0].documents = [{ ...civil, register: '١١٢' }] as any;
    expect((await create(same)).status).toBe(409);

    const otherRegister = family();
    otherRegister.members[0].documents = [{ ...civil, register: '113' }] as any;
    expect((await create(otherRegister)).status).toBe(201);

    const sameCert = family();
    sameCert.members[0].documents = [{ type: 'NATIONALITY_CERT', number: '778899', portfolio: '1205' }] as any;
    expect((await create(sameCert)).status).toBe(409);
  });

  it('يمنع البطاقة التموينية نفسها لعائلتين', async () => {
    expect((await create(family({ rationCard: { number: '44001122' } }))).status).toBe(201);
    const dup = await create(family({ rationCard: { number: '٤٤٠٠١١٢٢' } }));
    expect(dup.status).toBe(409);
    expect(dup.body.conflicts[0].kind).toBe('RATION_CARD');
  });

  it('يرفض الوثيقة نفسها لفردين في استمارة واحدة', async () => {
    const no = nationalNo();
    const f = family();
    f.members[0].documents = [{ type: 'NATIONAL_CARD', number: no }];
    f.members.push({ relation: 'SON', fullName: 'ابن', gender: 'M', documents: [{ type: 'NATIONAL_CARD', number: no }] } as any);
    expect((await create(f)).status).toBe(400);
  });

  it('عند تسجيلين متزامنين للوثيقة نفسها ينجح واحد فقط', async () => {
    const no = nationalNo();
    const make = () => {
      const f = family();
      f.members[0].documents = [{ type: 'NATIONAL_CARD', number: no }];
      return f;
    };
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => create(make(), i % 2 ? 'researcher' : 'researcher2')));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
  });

  it('إعادة إرسال العملية نفسها بعد انقطاع لا تكرّر السجل', async () => {
    const body = family({ clientOpId: randomUUID() });
    const a = await create(body);
    const b = await create(body);
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    const n = await sql('select count(*)::int as n from families where client_op_id = $1', [body.clientOpId]);
    expect(n.rows[0].n).toBe(1);
  });

  it('البحث بالوثيقة يجيب دون كشف الرقم', async () => {
    const no = nationalNo();
    const f = family();
    f.members[0].documents = [{ type: 'NATIONAL_CARD', number: no }];
    const created = await create(f);
    const hit = await api().post('/api/families/lookup/document').set(as('researcher')).send({ type: 'NATIONAL_CARD', number: no });
    expect(hit.body).toMatchObject({ found: true, familyNo: created.body.familyNo });
    const miss = await api().post('/api/families/lookup/document').set(as('researcher')).send({ type: 'NATIONAL_CARD', number: nationalNo() });
    expect(miss.body).toEqual({ found: false });
  });
});

describe('شبهة التكرار والاعتماد المزدوج', () => {
  const person = (fullName: string, motherName: string, birthDate: string) => {
    const f = family();
    f.members[0] = { ...f.members[0], fullName, motherName, birthDate, documents: [{ type: 'NATIONAL_CARD', number: nationalNo() }] };
    return f;
  };

  it('اسم متقارب الرسم مع اسم الأم نفسه: يُعلَّق السجل ثم يُفصل فيه', async () => {
    const original = await create(person('مصطفى أحمد عبد الرحمن العيساوي', 'خديجة إبراهيم', '1990-02-02'));
    expect(original.body.status).toBe('PENDING_APPROVAL');

    const suspect = await create(person('مصطفي احمد عبدالرحمن العيساوى', 'خديجه ابراهيم', '1991-07-07'), 'researcher2');
    expect(suspect.status).toBe(201);
    expect(suspect.body.status).toBe('PENDING_DEDUPE_REVIEW');
    expect(suspect.body.duplicateFlags[0]).toMatchObject({ status: 'OPEN', matchedFamilyNo: original.body.familyNo });

    const approveEarly = await api().post(`/api/families/${suspect.body.id}/approve`).set(as('supervisor')).send({});
    expect(approveEarly.status).toBe(409);

    const flagId = suspect.body.duplicateFlags[0].id;
    const noReason = await api().post(`/api/duplicate-flags/${flagId}/resolve`).set(as('supervisor')).send({ decision: 'DISMISS' });
    expect(noReason.status).toBe(400);

    const resolved = await api().post(`/api/duplicate-flags/${flagId}/resolve`).set(as('supervisor'))
      .send({ decision: 'DISMISS', note: 'ابنا عمّ، تحققنا من الوثيقتين' });
    expect(resolved.body.status).toBe('PENDING_APPROVAL');

    const approved = await api().post(`/api/families/${suspect.body.id}/approve`).set(as('supervisor')).send({});
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.decidedBy).toBe('supervisor');
  });

  it('تأكيد التكرار يرفض السجل الجديد', async () => {
    await create(person('زينب خالد إسماعيل الكبيسي', 'آمنة يوسف', '1985-04-04'));
    const suspect = await create(person('زينب خالد اسماعيل الكبيسي', 'امنه يوسف', '1985-04-04'), 'researcher2');
    const res = await api().post(`/api/duplicate-flags/${suspect.body.duplicateFlags[0].id}/resolve`).set(as('supervisor'))
      .send({ decision: 'CONFIRM', note: 'الشخص نفسه بوثيقة ثانية' });
    expect(res.body.status).toBe('REJECTED');
  });

  it('الأخوان (اسم أول مختلف وبقية الاسم والأم واحدة) لا يُعدّان تكراراً', async () => {
    await create(person('حسين علي جاسم المحمدي', 'سعدية حمد', '1970-01-01'));
    const brother = await create(person('حسن علي جاسم المحمدي', 'سعدية حمد', '1972-01-01'));
    expect(brother.body.status).toBe('PENDING_APPROVAL');
    const other = await create(person('طارق علي جاسم المحمدي', 'سعدية حمد', '1970-06-01'));
    expect(other.body.duplicateFlags).toHaveLength(0);
  });

  it('تشابه الاسم بلا قرينة قوية لا يُعلِّق السجل، ولو اتفقت سنة الميلاد', async () => {
    await create(person('محمد جاسم محمد الجميلي', 'نجاة سلمان', '1960-01-01'));
    const namesake = await create(person('محمد جاسم محمد الجميلي', 'وفاء عبيد', '1960-08-20'));
    expect(namesake.body.status).toBe('PENDING_APPROVAL');
  });

  it('الاسم نفسه وتاريخ الميلاد نفسه باليوم: يُعلَّق ولو اختلف اسم الأم المُدخَل', async () => {
    await create(person('رعد شاكر محمود الفهداوي', 'صبيحة نوري', '1968-11-23'));
    const same = await create(person('رعد شاكر محمود الفهداوى', 'انتصار هاشم', '1968-11-23'));
    expect(same.body.status).toBe('PENDING_DEDUPE_REVIEW');
    expect(same.body.duplicateFlags[0].reason).toContain('تاريخ الميلاد');
  });

  it('الاسم نفسه من هاتف العائلة نفسه: يُعلَّق', async () => {
    const a = person('ثامر وليد ناصر الزوبعي', 'كوثر بلال', '1977-01-01');
    await create(a);
    const b = person('ثامر وليد ناصر الزوبعي', 'جنان صالح', '1979-05-05');
    b.phone1 = a.phone1;
    expect((await create(b)).body.status).toBe('PENDING_DEDUPE_REVIEW');
  });

  it('لا يعتمد الموظف ما أدخله بنفسه، ولو كان مشرفاً', async () => {
    const mine = await create(family(), 'supervisor');
    const self = await api().post(`/api/families/${mine.body.id}/approve`).set(as('supervisor')).send({});
    expect(self.status).toBe(403);
    const other = await api().post(`/api/families/${mine.body.id}/approve`).set(as('admin')).send({});
    expect(other.body.status).toBe('APPROVED');
    const again = await api().post(`/api/families/${mine.body.id}/approve`).set(as('admin')).send({});
    expect(again.status).toBe(409);
  });

  it('قيد القاعدة نفسه يمنع أن يكون المعتمِد هو المُدخِل', async () => {
    const mine = await create(family());
    await expect(
      sql("update families set status = 'APPROVED', decided_by = created_by where id = $1", [mine.body.id]),
    ).rejects.toThrow(/decided_by_other/);
  });

  it('الرفض يلزمه سبب، ويحرّر الوثائق والبطاقة التموينية لتسجيل لاحق', async () => {
    const no = nationalNo();
    const f = family({ rationCard: { number: '90909090' } });
    f.members[0].documents = [{ type: 'NATIONAL_CARD', number: no }];
    const first = await create(f);
    expect((await api().post(`/api/families/${first.body.id}/reject`).set(as('supervisor')).send({})).status).toBe(409);
    const rejected = await api().post(`/api/families/${first.body.id}/reject`).set(as('supervisor')).send({ note: 'بيانات ناقصة' });
    expect(rejected.body.status).toBe('REJECTED');

    const g = family({ rationCard: { number: '90909090' } });
    g.members[0].documents = [{ type: 'NATIONAL_CARD', number: no }];
    expect((await create(g)).status).toBe(201);
  });

  it('البحث برقم العائلة وبالاسم مع اختلاف الرسم', async () => {
    const f = await create(person('إسراء عبد القادر مهدي الراوي', 'هدى صالح', '1999-09-09'));
    const byNo = await api().get('/api/families').query({ q: f.body.familyNo }).set(as('auditor'));
    expect(byNo.body.map((r: any) => r.id)).toEqual([f.body.id]);
    const byName = await api().get('/api/families').query({ q: 'اسراء عبدالقادر' }).set(as('auditor'));
    expect(byName.body.map((r: any) => r.id)).toContain(f.body.id);
    const pending = await api().get('/api/families').query({ status: 'REJECTED' }).set(as('auditor'));
    expect(pending.body.every((r: any) => r.status === 'REJECTED')).toBe(true);
  });
});

describe('سجل التدقيق', () => {
  it('لكل تسجيل واعتماد سطر، والسلسلة سليمة', async () => {
    const before = await api().get('/api/audit/verify').set(as('auditor'));
    expect(before.body.ok).toBe(true);
    const f = await create(family());
    await api().post(`/api/families/${f.body.id}/approve`).set(as('supervisor')).send({});
    const after = await api().get('/api/audit/verify').set(as('auditor'));
    expect(after.body).toMatchObject({ ok: true, entries: before.body.entries + 2 });
    const log = await api().get('/api/audit').query({ limit: 2 }).set(as('auditor'));
    expect(log.body.map((r: any) => r.action)).toEqual(['family.approve', 'family.create']);
    expect(log.body[0].actor).toBe('supervisor');
  });

  it('حمولة فيها تاريخ لا تكسر السلسلة عند إعادة الحساب', async () => {
    const { AuditService } = await import('../src/audit/audit.service');
    const { Db } = await import('../src/db/db.module');
    const audit = app.get(AuditService);
    await app.get(Db).tx((c) => audit.append(c, { actorId: null, action: 'test.date', entity: 'test', entityId: '1', payload: { when: new Date(), nested: { at: new Date(0), n: undefined } } as any }));
    expect((await api().get('/api/audit/verify').set(as('auditor'))).body.ok).toBe(true);
  });

  it('العملية المرفوضة لا تترك سطراً', async () => {
    const before = (await api().get('/api/audit/verify').set(as('auditor'))).body.entries;
    const f = family();
    f.members[0].documents = [{ type: 'NATIONAL_CARD', number: '198600001234' }];
    expect((await create(f)).status).toBe(409);
    expect((await api().get('/api/audit/verify').set(as('auditor'))).body.entries).toBe(before);
  });

  it('القاعدة ترفض تعديل السجل أو حذفه', async () => {
    await expect(sql("update audit_log set action = 'x' where seq = 1")).rejects.toThrow(/append-only/);
    await expect(sql('delete from audit_log where seq = 1')).rejects.toThrow(/append-only/);
    await expect(sql('truncate audit_log')).rejects.toThrow(/append-only/);
  });

  it('ولو عُطّل الحاجز وعُبث بسطر، كشفت السلسلة موضعه', async () => {
    await sql('alter table audit_log disable trigger audit_log_no_change');
    try {
      await sql(`update audit_log set payload = '{"forged":true}' where seq = 3`);
      const res = await api().get('/api/audit/verify').set(as('auditor'));
      expect(res.body).toMatchObject({ ok: false, brokenAtSeq: 3 });
    } finally {
      await sql('alter table audit_log enable trigger audit_log_no_change');
    }
  });
});
