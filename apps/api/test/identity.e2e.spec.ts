import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { canonicalId, editDistance } from '../src/common/arabic';
import { FieldCrypto } from '../src/common/crypto';
import { FamiliesService } from '../src/families/families.service';
import { documentKey } from '../src/families/families.schema';
import { family, login, sql, startApp } from './helpers';

let app: INestApplication;
const tokens: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });
const post = (path: string, user: string, body: any = {}) => api().post(`/api${path}`).set(as(user)).send(body);
const get = (path: string, user: string) => api().get(`/api${path}`).set(as(user));

let seq = 0;
/** عائلة ربّها يحمل هوية أحوال قديمة. */
const civil = (number: string, register: string, page: string, head: Record<string, any> = {}) => {
  const f = family();
  f.phone1 = `0772${String(2000000 + ++seq)}`;
  Object.assign(f.members[0], { documents: [{ type: 'CIVIL_ID', number, register, page }], birthDate: undefined, motherName: undefined, ...head });
  return f;
};
const create = (f: any) => post('/families', 'researcher', f);
const lookup = async (d: any) => (await post('/families/lookup/document', 'researcher', d)).body;

beforeAll(async () => {
  app = await startApp();
  for (const u of ['admin', 'researcher', 'supervisor', 'auditor']) tokens[u] = await login(app, u);
});
afterAll(async () => {
  await app.close();
});

describe('الصورة الموحّدة والمسافة', () => {
  it('الصفر في الأول والأرقام الهندية والفواصل لا تفرّق', () => {
    expect(canonicalId('0045')).toBe('45');
    expect(canonicalId('٠٠٤٥')).toBe('45');
    expect(canonicalId(' 4-5 ')).toBe('45');
    expect(canonicalId('000')).toBe('0');
    expect(canonicalId('12أ')).toBe('12أ');
    expect(documentKey({ type: 'CIVIL_ID', number: '00123456', register: '045', page: '7' }))
      .toBe(documentKey({ type: 'CIVIL_ID', number: '١٢٣٤٥٦', register: '45', page: '999' }));
  });
  it('المسافة تعدّ التبديل والزيادة والنقص وقلب الجارين حرفاً واحداً', () => {
    expect(editDistance('45', '45')).toBe(0);
    expect(editDistance('45', '54')).toBe(1);
    expect(editDistance('112', '12')).toBe(1);
    expect(editDistance('45', '46')).toBe(1);
    expect(editDistance('45', '78')).toBeGreaterThan(1);
  });
});

