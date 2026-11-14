/**
 * معيار قبول الخطوة 13 في المتصفح: محاولة صرف دفعة لمرحلة غير معتمدة تُمنع؛ ولا يعتمد الصرف من تحقق بنفسه.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/housing.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const { RUN, call, login, setupUsers, approvedFamily, run } = require('./lib.cjs');

run(async ({ step, shot, newPage }) => {
  const { tokens, names } = await setupUsers([
    ['researcher', 'FIELD_RESEARCHER', 'باحث ميداني'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف المستفيدين'],
    ['projects', 'PROJECT_SUPERVISOR', 'مشرف المشاريع'], ['accountant', 'ACCOUNTANT', 'المحاسب'],
  ]);
  const fam = await approvedFamily(tokens, { name: 'آمنة يوسف صالح العلواني', nid: `1975${RUN}01`, housing: 'OTHER' });
  const fund = await call('/accounting/funds', tokens.accountant, { name: 'صندوق بناء المنازل' });
  await call('/accounting/receipts', tokens.accountant, { fundId: fund.id, amount: 30000000, party: 'متبرع 9', description: 'لبناء المنازل' });
  const sup = await newPage();
  const acc = await newPage();

  await step('مشرف المشاريع ينشئ المشروع بمتعهده ومراحله', async () => {
    await login(sup, names.projects);
    await sup.getByRole('link', { name: 'بناء المنازل' }).click();
    await sup.getByRole('button', { name: 'مشروع جديد' }).click();
    const d = sup.getByRole('dialog');
    await d.getByLabel('رقم العائلة').fill(fam.familyNo);
    await d.getByText('آمنة يوسف صالح العلواني').waitFor();
    await d.getByLabel('موقع البناء').fill('النزال، قرب الجامع');
    await d.getByLabel('متعهد جديد').fill('جاسم محمد خلف الجميلي');
    await d.getByRole('button', { name: 'أضف المتعهد' }).click();
    await d.getByLabel('المتعهد', { exact: true }).locator('option', { hasText: 'جاسم محمد' }).waitFor({ state: 'attached' });
    await d.getByLabel('يُصرف من صندوق').selectOption({ label: 'صندوق بناء المنازل (المتاح 30,000,000)' });
    for (const [i, amount] of ['6000000', '12000000', '4800000', '1200000'].entries()) await d.getByLabel(`دفعة المرحلة ${i + 1}`).fill(amount);
    await d.getByText('24,000,000').waitFor();
    await d.getByRole('button', { name: 'أنشئ المشروع' }).click();
    await sup.getByText('هذا المشروع أنشأتَه أنت').waitFor();
    assert.equal(await sup.getByRole('button', { name: 'اعتماد المشروع' }).count(), 0);
  });

  await step('المحاسب يعتمد المشروع فتُحجز ميزانيته', async () => {
    await login(acc, names.accountant);
    await acc.getByRole('link', { name: 'بناء المنازل' }).click();
    await acc.getByRole('link', { name: /منزل العائلة/ }).click();
    await acc.getByRole('button', { name: 'اعتماد المشروع' }).click();
    await acc.getByText('اعتُمد المشروع وحُجزت ميزانيته').waitFor();
    await acc.getByText('جارٍ', { exact: true }).waitFor();
  });

  await step('لا زرّ صرف قبل زيارة التحقق، والتنبيه ظاهر', async () => {
    await sup.reload();
    await sup.getByRole('button', { name: 'طلب المتعهد صرفها' }).click();
    let d = sup.getByRole('dialog');
    await d.getByLabel('السبب (لازم)').fill('قال المتعهد إن الأساس تمّ ورفع صوره');
    await d.getByRole('button', { name: 'سجّل الطلب' }).click();
    await sup.getByText('لا تُصرف دفعة مرحلة لم تُسجَّل لها زيارة تحقق').waitFor();
    await acc.reload();
    await acc.getByText('تنتظر زيارة تحقق').waitFor();
    assert.equal(await acc.getByRole('button', { name: 'اعتمد واصرف الدفعة' }).count(), 0);
    await shot(sup, '27-housing-claimed');
  });

  await step('من سجّل الزيارة لا يرى زرّ الصرف، ويراه غيره', async () => {
    await sup.getByRole('button', { name: 'سجّل زيارة التحقق' }).click();
    const d = sup.getByRole('dialog');
    await d.getByLabel('السبب (لازم)').fill('زرت الموقع: الأساس مصبوب ومطابق للمخطط');
    await d.getByRole('button', { name: 'سجّل زيارة التحقق' }).click();
    await sup.getByText('تحققتَ منها أنت: يعتمد الصرف موظف آخر').waitFor();
    assert.equal(await sup.getByRole('button', { name: 'اعتمد واصرف الدفعة' }).count(), 0);
  });

  await step('المحاسب يعتمد فتُصرف الدفعة بسند، وتنتقل الحدود إلى المرحلة التالية', async () => {
    await acc.reload();
    await acc.getByRole('button', { name: 'اعتمد واصرف الدفعة' }).click();
    const d = acc.getByRole('dialog');
    await d.getByText('6,000,000 دينار').waitFor();
    await d.getByRole('button', { name: 'اعتمد واصرف' }).click();
    await acc.getByText('اعتُمدت المرحلة وصُرفت دفعتها').waitFor();
    await acc.getByText(/سند ص-1/).waitFor();
    await acc.getByText('صُرف 6,000,000 من 24,000,000 دينار (25%)').waitFor();
    await shot(acc, '28-housing');
    await acc.getByRole('link', { name: 'الصندوق والمحاسبة' }).click();
    await acc.getByRole('row', { name: /صندوق بناء المنازل/ }).getByRole('cell', { name: '18,000,000' }).waitFor();
  });
});
