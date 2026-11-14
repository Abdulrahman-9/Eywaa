/**
 * المتعهد في تطبيق الميدان: حصته وحدها، لا يسلّم لغيرها، والتخويل الاستثنائي لغير المسجَّلين يصدره المدير من اللوحة
 * فيعمل به المتعهد ولو انقطع الاتصال، ثم يظهر للمدير بأسمائه.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... BASE_URL=http://localhost:3000 ADMIN_URL=http://localhost:4173 node e2e/agent.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');
process.env.BASE_URL ??= 'http://localhost:3000';
const ADMIN = process.env.ADMIN_URL ?? 'http://localhost:4173';
const { BASE, RUN, PASSWORD, call, setupUsers, approvedFamily } = require('../../admin/e2e/lib.cjs');

const SHOTS = process.argv[2];
const steps = [];
const errors = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`✓ ${name}`); };
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

(async () => {
  const { tokens, names } = await setupUsers([
    ['researcher', 'FIELD_RESEARCHER', 'باحث'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف'],
    ['manager', 'DISTRIBUTION_MANAGER', 'مدير التوزيع'], ['agent', 'DISTRIBUTION_AGENT', 'أبو أحمد الحلبوسي'],
  ]);
  // أسماء متباينة: الاسم الرباعي المطابق يُعلَّق شبهةً، والأرقام لا تدخل في مقارنة الأسماء.
  const heads = ['ثامر حميد لطيف العزاوي', 'وسام رحيم كاطع الساعدي', 'عقيل ناصر شنشل الزبيدي', 'ضياء مجيد سلوم الحيالي', 'بشير طالب عجيل الدراجي', 'فراس هادي مطشر الكعبي'];
  for (const [i, name] of heads.entries()) await approvedFamily(tokens, { name, nid: `1968${RUN}0${i}` });
  const program = await call('/programs', tokens.admin, { name: 'لحوم الصدقات', kind: 'IN_KIND', unit: 'كغم', rules: {}, amount: { type: 'FIXED', value: 2 }, minGapDays: 0 });
  const center = await call('/points', tokens.admin, { name: 'المركز' });
  const agentUser = (await call('/agents', tokens.manager)).find((a) => a.username === names.agent);
  const agentPoint = await call(`/agents/${agentUser.id}/point`, tokens.manager, {});
  const today = new Date().toISOString().slice(0, 10);
  const camp = await call('/campaigns', tokens.manager, { programId: program.id, name: 'لحوم الجمعة', startsOn: today, endsOn: today, pointIds: [center.id, agentPoint.id] });
  assert.ok(camp.id, JSON.stringify(camp));
  await call(`/campaigns/${camp.id}/submit`, tokens.manager, {});
  await call(`/campaigns/${camp.id}/approve`, tokens.admin, {});
  const toks = await call(`/campaigns/${camp.id}/tokens`, tokens.manager);
  const mine = toks.filter((t) => t.point !== 'المركز');
  const theirs = toks.filter((t) => t.point === 'المركز');

  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar-IQ', deviceScaleFactor: Number(process.env.DSF ?? 2) });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const desk = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar-IQ', deviceScaleFactor: Number(process.env.DSF ?? 2) })).newPage();
  desk.on('pageerror', (e) => errors.push(e.message));
  const sync = async () => { await page.getByRole('button', { name: 'زامن الآن' }).click(); await page.getByText('تمّت المزامنة').waitFor(); };
  const deliver = async (token) => {
    if (await page.getByRole('button', { name: 'اكتب رقم العائلة ورمزها' }).count()) await page.getByRole('button', { name: 'اكتب رقم العائلة ورمزها' }).click();
    await page.getByLabel('الرمز الرقمي').fill(token);
    await page.getByRole('button', { name: 'تحقّق' }).click();
  };
  try {
    await step('المتعهد لا شاشة له في لوحة الإدارة، وتطبيقه يعرض حصته وحدها', async () => {
      await desk.goto(ADMIN);
      await desk.getByLabel('اسم المستخدم').fill(names.agent);
      await desk.getByLabel('كلمة المرور').fill(PASSWORD);
      await desk.getByRole('button', { name: 'دخول' }).click();
      await desk.getByText('عمل المتعهد من تطبيق الميدان على الهاتف').waitFor();
      assert.equal(await desk.getByRole('link', { name: 'العوائل' }).count(), 0);

      await page.goto(`${BASE}/m/`);
      await page.getByLabel('اسم المستخدم').fill(names.agent);
      await page.getByLabel('كلمة المرور').fill(PASSWORD);
      await page.getByRole('button', { name: 'دخول' }).click();
      for (const label of ['الرمز', 'أعد الرمز للتأكيد']) { await page.getByLabel(label, { exact: true }).fill('735194'); await page.getByRole('button', { name: 'متابعة' }).click(); }
      await page.getByText('لا حصة لك في حملة جارية').waitFor();
      await sync();
      await page.getByRole('button', { name: /لحوم الجمعة/ }).waitFor();
      await page.getByText(`${mine.length} عائلة · ${mine.length * 2} كغم · سلّمتَ 0`).waitFor();
      await shot(page, 'm12-agent-quota');
      await page.getByRole('button', { name: /لحوم الجمعة/ }).click();
      await page.getByText('بقي في حصتك').waitFor();
    });

    await step('يسلّم من حصته، ولا يسلّم لعائلة من حصة غيره ولو كان متصلاً', async () => {
      await page.getByRole('button', { name: 'سلّم', exact: true }).click();
      await deliver(mine[0].token);
      await page.getByRole('button', { name: mine[0].headName }).click();
      await page.getByText('وصل الخادم.').waitFor();
      await page.getByRole('button', { name: 'التالي' }).click();
      await deliver(theirs[0].token);
      await page.getByRole('heading', { name: 'لا تسلّم' }).waitFor();
      await page.getByText('ليس من حصة هذا الجهاز').waitFor();
      await page.getByRole('button', { name: 'التالي' }).click();
      await page.getByRole('button', { name: 'رجوع' }).click();
      assert.equal((await call(`/campaigns/${camp.id}`, tokens.manager)).totals.delivered, 1);
    });

    await step('المدير يخوّله من صفحة الحملة: سقف ومدة وسبب', async () => {
      await desk.getByRole('button', { name: 'تسجيل الخروج' }).click().catch(() => {});
      await desk.goto(ADMIN);
      if (await desk.getByText('عمل المتعهد من تطبيق الميدان').count()) { await desk.evaluate(() => sessionStorage.clear()); await desk.reload(); }
      await desk.getByLabel('اسم المستخدم').fill(names.manager);
      await desk.getByLabel('كلمة المرور').fill(PASSWORD);
      await desk.getByRole('button', { name: 'دخول' }).click();
      await desk.getByRole('heading', { name: 'الرئيسية' }).waitFor();
      await desk.goto(`${ADMIN}/campaigns/${camp.id}`);
      await desk.getByRole('button', { name: 'خوّل متعهداً' }).click();
      const d = desk.getByRole('dialog');
      assert.equal(await d.getByRole('button', { name: 'أصدر التخويل' }).isDisabled(), true);
      await d.getByLabel('أقصى عدد الحالات').fill('2');
      await d.getByLabel('المقدار لكل حالة').fill('2');
      await d.getByLabel('يسري (ساعة)').fill('3');
      await d.getByLabel('سبب التخويل').fill('تأخر الوقت وبقي لحم لا يحتمل إلى الغد');
      await d.getByRole('button', { name: 'أصدر التخويل' }).click();
      await desk.getByText('صدر التخويل. يصل هاتف المتعهد عند مزامنته.').waitFor();
      await desk.locator('[data-grant]').getByText('صُرف 0 من 2 · 2 كغم للحالة').waitFor();
    });

    await step('المتعهد يصرف بالتخويل والهاتف منقطع: الاسم وحده، والسقف والتكرار يُحرسان على الهاتف', async () => {
      await sync();
      await page.getByRole('heading', { name: 'صرف لغير المسجَّلين بتخويل' }).waitFor();
      await page.getByText('بقي 2 من 2 · 2 كغم للحالة').waitFor();
      await context.setOffline(true);
      await page.getByRole('button', { name: 'اصرف لغير مسجَّل' }).click();
      await page.getByLabel('اسم المستلم').fill('حمزة عدنان فاضل الزيدي');
      await page.getByRole('button', { name: 'اصرف وسجّل' }).click();
      await page.getByText('سُجّل: حمزة عدنان فاضل الزيدي · 2 كغم').waitFor();
      assert.equal(await page.getByTestId('grant-left').innerText(), '1');
      // الاسم نفسه بإملاء آخر: لا يُصرف له مرتين.
      await page.getByLabel('اسم المستلم').fill('حمزه عدنان فاضل الزيدى');
      await page.getByRole('button', { name: 'اصرف وسجّل' }).click();
      await page.getByText(/صرفتَ لـ«حمزة عدنان فاضل الزيدي»/).waitFor();
      await page.getByLabel('اسم المستلم').fill('نزار قيس مهند الطائي');
      await page.getByLabel('الهاتف (إن تيسّر)').fill('07708880001');
      await page.getByRole('button', { name: 'اصرف وسجّل' }).click();
      await page.getByText('سُجّل: نزار قيس مهند الطائي · 2 كغم').waitFor();
      await shot(page, 'm13-grant');
      // استُنفد السقف.
      await page.getByLabel('اسم المستلم').fill('ثالث فوق السقف');
      assert.equal(await page.getByRole('button', { name: 'اصرف وسجّل' }).isDisabled(), true);
      assert.equal((await call(`/campaigns/${camp.id}/grants`, tokens.manager))[0].used, 0, 'لم يبلغ الخادم شيء والهاتف منقطع');
    });

    await step('عند الاتصال تُرفع الحالات، ويراها المدير بأسمائها، وتصير طلبات تسجيل سريع', async () => {
      await context.setOffline(false);
      await page.getByText('وصل الخادم · 2 كغم').first().waitFor({ timeout: 15000 });
      const g = (await call(`/campaigns/${camp.id}/grants`, tokens.manager))[0];
      assert.equal(g.used, 2);
      assert.deepEqual(g.cases.map((c) => c.headName).sort(), ['حمزة عدنان فاضل الزيدي', 'نزار قيس مهند الطائي'].sort());
      await desk.reload();
      const card = desk.locator('[data-grant]');
      await card.getByText('صُرف 2 من 2 · 2 كغم للحالة').waitFor();
      await card.getByText('حمزة عدنان فاضل الزيدي').waitFor();
      await shot(desk, '53-grant');
      const quick = await call('/quick-requests', tokens.supervisor);
      assert.equal(quick.filter((q) => q.source === 'EMERGENCY' && q.campaignName === 'لحوم الجمعة').length, 2);
    });

    await step('المدير يسحب التخويل، فلا يبقى في هاتف المتعهد بعد مزامنته', async () => {
      await desk.getByRole('button', { name: 'اسحب التخويل' }).click();
      await desk.getByRole('dialog').getByRole('textbox').fill('انتهى التوزيع');
      await desk.getByRole('dialog').getByRole('button', { name: 'اسحب التخويل' }).click();
      await desk.getByText('سُحب التخويل').first().waitFor();
      await page.getByRole('button', { name: 'رجوع' }).click();
      await sync();
      await page.getByText('لا تخويل سارٍ الآن.').waitFor();
      await page.getByRole('button', { name: 'ما صرفتَه بتخويل' }).waitFor();
    });

    await step('لا أخطاء برمجية في المتصفح', async () => { if (errors.length) throw new Error(errors.join('\n')); });
    console.log(`\n${steps.length} خطوات نجحت`);
  } catch (err) {
    console.error(`✗ فشل بعد ${steps.length} خطوة:\n`, err.message);
    if (SHOTS) { await page.screenshot({ path: `${SHOTS}/agent-fail-m.png` }).catch(() => {}); await desk.screenshot({ path: `${SHOTS}/agent-fail-d.png` }).catch(() => {}); }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
