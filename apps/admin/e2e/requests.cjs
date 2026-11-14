/**
 * طلب التسجيل السريع في المتصفح: يُسجَّل بالاسم وحده، يُنبَّه إن شابه مسجَّلاً، يُدعى صاحبه أو تُسند زيارته،
 * ثم يُستكمل باستمارة كاملة فيُغلق بعائلتها.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/requests.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const { RUN, call, login, setupUsers, approvedFamily, run } = require('./lib.cjs');

run(async ({ step, shot, newPage }) => {
  const { tokens, names } = await setupUsers([['researcher', 'FIELD_RESEARCHER', 'الباحث سامر'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف المستفيدين']]);
  const existing = await approvedFamily(tokens, { name: 'سلمى حاتم مزهر الدليمي', nid: `1983${RUN}01` });
  const sup = await newPage();
  await login(sup, names.supervisor);

  await step('طلب بالاسم وحده يُسجَّل ويأخذ رقماً', async () => {
    await sup.getByRole('link', { name: 'طلبات التسجيل' }).click();
    await sup.getByRole('button', { name: 'طلب سريع جديد' }).click();
    const d = sup.getByRole('dialog');
    assert.equal(await d.getByRole('button', { name: 'سجّل الطلب' }).isDisabled(), true);
    await d.getByLabel('اسم رب الأسرة').fill('جبار كاظم حسون الشمري');
    await d.getByRole('button', { name: 'سجّل الطلب' }).click();
    await sup.getByText(/سُجّل الطلب \d+/).waitFor();
    await sup.getByText('الاسم وحده').waitFor();
  });

  await step('اسم يشبه مسجَّلاً: يُنبَّه بالعائلة التي تحمله', async () => {
    await sup.getByRole('button', { name: 'طلب سريع جديد' }).click();
    const d = sup.getByRole('dialog');
    await d.getByLabel('اسم رب الأسرة').fill('سلمي حاتم مزهر الدليمى');
    await d.getByLabel('الهاتف (اختياري)').fill('07701230099');
    await d.getByLabel('عدد الأفراد (اختياري)').fill('5');
    await d.getByRole('button', { name: 'سجّل الطلب' }).click();
    await sup.getByText('قد يكون مسجَّلاً من قبل.').waitFor();
    await sup.getByRole('link', { name: `العائلة ${existing.familyNo}` }).waitFor();
    await shot(sup, '52-quick-requests');
  });

  await step('الدعوة برسالة لمن له هاتف، والزيارة تُسند لباحث', async () => {
    const withPhone = sup.locator('[data-quick]', { hasText: 'سلمي حاتم مزهر الدليمى' }).first();
    const noPhone = sup.locator('[data-quick]', { hasText: 'جبار كاظم حسون الشمري' }).first();
    assert.equal(await noPhone.getByRole('button', { name: 'ادعُه برسالة' }).isDisabled(), true);
    await withPhone.getByRole('button', { name: 'ادعُه برسالة' }).click();
    await sup.getByText('دُعي سلمي حاتم مزهر الدليمى للحضور').waitFor();
    await withPhone.getByText('دُعي للحضور').waitFor();
    await noPhone.getByRole('button', { name: 'أسند زيارة' }).click();
    await sup.getByRole('dialog').getByLabel('الباحث').selectOption({ label: 'الباحث سامر' });
    await sup.getByRole('dialog').getByRole('button', { name: 'أسند الزيارة' }).click();
    await noPhone.getByText('يزوره الباحث سامر').waitFor();
  });

  await step('الباحث يستكمله باستمارة كاملة تبدأ باسمه، فيُغلق الطلب بعائلته', async () => {
    const res = await newPage();
    await login(res, names.researcher);
    await res.getByRole('link', { name: 'طلبات التسجيل' }).click();
    await res.locator('[data-quick]', { hasText: 'جبار كاظم حسون الشمري' }).first().getByRole('button', { name: 'استكمل التسجيل' }).click();
    await res.getByRole('heading', { name: /استكمال طلب التسجيل \d+/ }).waitFor();
    assert.equal(await res.getByLabel('الاسم الرباعي واللقب').inputValue(), 'جبار كاظم حسون الشمري');
    await res.getByLabel('رقم البطاقة (12 خانة)').fill(`1984${RUN}02`);
    await res.getByText('الوثيقة غير مسجَّلة من قبل.').waitFor();
    for (let i = 0; i < 4; i++) await res.getByRole('button', { name: 'التالي' }).click();
    await res.getByRole('button', { name: /احفظ|سجّل العائلة/ }).click();
    await res.getByRole('heading', { name: /سُجّلت العائلة \d+/ }).waitFor();
    const done = await call('/quick-requests?status=COMPLETED', tokens.supervisor);
    assert.equal(done.length, 1);
    assert.equal(done[0].headName, 'جبار كاظم حسون الشمري');
    assert.ok(done[0].familyNo);
  });

  await step('الطلب الذي ظهر أن صاحبه مسجَّل يُصرف بسببه', async () => {
    await sup.reload();
    await sup.getByRole('button', { name: 'اصرف الطلب' }).click();
    await sup.getByRole('dialog').getByRole('textbox').fill('مسجَّلة سلفاً في العائلة المذكورة');
    await sup.getByRole('dialog').getByRole('button', { name: 'اصرف الطلب' }).click();
    await sup.getByText('صُرف الطلب').waitFor();
    await sup.getByText('لا طلبات في هذا العرض.').waitFor();
  });
});
