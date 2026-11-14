/**
 * معيار قبول الخطوة 14 في المتصفح: تقرير المتبرع يطابق القيود، والكشوف تُنزَّل.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/reports.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { RUN, call, login, setupUsers, approvedFamily, run } = require('./lib.cjs');

run(async ({ step, shot, newPage }) => {
  const { tokens, names } = await setupUsers([
    ['researcher', 'FIELD_RESEARCHER', 'باحث ميداني'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف المستفيدين'],
    ['manager', 'DISTRIBUTION_MANAGER', 'مدير التوزيع'], ['distributor', 'DISTRIBUTOR', 'موظف توزيع'], ['accountant', 'ACCOUNTANT', 'المحاسب'],
  ]);
  for (let i = 0; i < 3; i++) await approvedFamily(tokens, { name: `عائلة تجريبية ${['أولى', 'ثانية', 'ثالثة'][i]}`, nid: `1975${RUN}0${i}`, kids: 1, orphans: true });
  const program = await call('/programs', tokens.admin, { name: 'كفالة الأيتام', kind: 'MONEY', unit: 'دينار', rules: { hasOrphans: true }, amount: { type: 'PER_ORPHAN', value: 50000 } });
  const fund = await call('/accounting/funds', tokens.accountant, { name: 'صندوق كفالة الأيتام', programId: program.id });
  const point = await call('/points', tokens.admin, { name: 'الجولان' });
  const page = await newPage();

  await step('المحاسب يضيف متبرعاً وينسب إليه سند القبض', async () => {
    await login(page, names.accountant);
    await page.getByRole('link', { name: 'المتبرعون والتقارير' }).click();
    await page.getByRole('button', { name: 'متبرع جديد' }).click();
    await page.getByLabel('اسم المتبرع').fill('متبرع 22');
    await page.getByRole('button', { name: 'أضف المتبرع' }).click();
    await page.getByText('نقداً 0 دينار').waitFor();
    await page.getByRole('link', { name: 'الصندوق والمحاسبة' }).click();
    await page.getByRole('button', { name: 'سند قبض' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('الصندوق', { exact: true }).selectOption({ label: 'صندوق كفالة الأيتام (نقده 0)' });
    await d.getByLabel('المبلغ بالدينار').fill('600000');
    await d.getByLabel('المتبرع').selectOption({ label: 'متبرع 22' });
    assert.equal(await d.getByLabel('من', { exact: true }).count(), 0);
    await d.getByLabel('البيان').fill('لكفالة الأيتام');
    await d.getByRole('button', { name: 'سجّل' }).click();
    await page.getByText('سُجّل القيد ق-1').waitFor();
  });

  await step('بعد صرف من الصندوق: تقريره يطابق القيود', async () => {
    const distributor = (await call('/users/brief?role=DISTRIBUTOR', tokens.admin))[0];
    const other = await call('/donors', tokens.accountant, { name: 'متبرع 5' });
    await call('/accounting/receipts', tokens.accountant, { fundId: fund.id, amount: 200000, description: 'لكفالة الأيتام', donorId: other.id });
    const camp = await call('/campaigns', tokens.manager, { name: 'كفالة الشهر', programId: program.id, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [point.id], fundId: fund.id });
    await call(`/campaigns/${camp.id}/submit`, tokens.manager, {});
    await call(`/campaigns/${camp.id}/approve`, tokens.admin, {});
    await call('/accounting/custody/issue', tokens.accountant, { fundId: fund.id, userId: distributor.id, amount: 150000 });
    for (const t of await call(`/campaigns/${camp.id}/tokens`, tokens.manager)) {
      await call('/deliveries/redeem', tokens.distributor, { pointId: point.id, deviceId: 'd1', locate: { token: t.token }, receiver: { kind: 'HEAD' }, clientOpId: crypto.randomUUID() });
    }
    await page.getByRole('link', { name: 'المتبرعون والتقارير' }).click();
    await page.getByRole('listitem').filter({ hasText: 'متبرع 22' }).getByRole('button', { name: 'تقريره' }).click();
    const d = page.getByRole('dialog');
    // وارد الصندوق 800,000 له منه 75%؛ صُرف 150,000: نصيبه 112,500.
    await d.getByText('وهي 75% من وارد الصندوق').waitFor();
    await d.getByText('صُرف من الصندوق 150,000، ونصيب عطائه منها 112,500').waitFor();
    await d.getByText('انتفعت من الصندوق 3 عائلة').waitFor();
    await d.getByText('محسوب بالتناسب').waitFor();
    await shot(page, '29-donor-report');
    await d.getByRole('button', { name: 'إغلاق' }).click();
    const tb = await call('/accounting/trial-balance', tokens.admin);
    assert.equal(tb.lines.find((l) => l.account === 'مصروف: مساعدات').balance, 150000);
  });

  await step('الرسم الشهري يعرض من استلم هذا الشهر', async () => {
    await page.getByRole('img', { name: /رسم أعمدة/ }).waitFor();
    const label = await page.getByRole('img', { name: /رسم أعمدة/ }).getAttribute('aria-label');
    assert.match(label, / 3$/);
    await shot(page, '30-reports');
  });

  await step('كشف التسليم يُنزَّل ملفاً يفتحه Excel', async () => {
    await page.getByLabel('كشف التسليم لحملة').selectOption({ label: 'كفالة الشهر' });
    await page.evaluate(() => {
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { window.__downloadName = this.download; return click.call(this); };
    });
    const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'نزّل' }).click()]);
    assert.equal(await page.evaluate(() => window.__downloadName), 'كشف التسليم - كفالة الشهر.csv');
    // الاسم العربي يصل من الخادم صحيحاً، لكن متصفح الاختبار هنا (لغته POSIX) يبدّل كل اسم غير لاتيني بـ«download»،
    // فلا يُفحص الاسم هنا؛ يُفحص ما طلبه التطبيق من المتصفح.
    assert.ok(['download', 'كشف التسليم - كفالة الشهر.csv'].includes(file.suggestedFilename()));
    const text = fs.readFileSync(await file.path(), 'utf8');
    assert.equal(text.charCodeAt(0), 0xfeff);
    assert.equal(text.trim().split('\r\n').length, 4);
    assert.ok(text.includes('"استلم"'));
    await page.getByText('نُزّل التقرير').waitFor();
  });
});
