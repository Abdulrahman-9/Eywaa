/**
 * معيار قبول الخطوة 5: إضافة برنامج جديد كامل من اللوحة دون تعديل برمجي، ويُحسب مستحقوه.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/programs.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const { BASE, RUN, login, setupUsers, approvedFamily, run } = require('./lib.cjs');

run(async ({ step, shot, newPage }) => {
  const { tokens, names } = await setupUsers([['researcher', 'FIELD_RESEARCHER', 'باحث ميداني'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف المستفيدين']]);
  const widow = await approvedFamily(tokens, { name: 'سعاد كريم عبد الله الدليمي', nid: `1975${RUN}01`, tags: ['WIDOW', 'ORPHANS'], kids: 3, orphans: true });
  await approvedFamily(tokens, { name: 'رعد شاكر محمود الفهداوي', nid: `1975${RUN}02`, kids: 8, income: 400000 });
  const rich = await approvedFamily(tokens, { name: 'طارق وليد ناصر الزوبعي', nid: `1975${RUN}03`, housing: 'OWNED', income: 900000 });
  const page = await newPage();

  await step('المدير ينشئ برنامج السلة بشروطه وشرائحه، ويرى عدد المستحقين قبل الحفظ', async () => {
    await login(page, 'admin', process.env.ADMIN_PASSWORD);
    await page.getByRole('link', { name: 'البرامج' }).click();
    await page.getByText('لا برامج بعد').waitFor();
    await page.getByRole('button', { name: 'برنامج جديد' }).click();
    await page.getByLabel('اسم البرنامج').fill('السلة الغذائية الشهرية');
    await page.getByLabel('أقل فاصل بين عطاءين').fill('25');
    await page.getByText('3 عائلة تستحق الآن').waitFor();
    await page.getByLabel('دخل الفرد دون خط الفقر').check();
    await page.getByText('2 عائلة تستحق الآن').waitFor();
    await page.getByLabel('طريقة المقدار').selectOption('BY_SIZE');
    await page.getByText('وحاجتها 4 سلة').waitFor();
    await shot(page, '14-program');
    await page.getByRole('button', { name: 'أنشئ البرنامج' }).click();
    await page.getByText('أُنشئ البرنامج').waitFor();
    await page.getByText('يستحقه الآن 2 عائلة، وحاجتها 4 سلة').waitFor();
  });

  await step('برنامج مالي لكل يتيم: يستحقه من فيها يتيم فقط', async () => {
    await page.getByRole('button', { name: 'برنامج جديد' }).click();
    await page.getByLabel('اسم البرنامج').fill('كفالة الأيتام');
    await page.getByLabel('نوعه').selectOption('MONEY');
    await page.getByLabel('وحدة المقدار').fill('دينار');
    await page.getByLabel('فيها يتيم').check();
    await page.getByLabel('طريقة المقدار').selectOption('PER_ORPHAN');
    await page.getByLabel('المقدار (دينار)').fill('50000');
    await page.getByText('1 عائلة تستحق الآن').waitFor();
    await page.getByText('وحاجتها 150,000 دينار').waitFor();
    await page.getByRole('button', { name: 'أنشئ البرنامج' }).click();
    await page.getByText('50,000 دينار لكل يتيم').waitFor();
  });

  await step('ملف العائلة يعرض ما تستحقه، وسبب ما لا تستحقه', async () => {
    await page.goto(`${BASE}/families/${widow.id}`);
    await page.getByRole('heading', { name: 'يستحق الآن' }).waitFor();
    await page.getByText('150,000 دينار').waitFor();
    await page.getByText('1 سلة').waitFor();
    await page.goto(`${BASE}/families/${rich.id}`);
    await page.getByText('دخل الفرد ليس دون خط الفقر').waitFor();
    await page.getByText('لا يتيم فيها').waitFor();
    await shot(page, '15-entitlements');
  });

  await step('تعديل الشروط يغيّر المستحقين، والمشرف يرى ولا يعدّل', async () => {
    await page.getByRole('link', { name: 'البرامج' }).click();
    await page.getByRole('button', { name: 'تعديل' }).first().click();
    await page.getByRole('group', { name: 'الفئة هي إحدى' }).getByLabel('أ', { exact: true }).check();
    await page.getByText('1 عائلة تستحق الآن').waitFor();
    await page.getByRole('button', { name: 'احفظ التعديل' }).click();
    await page.getByText('يستحقه الآن 1 عائلة، وحاجتها 1 سلة').waitFor();
    const sup = await newPage();
    await login(sup, names.supervisor);
    await sup.getByRole('link', { name: 'البرامج' }).click();
    await sup.getByText('كفالة الأيتام').waitFor();
    assert.equal(await sup.getByRole('button', { name: 'برنامج جديد' }).count(), 0);
    assert.equal(await sup.getByRole('button', { name: 'تعديل' }).count(), 0);
  });
});
