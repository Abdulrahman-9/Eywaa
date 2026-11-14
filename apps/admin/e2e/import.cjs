/**
 * استيراد العوائل من Excel في متصفح حقيقي: تنزيل القالب، رفع ملف فيه الصالح والمعيب والمكرَّر،
 * المعاينة قبل الحفظ، ثم الاستيراد ونتيجته.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/import.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RUN, call, login, setupUsers, approvedFamily, run } = require('./lib.cjs');

const HEAD = ['رقم الاستمارة', 'الصلة', 'الاسم الكامل', 'اسم الأم', 'الجنس', 'تاريخ الميلاد', 'يتيم', 'نوع الوثيقة', 'رقم الوثيقة', 'السجل', 'الصفحة',
  'الهاتف', 'المحلة', 'السكن', 'الفئات', 'عمل حر', 'عمود زائد'];
const nid = (n) => `1977${RUN}${String(n).padStart(2, '0')}`;

run(async ({ step, shot, newPage }) => {
  const { tokens, names } = await setupUsers([
    ['researcher', 'FIELD_RESEARCHER', 'باحث'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف المستفيدين'],
  ]);
  await approvedFamily(tokens, { name: 'هدى سالم عبد الدليمي', nid: nid(90) });

  const rows = [
    HEAD,
    // عائلة صالحة من ثلاثة أفراد؛ الهاتف والرقم الوطني أعداد كما يخزنها Excel، والتاريخ بصيغة اليوم أولاً.
    ['A1', 'رب الأسرة', 'منى خالد إبراهيم الجميلي', 'سعدية', 'أنثى', '14/3/1985', '', 'بطاقة وطنية', Number(nid(1)), '', '', 7701112233, 'الجولان', 'إيجار', 'أرامل، أيتام', 200000, 'س'],
    ['A1', 'ابن', 'عمر ياسر محمود الجميلي', '', '', '2012-09-01', 'نعم', '', '', '', '', '', '', '', '', '', ''],
    ['A1', 'ابنة', 'رقية ياسر محمود الجميلي', '', '', '', 'نعم', 'هوية أحوال', '00778899', '45', '112', '', '', '', '', '', ''],
    // صالحة بهوية الأحوال القديمة.
    ['A2', 'رب الأسرة', 'جاسم حميد علوان الفهداوي', 'نجية', 'ذكر', '1960', '', 'هوية أحوال', `55${RUN}`, '12', '87', '07809998877', 'النزال', 'ملك', 'متعفف', '', ''],
    // معيبة: رب الأسرة بلا وثيقة، وتاريخ لا يُفهم.
    ['A3', 'رب الأسرة', 'سليم ناجي فرحان', '', 'ذكر', 'قبل الحرب', '', '', '', '', '', '', '', '', '', '', ''],
    // معيبة: لا رب أسرة.
    ['A4', 'ابن', 'ولد بلا عائلة', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    // يرفضها النظام: وثيقتها مسجَّلة لعائلة قائمة.
    ['A5', 'رب الأسرة', 'هدى سالم عبد الدليمي', '', 'أنثى', '', '', 'بطاقة وطنية', nid(90), '', '', '', '', '', '', '', ''],
    // يرفضها النظام: وثيقتها هي وثيقة A1 في الملف نفسه.
    ['A6', 'رب الأسرة', 'منى خالد إبراهيم', '', 'أنثى', '', '', 'بطاقة وطنية', nid(1), '', '', '', '', '', '', '', ''],
  ];
  const file = path.join(os.tmpdir(), `import-${RUN}.xlsx`);
  const { default: writeXlsxFile } = await import('write-excel-file/node');
  await writeXlsxFile(rows.map((r) => r.map((value) => (value === '' ? null : { value, type: typeof value === 'number' ? Number : String })))).toFile(file);

  const page = await newPage();
  await login(page, names.supervisor);

  await step('الباحث لا يرى الاستيراد، والمشرف يراه', async () => {
    const other = await newPage();
    await login(other, names.researcher);
    await other.getByRole('link', { name: 'العوائل' }).click();
    await other.getByRole('link', { name: 'تسجيل عائلة' }).waitFor();
    assert.equal(await other.getByRole('link', { name: 'استيراد من Excel' }).count(), 0);
    await other.close();
    await page.getByRole('link', { name: 'العوائل' }).click();
    await page.getByRole('link', { name: 'استيراد من Excel' }).click();
    await page.getByRole('heading', { name: 'استيراد العوائل من Excel' }).waitFor();
  });

  await step('القالب يُنزَّل ملف xlsx يقرؤه المستورد نفسه', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'نزّل القالب' }).click()]);
    const saved = path.join(os.tmpdir(), `template-${RUN}.xlsx`);
    await dl.saveAs(saved);
    assert.ok(fs.statSync(saved).size > 2000);
    await page.getByLabel('ملف Excel').setInputFiles(saved);
    await page.getByRole('button', { name: 'ابدأ الاستيراد (1)' }).waitFor();
    await page.getByText('سعاد كريم عبد الله الدليمي').waitFor();
  });

  await step('المعاينة تفرز الصالح من المعيب قبل أن يُحفظ شيء', async () => {
    await page.getByLabel('ملف Excel').setInputFiles(file);
    await page.getByRole('button', { name: 'ابدأ الاستيراد (4)' }).waitFor();
    await page.getByText('أعمدة لم تُعرف فأُهملت: عمود زائد').waitFor();
    await page.getByText('رب الأسرة بلا وثيقة هوية').waitFor();
    await page.getByText('تاريخ الميلاد غير مفهوم').waitFor();
    await page.getByText('لا رب أسرة في هذه الاستمارة').waitFor();
    const before = await call('/families?limit=200', tokens.supervisor);
    assert.equal(before.length, 1, 'لا يُحفظ شيء قبل الضغط');
    await shot(page, '32-import-preview');
  });

  await step('الاستيراد يحفظ الصالح ويبيّن ما رفضه النظام وسببه', async () => {
    await page.getByRole('button', { name: 'ابدأ الاستيراد (4)' }).click();
    await page.getByText('انتهى: حُفظت 2 من 4.').waitFor();
    assert.equal(await page.getByText(/مسجَّل سلفاً في العائلة \d+/).count(), 2);
    await shot(page, '33-import-result');
    const all = await call('/families?limit=200', tokens.supervisor);
    assert.equal(all.length, 3);
  });

  await step('ما استُورد مطابق للملف: الأفراد، الهاتف، التاريخ، الدخل، الوثيقة القديمة', async () => {
    const all = await call('/families?limit=200', tokens.supervisor);
    const mona = await call(`/families/${all.find((f) => f.headName.startsWith('منى')).id}`, tokens.supervisor);
    assert.equal(mona.members.length, 3);
    assert.equal(mona.status, 'PENDING_APPROVAL');
    assert.match(mona.phone1, /7701112233$/);
    assert.deepEqual([...mona.tags].sort(), ['ORPHANS', 'WIDOW']);
    assert.equal(mona.housing, 'RENTED');
    const head = mona.members.find((m) => m.relation === 'HEAD');
    assert.equal(String(head.birthDate).slice(0, 10), '1985-03-14');
    assert.equal(mona.members.filter((m) => m.isOrphan).length, 2);
    assert.equal(mona.members.find((m) => m.relation === 'DAUGHTER').gender, 'F');
    assert.equal(mona.incomes[0].amountIqd, 200000);
    const jasim = await call(`/families/${all.find((f) => f.headName.startsWith('جاسم')).id}`, tokens.supervisor);
    assert.equal(jasim.members[0].documents[0].type, 'CIVIL_ID');
  });

  await step('إعادة رفع الملف نفسه لا تكرّر عائلة', async () => {
    await page.getByLabel('ملف Excel').setInputFiles(file);
    await page.getByRole('button', { name: 'ابدأ الاستيراد (4)' }).click();
    await page.getByText('انتهى: حُفظت 0 من 4.').waitFor();
    const all = await call('/families?limit=200', tokens.supervisor);
    assert.equal(all.length, 3);
  });

  await step('المستورَد يظهر في صف الاعتماد', async () => {
    await page.getByRole('link', { name: 'إلى صف الاعتماد' }).count();
    await page.getByRole('link', { name: 'الاعتماد والشبهات' }).click();
    await page.getByText('منى خالد إبراهيم الجميلي').first().waitFor();
  });
});
