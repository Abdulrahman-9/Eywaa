/**
 * الكشف الميداني في اللوحة: المشرف يكلّف متعهدَين بكشف عوائل، يرفع كلٌّ تقريره، ثم يفصل المشرف:
 * رفع نقاط بمعاينة أثره، وشطب عائلة طلب الكاشفان شطبها، واعتماد بلا أثر. وحالة الكشف تظهر في جدول العوائل،
 * وتعديل الكشف في تفسير النقاط، والمشطوبة يعيدها غير من شطبها، وحدّ التعديل بيد المدير.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/inspections.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const { RUN, call, login, setupUsers, approvedFamily, run } = require('./lib.cjs');

const ALL = ['address', 'housing', 'members', 'head', 'income', 'orphans', 'health', 'phone'];
const match = (except = {}) => ALL.map((key) => (except[key] ? { key, result: 'MISMATCH', found: except[key] } : { key, result: 'MATCH' }));

run(async ({ step, shot, newPage }) => {
  const { tokens, names } = await setupUsers([
    ['researcher', 'FIELD_RESEARCHER', 'الباحث'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف المستفيدين'],
    ['agent', 'DISTRIBUTION_AGENT', 'أبو أحمد الحلبوسي'], ['agent2', 'DISTRIBUTION_AGENT', 'أبو علي الدليمي'],
  ]);
  const heads = ['سعاد خلف عبيد الجميلي', 'نوال حميد لطيف العزاوي', 'فاطمة رحيم كاطع الساعدي'];
  const fams = [];
  for (const [i, name] of heads.entries()) fams.push(await approvedFamily(tokens, { name, nid: `1981${RUN}0${i}`, phone: `0770555000${i}` }));
  const sup = await newPage();
  const admin = await newPage();
  let list;

  await step('المشرف يكلّف متعهدَين بكشف العوائل غير المكشوفة', async () => {
    await login(sup, names.supervisor);
    await sup.getByRole('link', { name: 'الكشف الميداني' }).click();
    assert.equal(await sup.getByTestId('inspected-percent').innerText(), '0%');
    await sup.getByText('3 لم تُكشف بعد').waitFor();
    await sup.getByRole('button', { name: 'كلّف بالكشف' }).click();
    const d = sup.getByRole('dialog');
    await d.getByRole('button', { name: 'اعرض العوائل' }).click();
    await d.getByText('3 مختارة من 3').waitFor();
    assert.equal(await d.getByRole('button', { name: /كلّف بكشف/ }).isDisabled(), true);
    await d.getByLabel('الكاشف', { exact: true }).selectOption({ label: 'أبو أحمد الحلبوسي (متعهد)' });
    await d.getByLabel('كاشف ثانٍ (اختياري)').selectOption({ label: 'أبو علي الدليمي (متعهد)' });
    await d.getByText('شهادتان مستقلتان على كل عائلة').waitFor();
    await d.getByLabel('ما تريد التحقق منه خاصة (اختياري)').fill('نوع السكن وعدد الأفراد');
    await d.getByRole('button', { name: 'كلّف بكشف 3 عائلة' }).click();
    await sup.getByText('كُلّف بكشف 3 عائلة').waitFor();
    await sup.getByRole('button', { name: 'قيد الكشف (3)' }).click();
    await sup.getByTestId('inspection').nth(2).waitFor();
    assert.equal(await sup.getByTestId('inspection').count(), 3);
    list = await call('/inspections?status=ASSIGNED', tokens.supervisor);
    assert.equal(list.length, 3);
  });

  await step('الكاشفان يرفعان تقاريرهما من هاتفيهما', async () => {
    const of = (no) => list.find((x) => x.familyNo === no).id;
    const send = (no, who, body) => call(`/inspections/${of(no)}/report`, tokens[who], body);
    // الأولى: اختلفا. واحد يراها مطابقة إلا الهاتف، والآخر يوصي برفع نقاطها.
    let r = await send(fams[0].familyNo, 'agent', { contact: 'FAMILY', checks: match({ phone: 'تغيّر الرقم إلى 07809990000' }), recommendation: 'CONFIRM', notes: 'البيت متهالك والأثاث قليل' });
    assert.equal(r.report.mismatches, 1, JSON.stringify(r));
    await send(fams[0].familyNo, 'agent2', { contact: 'FAMILY', checks: match(), recommendation: 'RAISE', reason: 'ربة الأسرة طريحة الفراش ولا معيل لها' });
    // الثانية: اتفقا على طلب الشطب.
    await send(fams[1].familyNo, 'agent', { contact: 'OTHERS', checks: [{ key: 'address', result: 'MISMATCH', found: 'انتقلوا إلى بغداد منذ سنة' }], recommendation: 'REMOVE', reason: 'انتقلت العائلة خارج المدينة' });
    await send(fams[1].familyNo, 'agent2', { contact: 'OTHERS', checks: [{ key: 'address', result: 'MISMATCH', found: 'الدار مؤجَّرة لغيرهم' }], recommendation: 'REMOVE', reason: 'لا تسكن في العنوان' });
    // الثالثة: رفع واحد منهما فقط.
    await send(fams[2].familyNo, 'agent', { contact: 'FAMILY', checks: match(), recommendation: 'CONFIRM' });
  });

  await step('ما رُفع ينتظر قرار المشرف، وما اختلف فيه الكاشفان معلَّم', async () => {
    await sup.reload();
    assert.equal(await sup.getByTestId('waiting').innerText(), '3');
    await sup.getByRole('button', { name: 'تنتظر قرارك (3)' }).click();
    await sup.getByText('اختلف الكاشفان').waitFor();
    await sup.getByText('رُفع 1 من 2').waitFor();
    await sup.waitForTimeout(500);
    await shot(sup, '50-inspections');
  });

  await step('رفع النقاط: يرى المشرف ما تصير إليه نقاطها وفئتها قبل أن يعتمد', async () => {
    await sup.getByTestId('inspection').filter({ hasText: fams[0].familyNo }).getByRole('button', { name: 'افصل فيه' }).click();
    const d = sup.getByRole('dialog');
    await d.getByTestId('checks').getByText('تغيّر الرقم إلى 07809990000').waitFor();
    await d.getByText('طُلب التحقق من:').waitFor();
    await d.getByText('ربة الأسرة طريحة الفراش ولا معيل لها').waitFor();
    assert.equal(await d.getByTestId('report').count(), 2);
    await sup.waitForTimeout(400);
    await shot(sup, '51-compare');
    // اختلفا: لا اختيار مسبق، والزر معطّل.
    assert.equal(await d.getByRole('button', { name: 'اختر الأثر' }).isDisabled(), true);
    await d.getByRole('radio', { name: /رفع النقاط/ }).click();
    await d.getByLabel('عدد النقاط').fill('12');
    await d.getByText('أقصى ما يغيّره الكشف 10 نقاط.').waitFor();
    await d.getByLabel('عدد النقاط').fill('7');
    const preview = (await d.getByTestId('preview').innerText()).replace(/\s+/g, ' ');
    assert.match(preview, /تصير نقاطها 50 بعد 43، وتنتقل من الفئة ج إلى ب/);
    await sup.waitForTimeout(400);
    await shot(sup, '51-decision');
    await d.getByRole('button', { name: 'ارفع 7 نقاط' }).click();
    await sup.getByText('اعتُمد الكشف. رفع النقاط 7: من 43 إلى 50، وانتقلت من الفئة ج إلى ب').waitFor();
  });

  await step('قرار يخالف توصية الكاشف يلزمه سبب', async () => {
    await sup.getByTestId('inspection').filter({ hasText: fams[2].familyNo }).getByRole('button', { name: 'افصل فيه' }).click();
    const d = sup.getByRole('dialog');
    await d.getByText('رُفع 1 من 2. إن فصلتَ الآن فبما وصل').waitFor();
    // توصية الكاشف الواحد مختارة ابتداءً.
    await d.locator('[role=radio][aria-checked=true]').filter({ hasText: 'اعتماد بلا أثر' }).waitFor();
    await d.getByRole('radio', { name: /خفض النقاط/ }).click();
    await d.getByLabel('عدد النقاط').fill('3');
    await d.getByLabel('قرارك يخالف توصية الكاشف: سببه (لازم)').waitFor();
    assert.equal(await d.getByRole('button', { name: 'اخفض 3 نقاط' }).isDisabled(), true);
    await d.getByRole('radio', { name: /اعتماد بلا أثر/ }).click();
    await d.getByRole('button', { name: 'اعتمد بلا أثر' }).click();
    await sup.getByText('اعتُمد الكشف. بلا أثر: حالها كما سُجّل').waitFor();
  });

  await step('الشطب: طلبه الكاشفان فاعتمده المشرف، والعائلة تخرج من المستفيدين', async () => {
    await sup.getByTestId('inspection').filter({ hasText: fams[1].familyNo }).getByRole('button', { name: 'افصل فيه' }).click();
    const d = sup.getByRole('dialog');
    await d.locator('[role=radio][aria-checked=true]').filter({ hasText: 'شطب العائلة' }).waitFor();
    await d.getByText('تُشطب العائلة من المستفيدين.').waitFor();
    await d.getByRole('button', { name: 'اشطب العائلة' }).click();
    await sup.getByText('اعتُمد الكشف. شُطبت العائلة').waitFor();
    await sup.getByText('لا كشف ينتظر قرارك.').waitFor();
    assert.equal(await sup.getByTestId('inspected-percent').innerText(), '100%');
    await sup.getByText('أثر الكشوف المعتمدة').waitFor();
    await sup.getByText('اتفق الكاشفان في').waitFor();
    // تُنتظر التنبيهات العابرة حتى تزول قبل الصورة.
    await sup.getByText('اعتُمد الكشف. شُطبت العائلة').waitFor({ state: 'detached', timeout: 15000 });
    await shot(sup, '52-inspections-done');
  });

  await step('جدول العوائل يحمل حالة الكشف وتعديله، ويُصفّى بها', async () => {
    await sup.getByRole('link', { name: 'العوائل' }).click();
    const row = sup.getByRole('row', { name: new RegExp(fams[0].familyNo) });
    await row.getByTestId('inspection-state').getByText('مكشوفة').waitFor();
    await row.getByTestId('inspection-state').getByText('رفع 7').waitFor();
    await sup.getByRole('row', { name: new RegExp(fams[1].familyNo) }).getByText('مشطوبة').waitFor();
    await sup.waitForTimeout(400);
    await shot(sup, '53-families-inspection');
    await sup.getByLabel('الكشف الميداني').selectOption('DONE');
    await sup.getByRole('row', { name: new RegExp(fams[1].familyNo) }).waitFor({ state: 'detached' });
    assert.equal(await sup.getByTestId('inspection-state').count(), 2);
    await sup.getByLabel('الكشف الميداني').selectOption('NONE');
    await sup.getByText('لا عائلة تطابق البحث.').waitFor();
  });

  await step('ملف العائلة: تعديل الكشف في تفسير النقاط، وسجل كشوفها بمن قام بها', async () => {
    await sup.getByLabel('الكشف الميداني').selectOption('DONE');
    await sup.getByRole('row', { name: new RegExp(fams[0].familyNo) }).getByRole('link', { name: 'فتح' }).click();
    await sup.getByRole('heading', { name: 'لماذا 50 نقطة؟' }).waitFor();
    const adj = sup.getByTestId('score-adjustment');
    await adj.getByText('43').waitFor();
    await adj.getByText('رفع 7').waitFor();
    await sup.getByText('تعديل الكشف على نقاطها: رفع 7').waitFor();
    const card = sup.getByTestId('inspection');
    await card.getByText('رفع النقاط 7: من 43 إلى 50، وانتقلت من الفئة ج إلى ب').waitFor();
    await card.getByText('أبو علي الدليمي:').waitFor();
    await sup.waitForTimeout(400);
    await shot(sup, '54-family-inspection');
    await card.getByRole('button', { name: 'افتحه' }).click();
    await sup.getByRole('dialog').getByText('تعديل الكشف عليها صار «رفع 7» بعد «لا تعديل»').waitFor();
    await sup.getByRole('dialog').getByRole('button', { name: 'أغلق النافذة' }).click();
  });

  await step('المشطوبة يظهر شطبها وسببه، ويعيدها غير من شطبها', async () => {
    const removed = (await call('/families?status=REMOVED', tokens.supervisor))[0];
    await sup.goto(`${sup.url().split('/families')[0]}/families/${removed.id}`);
    await sup.getByText('عائلة مشطوبة من المستفيدين.').waitFor();
    await sup.getByText(/انتقلت العائلة خارج المدينة/).first().waitFor();
    // من شطبها لا يعيدها.
    assert.equal(await sup.getByRole('button', { name: 'أعدها إلى المستفيدين' }).count(), 0);
    await login(admin, 'admin', process.env.ADMIN_PASSWORD);
    await admin.goto(`${admin.url().replace(/\/$/, '')}/families/${removed.id}`);
    await admin.getByRole('button', { name: 'أعدها إلى المستفيدين' }).click();
    await admin.getByRole('dialog').getByRole('textbox').fill('عادت العائلة إلى المدينة');
    await admin.getByRole('dialog').getByRole('button', { name: 'أعد العائلة' }).click();
    await admin.getByText('أُعيدت العائلة إلى المستفيدين وحُسبت نقاطها').waitFor();
    await admin.getByText('عائلة مشطوبة من المستفيدين.').waitFor({ state: 'detached' });
  });

  await step('عائلة تنتظر الاعتماد: تُكلَّف بكشفها من ملفها، ثم تُعتمد مع كشفها في قرار واحد', async () => {
    const f = await call('/families', tokens.researcher, { tags: ['NEEDY'], housing: 'RENTED', phone1: '07705550009', incomes: [], proxies: [],
      members: [{ relation: 'HEAD', fullName: 'زينب كريم ناصر الفهداوي', gender: 'F', documents: [{ type: 'NATIONAL_CARD', number: `1981${RUN}09` }] }] });
    assert.ok(f.id, JSON.stringify(f));
    await sup.goto(`${sup.url().split('/families')[0]}/families/${f.id}`);
    await sup.getByRole('button', { name: 'كلّف بكشفها' }).click();
    const a = sup.getByRole('dialog');
    await a.getByLabel('الكاشف', { exact: true }).selectOption({ label: 'أبو علي الدليمي (متعهد)' });
    await a.getByRole('button', { name: 'كلّف بالكشف' }).click();
    await sup.getByText('كُلّف بكشف عائلة واحدة').waitFor();
    const row = sup.getByTestId('inspection');
    await row.getByText('لم يرفع بعد').waitFor();
    // عليها كشف قائم: لا تكليف ثانٍ.
    assert.equal(await sup.getByRole('button', { name: 'كلّف بكشفها' }).count(), 0);
    const ins = (await call(`/inspections?familyId=${f.id}`, tokens.supervisor))[0];
    await call(`/inspections/${ins.id}/report`, tokens.agent2, { contact: 'FAMILY', checks: match(), recommendation: 'CONFIRM' });
    await sup.reload();
    await sup.getByTestId('inspection').getByRole('button', { name: 'افصل فيه' }).click();
    const d = sup.getByRole('dialog');
    await d.getByLabel('واعتمد تسجيل العائلة الآن', { exact: false }).check();
    await d.getByRole('button', { name: 'اعتمد بلا أثر' }).click();
    await sup.getByText('اعتُمد الكشف. بلا أثر: حالها كما سُجّل، واعتُمد تسجيل العائلة').waitFor();
    await sup.getByText('الفئة ج · 43 نقطة').waitFor();
    await sup.getByTestId('inspection').getByText('واعتُمد تسجيلها').waitFor();
    assert.equal((await call(`/families/${f.id}`, tokens.supervisor)).status, 'APPROVED');
  });

  await step('حدّ تعديل الكشف بيد مدير النظام', async () => {
    await admin.getByRole('link', { name: 'الإعدادات' }).click();
    assert.equal((await admin.getByTestId('inspection-cap').innerText()).replace(/\s+/g, ' '), '±10 نقاط');
    await admin.getByLabel('الحدّ الجديد بالنقاط').fill('5');
    await admin.getByRole('button', { name: 'غيّر الحدّ' }).click();
    await admin.getByTestId('inspection-cap').getByText('±5').waitFor();
    assert.equal((await call('/inspections/summary', tokens.supervisor)).cap, 5);
    // والمتعهد لا يدخل هذه الصفحة.
    assert.equal((await call('/inspections', tokens.agent)).statusCode, 403);
  });
});
