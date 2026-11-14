/**
 * الصرف بالحوالة والمحفظة في المتصفح: كشف دفع يُنشأ من مستحقي حملة مالية، يُنزَّل ملفه،
 * ثم يعتمده محاسب آخر بمرجع التنفيذ فيُعدّ أصحابه مستلِمين وينقص الصندوق.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/payouts.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BASE, RUN, call, login, setupUsers, approvedFamily, run } = require('./lib.cjs');

run(async ({ step, shot, newPage }) => {
  const { tokens, names } = await setupUsers([
    ['researcher', 'FIELD_RESEARCHER', 'باحث'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف'], ['manager', 'DISTRIBUTION_MANAGER', 'مدير التوزيع'],
    ['accountant', 'ACCOUNTANT', 'المحاسب الأول'], ['accountant2', 'ACCOUNTANT', 'المحاسب الثاني'],
  ]);
  const heads = ['زهراء عباس كاظم الجنابي', 'مريم داود سلمان العبيدي', 'هناء قاسم نعمة الحلبوسي'];
  for (const [i, name] of heads.entries()) await approvedFamily(tokens, { name, nid: `1973${RUN}0${i}`, phone: `0770${RUN}${i}` });
  await approvedFamily(tokens, { name: 'عائلة بلا هاتف للتجربة', nid: `1973${RUN}09` });
  const program = await call('/programs', tokens.admin, { name: 'مساعدة نقدية', kind: 'MONEY', unit: 'دينار', rules: {}, amount: { type: 'FIXED', value: 150000 } });
  const fund = await call('/accounting/funds', tokens.accountant, { name: 'صندوق المساعدة النقدية', programId: program.id });
  await call('/accounting/receipts', tokens.accountant, { fundId: fund.id, amount: 2000000, party: 'متبرع كريم', description: 'للمساعدة النقدية' });
  const point = await call('/points', tokens.admin, { name: 'المركز' });
  const today = new Date().toISOString().slice(0, 10);
  const camp = await call('/campaigns', tokens.manager, { programId: program.id, name: 'مساعدة تشرين الثاني', startsOn: today, endsOn: today, pointIds: [point.id], fundId: fund.id });
  assert.ok(camp.id, JSON.stringify(camp));
  await call(`/campaigns/${camp.id}/submit`, tokens.manager, {});
  await call(`/campaigns/${camp.id}/approve`, tokens.admin, {});
  const cash = async () => (await call('/accounting/summary', tokens.accountant)).funds.find((f) => f.id === fund.id).cash;

  const first = await newPage();
  const second = await newPage();
  await login(first, names.accountant);
  await login(second, names.accountant2);

  await step('المحاسب ينشئ كشف دفع: يختار بالاسم، ومن لا هاتف له لا يُعرض', async () => {
    await first.goto(`${BASE}/campaigns/${camp.id}`);
    await first.getByRole('button', { name: 'كشف دفع جديد' }).click();
    const dialog = first.getByRole('dialog');
    await dialog.getByText('1 عائلة بلا رقم هاتف').waitFor();
    assert.equal(await dialog.getByRole('checkbox').count(), 3);
    assert.equal(await dialog.getByRole('button', { name: 'أنشئ الكشف' }).isDisabled(), true);
    await dialog.getByLabel('شركة المحفظة').fill('زين كاش');
    await dialog.getByText(heads[0]).click();
    await dialog.getByText(heads[1]).click();
    await dialog.getByText('2 عائلة · 300,000 دينار').waitFor();
    await shot(first, '36-payout-new');
    await dialog.getByRole('button', { name: 'أنشئ الكشف' }).click();
    await first.getByText(/أُنشئ الكشف \d+/).waitFor();
    await first.getByText('ينتظر التنفيذ والاعتماد').waitFor();
    await first.getByText('كشفك: يعتمده غيرك').waitFor();
    assert.equal(await first.getByRole('button', { name: 'اعتماد بعد التنفيذ' }).count(), 0);
    assert.equal(await cash(), 2000000);
  });

  await step('ملف الدفع يُنزَّل بالأسماء والأرقام والمبالغ', async () => {
    const [dl] = await Promise.all([first.waitForEvent('download'), first.getByRole('button', { name: 'نزّل ملف الدفع' }).click()]);
    const saved = path.join(os.tmpdir(), `payout-${RUN}.csv`);
    await dl.saveAs(saved);
    const text = fs.readFileSync(saved, 'utf8');
    assert.ok(text.includes('رقم المحفظة') && text.includes(heads[0]) && text.includes(heads[1]) && !text.includes(heads[2]));
    assert.equal((text.match(/150000/g) ?? []).length, 2);
  });

  await step('المحاسب الثاني يعتمد بمرجع التنفيذ: يُعدّان مستلِمين وينقص الصندوق', async () => {
    await second.goto(`${BASE}/campaigns/${camp.id}`);
    await second.getByRole('button', { name: 'اعتماد بعد التنفيذ' }).click();
    const dialog = second.getByRole('dialog');
    assert.equal(await dialog.getByRole('button', { name: 'اعتمد الكشف' }).isDisabled(), true);
    await dialog.getByLabel('مرجع التنفيذ').fill('ZC-2026-0042');
    await shot(second, '37-payout-approve');
    await dialog.getByRole('button', { name: 'اعتمد الكشف' }).click();
    await second.getByText(/اعتُمد الكشف \d+: 2 عائلة، 300,000 دينار/).waitFor();
    await second.getByText('المرجع ZC-2026-0042').waitFor();
    await second.getByText('حوالة أو محفظة').first().waitFor();
    await shot(second, '38-payout-paid');
    assert.equal(await cash(), 1700000);
    const d = await call(`/campaigns/${camp.id}`, tokens.manager);
    assert.equal(d.totals.delivered, 2);
  });

  await step('مدير التوزيع ينشئ كشفاً ولا يعتمده، ويرفضه بسببه فيتحرر صاحبه', async () => {
    const mgr = await newPage();
    await login(mgr, names.manager);
    await mgr.goto(`${BASE}/campaigns/${camp.id}`);
    await mgr.getByRole('button', { name: 'كشف دفع جديد' }).click();
    const dialog = mgr.getByRole('dialog');
    await dialog.getByLabel('طريقة الدفع').selectOption('TRANSFER');
    await dialog.getByLabel('مكتب الحوالة أو المصرف').fill('مكتب الصيرفة');
    await dialog.getByRole('button', { name: 'اختر الكل' }).click();
    await dialog.getByText('1 عائلة · 150,000 دينار').waitFor();
    await dialog.getByRole('button', { name: 'أنشئ الكشف' }).click();
    await mgr.getByText(/أُنشئ الكشف \d+/).waitFor();
    assert.equal(await mgr.getByRole('button', { name: 'اعتماد بعد التنفيذ' }).count(), 0, 'مدير التوزيع لا يعتمد صرفاً');
    await mgr.getByRole('button', { name: 'رفض' }).click();
    await mgr.getByRole('dialog').getByRole('textbox').fill('المكتب مغلق هذا الأسبوع');
    await mgr.getByRole('dialog').getByRole('button', { name: 'ارفض الكشف' }).click();
    await mgr.getByText('رُفض الكشف وتحرّر أصحابه').waitFor();
    assert.equal((await call(`/campaigns/${camp.id}/payout-candidates`, tokens.accountant)).length, 2);
    assert.equal(await cash(), 1700000);
  });
});
