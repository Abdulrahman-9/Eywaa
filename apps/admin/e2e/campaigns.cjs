/**
 * تحضير الحملة في المتصفح: قالب لحوم الأضاحي، تصفية العوائل وترتيبها وسقفها، الاستثناء والإضافة باليد،
 * تعديل المسودة، ثم الرجوع إلى الحملة بعد إقفالها والاستعلام عن حال عوائلها.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/campaigns.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const { BASE, RUN, call, login, setupUsers, approvedFamily, run } = require('./lib.cjs');

run(async ({ step, shot, newPage }) => {
  const { tokens, names } = await setupUsers([
    ['researcher', 'FIELD_RESEARCHER', 'باحث'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف'],
    ['manager', 'DISTRIBUTION_MANAGER', 'مدير التوزيع'], ['distributor', 'DISTRIBUTOR', 'موظف توزيع'],
  ]);
  // سبع عوائل: يزيد عدد أفرادها واحداً واحداً، والأخيرتان بدخل كبير (نقاط أقل).
  const fams = [];
  for (let i = 0; i < 7; i++) fams.push(await approvedFamily(tokens, { name: `رب الأسرة ${['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع'][i]} للتجربة`, nid: `1972${RUN}0${i}`, kids: i, income: i >= 5 ? 3000000 : 0, phone: `0771${RUN}${i}` }));
  await call('/points', tokens.admin, { name: 'الجامع الكبير' });
  const admin = await newPage();
  const mgr = await newPage();
  await login(admin, 'admin', process.env.ADMIN_PASSWORD);
  await login(mgr, names.manager);
  const final = (page) => page.getByTestId('final');
  let campaignUrl;
  let usedCode;

  await step('المدير ينشئ برنامج «لحوم الأضاحي» من قالبه', async () => {
    await admin.getByRole('link', { name: 'البرامج' }).click();
    await admin.getByRole('button', { name: 'لحوم الأضاحي' }).click();
    assert.equal(await admin.getByLabel('اسم البرنامج').inputValue(), 'لحوم الأضاحي');
    await admin.getByText('يستحقه 7 عائلة').or(admin.getByText(/7 عائلة/)).first().waitFor();
    await shot(admin, '43-program-template');
    await admin.getByRole('button', { name: 'أنشئ البرنامج' }).click();
    await admin.getByText('كغم').first().waitFor();
    await admin.getByRole('button', { name: 'لحوم الأضاحي' }).waitFor({ state: 'detached' });
    assert.equal(await admin.getByRole('button', { name: 'لحوم الصدقات' }).count(), 1);
  });

  const waitFinal = (n) => mgr.waitForFunction((x) => document.querySelector('[data-testid=final]')?.textContent === x, String(n));
  const next = () => mgr.getByRole('button', { name: 'التالي' }).click();
  const page = (n, title) => mgr.getByRole('button', { name: new RegExp(`^${n}\\. ${title}`) }).click();

  await step('المعالج صفحات: لا تُتجاوز صفحة ناقصة، وما كُتب يبقى عند الرجوع وعند تحديث الصفحة', async () => {
    await mgr.getByRole('link', { name: 'حملات التوزيع' }).click();
    await mgr.getByRole('link', { name: 'حملة جديدة' }).click();
    await mgr.getByRole('navigation', { name: 'مراحل التحضير' }).waitFor();
    assert.equal(await mgr.getByRole('button', { name: 'التالي' }).isDisabled(), true);
    assert.equal(await mgr.getByRole('button', { name: 'السابق' }).isDisabled(), true);
    assert.equal(await mgr.getByRole('button', { name: /^3\. العوائل/ }).isDisabled(), true);
    await mgr.getByText('اختر البرنامج', { exact: true }).waitFor();
    await mgr.getByLabel('البرنامج').selectOption({ label: 'لحوم الأضاحي' });
    await mgr.getByLabel('اسم الحملة').fill('أضاحي العيد');
    await waitFinal(7);
    await next();
    assert.match(mgr.url(), /\/campaigns\/new\/rules$/);
    await mgr.getByLabel('أقل عدد أفراد').fill('3');
    await waitFinal(5);
    await mgr.getByText('عائلة تطابق القواعد، من 7 متاحة.').waitFor();
    await mgr.getByLabel('الأَولى فالأَولى').selectOption('POINTS');
    // رجوع: الاسم كما كُتب. ثم تحديث الصفحة في منتصف العمل: كل شيء باقٍ.
    await mgr.getByRole('button', { name: 'السابق' }).click();
    assert.equal(await mgr.getByLabel('اسم الحملة').inputValue(), 'أضاحي العيد');
    await mgr.getByLabel('كم عائلة تستهدف؟').fill('3');
    await waitFinal(3);
    await mgr.reload();
    assert.equal(await mgr.getByLabel('اسم الحملة').inputValue(), 'أضاحي العيد');
    assert.equal(await mgr.getByLabel('كم عائلة تستهدف؟').inputValue(), '3');
    await next();
    assert.equal(await mgr.getByLabel('أقل عدد أفراد').inputValue(), '3');
    assert.equal(await mgr.getByLabel('الأَولى فالأَولى').inputValue(), 'POINTS');
    await shot(mgr, '54-wizard-rules');
    await next();
    await waitFinal(3);
    await mgr.locator('tbody tr').nth(2).waitFor();
    // الأعلى نقاطاً من ذوات الثلاثة فأكثر: الثالثة والرابعة والخامسة (السادسة والسابعة دخلهما كبير).
    const shown = await mgr.locator('tbody tr td:nth-child(2)').allTextContents();
    assert.deepEqual([...shown].sort(), [fams[2], fams[3], fams[4]].map((f) => f.familyNo).sort());
  });

  await step('العدد المستهدف أكبر مما طابق القواعد: يُعرض النقص، ويُكمَل بالتقريب أو بالترشيح', async () => {
    await page(1, 'الأساس');
    await mgr.getByLabel('كم عائلة تستهدف؟').fill('6');
    await page(3, 'العوائل');
    await mgr.getByRole('heading', { name: 'ينقص 1 عن العدد المستهدف (6)' }).waitFor();
    const gap = mgr.getByRole('region', { name: 'إكمال العدد' });
    // التقريب: أقرب حدّ يسدّ النقص هو 2 أفراد، لا 1.
    const relax = gap.locator('li', { hasText: 'أقل عدد الأفراد من 3 إلى 2' });
    await relax.getByText('+1 عائلة · يسدّ النقص').waitFor();
    // الترشيح: الأقرب إلى القواعد بسببه.
    await gap.locator(`[data-nominee="${fams[1].familyNo}"]`).getByText(/لم تستفد من المركز قط · خارج القواعد: أفرادها 2/).waitFor();
    await shot(mgr, '50-campaign-gap');
    await relax.getByRole('button', { name: 'طبّق' }).click();
    await mgr.getByText('عُدّلت القاعدة: أقل عدد الأفراد من 3 إلى 2').waitFor();
    await waitFinal(6);
    assert.equal(await mgr.getByRole('region', { name: 'إكمال العدد' }).count(), 0);
    // التقريب غيّر القاعدة نفسها في صفحتها. تُرجَع، ويُكمَل هذه المرة بالترشيح.
    await page(2, 'من يستفيد');
    assert.equal(await mgr.getByLabel('أقل عدد أفراد').inputValue(), '2');
    await mgr.getByLabel('أقل عدد أفراد').fill('3');
    await mgr.getByText('ينقص 1 عن المستهدف: يُكمَل في الصفحة التالية').waitFor();
    await next();
    await mgr.getByRole('heading', { name: 'ينقص 1 عن العدد المستهدف (6)' }).waitFor();
    await mgr.getByRole('button', { name: 'اقبل أول 1' }).waitFor();
    await mgr.locator(`[data-nominee="${fams[1].familyNo}"]`).getByRole('button', { name: 'رشّحها' }).click();
    await waitFinal(6);
    await mgr.locator('tbody tr', { hasText: fams[1].familyNo }).getByText('بالترشيح').waitFor();
    // تُخرَج المرشَّحة ويعود العدد إلى ثلاث، ليمضي الاختبار عليها.
    await mgr.locator('tbody tr', { hasText: fams[1].familyNo }).getByRole('button', { name: 'استثنِ' }).click();
    await page(1, 'الأساس');
    await mgr.getByLabel('كم عائلة تستهدف؟').fill('3');
    await waitFinal(3);
    await page(3, 'العوائل');
  });

  await step('اليدوي: استثناء عائلة من القائمة، وإضافة أخرى برقمها، ورفض من لا وجود له', async () => {
    await mgr.locator('tbody tr', { hasText: fams[3].familyNo }).getByRole('button', { name: 'استثنِ' }).click();
    await mgr.getByRole('button', { name: `${fams[3].familyNo} · أرجِعها` }).waitFor();
    await mgr.getByLabel('أضف عائلة برقمها').fill(fams[0].familyNo);
    await mgr.getByRole('button', { name: 'أضف العائلة' }).click();
    await mgr.locator('tbody tr', { hasText: fams[0].familyNo }).getByText('باليد').waitFor();
    await mgr.getByLabel('أضف عائلة برقمها').fill('9999999');
    await mgr.getByRole('button', { name: 'أضف العائلة' }).click();
    await mgr.getByText('لا عائلة معتمدة بهذا الرقم').waitFor();
    // صفحة فيها مضافة لا تدخل الحملة لا تُتجاوز.
    await mgr.getByText('في المضافة باليد عائلة لا تدخل الحملة').waitFor();
    assert.equal(await mgr.getByRole('button', { name: 'التالي' }).isDisabled(), true);
    await mgr.getByRole('button', { name: 'أزلها' }).click();
    await waitFinal(4);
    await shot(mgr, '44-campaign-new');
  });

  await step('نقاط التوزيع ثم المراجعة: كل ما اختير في صفحة واحدة، ثم تُنشأ المسودة', async () => {
    await next();
    await mgr.getByText('اختر نقطة توزيع أو متعهداً').waitFor();
    assert.equal(await mgr.getByRole('button', { name: 'التالي' }).isDisabled(), true);
    await mgr.getByLabel('الجامع الكبير', { exact: true }).check();
    await mgr.getByText(/4 عائلة على 1 جهة/).waitFor();
    await next();
    await mgr.getByRole('heading', { name: 'راجع قبل الحفظ' }).waitFor();
    const main = mgr.getByRole('main');
    await main.getByText('أضاحي العيد', { exact: true }).waitFor();
    await main.getByText('4 عائلة · 10 كغم', { exact: true }).waitFor();
    await main.getByText('الجامع الكبير', { exact: true }).waitFor();
    await main.getByText(/الأفراد 3 إلى ما فوق · المستهدف 3 عائلة، الأعلى نقاطاً أولاً · أُضيفت باليد: 1 · استُثنيت باليد: 1/).waitFor();
    await shot(mgr, '55-wizard-review');
    await mgr.getByRole('button', { name: 'أنشئ المسودة' }).click();
    await mgr.getByText('أُنشئت مسودة الحملة').waitFor();
    await mgr.getByRole('heading', { name: 'أضاحي العيد' }).waitFor();
    campaignUrl = mgr.url();
  });

  await step('صفحة الحملة تحفظ كيف اختيرت عوائلها، والمسودة تُعدَّل باليد', async () => {
    await mgr.getByText(/الأفراد 3 إلى ما فوق · المستهدف 3 عائلة، الأعلى نقاطاً أولاً · أُضيفت باليد: 1 · استُثنيت باليد: 1/).waitFor();
    await mgr.getByText('1–4 من 4').waitFor();
    await mgr.locator('tr', { hasText: fams[0].familyNo }).getByRole('button', { name: 'احذف' }).click();
    await mgr.getByRole('dialog').getByRole('textbox').fill('انتقلت إلى محافظة أخرى');
    await mgr.getByRole('dialog').getByRole('button', { name: 'احذفها من الحملة' }).click();
    await mgr.getByText('حُذفت العائلة من الحملة').waitFor();
    await mgr.getByText('1–3 من 3').waitFor();
    await mgr.getByRole('main').getByLabel('أضف عائلة برقمها').fill(fams[1].familyNo);
    await mgr.getByRole('button', { name: 'أضف العائلة' }).click();
    await mgr.getByText(`أُضيفت العائلة ${fams[1].familyNo}`).waitFor();
    await mgr.getByText('1–4 من 4').waitFor();
    await shot(mgr, '45-campaign-draft');
  });

  await step('تعديل المسودة يفتح الصفحات نفسها بما فيها، ومعه ما عُدّل باليد', async () => {
    await mgr.getByRole('link', { name: 'عدّل الحملة' }).click();
    assert.match(mgr.url(), /\/edit\/basics$/);
    await mgr.getByRole('heading', { name: 'تعديل مسودة: أضاحي العيد' }).waitFor();
    assert.equal(await mgr.getByLabel('اسم الحملة').inputValue(), 'أضاحي العيد');
    assert.equal(await mgr.getByLabel('كم عائلة تستهدف؟').inputValue(), '3');
    await mgr.getByLabel('اسم الحملة').fill('أضاحي العيد الكبير');
    await waitFinal(4);
    await next();
    assert.equal(await mgr.getByLabel('أقل عدد أفراد').inputValue(), '3');
    await next();
    // ما أُضيف وحُذف باليد في صفحة المسودة عاد هنا: الثانية مضافة، والأولى مستثناة.
    await mgr.locator('tbody tr', { hasText: fams[1].familyNo }).getByText('باليد').waitFor();
    await mgr.getByRole('button', { name: `${fams[0].familyNo} · أرجِعها` }).waitFor();
    await next();
    assert.equal(await mgr.getByLabel('الجامع الكبير', { exact: true }).isChecked(), true);
    await next();
    await mgr.getByRole('button', { name: 'احفظ التعديل' }).click();
    await mgr.getByText('حُفظ تعديل المسودة').waitFor();
    await mgr.getByRole('heading', { name: 'أضاحي العيد الكبير' }).waitFor();
    await mgr.getByText('1–4 من 4').waitFor();
  });

  await step('بعد الاعتماد: لا تعديل، والدعوة خرجت لكل عائلة، وتسليم واحد يظهر في الكشف', async () => {
    await mgr.getByRole('button', { name: 'أرسل للاعتماد' }).click();
    const id = campaignUrl.split('/').pop();
    await call(`/campaigns/${id}/approve`, tokens.admin, {});
    await mgr.reload();
    await mgr.getByText('جارية', { exact: true }).waitFor();
    assert.equal(await mgr.getByRole('button', { name: 'احذف' }).count(), 0);
    assert.equal(await mgr.getByRole('main').getByLabel('أضف عائلة برقمها').count(), 0);
    const msgs = await call(`/families/${fams[2].id}/messages`, tokens.supervisor);
    // الدعوة خرجت برمزها الرقمي؛ وسجل الرسائل في ملف العائلة يحجبه، فلا يقرؤه من لا يسلّم.
    assert.ok(msgs.some((m) => m.kind === 'CAMPAIGN_INVITE' && /أحضروا هذا الرمز: •{8}\./.test(m.text)));
    const toks = await call(`/campaigns/${id}/tokens`, tokens.manager);
    const point = (await call(`/campaigns/${id}`, tokens.manager)).points[0].id;
    const t = toks.find((x) => x.familyNo === fams[2].familyNo);
    usedCode = t.code;
    await call('/deliveries/redeem', tokens.distributor, { pointId: point, deviceId: 'desk', locate: { token: t.token }, clientOpId: crypto.randomUUID(), receiver: { kind: 'HEAD' } });
    await mgr.getByLabel('حال الاستلام').selectOption('DELIVERED');
    await mgr.getByText('1–1 من 1').waitFor();
    await mgr.locator('tr', { hasText: fams[2].familyNo }).getByText('استلمت', { exact: true }).waitFor();
    await mgr.getByLabel('حال الاستلام').selectOption('PENDING');
    await mgr.getByText('1–3 من 3').waitFor();
  });

  await step('مكان الحضور يُضبط للنقطة، والتذكير يصل من لم يستلم بعنوانها وساعاتها', async () => {
    await mgr.getByRole('button', { name: 'مكان الحضور' }).click();
    const d = mgr.getByRole('dialog');
    await d.getByLabel('العنوان').fill('شارع المستشفى، مقابل الصيدلية');
    await d.getByLabel('ساعات الحضور').fill('من 9 صباحاً إلى 2 ظهراً');
    await d.getByRole('button', { name: 'احفظ' }).click();
    await mgr.getByText('شارع المستشفى، مقابل الصيدلية · من 9 صباحاً إلى 2 ظهراً').waitFor();
    await mgr.getByRole('button', { name: 'ذكّر من لم يستلم' }).click();
    await mgr.getByText('ذُكّرت 3 عائلة لم تستلم').waitFor();
    const msgs = await call(`/families/${fams[4].id}/messages`, tokens.supervisor);
    assert.ok(msgs.some((m) => m.text.includes('الحضور إلى نقطة الجامع الكبير، شارع المستشفى، مقابل الصيدلية (من 9 صباحاً إلى 2 ظهراً)')), JSON.stringify(msgs.map((m) => m.text)));
    await mgr.getByRole('button', { name: 'ذكّر من لم يستلم' }).click();
    await mgr.getByText(/التذكير التالي بعد 12 ساعة/).waitFor();
  });

  await step('المتابعة: الصرف يوماً بيوم، وإنذار حين يُعرض الرمز المستعمل ثلاث مرات', async () => {
    const id = campaignUrl.split('/').pop();
    await mgr.getByRole('heading', { name: 'الصرف يوماً بيوم' }).waitFor();
    await mgr.getByText('سُلِّم 1 من 4، وبقي 3.').waitFor();
    await mgr.getByText('لا شيء يلفت النظر').waitFor();
    const toks = await call(`/campaigns/${id}/tokens`, tokens.manager);
    const point = (await call(`/campaigns/${id}`, tokens.manager)).points[0].id;
    // الرمز الذي سُلِّم به يُعرض ثلاث مرات أخرى. لم يبقَ في كشف الرموز، وسجل رسائل العائلة يحجبه: فيُؤخذ ممّا حُفظ قبل التسليم.
    const code = usedCode;
    for (let i = 0; i < 3; i++) await call('/deliveries/check', tokens.distributor, { pointId: point, deviceId: 'desk', locate: { campaignId: id, familyNo: fams[2].familyNo, code } });
    await mgr.reload();
    await mgr.locator('[data-alert="REPEATED_TOKEN"]').getByText('رمز مستعمل عُرض 3 مرات').waitFor();
    await shot(mgr, '51-campaign-alerts');
    await mgr.getByRole('link', { name: 'حملات التوزيع' }).click();
    await mgr.getByText('1 إنذار').waitFor();
    await mgr.goBack();
    assert.ok(toks.length >= 1);
  });

  await step('الرجوع إلى حملة سابقة: تُوجد في «السابقة»، ويُستعلم عن عائلة فيها باسمها', async () => {
    await mgr.getByRole('button', { name: 'إقفال الحملة' }).click();
    await mgr.getByRole('dialog').getByRole('button', { name: /إقفال|أقفل/ }).click();
    await mgr.getByText('مُقفلة', { exact: true }).waitFor();
    await mgr.getByRole('link', { name: 'حملات التوزيع' }).click();
    await mgr.getByRole('button', { name: 'الجارية (0)' }).waitFor();
    await mgr.getByRole('button', { name: 'السابقة (1)' }).click();
    await mgr.getByLabel('بحث باسم الحملة').fill('أضاحي');
    await mgr.getByText('استلم 1 من 4').waitFor();
    await shot(mgr, '46-campaigns-archive');
    await mgr.getByLabel('بحث باسم الحملة').fill('لا شيء');
    await mgr.getByText('لا حملة تطابق البحث.').waitFor();
    await mgr.getByLabel('بحث باسم الحملة').fill('');
    await mgr.getByRole('link', { name: /أضاحي العيد/ }).click();
    await mgr.getByLabel('ابحث في عوائل الحملة').fill('الثالث');
    await mgr.getByText('1–1 من 1').waitFor();
    await mgr.locator('tr', { hasText: fams[2].familyNo }).getByText(/رب الأسرة رب الأسرة الثالث للتجربة/).waitFor();
    await mgr.getByLabel('ابحث في عوائل الحملة').fill('');
    await mgr.getByLabel('حال الاستلام').selectOption('CANCELLED');
    await mgr.getByText('1–3 من 3').waitFor();
    await mgr.locator('tbody').getByText('لم تستلم', { exact: true }).first().waitFor();
    await shot(mgr, '47-campaign-closed');
  });
});
