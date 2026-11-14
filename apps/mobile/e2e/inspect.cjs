/**
 * الكشف الميداني من هاتف المتعهد والهاتف منقطع: يرى ما كُلّف به بصورة العائلة، يطابق ما في السجل بما رأى،
 * يكتب ما خالف، ويوصي بسبب؛ ومن لم يجد العائلة لا يطابق ولا يوصي بنقاط. ثم يُرفع ويفصل المدير فيبلغه ما آل إليه.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... BASE_URL=http://localhost:3000 node e2e/inspect.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');
process.env.BASE_URL ??= 'http://localhost:3000';
const { BASE, RUN, PASSWORD, call, setupUsers, approvedFamily } = require('../../admin/e2e/lib.cjs');

const SHOTS = process.argv[2];
const steps = [];
const errors = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`✓ ${name}`); };
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

(async () => {
  const { tokens, names } = await setupUsers([
    ['researcher', 'FIELD_RESEARCHER', 'باحث'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف'], ['agent', 'DISTRIBUTION_AGENT', 'أبو أحمد الحلبوسي'],
  ]);
  const a = await approvedFamily(tokens, { name: 'سعاد خلف عبيد الجميلي', nid: `1982${RUN}01`, tags: ['WIDOW', 'ORPHANS'], kids: 3, orphans: true, phone: '07705550001' });
  const b = await approvedFamily(tokens, { name: 'نوال حميد لطيف العزاوي', nid: `1982${RUN}02`, phone: '07705550002' });
  const agent = (await call('/inspections/inspectors', tokens.supervisor)).find((u) => u.fullName === 'أبو أحمد الحلبوسي');
  const made = await call('/inspections', tokens.supervisor, { familyIds: [a.id, b.id], inspectorIds: [agent.id], note: 'نوع السكن وعدد الأيتام' });
  assert.equal(made.created, 2, JSON.stringify(made));
  const idOf = (no) => made.inspections.find((x) => x.familyNo === no).id;

  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar-IQ', deviceScaleFactor: Number(process.env.DSF ?? 2) });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const sync = async () => { await page.getByRole('button', { name: 'زامن الآن' }).click(); await page.getByText('تمّت المزامنة').waitFor(); };
  const back = () => page.getByRole('button', { name: 'رجوع' }).click();
  try {
    await step('يزامن فيرى ما كُلّف بكشفه، بصورة العائلة كما في سجلها', async () => {
      await page.goto(`${BASE}/m/`);
      await page.getByLabel('اسم المستخدم').fill(names.agent);
      await page.getByLabel('كلمة المرور').fill(PASSWORD);
      await page.getByRole('button', { name: 'دخول' }).click();
      for (const label of ['الرمز', 'أعد الرمز للتأكيد']) { await page.getByLabel(label, { exact: true }).fill('735194'); await page.getByRole('button', { name: 'متابعة' }).click(); }
      await page.getByRole('button', { name: 'الكشوف المطلوبة (0)' }).waitFor();
      await sync();
      await page.getByRole('button', { name: 'الكشوف المطلوبة (2)' }).click();
      await page.getByRole('button', { name: /سعاد خلف عبيد الجميلي/ }).waitFor();
      await page.getByText('المطلوب: نوع السكن وعدد الأيتام').first().waitFor();
      await context.setOffline(true);
      await page.getByRole('button', { name: /سعاد خلف عبيد الجميلي/ }).click();
      await page.getByRole('group', { name: 'نوع السكن' }).getByText('إيجار').waitFor();
      await page.getByRole('group', { name: 'الأيتام' }).getByText('3 أيتام').waitFor();
      await page.getByRole('group', { name: 'عدد الأفراد' }).getByText('4 أفراد').waitFor();
      await page.getByText('الأفراد المسجَّلون (4)').click();
      await page.getByText(/ولد 1 سعاد خلف عبيد الجميلي · ابن/).waitFor();
      // لا رقم وثيقة على الهاتف.
      assert.equal(await page.getByText(`1982${RUN}01`).count(), 0);
    });

    await step('والهاتف منقطع: يطابق، ويكتب ما خالف، ويوصي بسبب', async () => {
      await page.getByRole('button', { name: 'ارفع الكشف' }).click();
      await page.getByText('اختر من لقيتَ.').waitFor();
      await page.getByRole('button', { name: 'قابلتُ العائلة في دارها' }).click();
      await page.getByRole('radio', { name: /الحال كما سُجّل/ }).click();
      await page.getByRole('button', { name: 'ارفع الكشف' }).click();
      await page.getByText('لم تطابق بنداً واحداً.', { exact: false }).waitFor();
      await page.getByRole('button', { name: 'كل ما في السجل مطابق' }).click();
      assert.equal(await page.getByTestId('verified').innerText(), '8 من 8');
      await page.getByRole('group', { name: 'نوع السكن' }).getByRole('button', { name: 'غير مطابق' }).click();
      await page.getByRole('button', { name: 'ارفع الكشف' }).click();
      await page.getByText('اكتب ما وجدتَه في «نوع السكن».').waitFor();
      await page.getByLabel('ما وجدتَه في «نوع السكن»').fill('هيكل غير مكتمل بلا أبواب');
      assert.equal(await page.getByTestId('verified').innerText(), '8 من 8 · 1 غير مطابق');
      await page.getByRole('radio', { name: /حالهم أشدّ مما سُجّل/ }).click();
      await page.getByRole('button', { name: 'ارفع الكشف' }).click();
      await page.getByText('ما الذي رأيتَه مما لم يُسجَّل؟ اكتبه.').waitFor();
      await page.getByLabel('ما الذي رأيتَه مما لم يُسجَّل؟').fill('يسكنون هيكلاً بلا أبواب، والأم مريضة');
      await page.getByLabel('ملاحظاتك').fill('لا أثاث في الدار إلا فرش على الأرض');
      await shot(page, 'm30-inspect-form');
      await page.getByRole('button', { name: 'ارفع الكشف' }).click();
      await page.getByText(`سُجّل كشف العائلة ${a.familyNo}. يُرفع إلى المدير ليعتمده.`).waitFor();
      await page.getByText('ينتظر الرفع').waitFor();
      assert.equal(await page.getByRole('button', { name: /سعاد خلف عبيد الجميلي/ }).count(), 0);
    });

    await step('من لم يجد العائلة لا يطابق ولا يوصي بنقاط: يعلّم أن الكشف تعذّر', async () => {
      await page.getByRole('button', { name: /نوال حميد لطيف العزاوي/ }).click();
      await page.getByRole('button', { name: 'لم أجد العائلة ولا من يعرفها' }).click();
      assert.equal(await page.getByRole('button', { name: 'كل ما في السجل مطابق' }).count(), 0);
      assert.equal(await page.getByRole('radio', { name: /الحال كما سُجّل/ }).isDisabled(), true);
      assert.equal(await page.getByRole('radio', { name: /حالهم أشدّ مما سُجّل/ }).isDisabled(), true);
      await page.getByRole('radio', { name: /تعذّر الكشف/ }).click();
      await page.getByLabel('لماذا تعذّر الكشف؟').fill('الدار مغلقة ولم يعرفهم الجيران');
      await page.getByRole('button', { name: 'ارفع الكشف' }).click();
      await page.getByText(`سُجّل كشف العائلة ${b.familyNo}.`, { exact: false }).waitFor();
      await page.getByText('لا كشف مطلوب منك الآن.', { exact: false }).waitFor();
      await shot(page, 'm31-inspect-list');
      await back();
      assert.equal(await page.getByTestId('pending').innerText(), '2');
      assert.equal((await call('/inspections?status=WAITING', tokens.supervisor)).length, 0);
    });

    await step('يعود الاتصال فيُرفع الكشفان كما كُتبا', async () => {
      await context.setOffline(false);
      await sync();
      assert.equal(await page.getByTestId('pending').innerText(), '0');
      const first = await call(`/inspections/${idOf(a.familyNo)}`, tokens.supervisor);
      assert.equal(first.status, 'SUBMITTED');
      const r = first.reports[0];
      assert.equal(r.recommendation, 'RAISE');
      assert.equal(r.contact, 'FAMILY');
      assert.equal(r.mismatches, 1);
      assert.deepEqual(r.checks.find((c) => c.key === 'housing'), { key: 'housing', label: 'نوع السكن', recorded: 'إيجار', result: 'MISMATCH', found: 'هيكل غير مكتمل بلا أبواب' });
      assert.equal(r.checks.filter((c) => c.result === 'MATCH').length, 7);
      assert.equal(r.notes, 'لا أثاث في الدار إلا فرش على الأرض');
      const second = await call(`/inspections/${idOf(b.familyNo)}`, tokens.supervisor);
      assert.equal(second.reports[0].recommendation, 'UNABLE');
      assert.equal(second.reports[0].checks.every((c) => c.result === 'UNCHECKED'), true);
      // إعادة المزامنة لا تكرّر ولا تُخطئ.
      await sync();
      assert.equal((await call('/inspections?status=WAITING', tokens.supervisor)).length, 2);
    });

    await step('المدير يفصل، فيبلغ الكاشفَ ما آل إليه كشفه', async () => {
      const up = await call(`/inspections/${idOf(a.familyNo)}/decide`, tokens.supervisor, { decision: 'APPROVE', effect: 'RAISE', points: 5 });
      assert.equal(up.effect, 'RAISED', JSON.stringify(up));
      await call(`/inspections/${idOf(b.familyNo)}/decide`, tokens.supervisor, { decision: 'REJECT', note: 'يُعاد التكليف بعد الاتصال بهم' });
      await sync();
      await page.getByRole('button', { name: 'الكشوف المطلوبة (0)' }).click();
      await page.getByText('اعتُمد: رُفعت نقاطها 5').waitFor();
      await page.getByText('لم يُعتمد: يُعاد التكليف بعد الاتصال بهم').waitFor();
      await shot(page, 'm32-inspect-results');
    });

    await step('لا أخطاء برمجية في المتصفح', async () => { if (errors.length) throw new Error(errors.join('\n')); });
    console.log(`\n${steps.length} خطوات نجحت`);
  } catch (err) {
    console.error(`✗ فشل بعد ${steps.length} خطوة:\n`, err.message);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/inspect-fail.png` }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
