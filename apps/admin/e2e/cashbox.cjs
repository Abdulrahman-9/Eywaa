/**
 * معيار قبول الخطوة 12 في المتصفح: قبض، صرف لا يثبت إلا باعتماد غيره، عهدة تُقفل بعجزها، وميزان متوازن.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/cashbox.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const { login, setupUsers, run } = require('./lib.cjs');

run(async ({ step, shot, newPage }) => {
  const { names } = await setupUsers([['accountant', 'ACCOUNTANT', 'المحاسب'], ['distributor', 'DISTRIBUTOR', 'موظف توزيع']]);
  const acc = await newPage();
  const admin = await newPage();

  await step('المحاسب يسجّل سند قبض فيزيد نقد الصندوق', async () => {
    await login(acc, names.accountant);
    await acc.getByRole('link', { name: 'الصندوق والمحاسبة' }).click();
    await acc.getByRole('button', { name: 'سند قبض' }).click();
    const d = acc.getByRole('dialog');
    await d.getByLabel('الصندوق', { exact: true }).selectOption({ index: 1 });
    await d.getByLabel('المبلغ بالدينار').fill('5000000');
    await d.getByLabel('من').fill('متبرع 31');
    await d.getByLabel('البيان').fill('تبرع نقدي غير مقيَّد');
    await d.getByRole('button', { name: 'سجّل' }).click();
    await acc.getByText('سُجّل القيد ق-1').waitFor();
    await acc.getByRole('row', { name: /الصندوق العام/ }).getByRole('cell', { name: '5,000,000' }).first().waitFor();
  });

  await step('سند الصرف لا ينقص النقد حتى يعتمده غيره', async () => {
    await acc.getByRole('button', { name: 'سند صرف' }).click();
    const d = acc.getByRole('dialog');
    await d.getByLabel('الصندوق', { exact: true }).selectOption({ index: 1 });
    await d.getByLabel('المبلغ بالدينار').fill('960000');
    await d.getByLabel('إلى').fill('تاجر الجملة');
    await d.getByLabel('البيان').fill('شراء 320 عبوة زيت');
    await d.getByLabel('باب الصرف').fill('مشتريات');
    await d.getByRole('button', { name: 'سجّل' }).click();
    await acc.getByText('سجّلتَه أنت: يعتمده غيرك').waitFor();
    await acc.getByRole('row', { name: /الصندوق العام/ }).getByRole('cell', { name: '5,000,000' }).first().waitFor();

    await login(admin, 'admin', process.env.ADMIN_PASSWORD);
    await admin.getByRole('link', { name: 'الصندوق والمحاسبة' }).click();
    await admin.getByRole('button', { name: 'اعتماد', exact: true }).click();
    await admin.getByRole('dialog').getByText('960,000 دينار').waitFor();
    await admin.getByRole('dialog').getByRole('button', { name: 'اعتماد القيد' }).click();
    await admin.getByText('اعتُمد القيد وثبت').waitFor();
    await admin.getByRole('row', { name: /الصندوق العام/ }).getByRole('cell', { name: '4,040,000' }).first().waitFor();
  });

  await step('العهدة تُسلَّم ثم تُقفل بعجز يظهر قبل الإقفال', async () => {
    await acc.reload();
    await acc.getByRole('button', { name: 'تسليم عهدة' }).click();
    let d = acc.getByRole('dialog');
    await d.getByLabel('الصندوق', { exact: true }).selectOption({ index: 1 });
    await d.getByLabel('المبلغ بالدينار').fill('500000');
    await d.getByLabel('أمين الصندوق').selectOption({ label: 'موظف توزيع' });
    await d.getByRole('button', { name: 'سجّل' }).click();
    await acc.getByRole('button', { name: 'أقفلها' }).click();
    d = acc.getByRole('dialog');
    await d.getByLabel('النقد الفعلي بعد العدّ').fill('495000');
    await d.getByText('عجز 5,000 دينار').waitFor();
    await shot(acc, '25-custody-close');
    await d.getByRole('button', { name: 'أقفل بالعجز' }).click();
    await acc.getByText('أُقفلت بعجز 5,000 ينتظر الاعتماد').waitFor();
    await acc.getByText('عجز عهدة').first().waitFor();
  });

  await step('ميزان المراجعة متوازن، والقيد يُعكس ولا يُحذف', async () => {
    await acc.getByText('متوازن', { exact: true }).waitFor();
    await acc.getByRole('button', { name: 'اعكسه' }).first().click();
    const d = acc.getByRole('dialog');
    await d.getByText('القيد لا يُحذف').waitFor();
    assert.equal(await d.getByRole('button', { name: 'سجّل قيد العكس' }).isDisabled(), true);
    await d.getByRole('button', { name: 'إلغاء' }).click();
    await shot(acc, '26-cashbox');
  });
});
