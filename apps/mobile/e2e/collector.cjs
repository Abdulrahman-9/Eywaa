/**
 * المتعهد محصِّلاً ومبلِّغاً من هاتفه والهاتف منقطع: يفتح صندوق تبرعات فيدخل ما عدّه ذمته، يسجّل تبرعاً نقدياً وعينياً،
 * يرفع طلب إضافة عائلة وطلب تعديل، ويشهد بفرق في مواد حُوّلت إليه. ثم يعود الاتصال فيُرفع كل شيء مرة واحدة،
 * وما ردّه الخادم يُعرض له. ثم يسلّم للمحاسب فتنقص ذمته.
 * التشغيل (على قاعدة فارغة):  ADMIN_PASSWORD=... BASE_URL=http://localhost:3000 node e2e/collector.cjs [مجلد الصور]
 */
const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');
process.env.BASE_URL ??= 'http://localhost:3000';
const { BASE, RUN, PASSWORD, call, setupUsers, approvedFamily } = require('../../admin/e2e/lib.cjs');

const SHOTS = process.argv[2];
const steps = [];
const errors = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log(`✓ ${name}`); };
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

(async () => {
  const { tokens, names } = await setupUsers([
    ['researcher', 'FIELD_RESEARCHER', 'باحث'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'مشرف'], ['accountant', 'ACCOUNTANT', 'المحاسب'],
    ['keeper', 'STOREKEEPER', 'أمين المخزن'], ['agent', 'DISTRIBUTION_AGENT', 'أبو أحمد الحلبوسي'],
  ]);
  const agent = (await call('/agents', tokens.admin)).find((a) => a.username === names.agent);
  await call(`/agents/${agent.id}/point`, tokens.admin, {});
  const fund = (await call('/accounting/summary', tokens.accountant)).funds[0];
  const box = await call('/boxes', tokens.accountant, { location: 'أسواق الجولان', address: 'شارع المستشفى', hostName: 'أبو عمر', hostPhone: '07901112233', fundId: fund.id, agentId: agent.id, installedOn: daysAgo(100).slice(0, 10) });
  assert.ok(box.id, JSON.stringify(box));
  for (const [amount, ago] of [[90000, 80], [60000, 55], [45000, 35]]) await call(`/boxes/${box.id}/collections`, tokens.agent, { amount, collectedAt: daysAgo(ago) });
  const item = await call('/inventory/items', tokens.keeper, { name: 'سلة غذائية', unit: 'سلة' });
  const whs = (await call('/inventory/stock', tokens.keeper)).warehouses;
  const main = whs.find((w) => w.main).id;
  await call('/inventory/moves', tokens.keeper, { kind: 'RECEIPT', itemId: item.id, toWarehouseId: main, quantity: 100, source: 'متبرع' });
  const transfer = await call('/inventory/moves', tokens.keeper, { kind: 'TRANSFER', itemId: item.id, fromWarehouseId: main, toWarehouseId: whs.find((w) => !w.main).id, quantity: 20 });
  assert.ok(transfer.id, JSON.stringify(transfer));
  const family = await approvedFamily(tokens, { name: 'سعاد خلف عبيد الجميلي', nid: `1978${RUN}01` });

  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar-IQ', deviceScaleFactor: Number(process.env.DSF ?? 2) });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const sync = async () => { await page.getByRole('button', { name: 'زامن الآن' }).click(); await page.getByText('تمّت المزامنة').waitFor(); };
  const back = () => page.getByRole('button', { name: 'رجوع' }).click();
  const custody = () => page.getByTestId('home-custody').innerText();
  try {
    await step('يدخل هاتفه ويزامن: ذمته وصناديقه وما ينتظر تأكيده', async () => {
      await page.goto(`${BASE}/m/`);
      await page.getByLabel('اسم المستخدم').fill(names.agent);
      await page.getByLabel('كلمة المرور').fill(PASSWORD);
      await page.getByRole('button', { name: 'دخول' }).click();
      for (const label of ['الرمز', 'أعد الرمز للتأكيد']) { await page.getByLabel(label, { exact: true }).fill('735194'); await page.getByRole('button', { name: 'متابعة' }).click(); }
      await page.getByRole('heading', { name: 'في ذمتك نقداً' }).waitFor();
      assert.equal(await custody(), '0');
      await sync();
      await page.getByTestId('home-custody').getByText('195,000').waitFor();
      await page.getByText('1 تحويل من المخزن ينتظر أن تؤكد استلامه.').waitFor();
      await page.getByText('1 من صناديقك لم يُفتح منذ أكثر من شهر.').waitFor();
      await page.getByRole('button', { name: 'الصناديق (1)' }).waitFor();
      await shot(page, 'm20-agent-home');
    });

    await step('والهاتف منقطع: يفتح صندوقه ويعدّ ما فيه، ويُنبَّه إن كان دون المعتاد', async () => {
      await context.setOffline(true);
      await page.getByRole('button', { name: 'الصناديق (1)' }).click();
      await page.getByText('لم يُفتح منذ 35 يوماً').waitFor();
      await page.getByRole('button', { name: /أسواق الجولان/ }).click();
      await page.getByRole('button', { name: 'راجع ثم سجّل' }).click();
      await page.getByText('اكتب ما عددتَه.').waitFor();
      await page.getByLabel('ما عددتَه فيه بالدينار').fill('٢٠٠٠٠');
      await page.getByLabel('رقم الختم (إن وُجد)').fill('خ-44');
      await page.getByRole('button', { name: 'راجع ثم سجّل' }).click();
      assert.equal(await page.getByTestId('confirm-amount').innerText(), '20,000');
      await page.getByText(/دون نصف المعتاد لهذا الصندوق/).waitFor();
      await shot(page, 'm21-box-confirm');
      await page.getByRole('button', { name: 'نعم، سجّل 20,000' }).click();
      await page.getByText('سُجّل فتح الصندوق 1: 20,000 دينار دخلت ذمتك.').waitFor();
      await page.getByText('سجّلتَ فتحه وينتظر الرفع').waitFor();
      // لا يُسجَّل الفتح مرتين.
      await page.getByRole('button', { name: /أسواق الجولان/ }).click();
      await page.getByLabel('ما عددتَه فيه بالدينار').fill('20000');
      await page.getByRole('button', { name: 'راجع ثم سجّل' }).click();
      await page.getByText(/لا يُسجَّل الفتح مرتين/).waitFor();
      await back(); await back();
      assert.equal(await custody(), '215,000');
    });

    await step('يسجّل تبرعاً نقدياً يدخل ذمته، ويبلّغ بتبرع عيني', async () => {
      await page.getByRole('button', { name: 'تبرع جديد' }).click();
      await page.getByRole('button', { name: 'سجّل التبرع' }).click();
      await page.getByText('اكتب اسم المتبرع، أو اختر «فاعل خير».').waitFor();
      await page.getByLabel('اسم المتبرع').fill('حاتم عبد الله');
      await page.getByLabel('هاتف المتبرع (إن تيسّر)').fill('07905556677');
      await page.getByLabel('المبلغ بالدينار').fill('100000');
      await page.getByLabel('فيمَ يريده (إن ذكر)').fill('كفالة يتيم');
      await shot(page, 'm22-donate');
      await page.getByRole('button', { name: 'سجّل التبرع' }).click();
      await page.getByText('سُجّل: 100,000 دينار من حاتم عبد الله، ودخلت ذمتك.').waitFor();
      await page.getByRole('button', { name: 'عيني' }).click();
      await page.getByRole('button', { name: 'لا يريد ذكر اسمه: فاعل خير' }).click();
      await page.getByLabel('ما تبرّع به').fill('بطانيات');
      await page.getByLabel('الكمية').fill('10');
      await page.getByLabel('الوحدة').fill('قطعة');
      await page.getByRole('button', { name: 'بلّغ بالتبرع' }).click();
      await page.getByText(/بُلّغ: 10 قطعة بطانيات من فاعل خير/).waitFor();
      await back();
      assert.equal(await custody(), '315,000');
    });

    await step('يرفع طلب إضافة عائلة وطلب تعديل عائلة برقمها', async () => {
      await page.getByRole('button', { name: 'طلباتي' }).click();
      await page.getByLabel('اسم رب الأسرة').fill('كريم');
      await page.getByRole('button', { name: 'ارفع الطلب' }).click();
      await page.getByText(/اكتب اسم رب الأسرة ثنائياً على الأقل/).waitFor();
      await page.getByLabel('اسم رب الأسرة').fill('كريم جبار سلمان الدليمي');
      await page.getByLabel('المحلة').fill('الجولان');
      await page.getByLabel('ما رأيتَه من حالهم').fill('أرملة وخمسة أيتام في بيت إيجار');
      await page.getByRole('button', { name: 'ارفع الطلب' }).click();
      await page.getByText(/رُفع طلب إضافة «كريم جبار سلمان الدليمي»/).waitFor();
      await page.getByRole('button', { name: 'تعديل عائلة' }).click();
      await page.getByLabel('رقم العائلة').fill(family.familyNo);
      await page.getByLabel('ما الذي تغيّر؟').fill('توفي رب الأسرة وانتقلت العائلة');
      await shot(page, 'm23-requests');
      await page.getByRole('button', { name: 'ارفع الطلب' }).click();
      await page.getByText(`رُفع طلب تعديل العائلة ${family.familyNo}. يزورها باحث ثم يُعتمد التعديل.`).waitFor();
      // رقم لا عائلة له: يُحفظ على الهاتف، ويردّه الخادم عند الرفع.
      await page.getByLabel('رقم العائلة').fill('99999');
      await page.getByLabel('ما الذي تغيّر؟').fill('تغيّر عنوانهم إلى حي آخر');
      await page.getByRole('button', { name: 'ارفع الطلب' }).click();
      await page.getByText('رُفع طلب تعديل العائلة 99999.', { exact: false }).waitFor();
      await back();
    });

    await step('يشهد بفرق في مواد حُوّلت إلى مخزنه', async () => {
      await page.getByRole('button', { name: 'ذمتي' }).click();
      await page.getByText('20 سلة سلة غذائية').first().waitFor();
      await page.getByRole('button', { name: 'فيها فرق' }).click();
      assert.equal(await page.getByRole('button', { name: 'بلّغ عن الفرق' }).isDisabled(), true);
      await page.getByLabel('ما الذي وجدتَه؟').fill('وصل 18 لا 20');
      await page.getByRole('button', { name: 'بلّغ عن الفرق' }).click();
      await page.getByText(/بلّغتَ عن فرق في 20 سلة سلة غذائية/).waitFor();
      assert.equal(await page.getByTestId('custody').innerText(), '315,000');
      await page.getByText('منها 120,000 سجّلتَها ولم تُرفع بعد.').waitFor();
      await shot(page, 'm24-custody');
      await back();
      assert.equal(await page.getByTestId('pending').innerText(), '7');
      // لم يبلغ الخادمَ شيء بعد.
      assert.equal((await call('/agent/me', tokens.agent)).custody.balance, 195000);
    });

    await step('يعود الاتصال فيُرفع كل شيء مرة واحدة، وما ردّه الخادم يُعرض له', async () => {
      await context.setOffline(false);
      await sync();
      assert.equal(await page.getByTestId('pending').innerText(), '0');
      await page.getByTestId('home-custody').getByText('315,000').waitFor();
      const me = await call('/agent/me', tokens.agent);
      assert.equal(me.custody.balance, 315000);
      assert.equal(me.boxes[0].lastAmount, 20000);
      assert.equal(me.boxes[0].stale, false);
      assert.equal(me.requests.additions[0].headName, 'كريم جبار سلمان الدليمي');
      assert.equal(me.requests.edits.length, 1);
      assert.equal(me.goods.transfers.find((t) => t.id === transfer.id).ack.ok, false);
      const detail = await call(`/agents/${agent.id}`, tokens.accountant);
      assert.equal(detail.donations.length, 2);
      assert.equal(detail.collections[0].low, true);
      assert.ok(detail.alerts.some((a) => a.includes('بلاغ فرق')));
      // إعادة المزامنة لا تكرّر شيئاً.
      await sync();
      assert.equal((await call('/agent/me', tokens.agent)).custody.balance, 315000);
      assert.equal((await call(`/boxes/${box.id}`, tokens.accountant)).openings, 4);

      await page.getByRole('button', { name: '1 عملية تحتاج نظرك' }).click();
      await page.getByText('لا عائلة بهذا الرقم').waitFor();
      await page.getByText(/ينتظر زيارة باحث/).waitFor();
      await page.getByText('عند المشرف').waitFor();
      await page.getByRole('button', { name: 'أزله من الجهاز' }).click();
      await page.getByText('لا عائلة بهذا الرقم').waitFor({ state: 'detached' });
      await back();
      await page.getByRole('button', { name: /عملية تحتاج نظرك/ }).waitFor({ state: 'detached' });
    });

    await step('يسلّم المحاسبَ فتنقص ذمته ويرى ذلك في كشفه', async () => {
      const r = await call('/accounting/custody/receive', tokens.accountant, { fundId: fund.id, userId: agent.id, amount: 300000 });
      assert.equal(r.remaining, 15000, JSON.stringify(r));
      await sync();
      await page.getByTestId('home-custody').getByText('15,000').waitFor();
      await page.getByRole('button', { name: 'ذمتي' }).click();
      await page.getByText('سلّمتَ المحاسب').waitFor();
      await page.getByText('− 300,000').waitFor();
      await shot(page, 'm25-custody-after');
    });

    await step('لا أخطاء برمجية في المتصفح', async () => { if (errors.length) throw new Error(errors.join('\n')); });
    console.log(`\n${steps.length} خطوات نجحت`);
  } catch (err) {
    console.error(`✗ فشل بعد ${steps.length} خطوة:\n`, err.message);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/collector-fail.png` }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
