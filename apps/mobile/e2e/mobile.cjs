/**
 * تطبيق الميدان في متصفح بمقاس هاتف، مخدوماً من الخادم نفسه تحت /m:
 * الدخول ورمز القفل، تشفير ما على الجهاز، تحميل البيان، التسليم متصلاً ومنقطعاً، المزامنة،
 * وقطع الشبكة في منتصف المزامنة مئة مرة (معيار قبول الخطوة 7)، ثم التسجيل دون اتصال (الخطوة 8).
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... BASE_URL=http://localhost:3000 node e2e/mobile.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');
process.env.BASE_URL ??= 'http://localhost:3000';
const { BASE, RUN, PASSWORD, call, setupUsers, approvedFamily } = require('../../admin/e2e/lib.cjs');

const APP = `${BASE}/m/`;
const SHOTS = process.argv[2];
const PIN = '482915';
const PNG = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/icon-512.png'));
const steps = [];
const errors = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`✓ ${name}`); };
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

async function firstRun(page, username) {
  await page.goto(APP);
  await page.getByLabel('اسم المستخدم').fill(username);
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await page.getByRole('heading', { name: 'رمز قفل الجهاز' }).waitFor();
}
async function setPin(page) {
  await page.getByLabel('الرمز', { exact: true }).fill(PIN);
  await page.getByRole('button', { name: 'متابعة' }).click();
  await page.getByLabel('أعد الرمز للتأكيد').fill(PIN);
  await page.getByRole('button', { name: 'متابعة' }).click();
  await page.getByRole('button', { name: 'زامن الآن' }).waitFor();
}
async function unlock(page, pin = PIN) {
  await page.getByLabel('رمز القفل').fill(pin);
  await page.getByRole('button', { name: 'متابعة' }).click();
}
const pending = async (page) => Number(await page.getByTestId('pending').innerText());
/** تسليم واحد بإدخال اليد: رمز مصوَّر ملصوق، أو رقم العائلة ورمزها الرقمي. */
async function deliver(page, { token, familyNo, code }, receiver) {
  if (await page.getByRole('button', { name: 'اكتب رقم العائلة ورمزها' }).count()) await page.getByRole('button', { name: 'اكتب رقم العائلة ورمزها' }).click();
  if (familyNo) await page.getByLabel('رقم العائلة').fill(familyNo);
  await page.getByLabel('الرمز الرقمي').fill(token ?? code);
  await page.getByRole('button', { name: 'تحقّق' }).click();
  if (receiver) {
    await page.getByRole('heading', { name: 'من الحاضر؟' }).waitFor();
    await page.getByRole('button', { name: receiver }).click();
    await page.getByRole('heading', { name: 'سُجّل التسليم' }).waitFor();
  }
}

