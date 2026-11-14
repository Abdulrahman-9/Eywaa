/**
 * التنبيه الفردي في المتصفح: من ملف العائلة، بمعاينة النص باسمها قبل الإرسال، ثم ظهوره في رسائلها.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/message.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const { BASE, RUN, call, login, setupUsers, approvedFamily, run } = require('./lib.cjs');

run(async ({ step, shot, newPage }) => {
  const { tokens, names } = await setupUsers([['researcher', 'FIELD_RESEARCHER', 'باحث'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف المستفيدين']]);
  const fam = await approvedFamily(tokens, { name: 'بشرى طه ياسين الهيتي', nid: `1981${RUN}01`, phone: `0770${RUN}1` });
  const silent = await approvedFamily(tokens, { name: 'عائلة بلا هاتف', nid: `1981${RUN}02` });
  const page = await newPage();
  await login(page, names.supervisor);

  await step('المشرف ينبّه عائلة بعينها ويرى النص باسمها قبل الإرسال', async () => {
    await page.goto(`${BASE}/families/${fam.id}`);
    await page.getByText('لم يُرسل إلى هذه العائلة شيء.').waitFor();
    await page.getByRole('button', { name: 'نبّه هذه العائلة' }).click();
    const d = page.getByRole('dialog');
    assert.equal(await d.getByRole('button', { name: 'أرسل' }).isDisabled(), true);
    await d.getByLabel('العنوان (لا يصل العائلة؛ للسجل)').fill('استدعاء لاستكمال وثيقة');
    await d.getByLabel('نص الرسالة').fill('السلام عليكم {الاسم}. نرجو مراجعة المركز يوم الأحد. رقم العائلة: {رقم_العائلة}');
    await d.getByText(`السلام عليكم بشرى طه ياسين الهيتي. نرجو مراجعة المركز يوم الأحد. رقم العائلة: ${fam.familyNo}`).waitFor();
    await d.getByText('المزوّد محاكاة').waitFor();
    await shot(page, '42-message');
    await d.getByRole('button', { name: 'أرسل' }).click();
    await page.getByText('سُجّل التنبيه (المزوّد محاكاة: لا يصل إلى الهاتف)').waitFor();
  });

  await step('الرسالة تظهر في ملف العائلة بحالها وقناتها، ولا تظهر عند غيرها', async () => {
    await page.getByRole('heading', { name: 'الرسائل' }).waitFor();
    await page.getByText('استدعاء لاستكمال وثيقة').waitFor();
    await page.getByText('خرجت', { exact: true }).waitFor();
    assert.equal((await call(`/families/${fam.id}/messages`, tokens.supervisor)).length, 1);
    assert.equal((await call(`/families/${silent.id}/messages`, tokens.supervisor)).length, 0);
  });

  await step('من لا هاتف له لا يُنبَّه، والباحث لا يرى الرسائل', async () => {
    await page.goto(`${BASE}/families/${silent.id}`);
    await page.getByText('لا رقم هاتف لهذه العائلة').waitFor();
    assert.equal(await page.getByRole('button', { name: 'نبّه هذه العائلة' }).isDisabled(), true);
    const other = await newPage();
    await login(other, names.researcher);
    await other.goto(`${BASE}/families/${fam.id}`);
    await other.getByRole('heading', { name: 'إعادة التقييم' }).waitFor();
    assert.equal(await other.getByRole('heading', { name: 'الرسائل' }).count(), 0);
  });
});
