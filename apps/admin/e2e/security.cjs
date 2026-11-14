/**
 * معيار قبول الخطوة 15 في المتصفح: كلمة مؤقتة تُغيَّر قسراً، تحقق بعاملين يُفعَّل ويُطلب عند الدخول، وقفل بعد خمس محاولات يفكّه المدير.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/security.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { BASE, RUN, PASSWORD, call, login, setupUsers, run } = require('./lib.cjs');

// رمز التحقق الزمني، كما يحسبه تطبيق المصادقة.
function totp(secret, offset = 0) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret) bits += A.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const mac = crypto.createHmac('sha1', key).update(counter).digest();
  const o = mac[mac.length - 1] & 0xf;
  return String((((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3]) % 1000000).padStart(6, '0');
}

run(async ({ step, shot, newPage }) => {
  const { tokens, names } = await setupUsers([['accountant', 'ACCOUNTANT', 'المحاسب']]);
  const admin = await newPage();
  const acc = await newPage();
  const fill = async (page, username, password) => {
    await page.goto(BASE);
    await page.getByLabel('اسم المستخدم').fill(username);
    await page.getByLabel('كلمة المرور', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'دخول' }).click();
  };

  await step('المدير يضع كلمة مؤقتة، فيُلزم صاحبها بتغييرها قبل أي شيء', async () => {
    await login(admin, 'admin', process.env.ADMIN_PASSWORD);
    await admin.getByRole('link', { name: 'المستخدمون' }).click();
    await admin.getByRole('row').filter({ hasText: names.accountant }).getByRole('button', { name: 'كلمة المرور والدخول' }).click();
    const d = admin.getByRole('dialog');
    await d.getByLabel('كلمة مرور مؤقتة').fill('temporary-password-1');
    await d.getByRole('button', { name: 'ضع الكلمة المؤقتة' }).click();
    await d.waitFor({ state: 'hidden' });

    await fill(acc, names.accountant, 'temporary-password-1');
    await acc.getByRole('heading', { name: 'ضع كلمة مرورك' }).waitFor();
    assert.equal(await acc.getByRole('link', { name: 'الرئيسية' }).count(), 0);
    await acc.getByLabel('كلمة المرور الحالية').fill('temporary-password-1');
    await acc.getByLabel('كلمة المرور الجديدة').fill('my-own-password-22');
    await acc.getByLabel('أعِدها للتأكد').fill('my-own-password-2');
    await acc.getByText('الكلمتان لا تتطابقان').waitFor();
    await acc.getByLabel('أعِدها للتأكد').fill('my-own-password-22');
    await acc.getByRole('button', { name: 'غيّر كلمة المرور' }).click();
    await acc.getByRole('heading', { name: 'الرئيسية' }).waitFor();
  });

  let secret;
  await step('المحاسب يفعّل التحقق بعاملين برمز من تطبيقه', async () => {
    await acc.getByRole('button', { name: /حسابي/ }).click();
    const d = acc.getByRole('dialog');
    await d.getByText('دورك يملك المال أو الصلاحيات').waitFor();
    await d.getByRole('button', { name: 'ابدأ التفعيل' }).click();
    secret = (await d.getByTestId('totp-secret').innerText()).trim();
    await d.getByRole('img', { name: 'رمز تفعيل التحقق بعاملين' }).locator('svg').waitFor();
    await shot(acc, '31-totp');
    await d.getByLabel('الرمز من التطبيق').fill('000000');
    await d.getByRole('button', { name: 'فعّل' }).click();
    await d.getByText('رمز التحقق غير صحيح أو انتهى وقته').waitFor();
    await d.getByLabel('الرمز من التطبيق').fill(totp(secret, -1));
    await d.getByRole('button', { name: 'فعّل' }).click();
    await acc.getByText('فُعّل التحقق بعاملين').waitFor();
    await d.getByText('مفعَّل', { exact: true }).waitFor();
    await d.getByRole('button', { name: 'إغلاق' }).click();
    await acc.getByRole('button', { name: 'تسجيل الخروج' }).click();
  });

  await step('الدخول يطلب الرمز بعد كلمة المرور', async () => {
    await fill(acc, names.accountant, 'my-own-password-22');
    await acc.getByLabel('رمز التحقق من تطبيق المصادقة').waitFor();
    await acc.getByLabel('رمز التحقق من تطبيق المصادقة').fill(totp(secret));
    await acc.getByRole('button', { name: 'دخول' }).click();
    await acc.getByRole('heading', { name: 'الرئيسية' }).waitFor();
    await acc.getByRole('button', { name: 'تسجيل الخروج' }).click();
  });

  await step('خمس محاولات خاطئة تقفل الحساب، والمدير يفكّه', async () => {
    for (let i = 0; i < 5; i++) await call('/auth/login', null, { username: names.accountant, password: 'wrong-password-123' });
    await fill(acc, names.accountant, 'my-own-password-22');
    await acc.getByText(/أُقفل الحساب لكثرة المحاولات الخاطئة/).waitFor();
    await admin.reload();
    const row = admin.getByRole('row').filter({ hasText: names.accountant });
    await row.getByText('مقفل').waitFor();
    await row.getByText('بعاملين').waitFor();
    await row.getByRole('button', { name: 'كلمة المرور والدخول' }).click();
    await admin.getByRole('dialog').getByRole('button', { name: 'فكّ القفل وعطّل العاملين' }).click();
    await admin.getByRole('dialog').waitFor({ state: 'hidden' });
    await fill(acc, names.accountant, 'my-own-password-22');
    await acc.getByRole('heading', { name: 'الرئيسية' }).waitFor();
  });
});