(async () => {
  const { tokens, names } = await setupUsers([
    ['researcher', 'FIELD_RESEARCHER', 'باحث ميداني'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف المستفيدين'],
    ['manager', 'DISTRIBUTION_MANAGER', 'مدير التوزيع'], ['distributor', 'DISTRIBUTOR', 'موظف توزيع'],
  ]);
  for (let i = 0; i < 44; i++) await approvedFamily(tokens, { name: `رب أسرة رقم ${i + 1} للتجربة`, nid: `1970${RUN}${String(i).padStart(2, '0')}` });
  // عائلة لها وكيل مسجَّل.
  const withProxy = await call('/families', tokens.researcher, { tags: ['NEEDY'], housing: 'RENTED', members: [{ relation: 'HEAD', fullName: 'أم حسن فاطمة جبار', gender: 'F', documents: [{ type: 'NATIONAL_CARD', number: `1971${RUN}00` }] }], incomes: [], proxies: [{ fullName: 'حسن علي جبار' }] });
  await call(`/families/${withProxy.id}/approve`, tokens.supervisor, {});
  const program = await call('/programs', tokens.admin, { name: 'السلة الغذائية', kind: 'IN_KIND', unit: 'سلة', rules: {}, amount: { type: 'FIXED', value: 1 }, minGapDays: 25 });
  const p1 = await call('/points', tokens.admin, { name: 'الجولان' });
  const p2 = await call('/points', tokens.admin, { name: 'الشهداء' });
  const today = new Date().toISOString().slice(0, 10);
  const camp = await call('/campaigns', tokens.manager, { programId: program.id, name: 'سلة الميدان', startsOn: today, endsOn: today, pointIds: [p1.id, p2.id] });
  assert.ok(camp.id, JSON.stringify(camp));
  await call(`/campaigns/${camp.id}/submit`, tokens.manager, {});
  await call(`/campaigns/${camp.id}/approve`, tokens.admin, {});
  const all = await call(`/campaigns/${camp.id}/tokens`, tokens.manager);
  assert.equal(all.length, 45);
  const here = all.filter((t) => t.point === 'الجولان');
  const elsewhere = all.filter((t) => t.point === 'الشهداء');
  const proxyTok = all.find((t) => t.headName === 'أم حسن فاطمة جبار');
  const pool = here.filter((t) => t !== proxyTok);
  const detail = () => call(`/campaigns/${camp.id}`, tokens.manager);

  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar-IQ', deviceScaleFactor: Number(process.env.DSF ?? 2) });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await step('أول استعمال: دخول بالحساب، ورمز قفل لا يُقبل منه السهل', async () => {
      await firstRun(page, names.distributor);
      await page.getByLabel('الرمز', { exact: true }).fill('123456');
      await page.getByRole('button', { name: 'متابعة' }).click();
      await page.getByText('رمز سهل التخمين').waitFor();
      await shot(page, 'm1-pin');
      await setPin(page);
      await page.getByText('موظف توزيع').waitFor();
    });

    await step('ما على الجهاز مشفّر: لا اسم ولا رمز جلسة يُقرأ من المخزن', async () => {
      const dump = await page.evaluate(() => new Promise((resolve) => {
        const req = indexedDB.open('eywaa-mobile');
        req.onsuccess = () => {
          const all = req.result.transaction('kv').objectStore('kv').getAll('v:data');
          all.onsuccess = () => resolve(Array.from(all.result[0]).map((b) => String.fromCharCode(b)).join(''));
        };
      }));
      assert.ok(dump.length > 100);
      for (const secret of ['token', 'DISTRIBUTOR', 'eyJ', 'username']) assert.ok(!dump.includes(secret), `في المخزن نصّ مقروء: ${secret}`);
    });

    await step('تحميل بيان الحملة والنقطة والجهاز متصل', async () => {
      await page.getByRole('button', { name: 'اختر الحملة والنقطة' }).click();
      await page.getByLabel('الحملة').selectOption({ label: 'سلة الميدان' });
      await page.getByLabel('نقطة التوزيع').selectOption({ label: `الجولان (${here.length} عائلة)` });
      await shot(page, 'm2-station');
      await page.getByRole('button', { name: 'حمّل البيان' }).click();
      await page.getByText('بقي في حصتك').waitFor();
      await page.getByText(String(here.length), { exact: true }).waitFor();
      await shot(page, 'm3-home');
    });

    await step('متصلاً: تسليم برقم العائلة ورمزها يبلغ الخادم في لحظته', async () => {
      await page.getByRole('button', { name: 'سلّم', exact: true }).click();
      const t = pool[0];
      await deliver(page, { familyNo: t.familyNo, code: t.code }, t.headName);
      await page.getByText('وصل الخادم.').waitFor();
      await shot(page, 'm4-done');
      const d = await detail();
      assert.equal(d.totals.delivered, 1);
      assert.equal(d.recent[0].mode, 'ONLINE');
      await page.getByRole('button', { name: 'التالي' }).click();
    });

    await step('متصلاً: الرمز المستعمل يُرفض ويُذكر من استلم، ورمز نقطة أخرى يُقبل بتنبيه', async () => {
      await deliver(page, { familyNo: pool[0].familyNo, code: pool[0].code });
      await page.getByRole('heading', { name: 'لا تسلّم' }).waitFor();
      await page.getByText('هذا الرمز استُعمل من قبل').waitFor();
      await page.getByText(`استلمه ${pool[0].headName}`).waitFor();
      await shot(page, 'm5-refused');
      await page.getByRole('button', { name: 'التالي' }).click();
      await deliver(page, { token: elsewhere[0].token }, elsewhere[0].headName);
      await page.getByRole('button', { name: 'التالي' }).click();
      assert.equal((await detail()).totals.delivered, 2);
    });

    await step('ينقطع الاتصال: التطبيق يفتح من الجهاز، والرمز الخاطئ لا يفتحه', async () => {
      await context.setOffline(true);
      await page.reload();
      await page.getByLabel('رمز القفل').waitFor();
      await unlock(page, '111222');
      await page.getByText('رمز خاطئ').waitFor();
      await unlock(page);
      await page.getByText('منقطع').waitFor();
      assert.equal(await pending(page), 0);
    });

    await step('منقطعاً: رمز مصوَّر من حصة الجهاز يُقبل، يستلمه وكيل مسجَّل، وتُحفظ صورته', async () => {
      await page.getByRole('button', { name: 'سلّم', exact: true }).click();
      await page.getByText('الجهاز منقطع: لا يُقبل إلا من كان في حصة هذا الشبّاك').waitFor();
      await deliver(page, { token: proxyTok.token });
      await page.getByText('الجهاز منقطع: حُكم بالبيان المحمَّل.').waitFor();
      await shot(page, 'm6-receiver');
      await page.getByRole('button', { name: 'حسن علي جبار' }).click();
      await page.getByText('حُفظ على الجهاز، ويُرفع حين يتصل.').waitFor();
      await page.getByLabel('صورة التسليم').setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: PNG });
      await page.getByText('حُفظت الصورة.').waitFor();
      await page.getByRole('button', { name: 'التالي' }).click();
      assert.equal((await detail()).totals.delivered, 2, 'لم يبلغ الخادم شيء والجهاز منقطع');
    });

    await step('منقطعاً: الرمز الرقمي يُتحقَّق منه بلا خادم، والخاطئ يُرفض', async () => {
      const t = pool[1];
      const wrong = String((Number(t.code) + 7) % 100000000).padStart(8, '0');
      await deliver(page, { familyNo: t.familyNo, code: wrong });
      await page.getByText('رقم العائلة أو الرمز الرقمي غير صحيح').waitFor();
      await page.getByRole('button', { name: 'التالي' }).click();
      await deliver(page, { familyNo: t.familyNo, code: t.code }, t.headName);
      await page.getByRole('button', { name: 'التالي' }).click();
    });

    await step('منقطعاً: المكرَّر، ورمز نقطة أخرى، والمزوَّر: كلها «لا تسلّم» بسببها', async () => {
      await deliver(page, { token: proxyTok.token });
      await page.getByText('سلّمتَه أنت إلى حسن علي جبار').waitFor();
      await page.getByRole('button', { name: 'التالي' }).click();
      await deliver(page, { token: elsewhere[1].token });
      await page.getByText('ليس من حصة هذا الجهاز').waitFor();
      await shot(page, 'm7-not-mine');
      await page.getByRole('button', { name: 'التالي' }).click();
      await deliver(page, { token: pool[2].token.slice(0, -6) + 'AAAAAA' });
      await page.getByText('رمز غير صحيح أو مزوَّر').waitFor();
      await page.getByRole('button', { name: 'التالي' }).click();
      await page.getByRole('button', { name: 'رجوع' }).click();
      assert.equal(await pending(page), 2);
    });

    await step('يعود الاتصال: ما على الجهاز يُرفع وحده، باسم المستلم وصورته', async () => {
      await context.setOffline(false);
      await page.waitForFunction(() => document.querySelector('[data-testid=pending]')?.textContent === '0', null, { timeout: 15000 });
      const d = await detail();
      assert.equal(d.totals.delivered, 4);
      const viaProxy = d.recent.find((r) => r.familyNo === proxyTok.familyNo);
      assert.equal(viaProxy.mode, 'OFFLINE');
      assert.equal(viaProxy.receiverName, 'حسن علي جبار');
      assert.equal(viaProxy.hasProof, true);
      assert.equal(d.incidents.filter((i) => i.kind === 'DOUBLE_DELIVERY').length, 0);
    });

    await step('الشبكة تُقطع في منتصف المزامنة 100 مرة: لا عملية تُفقد ولا تتكرر', async () => {
      await context.setOffline(true);
      await page.getByRole('button', { name: 'سلّم', exact: true }).click();
      const batch = pool.slice(2, 16);
      for (const t of batch.slice(0, 8)) { await deliver(page, { token: t.token }, t.headName); await page.getByRole('button', { name: 'التالي' }).click(); }
      await page.getByRole('button', { name: 'رجوع' }).click();
      await context.setOffline(false);
      let reached = 0, cut = 0, round = 0;
      // نصف المرات يُقطع الطلب قبل الخادم، ونصفها بعد أن نفّذه الخادم وقبل أن يبلغ جوابُه الجهاز.
      await page.route('**/api/deliveries/sync', async (route) => {
        if (round++ % 2 === 0) { cut++; return route.abort('connectionreset'); }
        await route.fetch().catch(() => {});
        reached++;
        return route.abort('connectionreset');
      });
      const more = batch.slice(8);
      for (let i = 0; i < 100; i++) {
        if (i % 17 === 5 && more.length) {
          // تسليمات جديدة تدخل بين المحاولات، والجهاز منقطع.
          await context.setOffline(true);
          await page.getByRole('button', { name: 'سلّم', exact: true }).click();
          const t = more.shift();
          await deliver(page, { token: t.token }, t.headName);
          await page.getByRole('button', { name: 'التالي' }).click();
          await page.getByRole('button', { name: 'رجوع' }).click();
          await context.setOffline(false);
        }
        const before = round;
        await page.getByRole('button', { name: 'زامن الآن' }).click();
        while (round === before) await page.waitForTimeout(5);
        await page.getByRole('button', { name: 'زامن الآن' }).waitFor();
      }
      assert.ok(round >= 100, `محاولات المزامنة ${round}`);
      assert.ok(cut >= 40 && reached >= 40, `قبل الخادم ${cut}، بعده ${reached}`);
      const delivered = 8 + (batch.length - 8 - more.length);
      assert.equal(await pending(page), delivered, 'الجهاز ما زال يعدّها غير مرفوعة: لم يبلغه جواب');
      await page.unroute('**/api/deliveries/sync');
      await page.getByRole('button', { name: 'زامن الآن' }).click();
      await page.getByText('تمّت المزامنة').waitFor();
      assert.equal(await pending(page), 0);
      const d = await detail();
      assert.equal(d.totals.delivered, 4 + delivered, 'كل تسليم مرة واحدة في الخادم');
      assert.equal(d.incidents.filter((i) => i.kind === 'DOUBLE_DELIVERY').length, 0);
      console.log(`   ${round} محاولة مزامنة مقطوعة (${cut} قبل الخادم، ${reached} بعد تنفيذه)، ${delivered} تسليماً، 0 مفقود، 0 مكرَّر`);
    });

    await step('تسليم سبقه غيره بالاتصال يُكشف عند المزامنة ويظهر في كشف اليوم', async () => {
      const t = pool[20];
      await context.setOffline(true);
      await page.getByRole('button', { name: 'سلّم', exact: true }).click();
      await deliver(page, { token: t.token }, t.headName);
      await page.getByRole('button', { name: 'التالي' }).click();
      await page.getByRole('button', { name: 'رجوع' }).click();
      // في الأثناء استُلم بالرمز نفسه في نقطة متصلة، من جهاز آخر.
      const other = await call('/deliveries/redeem', tokens.manager, { pointId: p2.id, deviceId: 'desk-2', locate: { token: t.token }, clientOpId: crypto.randomUUID(), receiver: { kind: 'HEAD' } });
      assert.ok(other.deliveredAt, JSON.stringify(other));
      await context.setOffline(false);
      await page.getByText('1 عملية تحتاج نظرك').waitFor({ timeout: 15000 });
      await page.getByRole('button', { name: 'كشف اليوم' }).click();
      await page.getByText('سُلِّم قبلك').waitFor();
      await page.getByText('رُفع بلاغ إلى مدير التوزيع').waitFor();
      await shot(page, 'm8-day');
      assert.equal((await detail()).incidents.filter((i) => i.kind === 'DOUBLE_DELIVERY').length, 1);
      await page.getByRole('button', { name: 'رجوع' }).click();
    });

    await step('الجلسة المنتهية لا تُضيع شيئاً: تُجدَّد بكلمة المرور ثم يُرفع', async () => {
      await context.setOffline(true);
      await page.getByRole('button', { name: 'سلّم', exact: true }).click();
      await deliver(page, { token: pool[21].token }, pool[21].headName);
      await page.getByRole('button', { name: 'التالي' }).click();
      await page.getByRole('button', { name: 'رجوع' }).click();
      await page.route('**/api/deliveries/sync', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"انتهت الجلسة"}' }));
      await context.setOffline(false);
      await page.getByText('انتهت الجلسة مع الخادم').waitFor({ timeout: 15000 });
      await page.unroute('**/api/deliveries/sync');
      await page.getByRole('button', { name: 'جدّدها' }).click();
      await page.getByLabel('كلمة المرور').fill(PASSWORD);
      await page.getByRole('button', { name: 'جدّد الجلسة' }).click();
      await page.getByRole('button', { name: 'زامن الآن' }).click();
      await page.getByText('تمّت المزامنة').waitFor();
      assert.equal(await pending(page), 0);
    });

    await step('القفل يُخرج البيانات من الذاكرة، والرمز يعيدها', async () => {
      await page.getByRole('button', { name: 'اقفل التطبيق' }).click();
      await page.getByLabel('رمز القفل').waitFor();
      assert.equal(await page.getByText('سلة الميدان').count(), 0);
      await unlock(page);
      await page.getByText('سلة الميدان').waitFor();
    });

    // ---------- الباحث الميداني على جهاز آخر ----------
    const ctx2 = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar-IQ', deviceScaleFactor: Number(process.env.DSF ?? 2), geolocation: { latitude: 33.3536, longitude: 43.7836 }, permissions: ['geolocation'] });
    const field = await ctx2.newPage();
    field.on('pageerror', (e) => errors.push(e.message));
    const doc = `1988${RUN}55`;
    const fill = async (name, number) => {
      await field.getByRole('button', { name: 'سجّل عائلة' }).click();
      await field.getByLabel('الاسم الرباعي واللقب').fill(name);
      await field.getByLabel('رقم الوثيقة').fill(number);
    };

    await step('الباحث يسجّل عائلة كاملة بلا شبكة: أفراد وموقع وصورة وثيقة', async () => {
      await firstRun(field, names.researcher);
      await setPin(field);
      assert.equal(await field.getByRole('button', { name: 'اختر الحملة والنقطة' }).count(), 0, 'الباحث لا يرى التوزيع');
      await ctx2.setOffline(true);
      await field.getByRole('button', { name: 'سجّل عائلة' }).click();
      await field.getByRole('button', { name: 'احفظ على الجهاز' }).click();
      await field.getByText('اكتب اسم رب الأسرة ثلاثياً على الأقل.').waitFor();
      await field.getByText('رقم البطاقة الوطنية 12 خانة.').waitFor();
      await field.getByLabel('الاسم الرباعي واللقب').fill('وفاء صالح مهدي الراوي');
      await field.getByLabel('اسم الأم').fill('خديجة');
      await field.getByRole('region', { name: 'رب الأسرة' }).getByLabel('الجنس', { exact: true }).selectOption('F');
      await field.getByLabel('رقم الوثيقة').fill(doc);
      await field.getByLabel('الهاتف').fill('٠٧٧٠٥٥٥١٢٣٤');
      await field.getByRole('button', { name: 'أضف فرداً' }).click();
      await field.getByLabel('الاسم', { exact: true }).fill('ياسين عماد خلف الراوي');
      await field.getByLabel('يتيم').check();
      await field.getByRole('button', { name: 'أرامل' }).click();
      await field.getByRole('button', { name: 'أيتام' }).click();
      await field.getByLabel('المحلة').fill('الجولان');
      await field.getByLabel('نوع العقار').selectOption('RENTED');
      await field.getByRole('button', { name: 'التقط موقع الدار' }).click();
      await field.getByRole('button', { name: /الموقع: 33\.3536/ }).waitFor();
      await field.getByLabel('رعاية اجتماعية').fill('150000');
      await field.getByLabel('صورة وثيقة').setInputFiles({ name: 'id.png', mimeType: 'image/png', buffer: PNG });
      await field.getByRole('img', { name: 'وثيقة هوية' }).waitFor();
      assert.ok(await field.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'الصفحة تفيض أفقياً');
      await shot(field, 'm9-register');
      await field.getByRole('button', { name: 'احفظ على الجهاز' }).click();
      await field.getByText('ينتظر الرفع').waitFor();
      assert.equal((await call(`/families?q=${encodeURIComponent('وفاء صالح')}`, tokens.supervisor)).length, 0);
    });

    await step('الوثيقة نفسها لا تُسجَّل مرتين على الجهاز قبل الرفع', async () => {
      await field.getByRole('button', { name: 'رجوع' }).click();
      await fill('وفاء صالح مهدي الراوي', doc);
      await field.getByRole('button', { name: 'احفظ على الجهاز' }).click();
      await field.getByText('هذه الوثيقة سجّلتَ بها «وفاء صالح مهدي الراوي» على هذا الجهاز').waitFor();
      await field.getByRole('button', { name: 'رجوع' }).click();
    });

    await step('عند الاتصال تظهر العائلة في النظام برقمها وأفرادها وموقعها ومرفقها', async () => {
      await ctx2.setOffline(false);
      await field.waitForFunction(() => document.querySelector('[data-testid=pending]')?.textContent === '0', null, { timeout: 15000 });
      await field.getByRole('button', { name: /ما سجّلتَه/ }).click();
      await field.getByText(/رقم العائلة \d+ · بانتظار الاعتماد/).waitFor();
      await shot(field, 'm10-outbox');
      const [row] = await call(`/families?q=${encodeURIComponent('وفاء صالح')}`, tokens.supervisor);
      const f = await call(`/families/${row.id}`, tokens.supervisor);
      assert.equal(f.members.length, 2);
      assert.equal(f.members.filter((m) => m.isOrphan).length, 1);
      assert.match(f.phone1, /7705551234$/);
      assert.deepEqual([...f.tags].sort(), ['ORPHANS', 'WIDOW']);
      assert.equal(f.createdBy, names.researcher);
      const files = await call(`/families/${row.id}/attachments`, tokens.supervisor);
      assert.equal(files.length, 1);
      assert.equal(files[0].category, 'IDENTITY');
      assert.equal(files[0].mime, 'image/jpeg');
      await field.getByRole('button', { name: 'رجوع' }).click();
    });

    await step('من سُجّل من قبل يردّه الخادم عند الرفع، ويُذكر رقم عائلته', async () => {
      await ctx2.setOffline(true);
      await fill('وفاء صالح مهدي الراوي', doc);
      await field.getByRole('button', { name: 'احفظ على الجهاز' }).click();
      await ctx2.setOffline(false);
      await field.getByText(/رفضه الخادم: مسجَّل سلفاً في العائلة \d+/).waitFor({ timeout: 15000 });
      await field.getByRole('button', { name: 'أزله من الجهاز' }).click();
      await field.getByText(/رفضه الخادم/).waitFor({ state: 'detached' });
    });

    await step('لا أخطاء برمجية في المتصفح', async () => { if (errors.length) throw new Error(errors.join('\n')); });
    console.log(`\n${steps.length} خطوات نجحت`);
  } catch (err) {
    console.error(`✗ فشل بعد ${steps.length} خطوة:\n`, err.message);
    if (SHOTS) for (const [i, c] of browser.contexts().entries()) for (const p of c.pages()) await p.screenshot({ path: `${SHOTS}/mfail-${i}.png` }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