describe('فرادة هوية الأحوال: السجل ثم الرقم', () => {
  let first: any;

  it('السجل والرقم نفساهما يمنعان التسجيل، ولو اختلفت الصفحة أو كُتبا بصفر أو بأرقام هندية', async () => {
    const res = await create(civil('123456', '45', '112', { fullName: 'حامد سلمان داود العاني' }));
    expect(res.status).toBe(201);
    first = res.body;
    for (const [number, register, page] of [['123456', '45', '999'], ['00123456', '045', '112'], ['١٢٣٤٥٦', '٤٥', '١'], ['123-456', ' 45 ', '2']]) {
      const again = await create(civil(number, register, page, { fullName: 'اسم آخر تماماً للتجربة' }));
      expect(again.status).toBe(409);
      expect(again.body.conflicts[0]).toMatchObject({ kind: 'DOCUMENT', familyNo: first.familyNo });
    }
    expect(await lookup({ type: 'CIVIL_ID', number: '0123456', register: '45', page: '5' })).toMatchObject({ found: true, familyNo: first.familyNo });
  });

  it('الرقم نفسه بسجل آخر واسم آخر: شخص آخر، يُسجَّل بلا شبهة', async () => {
    const res = await create(civil('123456', '78', '3', { fullName: 'ماجد فرحان عبيد الكبيسي' }));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING_APPROVAL');
    expect(res.body.duplicateFlags).toHaveLength(0);
  });

  it('الرقم نفسه بسجل آخر والاسم متشابه: يُعلَّق السجل، والشبهة تذكر السجلّين', async () => {
    const res = await create(civil('123456', '91', '8', { fullName: 'حامد سلمان داود العاني' }));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING_DEDUPE_REVIEW');
    const flag = res.body.duplicateFlags.find((x: any) => x.reason.startsWith('رقم الهوية نفسه'));
    expect(flag.reason).toContain('(91 هنا، 45 هناك)');
    expect(flag.reason).toContain('الاسم');
    expect(flag.reason).not.toContain('متقاربان');
    expect(flag.matchedFamilyNo ?? flag.matchedFamily?.familyNo ?? first.familyNo).toBe(first.familyNo);
  });

  it('سجل مقلوب الخانتين والاسم الأول نفسه: شبهة أعلى، وتنبّه إلى خطأ الإدخال', async () => {
    const res = await create(civil('123456', '54', '112', { fullName: 'حامد عبد الله كريم الراوي' }));
    expect(res.body.status).toBe('PENDING_DEDUPE_REVIEW');
    const flag = res.body.duplicateFlags.find((x: any) => x.reason.includes('(54 هنا، 45 هناك)'));
    expect(flag.reason).toContain('الاسم الأول');
    expect(flag.reason).toContain('السجلان متقاربان كتابةً: يُحتمل خطأ في الإدخال');
    const far = await sql("select score from duplicate_flags where reason like '%(91 هنا، 45 هناك)%'");
    // اسم مطابق تماماً بسجل بعيد أعلى من اسم أول وحده بسجل قريب؛ وكلاهما فوق 0.6.
    expect(Number(flag.score)).toBeGreaterThan(0.6);
    expect(Number(far.rows[0].score)).toBeGreaterThan(0.75);
  });

  it('اسم مختلف لكن اسم الأم أو تاريخ الميلاد مطابق: شبهة أيضاً', async () => {
    const base = await create(civil('777001', '10', '1', { fullName: 'سندس جبار محسن الحديثي', motherName: 'نعيمة حسين', birthDate: '1970-02-03' }));
    expect(base.body.status).toBe('PENDING_APPROVAL');
    const mother = await create(civil('777001', '300', '1', { fullName: 'أم علي الحديثية', motherName: 'نعيمه حسين', birthDate: '1988-01-01' }));
    expect(mother.body.duplicateFlags.some((x: any) => x.reason.includes('اسم الأم'))).toBe(true);
    const birth = await create(civil('777001', '400', '1', { fullName: 'زوجة فلان الفلاني', birthDate: '1970-02-03' }));
    expect(birth.body.duplicateFlags.some((x: any) => x.reason.includes('تاريخ الميلاد'))).toBe(true);
    // سجل قريب كتابةً وحده، بلا قرينة في الاسم: لا شبهة. السجلات متتالية، فالجار ليس دليلاً.
    const neighbour = await create(civil('777001', '11', '1', { fullName: 'رجل غريب لا صلة له' }));
    expect(neighbour.body.status).toBe('PENDING_APPROVAL');
  });

  it('الباحث يرى أثناء الكتابة أن الرقم مسجَّل بسجل آخر، قبل أن يحفظ', async () => {
    const r = await lookup({ type: 'CIVIL_ID', number: '0123456', register: '46', page: '1' });
    expect(r.found).toBe(false);
    expect(r.similar.map((x: any) => x.book).sort()).toEqual(['45', '54', '78', '91']);
    expect(r.similar.find((x: any) => x.book === '45')).toMatchObject({ near: true, familyNo: first.familyNo, personName: 'حامد سلمان داود العاني' });
    expect(r.similar.find((x: any) => x.book === '91').near).toBe(false);
    expect((await lookup({ type: 'CIVIL_ID', number: '55555', register: '1', page: '1' })).similar).toEqual([]);
  });

  it('البحث برقم الهوية وحده يجد كل من يحمله، بأي سجل', async () => {
    const hits = (await get('/families?q=123456&limit=50', 'supervisor')).body;
    expect(hits).toHaveLength(4);
    expect((await get('/families?q=٠٠١٢٣٤٥٦', 'supervisor')).body).toHaveLength(4);
    const nc = await create(family());
    const number = await sql('select number_enc from person_documents d join persons p on p.id = d.person_id where p.family_id = $1', [nc.body.id]);
    const plain = app.get(FieldCrypto).decrypt(number.rows[0].number_enc);
    expect((await get(`/families?q=${plain}`, 'supervisor')).body.map((f: any) => f.id)).toEqual([nc.body.id]);
  });

  it('المفتاح لا يخرج من الخادم: لا بصمة في أي جواب، والمحفوظ بصمة لا رقم', async () => {
    const body = JSON.stringify((await get(`/families/${first.id}`, 'supervisor')).body);
    const row = (await sql('select key_hash, number_hash, key_version from person_documents d join persons p on p.id = d.person_id where p.family_id = $1', [first.id])).rows[0];
    expect(row.key_version).toBe(2);
    expect(body).not.toContain(row.key_hash);
    expect(body).not.toContain(row.number_hash);
    expect(body).not.toContain('123456');
    expect(row.key_hash).not.toContain('123456');
    expect(row.number_hash).not.toContain('123456');
  });

  it('السجل المرفوض يحرّر مفتاحه ويخرج من مطابقة الرقم', async () => {
    const f = await create(civil('888002', '20', '1', { fullName: 'مرفوض للتجربة الأولى' }));
    await post(`/families/${f.body.id}/reject`, 'supervisor', { note: 'بيانات خاطئة' });
    expect((await create(civil('888002', '20', '1', { fullName: 'مرفوض للتجربة الأولى' }))).status).toBe(201);
    const r = await lookup({ type: 'CIVIL_ID', number: '888002', register: '21', page: '1' });
    expect(r.similar).toHaveLength(1);
  });
});

