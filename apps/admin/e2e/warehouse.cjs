/**
 * معيار قبول الخطوة 11 في المتصفح: وارد وتحويل، تالف لا يُخصم إلا باعتماد غيره، ومطابقة حملة تُظهر الفرق المدسوس.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/warehouse.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const { BASE, RUN, call, login, setupUsers, approvedFamily, run } = require('./lib.cjs');

run(async ({ step, shot, newPage }) => {
  const { tokens, names } = await setupUsers([
    ['researcher', 'FIELD_RESEARCHER', 'باحث ميداني'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف المستفيدين'],
    ['manager', 'DISTRIBUTION_MANAGER', 'مدير التوزيع'], ['keeper', 'STOREKEEPER', 'أمين المخزن'], ['distributor', 'DISTRIBUTOR', 'موظف توزيع'],
  ]);
  for (let i = 0; i < 3; i++) await approvedFamily(tokens, { name: `عائلة تجريبية رقم ${['أولى', 'ثانية', 'ثالثة'][i]}`, nid: `1975${RUN}0${i}` });
  const point = await call('/points', tokens.admin, { name: 'الجولان' });
  const keeper = await newPage();
  const manager = await newPage();

  await step('أمين المخزن يضيف صنفاً ويسجّل وارده ويحوّل إلى النقطة', async () => {
    await login(keeper, names.keeper);
    await keeper.getByRole('link', { name: 'المخازن' }).click();
    await keeper.getByText('لا أصناف بعد').waitFor();
    await keeper.getByRole('button', { name: 'صنف جديد' }).click();
    await keeper.getByLabel('اسم الصنف').fill('سلة غذائية');
    await keeper.getByLabel('الوحدة').fill('سلة');
    await keeper.getByRole('button', { name: 'أضف الصنف' }).click();
    await keeper.getByRole('cell', { name: /سلة غذائية/ }).waitFor();

    await keeper.getByRole('button', { name: 'تسجيل وارد' }).click();
    let d = keeper.getByRole('dialog');
    await d.getByLabel('الصنف').selectOption({ index: 1 });
    await d.getByLabel('الكمية').fill('50');
    await d.getByLabel('المصدر').fill('متبرع 14');
    await d.getByRole('button', { name: 'سجّل الحركة' }).click();
    await keeper.getByText('سُجّلت الحركة').first().waitFor();

    await keeper.getByRole('button', { name: 'تحويل إلى نقطة' }).click();
    d = keeper.getByRole('dialog');
    await d.getByLabel('الصنف').selectOption({ index: 1 });
    await d.getByLabel('إلى مخزن النقطة').selectOption({ label: 'مخزن الجولان' });
    await d.getByLabel('الكمية').fill('60');
    await d.getByRole('button', { name: 'سجّل الحركة' }).click();
    await d.getByText('في المخزن 50 والمطلوب 60').waitFor();
    await d.getByLabel('الكمية').fill('2');
    await d.getByRole('button', { name: 'سجّل الحركة' }).click();
    await keeper.getByText('2 سلة سلة غذائية من المخزن الرئيس إلى مخزن الجولان').waitFor();
  });

  await step('التالف ينتظر اعتماد غير مسجِّله، ثم يُخصم', async () => {
    await keeper.getByRole('button', { name: 'تالف', exact: true }).click();
    const d = keeper.getByRole('dialog');
    await d.getByLabel('الصنف').selectOption({ index: 1 });
    await d.getByLabel('الكمية').fill('5');
    assert.equal(await d.getByRole('button', { name: 'سجّل الحركة' }).isDisabled(), true);
    await d.getByLabel('سبب التلف (لازم)').fill('سلال مبتلّة، بمحضر');
    await d.getByRole('button', { name: 'سجّل الحركة' }).click();
    await keeper.getByText('سجّلتَه أنت: يعتمده غيرك').waitFor();
    await keeper.getByRole('row', { name: /سلة غذائية/ }).getByRole('cell', { name: '48', exact: true }).waitFor();

    await login(manager, names.manager);
    await manager.getByRole('link', { name: 'المخازن' }).click();
    await manager.getByRole('button', { name: 'اعتماد', exact: true }).click();
    await manager.getByRole('dialog').getByRole('button', { name: 'اعتماد الحركة' }).click();
    await manager.getByText('اعتُمدت الحركة وخُصمت من الرصيد').waitFor();
    await manager.getByRole('row', { name: /سلة غذائية/ }).getByRole('cell', { name: '43', exact: true }).waitFor();
    await shot(manager, '23-warehouse');
  });

  await step('مطابقة الحملة تُظهر ما سُلِّم فوق ما أُرسل', async () => {
    const items = await call('/inventory/items', tokens.admin);
    const program = await call('/programs', tokens.admin, { name: 'السلة', kind: 'IN_KIND', unit: 'سلة', rules: {}, amount: { type: 'FIXED', value: 1 }, itemId: items[0].id });
    const camp = await call('/campaigns', tokens.manager, { name: 'سلة الشهر', programId: program.id, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [point.id] });
    await call(`/campaigns/${camp.id}/submit`, tokens.manager, {});
    await call(`/campaigns/${camp.id}/approve`, tokens.admin, {});
    const stock = await call('/inventory/stock', tokens.admin);
    const main = stock.warehouses.find((w) => w.main).id, wh = stock.warehouses.find((w) => !w.main).id;
    // أُرسل للحملة سلتان، وتُسلَّم ثلاث: الثالثة بلا بضاعة مرسلة.
    await call('/inventory/moves', tokens.keeper, { kind: 'RETURN', itemId: items[0].id, fromWarehouseId: wh, toWarehouseId: main, quantity: 2 });
    // التحويل من الواجهة: الحملة الجارية على الصنف تُختار سلفاً في حقل «للحملة»، وبه يدخل التحويل مطابقتها.
    await keeper.reload();
    await keeper.getByRole('button', { name: 'تحويل إلى نقطة' }).click();
    const td = keeper.getByRole('dialog');
    await td.getByLabel('الصنف').selectOption({ index: 1 });
    await td.getByLabel('إلى مخزن النقطة').selectOption({ label: 'مخزن الجولان' });
    await td.getByLabel('للحملة').waitFor();
    assert.equal(await td.getByLabel('للحملة').inputValue(), camp.id);
    await td.getByLabel('الكمية').fill('2');
    await td.getByRole('button', { name: 'سجّل الحركة' }).click();
    await keeper.getByText('سُجّلت الحركة').first().waitFor();
    const toks = await call(`/campaigns/${camp.id}/tokens`, tokens.manager);
    for (const t of toks) await call('/deliveries/redeem', tokens.distributor, { pointId: point.id, deviceId: 'd1', locate: { token: t.token }, receiver: { kind: 'HEAD' }, clientOpId: crypto.randomUUID() });

    await manager.goto(`${BASE}/campaigns/${camp.id}`);
    await manager.getByRole('heading', { name: 'مطابقة الصادر بالمسلَّم' }).waitFor();
    await manager.getByText('1 ناقصة').waitFor();
    await manager.getByText('1 سلة سُلِّمت فوق ما أُرسل إلى نقاطها').waitFor();
    await shot(manager, '24-reconcile');
    await manager.getByRole('link', { name: 'المخازن' }).click();
    await manager.getByText('-1 ناقصة').waitFor();
  });

  await step('الجرد: ما خالف الدفتر تسوية لا تغيّر الرصيد حتى يعتمدها غير من جرد، والأرقام العربية تُقرأ', async () => {
    await keeper.reload();
    await keeper.getByRole('button', { name: 'جرد', exact: true }).click();
    const d = keeper.getByRole('dialog');
    await d.getByRole('row', { name: /سلة غذائية/ }).getByRole('cell', { name: '43', exact: true }).waitFor();
    await d.getByLabel('العدّ الفعلي: سلة غذائية').fill('٤٠');
    await d.getByText('نقص 3').waitFor();
    assert.equal(await d.getByRole('button', { name: 'احفظ الجرد بفروقه' }).isDisabled(), true);
    await d.getByLabel('بيان الجرد').fill('جرد آخر الشهر');
    await shot(keeper, '25-stocktake');
    await d.getByRole('button', { name: 'احفظ الجرد بفروقه' }).click();
    await keeper.getByText('سُجّل الجرد: 1 فرق ينتظر اعتماد موظف آخر').waitFor();
    await keeper.getByRole('main').getByRole('row', { name: /سلة غذائية/ }).getByRole('cell', { name: '43', exact: true }).waitFor();
    await manager.reload();
    await manager.getByRole('button', { name: 'اعتماد', exact: true }).click();
    await manager.getByRole('dialog').getByRole('button', { name: 'اعتماد الحركة' }).click();
    await manager.getByRole('row', { name: /سلة غذائية/ }).getByRole('cell', { name: '40', exact: true }).waitFor();
  });
});
