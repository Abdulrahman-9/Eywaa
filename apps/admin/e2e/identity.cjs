/**
 * هوية الأحوال القديمة في المتصفح: السجل والرقم معاً يمنعان، والرقم نفسه بسجل آخر ينبّه أثناء الكتابة،
 * وإن تشابه الاسم عُلّق السجل وظهر للمشرف بسببه؛ والبحث برقم الهوية وحده يجد حامليه.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/identity.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const { BASE, RUN, call, login, setupUsers, run } = require('./lib.cjs');

run(async ({ step, shot, newPage }) => {
  const { tokens, names } = await setupUsers([['researcher', 'FIELD_RESEARCHER', 'باحث'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف المستفيدين']]);
  const number = `77${RUN}`;
  const mk = (fullName, register) => call('/families', tokens.researcher, { tags: ['NEEDY'], housing: 'RENTED', incomes: [], proxies: [],
    members: [{ relation: 'HEAD', fullName, gender: 'M', documents: [{ type: 'CIVIL_ID', number, register, page: '10' }] }] });
  const first = await mk('حامد سلمان داود العاني', '45');
  await mk('ماجد فرحان عبيد الكبيسي', '78');
  const page = await newPage();
  await login(page, names.researcher);

  await step('السجل والرقم نفساهما يمنعان، ولو كُتبا بصفر وبصفحة أخرى', async () => {
    await page.getByRole('link', { name: 'العوائل' }).click();
    await page.getByRole('link', { name: 'تسجيل عائلة' }).click();
    await page.getByLabel('نوع الوثيقة').selectOption('CIVIL_ID');
    await page.getByLabel('الرقم', { exact: true }).fill(`00${number}`);
    await page.getByLabel('السجل').fill('045');
    await page.getByLabel('الصفحة').fill('999');
    await page.getByText('هذه الوثيقة مسجَّلة سلفاً.').waitFor();
    await page.getByText(`هي للعائلة ${first.familyNo}`).waitFor();
  });

  await step('الرقم نفسه بسجل قريب: تنبيه أثناء الكتابة بمن يحمله، ولا يُمنع', async () => {
    await page.getByLabel('السجل').fill('54');
    await page.getByText('الرقم نفسه مسجَّل بسجل آخر.').waitFor();
    await page.getByText('«حامد سلمان داود العاني»').waitFor();
    await page.getByText('قريب مما كتبتَ: تحقق من الرقم في الوثيقة').waitFor();
    await page.getByText('«ماجد فرحان عبيد الكبيسي»').waitFor();
    assert.equal(await page.getByText('هذه الوثيقة مسجَّلة سلفاً.').count(), 0);
    await shot(page, '48-same-number');
  });

  await step('إن تشابه الاسم عُلّق السجل، والمشرف يرى السبب بالسجلّين', async () => {
    const res = await mk('حامد سلمان داود', '54');
    assert.equal(res.status, 'PENDING_DEDUPE_REVIEW');
    const sup = await newPage();
    await login(sup, names.supervisor);
    await sup.goto(`${BASE}/review?tab=flags`);
    await sup.getByText(/رقم الهوية نفسه والسجل مختلف \(54 هنا، 45 هناك\)/).first().waitFor();
    await sup.getByText(/السجلان متقاربان كتابةً: يُحتمل خطأ في الإدخال/).first().waitFor();
    await shot(sup, '49-same-number-flag');
  });

  await step('البحث برقم الهوية وحده يجد كل من يحمله', async () => {
    await page.goto(`${BASE}/families`);
    await page.getByLabel('بحث').fill(number);
    await page.getByText('حامد سلمان داود العاني').waitFor();
    await page.getByText('ماجد فرحان عبيد الكبيسي').waitFor();
    await page.getByText('حامد سلمان داود', { exact: true }).waitFor();
    assert.equal(await page.locator('tbody tr').count(), 3);
  });
});
