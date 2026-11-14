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

  await step('تحضير الحملة: كل شرط يضيّق، والمعاينة تتبع', async () => {
    await mgr.getByRole('link', { name: 'حملات التوزيع' }).click();
    await mgr.getByRole('link', { name: 'حملة جديدة' }).click();
    await mgr.getByLabel('البرنامج').selectOption({ label: 'لحوم الأضاحي' });
    await mgr.getByLabel('اسم الحملة').fill('أضاحي العيد');
    await mgr.getByLabel('الجامع الكبير', { exact: true }).check();
    await mgr.getByTestId('final').waitFor();
    await mgr.waitForFunction(() => document.querySelector('[data-testid=final]')?.textContent === '7');
    await mgr.getByLabel('أقل عدد أفراد').fill('3');
    await mgr.waitForFunction(() => document.querySelector('[data-testid=final]')?.textContent === '5');
    await mgr.getByLabel('الأَولى فالأَولى').selectOption('POINTS');
    await mgr.getByLabel('كم عائلة تستهدف؟').fill('3');
    await mgr.waitForFunction(() => document.querySelector('[data-testid=final]')?.textContent === '3');
    // الأعلى نقاطاً من ذوات الثلاثة فأكثر: الثالثة والرابعة والخامسة (السادسة والسابعة دخلهما كبير).
    const shown = await mgr.locator('tbody tr td:nth-child(2)').allTextContents();
    assert.deepEqual([...shown].sort(), [fams[2], fams[3], fams[4]].map((f) => f.familyNo).sort());
  });

  await step('العدد المستهدف أكبر مما طابق القواعد: يُعرض النقص، ويُكمَل بالتقريب أو بالترشيح', async () => {
    const waitFinal = (n) => mgr.waitForFunction((x) => document.querySelector('[data-testid=final]')?.textContent === x, String(n));
    await mgr.getByLabel('كم عائلة تستهدف؟').fill('6');
    await mgr.getByRole('heading', { name: 'ينقص 1 عن العدد المستهدف (6)' }).waitFor();
    const gap = mgr.getByRole('region', { name: 'إكمال العدد' });
    // التقريب: أقرب حدّ يسدّ النقص هو 2 أفراد، لا 1.
    const relax = gap.locator('li', { hasText: 'أقل عدد الأفراد من 3 إلى 2' });
    await relax.getByText('+1 عائلة · يسدّ النقص').waitFor();
    // الترشيح: الأقرب إلى القواعد بسببه.
    await gap.locator(`[data-nominee="${fams[1].familyNo}"]`).getByText(/لم تستفد من المركز قط · خارج القواعد: أفرادها 2/).waitFor();
    await shot(mgr, '50-campaign-gap');
    await relax.getByRole('button', { name: 'طبّق' }).click();
    assert.equal(await mgr.getByLabel('أقل عدد أفراد').inputValue(), '2', 'التقريب يغيّر القاعدة الظاهرة');
    await waitFinal(6);
    assert.equal(await mgr.getByRole('region', { name: 'إكمال العدد' }).count(), 0);
    // يُرجَع الحدّ، ويُكمَل هذه المرة بالترشيح.
    await mgr.getByLabel('أقل عدد أفراد').fill('3');
    await mgr.getByRole('heading', { name: 'ينقص 1 عن العدد المستهدف (6)' }).waitFor();
    await mgr.getByRole('button', { name: 'اقبل أول 1' }).waitFor();
    await mgr.locator(`[data-nominee="${fams[1].familyNo}"]`).getByRole('button', { name: 'رشّحها' }).click();
    await waitFinal(6);
    await mgr.locator('tbody tr', { hasText: fams[1].familyNo }).getByText('بالترشيح').waitFor();
    // تُخرَج المرشَّحة ويعود العدد إلى ما كان، ليمضي الاختبار على ثلاث.
    await mgr.locator('tbody tr', { hasText: fams[1].familyNo }).getByRole('button', { name: 'استثنِ' }).click();
    await mgr.getByLabel('كم عائلة تستهدف؟').fill('3');
    await waitFinal(3);
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
    await mgr.waitForFunction(() => document.querySelector('button[disabled]')?.textContent?.includes('أنشئ المسودة') || [...document.querySelectorAll('button')].some((b) => b.textContent === 'أنشئ المسودة' && b.disabled));
    await mgr.getByRole('button', { name: 'أزلها' }).click();
    await mgr.waitForFunction(() => document.querySelector('[data-testid=final]')?.textContent === '4');
    await shot(mgr, '44-campaign-new');
    await mgr.getByRole('button', { name: 'أنشئ المسودة' }).click();
    await mgr.getByRole('heading', { name: 'أضاحي العيد' }).waitFor();
    campaignUrl = mgr.url();
  });

  await step('صفحة الحملة تحفظ كيف اختيرت عوائلها، والمسودة تُعدَّل باليد', async () => {
    await mgr.getByText('الأفراد 3 إلى ما فوق').waitFor();
    await mgr.getByText('المستهدف 3 عائلة، الأعلى نقاطاً أولاً').waitFor();
    await mgr.getByText('أُضيفت باليد: 1').waitFor();
    await mgr.getByText('استُثنيت باليد: 1').waitFor();
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

  await step('بعد الاعتماد: لا تعديل، والدعوة خرجت لكل عائلة، وتسليم واحد يظهر في الكشف', async () => {
    await mgr.getByRole('button', { name: 'أرسل للاعتماد' }).click();
    const id = campaignUrl.split('/').pop();
    await call(`/campaigns/${id}/approve`, tokens.admin, {});
    await mgr.reload();
    await mgr.getByText('جارية', { exact: true }).waitFor();
    assert.equal(await mgr.getByRole('button', { name: 'احذف' }).count(), 0);
    assert.equal(await mgr.getByRole('main').getByLabel('أضف عائلة برقمها').count(), 0);
    const msgs = await call(`/families/${fams[2].id}/messages`, tokens.supervisor);
    assert.ok(msgs.some((m) => m.kind === 'CAMPAIGN_INVITE' && /أحضروا هذا الرمز: \d{8}/.test(m.text)));
    const toks = await call(`/campaigns/${id}/tokens`, tokens.manager);
    const point = (await call(`/campaigns/${id}`, tokens.manager)).points[0].id;
    const t = toks.find((x) => x.familyNo === fams[2].familyNo);
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
