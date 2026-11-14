/**
 * إعادة التقييم عند الطلب في المتصفح: يفتحها المشرف ويسندها، يراها الباحث في قائمته فيسجّل الزيارة،
 * ولا تُعتمد وطلب تعديلها معلّق، ثم يعتمدها المشرف.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/reassess.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const { BASE, RUN, call, login, setupUsers, approvedFamily, run } = require('./lib.cjs');

run(async ({ step, shot, newPage }) => {
  const { tokens, names } = await setupUsers([
    ['researcher', 'FIELD_RESEARCHER', 'الباحث سامر'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف المستفيدين'],
  ]);
  const fam = await approvedFamily(tokens, { name: 'خولة ناظم رشيد السامرائي', nid: `1979${RUN}01`, income: 400000 });
  const sup = await newPage();
  const res = await newPage();
  await login(sup, names.supervisor);
  await login(res, names.researcher);

  await step('المشرف يفتح الطلب بسببه ويسنده إلى باحث', async () => {
    await sup.goto(`${BASE}/families/${fam.id}`);
    await sup.getByText('لم يُطلب لهذه العائلة إعادة تقييم.').waitFor();
    await sup.getByRole('button', { name: 'افتح طلب إعادة تقييم' }).click();
    const d = sup.getByRole('dialog');
    assert.equal(await d.getByRole('button', { name: 'افتح الطلب' }).isDisabled(), true);
    await d.getByLabel('السبب (لازم)').fill('توفي معيلها وانقطع دخلها');
    await d.getByLabel('من يزورها؟').selectOption({ label: 'الباحث سامر' });
    await d.getByRole('button', { name: 'افتح الطلب' }).click();
    await sup.getByText('فُتح طلب إعادة التقييم').waitFor();
    await sup.getByText('تنتظر الزيارة').waitFor();
    assert.equal(await sup.getByRole('button', { name: 'افتح طلب إعادة تقييم' }).count(), 0, 'للعائلة طلب قائم واحد');
  });

  await step('الباحث يجدها في «زيارات مطلوبة» ويسجّل ما رآه', async () => {
    await res.getByRole('link', { name: 'العوائل' }).click();
    await res.getByRole('heading', { name: 'زيارات إعادة تقييم مطلوبة (1)' }).waitFor();
    await shot(res, '39-visits-todo');
    await res.getByRole('link', { name: 'خولة ناظم رشيد السامرائي' }).first().click();
    await res.getByRole('button', { name: 'سجّل الزيارة' }).click();
    const d = res.getByRole('dialog');
    await d.getByLabel('ما وجدتَه في الزيارة').fill('المعيل توفي في أيلول. لا دخل للعائلة الآن.');
    await d.getByLabel('النتيجة').selectOption('CHANGED');
    await d.getByText('تسجيل الزيارة لا يغيّر بيانات العائلة').waitFor();
    await shot(res, '40-visit');
    await d.getByRole('button', { name: 'سجّل الزيارة' }).click();
    await res.getByText('سُجّلت الزيارة. يعتمدها موظف غيرك.').waitFor();
    await res.getByText('زِيرت: تنتظر الاعتماد').waitFor();
    assert.equal(await res.getByRole('button', { name: 'اعتمد الزيارة' }).count(), 0, 'الباحث لا يعتمد');
  });

  let changeId;
  await step('لا تُعتمد الزيارة وطلب تعديلها معلّق', async () => {
    changeId = (await call(`/families/${fam.id}/changes`, tokens.researcher, { type: 'SET_INCOMES', payload: { incomes: [] }, reason: 'انقطع الدخل بوفاة المعيل' })).id;
    await sup.getByRole('link', { name: 'الاعتماد والشبهات' }).click();
    await sup.getByRole('tab', { name: /إعادة التقييم/ }).or(sup.getByRole('button', { name: /إعادة التقييم/ })).first().click();
    await sup.getByText('تغيّرت حالها.').waitFor();
    await shot(sup, '41-visit-review');
    await sup.getByRole('button', { name: 'اعتمد الزيارة' }).click();
    await sup.getByRole('dialog').getByRole('button', { name: 'اعتمد الزيارة' }).click();
    await sup.getByRole('dialog').getByText('طلب تعديل معلّق').waitFor();
    await sup.getByRole('dialog').getByRole('button', { name: 'إلغاء' }).click();
  });

  await step('بعد الفصل في التعديل يعتمدها المشرف، فتُغلق وتُعاد نقاط العائلة', async () => {
    const before = (await call(`/families/${fam.id}/score`, tokens.supervisor)).points;
    await call(`/changes/${changeId}/approve`, tokens.supervisor, {});
    await sup.getByRole('button', { name: 'اعتمد الزيارة' }).click();
    await sup.getByRole('dialog').getByRole('button', { name: 'اعتمد الزيارة' }).click();
    await sup.getByText('اعتُمدت الزيارة وأُغلق الطلب').waitFor();
    await sup.getByText('لا طلبات إعادة تقييم قائمة.').waitFor();
    const after = (await call(`/families/${fam.id}/score`, tokens.supervisor)).points;
    assert.ok(after > before, `النقاط ارتفعت بانقطاع الدخل: ${before} ← ${after}`);
    await sup.goto(`${BASE}/families/${fam.id}`);
    await sup.getByText('اعتُمدت', { exact: true }).waitFor();
    await sup.getByRole('button', { name: 'افتح طلب إعادة تقييم' }).waitFor();
  });
});
