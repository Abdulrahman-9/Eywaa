/**
 * أحداث العائلة في متصفح حقيقي: تغيير رب الأسرة، نقل فرد إلى عائلة أخرى، وبطاقة العائلة المطبوعة.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/events.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const { RUN, call, login, setupUsers, run } = require('./lib.cjs');

const nid = (n) => `1966${RUN}${String(n).padStart(2, '0')}`;

run(async ({ step, shot, newPage }) => {
  const { tokens, names } = await setupUsers([
    ['researcher', 'FIELD_RESEARCHER', 'باحث'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف المستفيدين'],
  ]);
  const make = async (members) => {
    const f = await call('/families', tokens.researcher, { tags: ['NEEDY'], housing: 'RENTED', address: { mahalla: 'الجولان' }, members, incomes: [], proxies: [{ fullName: 'خال الأولاد سعد' }] });
    return call(`/families/${f.id}/approve`, tokens.supervisor, {});
  };
  const a = await make([
    { relation: 'HEAD', fullName: 'كاظم جواد حسن العاني', gender: 'M', documents: [{ type: 'NATIONAL_CARD', number: nid(1) }] },
    { relation: 'SPOUSE', fullName: 'نجلاء فاضل عباس', gender: 'F', documents: [{ type: 'NATIONAL_CARD', number: nid(2) }] },
    { relation: 'DAUGHTER', fullName: 'شهد كاظم جواد', gender: 'F', documents: [] },
  ]);
  const b = await make([{ relation: 'HEAD', fullName: 'ليث عامر صبحي الكبيسي', gender: 'M', documents: [{ type: 'NATIONAL_CARD', number: nid(3) }] }]);

  const page = await newPage();
  await login(page, names.researcher);
  const sup = await newPage();
  await login(sup, names.supervisor);
  const ask = async (type, fill, reason) => {
    await page.goto(`${process.env.BASE_URL ?? 'http://localhost:4173'}/families/${a.id}`);
    await page.getByRole('button', { name: 'طلب تعديل' }).click();
    await page.getByLabel('ما الذي تعدّله؟').selectOption({ label: type });
    await fill();
    await page.getByLabel('سبب التعديل (لازم)').fill(reason);
  };
  const approve = async (line) => {
    await sup.goto(`${process.env.BASE_URL ?? 'http://localhost:4173'}/review?tab=changes`);
    await sup.getByText(line).waitFor();
    await sup.getByRole('button', { name: 'اعتماد التعديل' }).click();
    await sup.getByRole('dialog').getByRole('button', { name: /اعتم/ }).click();
    await sup.getByText('اعتُمد التعديل وسرى').waitFor();
  };

  await step('طلب تغيير رب الأسرة: لا يُعرض للاختيار إلا الأحياء من غير رب الأسرة', async () => {
    await ask('تغيير رب الأسرة', async () => {
      const options = await page.getByLabel('رب الأسرة الجديد').locator('option').allTextContents();
      assert.deepEqual(options, ['نجلاء فاضل عباس', 'شهد كاظم جواد']);
      await page.getByLabel('رب الأسرة الجديد').selectOption({ label: 'نجلاء فاضل عباس' });
      await page.getByLabel('صلة رب الأسرة السابق بالجديد').selectOption({ label: 'الزوج/الزوجة' });
    }, 'سفر رب الأسرة');
    await shot(page, '34-change-head');
    await page.getByRole('button', { name: 'أرسل للاعتماد' }).click();
    await page.getByText('أُرسل طلب التعديل إلى الاعتماد').waitFor();
  });

  await step('المشرف يرى الطلب باسم الرب الجديد ويعتمده، فيتبدّل عنوان الملف', async () => {
    await approve('رب الأسرة الجديد: نجلاء فاضل عباس');
    await sup.goto(`${process.env.BASE_URL ?? 'http://localhost:4173'}/families/${a.id}`);
    await sup.getByRole('heading', { level: 1, name: 'نجلاء فاضل عباس' }).waitFor();
  });

  await step('من لا وثيقة له لا يصير رب أسرة، والرسالة تقول ما يلزم', async () => {
    await ask('تغيير رب الأسرة', async () => {
      await page.getByLabel('رب الأسرة الجديد').selectOption({ label: 'شهد كاظم جواد' });
    }, 'تجربة');
    await page.getByRole('button', { name: 'أرسل للاعتماد' }).click();
    await page.getByText('يلزم لرب الأسرة وثيقة هوية').waitFor();
    await page.getByRole('button', { name: 'إلغاء' }).click();
  });

  await step('نقل فرد إلى عائلة أخرى: يُطلب ثم يُعتمد فينتقل', async () => {
    await ask('نقل فرد إلى عائلة أخرى', async () => {
      await page.getByLabel('الفرد المنقول').selectOption({ label: 'شهد كاظم جواد' });
      await page.getByLabel('رقم العائلة المنقول إليها').fill(b.familyNo);
      await page.getByLabel('صلته برب أسرتها').selectOption({ label: 'الزوج/الزوجة' });
    }, 'زواج');
    await page.getByRole('button', { name: 'أرسل للاعتماد' }).click();
    await page.getByText('أُرسل طلب التعديل إلى الاعتماد').waitFor();
    await approve('يُنقل: شهد كاظم جواد');
    const [from, to] = await Promise.all([call(`/families/${a.id}`, tokens.supervisor), call(`/families/${b.id}`, tokens.supervisor)]);
    assert.equal(from.members.length, 2);
    assert.deepEqual(to.members.map((m) => m.fullName).sort(), ['شهد كاظم جواد', 'ليث عامر صبحي الكبيسي'].sort());
  });

  await step('بطاقة العائلة: تظهر في الطباعة وحدها، برقمها ومن يستلم عنها', async () => {
    await sup.goto(`${process.env.BASE_URL ?? 'http://localhost:4173'}/families/${a.id}`);
    await sup.getByRole('button', { name: 'اطبع البطاقة' }).waitFor();
    const card = sup.locator('article', { hasText: 'بطاقة عائلة' });
    assert.equal(await card.isVisible(), false);
    await sup.emulateMedia({ media: 'print' });
    await card.waitFor({ state: 'visible' });
    const text = await card.innerText();
    assert.ok(text.includes(a.familyNo) && text.includes('نجلاء فاضل عباس') && text.includes('خال الأولاد سعد'));
    assert.equal(await sup.getByRole('button', { name: 'اطبع البطاقة' }).isVisible(), false);
    await card.locator('svg').waitFor();
    await shot(sup, '35-family-card');
    await sup.emulateMedia({ media: 'screen' });
  });
});
