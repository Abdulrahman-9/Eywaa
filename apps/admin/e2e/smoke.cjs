/**
 * معيار قبول الخطوة 2، في متصفح حقيقي:
 *   المدير ينشئ موظفاً ويعطّله من اللوحة؛ والموظف لا يرى ما ليس من صلاحيته ولا يبلغه ولو كتب العنوان بيده.
 * التشغيل (والخادم واللوحة يعملان):
 *   BASE_URL=http://localhost:4173 ADMIN_PASSWORD=... node e2e/smoke.cjs [مجلد الصور]
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SHOTS = process.argv[2];
const NEW_USER = `auditor.${Date.now().toString(36)}`;
const NEW_PASSWORD = 'auditor-demo-password';

const steps = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`✓ ${name}`); };
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

async function login(page, username, password) {
  await page.goto(BASE);
  await page.getByLabel('اسم المستخدم').fill(username);
  await page.getByLabel('كلمة المرور').fill(password);
  await page.getByRole('button', { name: 'دخول' }).click();
}

(async () => {
  const browser = await chromium.launch();
  const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'ar-IQ' });
  const admin = await adminCtx.newPage();
  const errors = [];
  admin.on('pageerror', (e) => errors.push(e.message));

  await step('كلمة مرور خاطئة تُرفض برسالة عربية', async () => {
    await admin.goto(BASE);
    await shot(admin, '1-login');
    await login(admin, 'admin', 'wrong-password-xx');
    await admin.getByRole('alert').filter({ hasText: 'غير صحيحة' }).waitFor();
  });

  await step('المدير يدخل ويرى الرئيسية والقائمة كاملة', async () => {
    await login(admin, 'admin', ADMIN_PASSWORD);
    await admin.getByRole('heading', { name: 'الرئيسية' }).waitFor();
    await admin.getByText('العوائل المعتمدة').first().waitFor();
    for (const item of ['المستخدمون', 'سجل التدقيق', 'الإعدادات']) await admin.getByRole('link', { name: item }).waitFor();
    await admin.waitForTimeout(600);
    await shot(admin, '2-home');
  });

  await step('خطأ الإدخال يظهر تحت حقله، ثم يُنشأ الموظف', async () => {
    await admin.getByRole('link', { name: 'المستخدمون' }).click();
    await admin.getByRole('button', { name: 'إضافة مستخدم' }).click();
    await admin.getByLabel('الاسم الكامل').fill('مدقق تجريبي');
    await admin.getByLabel('اسم المستخدم').fill(NEW_USER);
    await admin.getByLabel('كلمة المرور').fill('short');
    await admin.getByLabel('الدور').selectOption('AUDITOR');
    await admin.getByRole('button', { name: 'إضافة', exact: true }).click();
    await admin.getByText('كلمة المرور 12 خانة على الأقل').waitFor();
    await admin.getByLabel('كلمة المرور').fill(NEW_PASSWORD);
    await admin.getByRole('button', { name: 'إضافة', exact: true }).click();
    await admin.getByRole('cell', { name: NEW_USER }).waitFor();
    await shot(admin, '3-users');
  });

  const staffCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ar-IQ' });
  const staff = await staffCtx.newPage();

  await step('الموظف الجديد لا يرى «المستخدمون» في قائمته', async () => {
    await login(staff, NEW_USER, NEW_PASSWORD);
    await staff.getByRole('heading', { name: 'الرئيسية' }).waitFor();
    await staff.getByRole('link', { name: 'سجل التدقيق' }).waitFor();
    assert.equal(await staff.getByRole('link', { name: 'المستخدمون' }).count(), 0);
  });

  await step('ولا يبلغها ولو كتب العنوان بيده، والخادم نفسه يرفضه', async () => {
    await staff.goto(`${BASE}/users`);
    await staff.getByRole('heading', { name: 'لا صلاحية لك في هذه الصفحة' }).waitFor();
    const status = await staff.evaluate(async () => {
      const token = sessionStorage.getItem('eywaa.token');
      return (await fetch('/api/users', { headers: { Authorization: `Bearer ${token}` } })).status;
    });
    assert.equal(status, 403);
  });

  await step('غير المدير يرى خط الفقر ولا يملك تغييره', async () => {
    await staff.getByRole('link', { name: 'العودة إلى الرئيسية' }).click();
    await staff.getByRole('link', { name: 'الإعدادات' }).click();
    await staff.getByText('300,000').waitFor();
    assert.equal(await staff.getByLabel('القيمة الجديدة بالدينار').count(), 0);
  });

  await step('المدير يغيّر خط الفقر بعد تأكيد', async () => {
    await admin.getByRole('link', { name: 'الإعدادات' }).click();
    await admin.getByLabel('القيمة الجديدة بالدينار').fill('320000');
    await admin.getByRole('button', { name: 'تغيير', exact: true }).click();
    await admin.getByText('من 300,000 إلى 320,000').waitFor();
    await admin.getByRole('button', { name: 'تأكيد التغيير' }).click();
    await admin.getByText('حُفظ خط الفقر الجديد').waitFor();
    await admin.getByText('320,000').first().waitFor();
    await admin.getByLabel('القيمة الجديدة بالدينار').fill('300000');
    await admin.getByRole('button', { name: 'تغيير', exact: true }).click();
    await admin.getByRole('button', { name: 'تأكيد التغيير' }).click();
    await admin.getByText('آخر تغيير').waitFor();
  });

  await step('المدير يعطّل الموظف، فتُقطع جلسته القائمة فوراً', async () => {
    await admin.getByRole('link', { name: 'المستخدمون' }).click();
    const row = admin.getByRole('row').filter({ hasText: NEW_USER });
    await row.getByRole('button', { name: 'تعطيل' }).click();
    await admin.getByRole('button', { name: 'تعطيل الحساب' }).click();
    await row.getByText('معطَّل').waitFor();
    await staff.getByRole('link', { name: 'سجل التدقيق' }).click();
    await staff.getByRole('button', { name: 'دخول' }).waitFor();
    await login(staff, NEW_USER, NEW_PASSWORD);
    await staff.getByRole('alert').waitFor();
  });

  await step('سجل التدقيق يعرض ما جرى، وفحص السلامة ينجح', async () => {
    await admin.getByRole('link', { name: 'سجل التدقيق' }).click();
    await admin.getByRole('cell', { name: 'إنشاء مستخدم' }).first().waitFor();
    await admin.getByRole('cell', { name: 'تغيير إعداد' }).first().waitFor();
    await admin.getByRole('button', { name: 'تحقق من سلامة السجل' }).click();
    await admin.getByText('السجل سليم').waitFor();
    await shot(admin, '4-audit');
  });

  await step('اللوحة تصلح على عرض الهاتف بلا تمرير أفقي', async () => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ar-IQ' });
    const p = await phone.newPage();
    await login(p, 'admin', ADMIN_PASSWORD);
    await p.getByRole('heading', { name: 'الرئيسية' }).waitFor();
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await shot(p, '5-phone');
    await phone.close();
  });

  await step('لا أخطاء برمجية في المتصفح', async () => assert.deepEqual(errors, []));

  await browser.close();
  console.log(`\n${steps.length} خطوة نجحت`);
})().catch((err) => {
  console.error(`✗ فشل بعد ${steps.length} خطوة:\n`, err.message);
  process.exit(1);
});
