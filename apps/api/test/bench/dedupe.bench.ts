/**
 * معيار قبول المرحلة 1: 10,000 عائلة مصطنعة بأسماء عراقية شائعة، دُسَّت فيها مكررات.
 * التشغيل:  pnpm jest --testMatch '**\/*.bench.ts' --testTimeout 900000
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { login, sql, startApp } from '../helpers';

const FAMILIES = Number(process.env.BENCH_FAMILIES ?? 10000);
const MALE = ['محمد', 'أحمد', 'علي', 'حسين', 'حسن', 'عمر', 'عثمان', 'خالد', 'ياسين', 'مصطفى', 'إبراهيم', 'يوسف', 'عبد الله', 'عبد الرحمن', 'جاسم', 'كريم', 'سعد', 'ماجد', 'طارق', 'زياد', 'فراس', 'ثامر', 'صباح', 'رعد', 'قاسم', 'حميد', 'سلمان', 'نوري', 'فاضل', 'عادل', 'ناصر', 'هاشم', 'مهدي', 'صالح', 'خلف', 'عبيد', 'حمد', 'شاكر', 'وليد', 'بلال'];
const FEMALE = ['فاطمة', 'زينب', 'مريم', 'عائشة', 'خديجة', 'نور', 'سعاد', 'هدى', 'آمنة', 'إسراء', 'رقية', 'سارة', 'نجاة', 'وفاء', 'سعدية', 'حنان', 'أمل', 'شيماء', 'دعاء', 'رغد', 'بشرى', 'انتصار', 'سميرة', 'ليلى', 'نادية', 'كوثر', 'صبيحة', 'جنان', 'غفران', 'ابتسام'];
const CLANS = ['الدليمي', 'الجميلي', 'العيساوي', 'المحمدي', 'الكبيسي', 'الراوي', 'الفهداوي', 'الحلبوسي', 'الزوبعي', 'العلواني', 'الجنابي', 'العبيدي', 'الفلاحي', 'الكرطاني', 'العاني'];

let seed = 42;
// mulberry32: مولّد صحيح في حدود 32 بتاً (الضرب العادي يفقد الدقة في JS فيدور في حلقة قصيرة).
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
const year = (from: number, to: number) => from + Math.floor(rnd() * (to - from + 1));
let docSeq = 0;
const nid = () => String(200000000000 + ++docSeq);

function makeFamily(i: number) {
  const father = pick(MALE), grandfather = pick(MALE), great = pick(MALE), clan = pick(CLANS);
  const headIsWidow = rnd() < 0.5;
  const headName = headIsWidow
    ? `${pick(FEMALE)} ${pick(MALE)} ${pick(MALE)} ${pick(CLANS)}`
    : `${father} ${grandfather} ${great} ${clan}`;
  const mother = () => `${pick(FEMALE)} ${pick(MALE)} ${pick(MALE)}`;
  const members: any[] = [{
    relation: 'HEAD', fullName: headName, motherName: mother(), gender: headIsWidow ? 'F' : 'M',
    birthDate: `${year(1955, 1995)}-0${1 + Math.floor(rnd() * 9)}-15`,
    documents: rnd() < 0.7
      ? [{ type: 'NATIONAL_CARD', number: nid() }]
      : [{ type: 'CIVIL_ID', number: String(++docSeq), register: String(100 + (i % 400)), page: String(1 + (i % 200)) }],
  }];
  const childMother = headIsWidow ? headName.split(' ').slice(0, 3).join(' ') : mother();
  const kids = 1 + Math.floor(rnd() * 5);
  for (let k = 0; k < kids; k++) {
    const boy = rnd() < 0.5;
    members.push({
      relation: boy ? 'SON' : 'DAUGHTER', fullName: `${pick(boy ? MALE : FEMALE)} ${father} ${grandfather} ${clan}`,
      motherName: childMother, gender: boy ? 'M' : 'F', birthDate: `${year(2005, 2023)}-06-01`,
      isOrphan: headIsWidow, documents: rnd() < 0.8 ? [{ type: 'NATIONAL_CARD', number: nid() }] : [],
    });
  }
  return {
    tags: headIsWidow ? ['WIDOW', 'ORPHANS'] : ['NEEDY'],
    phone1: `077${String(10000000 + i)}`,
    rationCard: { number: String(50000000 + i) },
    housing: pick(['OWNED', 'RENTED', 'OTHER']),
    members,
    incomes: [],
    proxies: [],
  };
}

/** يكتب الاسم برسم آخر: همزات وتاء مربوطة وألف مقصورة و«عبد» ملتصقة. */
const respell = (name: string) =>
  name.replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/عبد /g, 'عبد');

