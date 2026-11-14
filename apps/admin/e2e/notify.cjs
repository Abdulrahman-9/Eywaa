/**
 * معيار قبول الخطوة 10 في المتصفح: معاينة المخاطَبين بقنواتهم، إرسال، وتفصيل لكل رسالة حال.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/notify.cjs [مجلد الصور]
 */
const { RUN, call, login, setupUsers, approvedFamily, run } = require('./lib.cjs');

run(async ({ step, shot, newPage }) => {
  const { tokens, names } = await setupUsers([['researcher', 'FIELD_RESEARCHER', 'باحث ميداني'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف المستفيدين'], ['manager', 'DISTRIBUTION_MANAGER', 'مدير التوزيع']]);
  await approvedFamily(tokens, { name: 'سعاد كريم عبد الله الدليمي', nid: `1975${RUN}01`, phone: '07701234567' });
  await approvedFamily(tokens, { name: 'رعد شاكر محمود الفهداوي', nid: `1975${RUN}02`, phone: '07801234567' });
  await approvedFamily(tokens, { name: 'نور ياسين محمود الجميلي', nid: `1975${RUN}03` });
  const page = await newPage();

  await step('المعاينة تعدّ المخاطَبين بقنواتهم وتعرض الرسالة باسم حقيقي، وتنبّه أن الإرسال محاكاة', async () => {
    await login(page, names.supervisor);
    await page.getByRole('link', { name: 'التنبيهات' }).click();
    await page.getByLabel('النص').fill('السلام عليكم {الاسم}. يفتح المركز أبوابه السبت.');
    await page.getByText('وضع المحاكاة: الرسائل تُسجَّل ولا تصل إلى أي هاتف').waitFor();
    await page.getByText('3 عائلة', { exact: true }).waitFor();
    await page.getByText('2 واتساب، 1 بلا هاتف').waitFor();
    await page.getByText('السلام عليكم سعاد كريم عبد الله الدليمي. يفتح المركز أبوابه السبت.').waitFor();
    await shot(page, '21-notify');
  });

  await step('المتغير المجهول يمنع الإرسال برسالة تسمّيه', async () => {
    await page.getByLabel('النص').fill('مرحباً {العنوان} وأهلاً بكم');
    await page.getByText('متغيرات لا يعرفها النظام: {العنوان}').waitFor();
    await page.getByLabel('النص').fill('السلام عليكم {الاسم}. يفتح المركز أبوابه السبت.');
    await page.getByText('3 عائلة', { exact: true }).waitFor();
  });

  await step('الإرسال بعد تأكيد، ولكل رسالة حال معلومة', async () => {
    await page.getByLabel('عنوان الإرسال').fill('إعلان الدوام');
    await page.getByRole('button', { name: 'أرسل إلى 3 عائلة' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'أرسل الآن' }).click();
    await page.getByText('خرجت 3 رسالة').waitFor();
    await page.getByRole('button', { name: 'إعلان الدوام' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('منها واتساب').waitFor();
    await dialog.getByRole('link', { name: /نور ياسين/ }).waitFor();
    await shot(page, '22-notify-detail');
  });
});
