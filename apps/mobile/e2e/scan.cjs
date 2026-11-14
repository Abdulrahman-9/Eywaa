/**
 * الماسح بالكاميرا: يُعطى المتصفح كاميرا وهمية تعرض رمز استلام حقيقياً (نحو 330 حرفاً)،
 * فيقرؤه التطبيق ويبلغ شاشة «من الحاضر؟». يُثبت أن الرمز الكثيف يُقرأ من إطار 1280×720.
 * التشغيل:  ADMIN_PASSWORD=... BASE_URL=http://localhost:3000 node e2e/scan.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, devices } = require('playwright');
const QRCode = require('../../admin/node_modules/qrcode');
process.env.BASE_URL ??= 'http://localhost:3000';
const { BASE, RUN, PASSWORD, call, setupUsers, approvedFamily } = require('../../admin/e2e/lib.cjs');

(async () => {
  const { tokens, names } = await setupUsers([
    ['researcher', 'FIELD_RESEARCHER', 'باحث'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف'],
    ['manager', 'DISTRIBUTION_MANAGER', 'مدير التوزيع'], ['distributor', 'DISTRIBUTOR', 'موظف توزيع'],
  ]);
  const fam = await approvedFamily(tokens, { name: `صاحب الرمز المصوَّر ${RUN}`, nid: `1969${RUN}11` });
  const program = await call('/programs', tokens.admin, { name: `سلة ${RUN}`, kind: 'IN_KIND', unit: 'سلة', rules: {}, amount: { type: 'FIXED', value: 1 }, minGapDays: 0 });
  const point = await call('/points', tokens.admin, { name: `نقطة ${RUN}` });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(new Date());
  const camp = await call('/campaigns', tokens.manager, { programId: program.id, name: `حملة المسح ${RUN}`, startsOn: today, endsOn: today, pointIds: [point.id] });
  await call(`/campaigns/${camp.id}/submit`, tokens.manager, {});
  await call(`/campaigns/${camp.id}/approve`, tokens.admin, {});
  const tok = (await call(`/campaigns/${camp.id}/tokens`, tokens.manager)).find((t) => t.familyNo === fam.familyNo);
  assert.ok(tok.token.length > 250, 'الرمز كثيف كما في الواقع');

  // إطار الكاميرا: الرمز كما يظهر على بطاقة مطبوعة ممسوكة أمام الهاتف، يشغل نحو نصف ارتفاع الإطار.
  const plain = await chromium.launch();
  const frame = await plain.newPage({ viewport: { width: 1280, height: 720 } });
  const svg = await QRCode.toString(tok.token, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  await frame.setContent(`<body style="margin:0;height:720px;display:grid;place-items:center;background:#8a8f8c"><div style="width:400px;height:400px;background:#fff">${svg}</div></body>`);
  const jpeg = await frame.screenshot({ type: 'jpeg', quality: 80 });
  await plain.close();
  const video = path.join(os.tmpdir(), `qr-${RUN}.mjpeg`);
  fs.writeFileSync(video, Buffer.concat(Array.from({ length: 30 }, () => jpeg)));

  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
  const context = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar-IQ', deviceScaleFactor: Number(process.env.DSF ?? 2), permissions: ['camera'] });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}/m/`);
    await page.getByLabel('اسم المستخدم').fill(names.distributor);
    await page.getByLabel('كلمة المرور').fill(PASSWORD);
    await page.getByRole('button', { name: 'دخول' }).click();
    for (const label of ['الرمز', 'أعد الرمز للتأكيد']) {
      await page.getByLabel(label, { exact: true }).fill('735194');
      await page.getByRole('button', { name: 'متابعة' }).click();
    }
    await page.getByRole('button', { name: 'اختر الحملة والنقطة' }).click();
    await page.getByLabel('الحملة').selectOption({ label: `حملة المسح ${RUN}` });
    await page.getByRole('button', { name: 'حمّل البيان' }).click();
    await page.getByRole('button', { name: 'سلّم', exact: true }).click();
    const started = Date.now();
    await page.getByRole('heading', { name: 'من الحاضر؟' }).waitFor({ timeout: 20000 });
    const ms = Date.now() - started;
    await page.getByText(`العائلة ${fam.familyNo}`).waitFor();
    console.log(`✓ الكاميرا قرأت رمزاً من ${tok.token.length} حرفاً وبلغت شاشة المستلم في ${ms} م.ث`);
    await page.getByRole('button', { name: `صاحب الرمز المصوَّر ${RUN}` }).click();
    await page.getByRole('heading', { name: 'سُجّل التسليم' }).waitFor();
    await page.getByRole('button', { name: 'التالي' }).click();
    // الكاميرا ما زالت ترى الرمز نفسه: يُرفض الآن لأنه استُعمل.
    await page.getByRole('heading', { name: 'لا تسلّم' }).waitFor({ timeout: 20000 });
    await page.getByText('هذا الرمز استُعمل من قبل').waitFor();
    console.log('✓ الرمز نفسه أمام الكاميرا ثانية: «لا تسلّم»');
    assert.equal((await call(`/campaigns/${camp.id}`, tokens.manager)).totals.delivered, 1);
    console.log('\n2 خطوات نجحت');
  } catch (err) {
    console.error('✗ فشل:\n', err.message);
    if (process.argv[2]) await page.screenshot({ path: `${process.argv[2]}/scan-fail.png` }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