it(`كشف التكرار على ${FAMILIES} عائلة`, async () => {
  const app: INestApplication = await startApp();
  const tokenA = await login(app, 'researcher');
  const post = (body: any) =>
    request(app.getHttpServer()).post('/api/families').set({ Authorization: `Bearer ${tokenA}` }).send(body);

  const base: any[] = [];
  const t0 = Date.now();
  let created = 0, cleanFlagged = 0;
  for (let i = 0; i < FAMILIES; i++) {
    const f = makeFamily(i);
    const res = await post(f);
    if (res.status !== 201) throw new Error(`unexpected ${res.status}: ${JSON.stringify(res.body)}`);
    created++;
    if (res.body.status === 'PENDING_DEDUPE_REVIEW') cleanFlagged++;
    base.push(f);
  }
  const seconds = (Date.now() - t0) / 1000;

  // 1) مكررات قطعية: وثيقة فرد قائم (رب أسرة أو ولد) تحت اسم جديد تماماً.
  let docBlocked = 0;
  for (let i = 0; i < 200; i++) {
    const victim = base[i * 37 % FAMILIES];
    const withDoc = victim.members.filter((m: any) => m.documents.length);
    const stolen = withDoc[i % withDoc.length].documents[0];
    const f = makeFamily(FAMILIES + i);
    f.members[0].documents = [stolen];
    if ((await post(f)).status === 409) docBlocked++;
  }
  // 2) بطاقة تموينية مكررة بوثائق جديدة.
  let rationBlocked = 0;
  for (let i = 0; i < 100; i++) {
    const f = makeFamily(FAMILIES + 1000 + i);
    f.rationCard = { number: base[i * 53 % FAMILIES].rationCard.number };
    if ((await post(f)).status === 409) rationBlocked++;
  }
  // 3) الشخص نفسه برسم آخر ووثيقة أخرى وهاتف آخر وبطاقة تموينية أخرى (القرينة: اسم الأم وسنة الميلاد).
  let fuzzyCaught = 0;
  for (let i = 0; i < 100; i++) {
    const victim = base[i * 71 % FAMILIES];
    const f = makeFamily(FAMILIES + 2000 + i);
    const head = victim.members[0];
    f.members = [{ ...head, fullName: respell(head.fullName), motherName: respell(head.motherName), documents: [{ type: 'NATIONAL_CARD', number: nid() }] }];
    const res = await post(f);
    if (res.status === 201 && res.body.status === 'PENDING_DEDUPE_REVIEW') fuzzyCaught++;
  }

  const persons = (await sql('select count(*)::int as n from persons')).rows[0].n;
  const report = {
    families: created,
    persons,
    secondsToRegister: Math.round(seconds),
    msPerFamily: Math.round((seconds * 1000) / created),
    exactDocumentDuplicatesBlocked: `${docBlocked}/200`,
    rationDuplicatesBlocked: `${rationBlocked}/100`,
    respelledPersonsFlagged: `${fuzzyCaught}/100`,
    cleanFamiliesFlaggedForReview: `${cleanFlagged}/${created} (${((cleanFlagged / created) * 100).toFixed(2)}%)`,
  };
  console.log(JSON.stringify(report, null, 2));
  await app.close();

  expect(docBlocked).toBe(200);
  expect(rationBlocked).toBe(100);
  expect(fuzzyCaught).toBe(100);
});
