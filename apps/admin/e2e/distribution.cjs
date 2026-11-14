/**
 * معيار قبول الخطوة 6 في المتصفح: حملة تُنشأ وتُعتمد من موظف آخر، تُطبع رموزها، يُسلَّم بها مرة،
 * ويُرفض الرمز المستعمل والمزوَّر، ثم تُقفل.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... node e2e/distribution.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const { BASE, RUN, call, login, setupUsers, approvedFamily, run } = require('./lib.cjs');

run(async ({ step, shot, newPage }) => {
  const { tokens, names } = await setupUsers([
    ['researcher', 'FIELD_RESEARCHER', 'باحث ميداني'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف المستفيدين'],
    ['manager', 'DISTRIBUTION_MANAGER', 'مدير التوزيع'], ['distributor', 'DISTRIBUTOR', 'موظف توزيع'],
  ]);
  const heads = ['سعاد كريم عبد الله الدليمي', 'رعد شاكر محمود الفهداوي', 'نور ياسين محمود الجميلي', 'حسين علي جاسم المحمدي'];
  const fams = [];
  for (const [i, name] of heads.entries()) fams.push(await approvedFamily(tokens, { name, nid: `1975${RUN}0${i}`, kids: i }));
  await call('/programs', tokens.admin, { name: 'السلة الغذائية', kind: 'IN_KIND', unit: 'سلة', rules: {}, amount: { type: 'FIXED', value: 1 }, minGapDays: 25 });
  await call('/points', tokens.admin, { name: 'الجولان' });

  const manager = await newPage();
  const adminPage = await newPage();
  const desk = await newPage();
  let campaignUrl, cards;

  await step('مدير التوزيع ينشئ حملة من البرنامج ويضيف نقطة ثانية', async () => {
    await login(manager, names.manager);
    await manager.getByRole('link', { name: 'حملات التوزيع' }).click();
    await manager.getByRole('link', { name: 'حملة جديدة' }).click();
    const dialog = manager.getByRole('main');
    const next = () => dialog.getByRole('button', { name: 'التالي' }).click();
    await dialog.getByLabel('البرنامج').selectOption({ label: 'السلة الغذائية' });
    await dialog.getByText('يستحقه الآن 4 عائلة').waitFor();
    await dialog.getByLabel('اسم الحملة').fill('سلة تشرين الثاني');
    await next();
    await dialog.getByText('عائلة تطابق القواعد').waitFor();
    await next();
    await dialog.getByRole('heading', { name: 'من يدخل الحملة' }).waitFor();
    await next();
    await dialog.getByLabel('الجولان', { exact: true }).check();
    await dialog.getByLabel('نقطة جديدة').fill('الشهداء');
    await dialog.getByRole('button', { name: 'أضف النقطة' }).click();
    await dialog.getByLabel('الشهداء', { exact: true }).waitFor();
    await next();
    await dialog.getByRole('heading', { name: 'راجع قبل الحفظ' }).waitFor();
    await dialog.getByRole('button', { name: 'أنشئ المسودة' }).click();
    await manager.getByRole('heading', { name: 'سلة تشرين الثاني' }).waitFor();
    await manager.getByText('مسودة', { exact: true }).waitFor();
    campaignUrl = manager.url();
  });

  await step('لا يعتمد حملته بنفسه، ولا رموز قبل الاعتماد', async () => {
    await manager.getByRole('button', { name: 'أرسل للاعتماد' }).click();
    await manager.getByText('هذه الحملة أنشأتَها أنت').waitFor();
    assert.equal(await manager.getByRole('button', { name: 'اعتماد الحملة' }).count(), 0);
    assert.equal(await manager.getByRole('link', { name: 'الرموز للطباعة' }).count(), 0);
  });

  await step('المدير يعتمدها بعد أن يرى أرقامها، فتصير جارية', async () => {
    await login(adminPage, 'admin', process.env.ADMIN_PASSWORD);
    await adminPage.goto(campaignUrl);
    await adminPage.getByRole('button', { name: 'اعتماد الحملة' }).click();
    const dialog = adminPage.getByRole('dialog');
    await dialog.getByText('4 سلة').waitFor();
    await dialog.getByText('4 عائلة').waitFor();
    await dialog.getByRole('button', { name: 'اعتماد الحملة' }).click();
    await adminPage.getByText('اعتُمدت الحملة وصدرت رموزها').waitFor();
    await adminPage.getByText('جارية', { exact: true }).waitFor();
  });

  await step('بطاقات الرموز تُعرض للطباعة برمز QR ورمز رقمي', async () => {
    await manager.reload();
    await manager.getByRole('link', { name: 'الرموز للطباعة' }).click();
    await manager.locator('article svg').first().waitFor();
    cards = await manager.locator('article').evaluateAll((els) => els.map((el) => ({
      token: el.dataset.token, text: el.innerText, familyNo: (el.innerText.match(/رقم العائلة: (\d+)/) ?? [])[1], code: (el.innerText.match(/\b(\d{8})\b/) ?? [])[1],
    })));
    assert.equal(cards.length, 4);
    assert.ok(cards.every((c) => c.token.startsWith('E1.') && c.familyNo && c.code));
    await shot(manager, '16-tokens');
  });

  await step('موظف التوزيع يمسح الرمز، يختار المستلم، ويسلّم', async () => {
    await login(desk, names.distributor);
    assert.equal(await desk.getByRole('link', { name: 'حملات التوزيع' }).count(), 0);
    await desk.getByRole('link', { name: 'شبّاك التسليم' }).click();
    await desk.getByLabel('نقطتك').selectOption({ label: 'الجولان' });
    await desk.getByLabel('امسح الرمز هنا').fill(cards[0].token);
    await desk.keyboard.press('Enter');
    await desk.getByText('الرمز صحيح').waitFor();
    await desk.getByText(`العائلة ${cards[0].familyNo}`).waitFor();
    assert.equal(await desk.getByRole('button', { name: 'سلّم وسجّل' }).isDisabled(), true);
    await shot(desk, '17-desk-check');
    await desk.getByRole('button', { name: /رب الأسرة/ }).click();
    await desk.getByRole('button', { name: 'سلّم وسجّل' }).click();
    await desk.getByText('تمّ التسليم').waitFor();
    await shot(desk, '18-desk-done');
  });

  await step('صورة التسليم تُرفق', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-proof')]);
    await desk.getByLabel('صورة التسليم').setInputFiles({ name: 'proof.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    await desk.getByText('حُفظت صورة التسليم').waitFor();
    await desk.getByRole('button', { name: 'امسح التالي' }).click();
  });

  await step('الرمز نفسه مرة ثانية: «لا تسلّم»، ويُعرض من استلم ومتى', async () => {
    await desk.getByLabel('امسح الرمز هنا').fill(cards[0].token);
    await desk.keyboard.press('Enter');
    await desk.getByText('لا تسلّم', { exact: true }).waitFor();
    await desk.getByText('هذا الرمز استُعمل من قبل').waitFor();
    await desk.getByText('في الجولان').waitFor();
    await shot(desk, '19-desk-refused');
    await desk.getByRole('button', { name: 'امسح التالي' }).click();
  });

  await step('الرمز المزوَّر يُرفض، والرمز الرقمي مع رقم العائلة يُقبل', async () => {
    await desk.getByLabel('امسح الرمز هنا').fill(cards[1].token.slice(0, -6) + 'AAAAAA');
    await desk.keyboard.press('Enter');
    await desk.getByText('رمز غير صحيح أو مزوَّر').waitFor();
    await desk.getByRole('button', { name: 'امسح التالي' }).click();
    await desk.getByLabel('رقم العائلة').fill(cards[1].familyNo);
    await desk.getByLabel('الرمز الرقمي').fill(cards[1].code);
    await desk.getByRole('button', { name: 'تحقق' }).nth(1).click();
    await desk.getByText('الرمز صحيح').waitFor();
    await desk.getByRole('button', { name: /رب الأسرة/ }).click();
    await desk.getByRole('button', { name: 'سلّم وسجّل' }).click();
    await desk.getByText('تمّ التسليم').waitFor();
  });

  await step('صفحة الحملة تعرض ما سُلِّم وما رُفض، وملف العائلة يعرض ما استلمته', async () => {
    await manager.goto(campaignUrl);
    await manager.getByText('ما رُفض وما كُشف (2)').waitFor();
    await manager.getByText('50%').waitFor();
    await manager.getByText('بصورة').first().waitFor();
    await shot(manager, '20-campaign');
    await manager.getByRole('link', { name: cards[0].familyNo }).first().click();
    await manager.getByRole('heading', { name: 'ما استلمته العائلة' }).waitFor();
    await manager.getByText('1 سلة · سلة تشرين الثاني').waitFor();
  });

  await step('الإقفال يبيّن كم عائلة لم تستلم، ثم يُلغي رموزها', async () => {
    await manager.goto(campaignUrl);
    await manager.getByRole('button', { name: 'إقفال الحملة' }).click();
    const dialog = manager.getByRole('dialog');
    await dialog.getByText('تُلغى رموز 2 عائلة').waitFor();
    await dialog.getByRole('button', { name: 'إقفال الحملة' }).click();
    await manager.getByText('مُقفلة', { exact: true }).waitFor();
    await desk.reload();
    await desk.getByLabel('الحملة').locator('option', { hasText: 'لا حملة جارية' }).waitFor({ state: 'attached' });
    await desk.getByText('اختر الحملة ونقطتك لتبدأ التسليم').waitFor();
  });
});
