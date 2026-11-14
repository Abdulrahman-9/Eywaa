/**
 * معيار قبول الخطوة 4 في المتصفح: النقاط تظهر بعد الاعتماد مع تفصيلها، والمدير يعدّل وزناً فيرى أثره
 * قبل الطلب، ولا يسري الإصدار حتى يعتمده غيره.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/scoring.cjs [مجلد الصور]
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
const SHOTS = process.argv[2];
const PASSWORD = 'staff-demo-password';
const RUN = Date.now().toString().slice(-6);
const steps = [];
let pages = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`✓ ${name}`); };
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

async function call(path, token, body, method = 'POST') {
  const res = await fetch(`${BASE}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}
async function login(page, username, password) {
  await page.goto(BASE);
  await page.getByLabel('اسم المستخدم').fill(username);
  await page.getByLabel('كلمة المرور').fill(password);
  await page.getByRole('button', { name: 'دخول' }).click();
  await page.getByRole('heading', { name: 'الرئيسية' }).waitFor();
}

(async () => {
  const admin = (await call('/auth/login', null, { username: 'admin', password: process.env.ADMIN_PASSWORD })).token;
  await call('/users', admin, { username: `res${RUN}`, fullName: 'باحث ميداني', password: PASSWORD, role: 'FIELD_RESEARCHER' });
  await call('/users', admin, { username: `sup${RUN}`, fullName: 'مشرف المستفيدين', password: PASSWORD, role: 'BENEFICIARY_SUPERVISOR' });
  const res = (await call('/auth/login', null, { username: `res${RUN}`, password: PASSWORD })).token;
  // أرملة بثلاثة أيتام في إيجار بلا دخل: 70 نقطة بالإصدار 1 (فئة أ).
  const names = ['سعاد كريم عبد الله الدليمي', 'عمر ياسين محمود الدليمي', 'نور ياسين محمود الدليمي', 'علي ياسين محمود الدليمي'];
  const widow = await call('/families', res, {
    tags: ['WIDOW', 'ORPHANS'], housing: 'RENTED', incomes: [], proxies: [],
    members: names.map((fullName, i) => ({ relation: i ? 'SON' : 'HEAD', fullName, gender: i ? 'M' : 'F', isOrphan: i > 0, documents: i ? [] : [{ type: 'NATIONAL_CARD', number: `1975${RUN}01` }] })),
  });
  await call(`/families/${widow.id}/approve`, admin, {});

  const browser = await chromium.launch();
  const ctx = () => browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: Number(process.env.DSF ?? 2), locale: 'ar-IQ' });
  const adminPage = await (await ctx()).newPage();
  const supPage = await (await ctx()).newPage();
  pages = [adminPage, supPage];
  const errors = [];
  for (const p of pages) p.on('pageerror', (e) => errors.push(e.message));

  await step('ملف العائلة يعرض الفئة والنقاط وتفصيلها معياراً معياراً', async () => {
    await login(adminPage, 'admin', process.env.ADMIN_PASSWORD);
    await adminPage.goto(`${BASE}/families/${widow.id}`);
    await adminPage.getByText('الفئة أ · 70 نقطة').waitFor();
    await adminPage.getByRole('heading', { name: 'لماذا 70 نقطة؟' }).waitFor();
    await adminPage.getByText('15 / 15').waitFor();
    await shot(adminPage, '12-score');
  });

  await step('المدير يرفع حدّ الفئة أ فيرى الأثر قبل أن يطلب', async () => {
    await adminPage.getByRole('navigation', { name: 'القائمة الرئيسية' }).getByRole('link', { name: 'النقاط والفئات' }).click();
    await adminPage.getByText('غيّر وزناً أو حدّاً').waitFor();
    await adminPage.getByLabel('الفئة أ: من').fill('80');
    await adminPage.getByText('تنزل من أ إلى ب').waitFor();
    await adminPage.getByText('اعرض العوائل المتأثرة').click();
    await adminPage.getByRole('link', { name: /سعاد كريم/ }).waitFor();
    await shot(adminPage, '13-scoring');
  });

  await step('لا يُرسل الطلب قبل الإقرار بالاطلاع على الأثر', async () => {
    await adminPage.getByRole('button', { name: 'اطلب اعتماد الإصدار 2' }).click();
    const dialog = adminPage.getByRole('dialog');
    assert.equal(await dialog.getByRole('button', { name: 'اطلب اعتماد الإصدار' }).isDisabled(), true);
    await dialog.getByLabel('اطّلعتُ على أثر التعديل').check();
    await dialog.getByRole('button', { name: 'اطلب اعتماد الإصدار' }).click();
    await adminPage.getByText('أُرسل الإصدار إلى الاعتماد').waitFor();
    await adminPage.getByText('اقترحتَه أنت: يعتمده غيرك').waitFor();
    assert.equal(await adminPage.getByRole('button', { name: 'اعتماد الإصدار 2' }).count(), 0);
  });

  await step('النقاط لا تتغير قبل الاعتماد', async () => {
    const f = await call(`/families/${widow.id}`, admin, null, 'GET');
    assert.deepEqual(f.score, { points: 70, class: 'A' });
  });

  await step('المشرف يعتمد الإصدار، فتنتقل العائلة إلى الفئة ب', async () => {
    await login(supPage, `sup${RUN}`, PASSWORD);
    await supPage.getByRole('navigation', { name: 'القائمة الرئيسية' }).getByRole('link', { name: 'النقاط والفئات' }).click();
    await supPage.getByRole('button', { name: 'اعتماد الإصدار 2' }).click();
    await supPage.getByRole('dialog').getByRole('button', { name: 'اعتماد الإصدار' }).click();
    await supPage.getByText('اعتُمد الإصدار وأُعيد حساب النقاط').waitFor();
    await supPage.getByText('الإصدار 2 سارٍ').waitFor();
    await supPage.goto(`${BASE}/families/${widow.id}`);
    await supPage.getByText('الفئة ب · 70 نقطة').waitFor();
    await supPage.getByText('بالإصدار 2 من المعادلة').waitFor();
  });

  await step('القائمة تصفّي بالفئة، والرئيسية تعرض التوزيع', async () => {
    await supPage.getByRole('link', { name: 'العوائل', exact: true }).click();
    await supPage.getByLabel('الفئة').selectOption('B');
    await supPage.getByRole('row').filter({ hasText: '70 نقطة' }).waitFor();
    await supPage.getByLabel('الفئة').selectOption('A');
    await supPage.getByText('لا عائلة تطابق البحث').waitFor();
    await supPage.getByRole('link', { name: 'الرئيسية' }).click();
    await supPage.getByRole('heading', { name: 'العوائل بحسب الفئة' }).waitFor();
  });

  await step('لا أخطاء برمجية في المتصفح', async () => assert.deepEqual(errors, []));
  await browser.close();
  console.log(`\n${steps.length} خطوات نجحت`);
})().catch(async (err) => {
  console.error(`✗ فشل بعد ${steps.length} خطوة:\n`, err.message);
  if (SHOTS) for (const [i, p] of pages.entries()) await p.screenshot({ path: `${SHOTS}/fail-${i}.png` }).catch(() => {});
  process.exit(1);
});