describe('شهادة الجنسية', () => {
  it('الرقم والمحفظة مفتاحها، والرقم نفسه بمحفظة أخرى واسم متشابه شبهة', async () => {
    const a = family();
    a.members[0].fullName = 'غازي فيصل حمد الجبوري';
    a.members[0].documents = [{ type: 'NATIONALITY_CERT', number: '0099887', portfolio: '12' }];
    expect((await create(a)).status).toBe(201);
    const same = family();
    same.members[0].documents = [{ type: 'NATIONALITY_CERT', number: '99887', portfolio: '012' }];
    expect((await create(same)).status).toBe(409);
    const other = family();
    other.members[0].fullName = 'غازي فيصل حمد الجبوري';
    other.members[0].motherName = undefined;
    other.members[0].birthDate = undefined;
    other.members[0].documents = [{ type: 'NATIONALITY_CERT', number: '99887', portfolio: '21' }];
    const res = await create(other);
    expect(res.body.duplicateFlags.some((x: any) => x.reason.includes('رقم الشهادة نفسه والمحفظة مختلفة (21 هنا، 12 هناك)') && x.reason.includes('المحفظتان متقاربتان كتابةً'))).toBe(true);
  });
});

describe('ترحيل الوثائق المحفوظة بالمفتاح القديم', () => {
  it('يُعاد حساب مفتاحها عند الإقلاع، فتدخل في الفرادة الجديدة ومطابقة الرقم', async () => {
    const crypto = app.get(FieldCrypto);
    const f = await create(civil('444001', '30', '5', { fullName: 'قديم محفوظ بالمفتاح الأول' }));
    // تُرجَع وثيقته إلى ما كانت عليه قبل هذا الإصدار: مفتاح «رقم|سجل|صفحة»، بلا بصمة رقم.
    await sql("update person_documents set key_hash = $2, number_hash = null, key_version = 1 where person_id = $1", [f.body.members[0].id, crypto.blindIndex('CI:444001|30|5')]);
    // بالمفتاح القديم يفلت من سُجّل بصفحة أخرى.
    expect((await lookup({ type: 'CIVIL_ID', number: '444001', register: '30', page: '6' })).found).toBe(false);

    expect(await app.get(FamiliesService).rekeyDocuments()).toEqual({ rekeyed: 1, collisions: 0 });
    expect((await lookup({ type: 'CIVIL_ID', number: '444001', register: '30', page: '6' })).found).toBe(true);
    expect((await lookup({ type: 'CIVIL_ID', number: '444001', register: '31', page: '1' })).similar).toHaveLength(1);
    expect(await app.get(FamiliesService).rekeyDocuments()).toEqual({ rekeyed: 0, collisions: 0 });
  });

  it('وثيقتان قديمتان بسجل ورقم واحد وصفحتين: لا يُحذف شيء، وتُرفع شبهة للمشرف', async () => {
    const crypto = app.get(FieldCrypto);
    const a = await create(civil('444002', '60', '1', { fullName: 'مكرر قديم الأول' }));
    const b = await create(civil('444002', '61', '2', { fullName: 'شخص ثانٍ مختلف الاسم' }));
    // كما لو سُجّلا قديماً بالسجل نفسه وصفحتين مختلفتين، حين كانت الصفحة من المفتاح.
    await sql("update person_documents set register = '60', key_hash = $2, number_hash = null, key_version = 1 where person_id = $1", [b.body.members[0].id, crypto.blindIndex('CI:444002|60|2')]);
    expect(await app.get(FamiliesService).rekeyDocuments()).toEqual({ rekeyed: 0, collisions: 1 });
    const docs = await sql('select count(*)::int as n from person_documents where person_id = any($1)', [[a.body.members[0].id, b.body.members[0].id]]);
    expect(docs.rows[0].n).toBe(2);
    const flags = (await get('/duplicate-flags', 'supervisor')).body;
    expect(flags.some((x: any) => x.reason.includes('مسجَّلة لشخصين بصفحتين مختلفتين') && x.familyNo === b.body.familyNo)).toBe(true);
    expect((await get('/audit/verify', 'auditor')).body.ok).toBe(true);
  });
});
