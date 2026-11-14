/**
 * معيار قبول الخطوة 3، في متصفح حقيقي: تسجيل عائلة بالمعالج، رفع مرفق، منع التكرار أثناء الكتابة،
 * الاعتماد من موظف آخر، طلب تعديل واعتماده، والفصل في شبهة تكرار.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/families.cjs [مجلد الصور]
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
const SHOTS = process.argv[2];
const PASSWORD = 'staff-demo-password';
const RUN = Date.now().toString().slice(-6);
const NID = `1985${RUN}77`;

const steps = [];
let failShots = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`✓ ${name}`); };
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

async function apiCall(path, token, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  return res.json();
}
async function login(page, username, password) {
  await page.goto(BASE);
  await page.getByLabel('اسم المستخدم').fill(username);
  await page.getByLabel('كلمة المرور').fill(password);
  await page.getByRole('button', { name: 'دخول' }).click();
  await page.getByRole('heading', { name: 'الرئيسية' }).waitFor();
}
async function fillHead(page, name, mother, birth, nid) {
  await page.getByLabel('الاسم الرباعي واللقب').fill(name);
  await page.getByLabel('اسم الأم الكامل').fill(mother);
  await page.getByLabel('المواليد').fill(birth);
  await page.getByLabel('رقم البطاقة (12 خانة)').fill(nid);
}

(async () => {
  const admin = (await apiCall('/auth/login', null, { username: 'admin', password: process.env.ADMIN_PASSWORD })).token;
  for (const [username, fullName, role] of [[`res${RUN}`, 'باحث ميداني', 'FIELD_RESEARCHER'], [`sup${RUN}`, 'مشرف المستفيدين', 'BENEFICIARY_SUPERVISOR']]) {
    await apiCall('/users', admin, { username, fullName, password: PASSWORD, role });
  }

  const browser = await chromium.launch();
  const ctx = (o = {}) => browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'ar-IQ', ...o });
  const researcher = await (await ctx()).newPage();
  const supervisor = await (await ctx()).newPage();
  const errors = [];
  for (const p of [researcher, supervisor]) p.on('pageerror', (e) => errors.push(e.message));
  failShots = [researcher, supervisor];
  let familyUrl;

  await step('الباحث يسجّل عائلة بالمعالج من أوله إلى آخره', async () => {
    await login(researcher, `res${RUN}`, PASSWORD);
    await researcher.getByRole('link', { name: 'العوائل' }).click();
    await researcher.getByRole('link', { name: 'تسجيل عائلة' }).click();
    await researcher.getByLabel('أرامل').check();
    await researcher.getByLabel('أيتام').check();
    await fillHead(researcher, 'سعاد كريم عبد الله الدليمي', 'فاطمة علي حسن', '1975-03-10', NID);
    await researcher.getByLabel('الجنس').selectOption('F');
    await researcher.getByLabel('الهاتف', { exact: true }).fill('0770 123 4567');
    await researcher.getByText('الوثيقة غير مسجَّلة من قبل').waitFor();
    await shot(researcher, '6-register');
    await researcher.getByRole('button', { name: 'التالي: الأفراد' }).click();

    await researcher.getByRole('button', { name: 'أضف فرداً' }).click();
    await researcher.getByLabel('الاسم الكامل').fill('عمر ياسين محمود الدليمي');
    await researcher.getByLabel('المواليد').fill('2012-05-01');
    await researcher.getByLabel('يتيم').check();
    await researcher.getByRole('button', { name: 'التالي: السكن والوثائق' }).click();

    await researcher.getByLabel('المحلة').fill('الجولان');
    await researcher.getByLabel('نوع العقار').selectOption('RENTED');
    await researcher.getByLabel('رقم البطاقة التموينية').fill(`44${RUN}`);
    await researcher.getByRole('button', { name: 'التالي: الدخل والوكلاء' }).click();

    await researcher.getByRole('button', { name: 'أضف مصدر دخل' }).click();
    await researcher.getByLabel('المصدر').selectOption('PENSION');
    await researcher.getByLabel('المبلغ بالدينار').fill('250000');
    await researcher.getByRole('button', { name: 'أضف وكيلاً' }).click();
    await researcher.getByLabel('اسم الوكيل').fill('كريم عبد الله حسين');
    await researcher.getByRole('button', { name: 'التالي: المراجعة والحفظ' }).click();

    await researcher.getByText('250,000 دينار').waitFor();
    await researcher.getByRole('button', { name: 'احفظ وأرسل للاعتماد' }).click();
    await researcher.getByRole('heading', { name: /سُجّلت العائلة \d{7}/ }).waitFor();
    await researcher.getByText('السجل في صف الاعتماد').waitFor();
  });

  await step('يرفع مرفقاً اختيارياً بعد الحفظ، ويُرفض الملف المزوَّر الامتداد', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-test-image')]);
    await researcher.getByLabel('نوع المرفق').selectOption('PHOTO');
    await researcher.getByLabel('اختر ملفاً').setInputFiles({ name: 'صورة.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    await researcher.getByText('صورة.jpg').waitFor();
    await researcher.getByLabel('اختر ملفاً').setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('MZ not an image at all, really') });
    await researcher.getByText('نوع الملف غير مقبول').waitFor();
    await researcher.getByRole('button', { name: 'افتح ملف العائلة' }).click();
    await researcher.getByRole('heading', { name: 'سعاد كريم عبد الله الدليمي' }).waitFor();
    await researcher.getByText('هذا السجل أدخلتَه أنت').waitFor();
    assert.equal(await researcher.getByRole('button', { name: 'اعتماد', exact: true }).count(), 0);
    await researcher.getByText('2: 1 ذكور و1 إناث').waitFor();
    await researcher.getByText('دون خط الفقر').waitFor();
    familyUrl = researcher.url();
    await shot(researcher, '7-family');
  });

  await step('الوثيقة المكررة تُكشف أثناء الكتابة ويُمنع المضيّ', async () => {
    await researcher.goto(`${BASE}/families/new`);
    await fillHead(researcher, 'اسم آخر تماماً', 'أم أخرى', '1990-01-01', NID);
    await researcher.getByText('هذه الوثيقة مسجَّلة سلفاً').waitFor();
    assert.equal(await researcher.getByRole('button', { name: 'التالي: الأفراد' }).isDisabled(), true);
    await shot(researcher, '8-duplicate');
    await researcher.getByRole('button', { name: 'ابدأ من جديد' }).click();
  });

  await step('المشرف يرى السجل في صفّه ويعتمده', async () => {
    await login(supervisor, `sup${RUN}`, PASSWORD);
    await supervisor.getByRole('link', { name: /الاعتماد والشبهات/ }).click();
    await supervisor.getByRole('tab', { name: 'اعتماد التسجيل (1)' }).waitFor();
    await supervisor.getByRole('link', { name: 'مراجعة' }).click();
    await supervisor.getByRole('button', { name: 'اعتماد', exact: true }).click();
    await supervisor.getByRole('dialog').getByRole('button', { name: 'اعتماد', exact: true }).click();
    await supervisor.getByText('اعتُمدت العائلة').waitFor();
    await supervisor.getByText('معتمد', { exact: true }).first().waitFor();
  });

  await step('الباحث يطلب تعديلاً، ولا يسري حتى يعتمده المشرف', async () => {
    await researcher.goto(familyUrl);
    await researcher.getByRole('button', { name: 'طلب تعديل' }).click();
    const dialog = researcher.getByRole('dialog');
    await dialog.getByLabel('نوع العقار').selectOption('OWNED');
    await dialog.getByLabel('سبب التعديل (لازم)').fill('اشترت العائلة الدار');
    await dialog.getByRole('button', { name: 'أرسل للاعتماد' }).click();
    await researcher.getByText('أُرسل طلب التعديل إلى الاعتماد').waitFor();
    await researcher.getByText('طلب تعديل ينتظر الاعتماد').waitFor();
    await researcher.getByText('نوع العقار: إيجار').waitFor();

    await supervisor.goto(`${BASE}/review?tab=changes`);
    await supervisor.getByText('نوع العقار: ملك').waitFor();
    await shot(supervisor, '9-changes');
    await supervisor.getByRole('button', { name: 'اعتماد التعديل' }).click();
    await supervisor.getByRole('dialog').getByRole('button', { name: 'اعتماد التعديل' }).click();
    await supervisor.getByText('اعتُمد التعديل وسرى').waitFor();
    await researcher.reload();
    await researcher.getByText('نوع العقار: ملك').waitFor();
  });

  await step('اسم متقارب الرسم بوثيقة أخرى: يُعلَّق، والمشرف يقابل السجلّين ويفصل', async () => {
    await researcher.goto(`${BASE}/families/new`);
    await fillHead(researcher, 'سعاد كريم عبدالله الدليمى', 'فاطمه علي حسن', '1976-01-01', `1976${RUN}11`);
    await researcher.getByText('الوثيقة غير مسجَّلة من قبل').waitFor();
    for (const next of ['التالي: الأفراد', 'التالي: السكن والوثائق', 'التالي: الدخل والوكلاء', 'التالي: المراجعة والحفظ']) {
      await researcher.getByRole('button', { name: next }).click();
    }
    await researcher.getByRole('button', { name: 'احفظ وأرسل للاعتماد' }).click();
    await researcher.getByText('عُلّق السجل لشبهة تكرار').waitFor();

    await supervisor.goto(`${BASE}/review?tab=flags`);
    await supervisor.getByRole('heading', { name: 'أهما شخص واحد؟' }).waitFor();
    await supervisor.getByText('يختلف').first().waitFor();
    await shot(supervisor, '10-compare');
    await supervisor.getByRole('button', { name: 'تكرار مؤكَّد: ارفض الجديد' }).click();
    const dialog = supervisor.getByRole('dialog');
    assert.equal(await dialog.getByRole('button', { name: 'ارفض السجل الجديد' }).isDisabled(), true);
    await dialog.getByLabel('السبب (لازم)').fill('الشخص نفسه بوثيقة ثانية');
    await dialog.getByRole('button', { name: 'ارفض السجل الجديد' }).click();
    await supervisor.getByText('أُكّد التكرار ورُفض السجل الجديد').waitFor();
    await supervisor.getByText('لا شيء ينتظر قرارك').waitFor();
  });

  await step('القائمة تبحث بالاسم مع اختلاف الرسم وتصفّي بالحال', async () => {
    await supervisor.getByRole('link', { name: 'العوائل' }).click();
    await supervisor.getByLabel('بحث').fill('سعاد كريم عبدالله');
    await supervisor.getByRole('row').filter({ hasText: 'معتمد' }).first().waitFor();
    await supervisor.getByLabel('الحال').selectOption('REJECTED');
    await supervisor.getByRole('row').filter({ hasText: 'مرفوض' }).first().waitFor();
    await supervisor.getByRole('row').filter({ hasText: 'معتمد' }).first().waitFor({ state: 'detached' });
    await supervisor.getByLabel('الحال').selectOption('');
    await shot(supervisor, '11-families');
  });

  await step('لا أخطاء برمجية في المتصفح', async () => assert.deepEqual(errors, []));
  await browser.close();
  console.log(`\n${steps.length} خطوات نجحت`);
})().catch(async (err) => {
  console.error(`✗ فشل بعد ${steps.length} خطوة:\n`, err.message);
  if (SHOTS) for (const [i, p] of failShots.entries()) await p.screenshot({ path: `${SHOTS}/fail-${i}.png` }).catch(() => {});
  process.exit(1);
});
