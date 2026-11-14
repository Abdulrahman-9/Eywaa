/**
 * قسم المتعهدين وصناديق التبرعات في المتصفح: المدير يضيف المتعهد بهاتفه، المحاسب ينشئ صندوقاً ويسجّل فتحه،
 * ما حصّله المتعهد وتسلّمه يظهر في ذمته، المحاسب يستلم منها بسند يُطبع، أمين المخزن يستلم التبرع العيني،
 * وكشف حساب الصندوق يجمع المصادر، ومدير التوزيع يجعل متعهداً مسؤول نقطة في حملة.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/agents.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const { RUN, PASSWORD, TEMP, call, login, setupUsers, firstLogin, approvedFamily, run } = require('./lib.cjs');

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

run(async ({ step, shot, newPage }) => {
  const { tokens, names } = await setupUsers([
    ['accountant', 'ACCOUNTANT', 'المحاسب'], ['manager', 'DISTRIBUTION_MANAGER', 'مدير التوزيع'], ['manager2', 'DISTRIBUTION_MANAGER', 'مدير توزيع ثانٍ'],
    ['keeper', 'STOREKEEPER', 'أمين المخزن'], ['researcher', 'FIELD_RESEARCHER', 'باحث'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف'],
  ]);
  const agentUser = `agent${RUN}`;
  const admin = await newPage();
  const acc = await newPage();
  const mgr = await newPage();
  const keeper = await newPage();
  let agentToken, agentId, boxId;

  await step('المدير يضيف المتعهد باسمه وهاتفه، وتُنشأ نقطته معه', async () => {
    await login(admin, 'admin', process.env.ADMIN_PASSWORD);
    await admin.getByRole('link', { name: 'المتعهدون' }).click();
    await admin.getByText('لا متعهد بعد').waitFor();
    await admin.getByRole('button', { name: 'أضف متعهداً' }).click();
    const d = admin.getByRole('dialog');
    await d.getByLabel('الاسم الكامل').fill('أبو أحمد الحلبوسي');
    await d.getByLabel('اسم المستخدم').fill(agentUser);
    await d.getByLabel('كلمة مرور مؤقتة').fill(TEMP);
    // الهاتف لازم: الزر معطّل دونه.
    assert.equal(await d.getByRole('button', { name: 'أضف المتعهد' }).isDisabled(), true);
    await d.getByLabel('رقم الهاتف').fill('0770 123 4567');
    await d.getByRole('button', { name: 'أضف المتعهد' }).click();
    await admin.getByText('أُضيف المتعهد وأُنشئت نقطته').waitFor();
    await admin.getByRole('heading', { name: /أبو أحمد الحلبوسي/ }).waitFor();
    await admin.getByRole('link', { name: '07701234567' }).waitFor();
    agentId = admin.url().split('/').pop();
    // كلمته مؤقتة: يغيّرها عند أول دخول، وقبل ذلك لا يفتح له الخادم شيئاً.
    agentToken = await firstLogin(agentUser);
    assert.ok(agentToken);
  });

  await step('المحاسب ينشئ صندوق تبرعات بموقعه وصاحبه ومتعهده', async () => {
    await login(acc, names.accountant);
    await acc.getByRole('link', { name: 'صناديق التبرعات' }).click();
    await acc.getByText('لا صندوق بعد').waitFor();
    await acc.getByRole('button', { name: 'صندوق جديد' }).click();
    const d = acc.getByRole('dialog');
    await d.getByLabel('الموقع', { exact: true }).fill('أسواق الجولان');
    await d.getByLabel('العنوان', { exact: true }).fill('شارع المستشفى، قرب الصيدلية');
    await d.getByLabel('صاحب الموقع', { exact: true }).fill('أبو عمر');
    await d.getByLabel('هاتفه').fill('07901112233');
    await d.getByLabel('تدخل تحصيلاته صندوق').selectOption({ label: 'الصندوق العام' });
    await d.getByLabel('المتعهد المحصِّل').selectOption({ label: 'أبو أحمد الحلبوسي' });
    await d.getByLabel('تاريخ وضعه').fill(daysAgo(100).slice(0, 10));
    await d.getByRole('button', { name: 'أضف الصندوق' }).click();
    await acc.getByText('أُضيف الصندوق 1').waitFor();
    const card = acc.getByTestId('box-card');
    await card.getByText('أسواق الجولان').waitFor();
    await card.getByText(/لم يُفتح قط/).waitFor();
    boxId = (await call('/boxes', tokens.accountant)).boxes[0].id;
  });

  await step('المتعهد يحصّل ويتسلّم تبرعات من هاتفه فتدخل ذمته', async () => {
    for (const [amount, ago] of [[90000, 70], [60000, 40], [45000, 12]]) {
      const c = await call(`/boxes/${boxId}/collections`, agentToken, { amount, collectedAt: daysAgo(ago), sealNo: `خ-${ago}` });
      assert.ok(c.entryNo, JSON.stringify(c));
    }
    const cash = await call('/agent-donations', agentToken, { kind: 'CASH', donorName: 'حاتم عبد الله', donorPhone: '07905556677', amount: 250000, purpose: 'كفالة يتيم' });
    assert.equal(cash.status, 'RECEIVED');
    const kind = await call('/agent-donations', agentToken, { kind: 'IN_KIND', donorName: 'مطحنة الفرات', itemText: 'طحين صفر', quantity: 40, unit: 'كيس' });
    assert.equal(kind.status, 'REPORTED');
    await call('/quick-requests', agentToken, { headName: 'كريم جبار سلمان الدليمي', mahalla: 'الجولان', note: 'أرملة وخمسة أيتام' });
    const fam = await approvedFamily(tokens, { name: 'سعاد خلف عبيد الجميلي', nid: `1977${RUN}01` });
    const req = await call('/agent/family-requests', agentToken, { familyNo: fam.familyNo, reason: 'توفي رب الأسرة وانتقلت العائلة' });
    assert.equal(req.already, false, JSON.stringify(req));
    const mine = await call('/agent/me', agentToken);
    assert.equal(mine.custody.balance, 445000);
  });

  await step('صفحة الصناديق تعرض آخر فتح ومعدَّله، وسجل الفتح بسنداته', async () => {
    await acc.reload();
    const card = acc.getByTestId('box-card');
    await card.getByText('45,000').waitFor();
    await card.getByText('65,000').waitFor();
    await acc.getByText('حصيلة الصناديق في 12 شهراً').waitFor();
    await acc.waitForTimeout(500);
    await shot(acc, '40-boxes');
    await card.click();
    const d = acc.getByRole('dialog');
    await d.getByText('195,000').waitFor();
    assert.equal(await d.getByTestId('collection').count(), 3);
    await d.getByText('ختم خ-12').waitFor();
    await acc.waitForTimeout(500);
    await shot(acc, '41-box');
  });

  await step('المحاسب يسجّل فتحاً جرى في المركز فيدخل النقد مباشرة', async () => {
    const d = acc.getByRole('dialog');
    await d.getByRole('button', { name: 'سجّل فتحاً' }).click();
    await d.getByRole('button', { name: 'فُتح في المركز' }).click();
    await d.getByText('يدخل المبلغ نقد «الصندوق العام» مباشرة').waitFor();
    await d.getByLabel('ما عُدّ فيه بالدينار').fill('7000');
    await d.getByRole('button', { name: 'سجّل الفتح' }).click();
    await acc.getByText(/سُجّل الفتح: 7,000 دينار بالسند/).waitFor();
    await d.getByText(/فُتح في المركز أمام/).waitFor();
    assert.equal(await d.getByTestId('collection').count(), 4);
    await d.getByRole('button', { name: 'أغلق النافذة' }).click();
  });

  await step('مدير التوزيع يتابع المتعهدين: الذمة والنشاط وما يستوجب النظر', async () => {
    await login(mgr, names.manager);
    await mgr.getByRole('link', { name: 'المتعهدون' }).click();
    const card = mgr.getByTestId('agent-card');
    await card.getByText('أبو أحمد الحلبوسي').waitFor();
    await card.getByText('445,000').first().waitFor();
    await card.getByText(/تبرع عيني بلّغ به ولم يُستلم/).waitFor();
    // لا يضيف متعهداً: ذاك للمدير وحده.
    assert.equal(await mgr.getByRole('button', { name: 'أضف متعهداً' }).count(), 0);
    await mgr.waitForTimeout(500);
    await shot(mgr, '42-agents');
    await mgr.getByRole('button', { name: /التبرعات المسجَّلة/ }).click();
    await mgr.getByText('250,000 دينار').waitFor();
    assert.equal(await mgr.getByTestId('donation').count(), 2);
    await mgr.getByRole('button', { name: /^المتعهدون/ }).click();
    await card.click();
    await mgr.getByRole('heading', { name: 'سجل نشاطه' }).waitFor();
    await mgr.getByText('سجّل تبرعاً نقدياً 250,000 من حاتم عبد الله').waitFor();
    await mgr.getByText(/فتح الصندوق 1 وعدّ فيه 45,000/).waitFor();
    await mgr.getByText(/طلب تعديل بيانات عائلة/).waitFor();
    await mgr.waitForTimeout(500);
    await shot(mgr, '43-agent');
    await mgr.getByRole('button', { name: 'الحملات والطلبات' }).click();
    await mgr.getByText('إضافة: كريم جبار سلمان الدليمي').waitFor();
    await mgr.getByText('ينتظر زيارة').waitFor();
    // لا يستلم الذمة: ذاك للمحاسب.
    assert.equal(await mgr.getByRole('button', { name: 'استلم من ذمته' }).count(), 0);
  });

  await step('المحاسب يستلم من ذمة المتعهد جزءاً بسند يُطبع، ويبقى الباقي عليه', async () => {
    await acc.goto(`${acc.url().split('/boxes')[0]}/agents/${agentId}`);
    await acc.getByRole('button', { name: 'الذمة النقدية' }).click();
    assert.equal(await acc.getByTestId('custody-balance').innerText(), '445,000');
    await acc.getByRole('button', { name: 'استلم من ذمته' }).click();
    const d = acc.getByRole('dialog');
    await d.getByLabel('المبلغ المستلَم بالدينار').fill('500000');
    await d.getByText(/في ذمته 445,000 فقط/).waitFor();
    assert.equal(await d.getByRole('button', { name: 'سجّل الاستلام' }).isDisabled(), true);
    await d.getByLabel('المبلغ المستلَم بالدينار').fill('300000');
    await d.getByText('يبقى في ذمته 145,000').waitFor();
    await d.getByRole('button', { name: 'سجّل الاستلام' }).click();
    await acc.getByText(/استُلم 300,000 بالقيد .* بقي في ذمته 145,000/).waitFor();
    const v = acc.getByTestId('voucher');
    await v.getByText('استلام ذمة').first().waitFor();
    await v.getByText('فقط ثلاثمئة ألف دينار عراقي لا غير').waitFor();
    await v.getByRole('cell', { name: 'ذمة أبو أحمد الحلبوسي' }).waitFor();
    await acc.waitForTimeout(500);
    await shot(acc, '44-voucher');
    await acc.getByRole('button', { name: 'أغلق', exact: true }).click();
    await acc.getByTestId('custody-balance').getByText('145,000').waitFor();
    await acc.waitForTimeout(500);
    await shot(acc, '45-agent-cash');
  });

  await step('أمين المخزن يستلم التبرع العيني بما وجد، والفرق بسببه', async () => {
    await call('/inventory/items', tokens.keeper, { name: 'طحين', unit: 'كيس' });
    await login(keeper, names.keeper);
    await keeper.getByRole('link', { name: 'المخازن' }).click();
    await keeper.getByText('تبرعات عينية بلّغ بها المتعهدون وتنتظر الاستلام (1)').waitFor();
    await keeper.getByRole('button', { name: 'استلمه في المخزن' }).click();
    const d = keeper.getByRole('dialog');
    await d.getByLabel('الصنف في المخزن').selectOption({ label: 'طحين (كيس)' });
    await d.getByLabel('الكمية المستلَمة').fill('38');
    await d.getByText('المبلَّغ 40 والمستلَم 38').waitFor();
    assert.equal(await d.getByRole('button', { name: 'أدخله المخزن' }).isDisabled(), true);
    await d.getByLabel('سبب الفرق (لازم)').fill('كيسان ممزقان');
    await d.getByRole('button', { name: 'أدخله المخزن' }).click();
    await keeper.getByText('دخل التبرع المخزن وارداً باسم المتبرع').waitFor();
    await keeper.getByText('تبرعات عينية بلّغ بها المتعهدون').waitFor({ state: 'detached' });
    const stock = await call('/inventory/stock', tokens.keeper);
    assert.equal(stock.items.find((i) => i.name === 'طحين').main, 38);
  });

  await step('كشف حساب الصندوق: رصيد جارٍ ومصادر إيراد، وما في الذمم', async () => {
    await acc.getByRole('link', { name: 'الصندوق والمحاسبة' }).click();
    await acc.getByRole('row', { name: /الصندوق العام/ }).getByRole('link', { name: 'كشف الحساب' }).click();
    await acc.getByRole('heading', { name: /كشف حساب «الصندوق العام»/ }).first().waitFor();
    await acc.getByRole('button', { name: 'كل المدة' }).click();
    // نقد الصندوق: 7,000 فُتح في المركز + 300,000 استُلم من الذمة.
    await acc.getByTestId('closing').getByText('307,000').waitFor();
    const main = acc.getByRole('main');
    await main.getByText('صناديق التبرعات').waitFor();
    await main.getByText('تبرعات بيد المتعهدين').waitFor();
    await main.getByText('145,000').first().waitFor();
    await acc.waitForTimeout(500);
    await shot(acc, '46-statement');
  });

  await step('مدير التوزيع يجعل المتعهد مسؤول نقطة ثابتة في حملة', async () => {
    for (const [i, name] of ['ثامر حميد لطيف العزاوي', 'وسام رحيم كاطع الساعدي'].entries()) await approvedFamily(tokens, { name, nid: `1969${RUN}0${i}` });
    const program = await call('/programs', tokens.admin, { name: 'لحوم الأضاحي', kind: 'IN_KIND', unit: 'كغم', rules: {}, amount: { type: 'FIXED', value: 2 }, minGapDays: 0 });
    const point = await call('/points', tokens.manager, { name: 'جامع الفرقان' });
    const camp = await call('/campaigns', tokens.manager, { name: 'أضاحي العيد', programId: program.id, startsOn: '2026-01-01', endsOn: '2099-12-31', pointIds: [point.id] });
    await call(`/campaigns/${camp.id}/submit`, tokens.manager, {});
    await call(`/campaigns/${camp.id}/approve`, tokens.manager2, {});
    await mgr.goto(`${mgr.url().split('/agents')[0]}/campaigns/${camp.id}`);
    await mgr.getByLabel('مسؤول نقطة جامع الفرقان').selectOption({ label: 'أبو أحمد الحلبوسي' });
    await mgr.getByText('عُيّن مسؤول النقطة: عوائلها صارت حصته في هذه الحملة').waitFor();
    const mine = await call('/agent/assignments', agentToken);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].pointName, 'جامع الفرقان');
    assert.equal(mine[0].families, 3);
  });

  await step('المتعهد لا يدخل هذه الصفحات، والمدقق يراها ولا يغيّر', async () => {
    assert.equal((await call('/agents/overview', agentToken)).statusCode, 403);
    assert.equal((await call('/boxes', agentToken)).statusCode, 403);
    assert.equal((await call('/boxes', tokens.manager, { location: 'محل', fundId: boxId })).statusCode, 403);
  });
});
