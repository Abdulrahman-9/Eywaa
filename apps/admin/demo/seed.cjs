/**
 * بيانات نسخة العرض: يملأ نظاماً فارغاً بمركز وهمي متكامل (عوائل، حملات، مخازن، صندوق، متعهدون، كشوف، بناء).
 * الأسماء والأرقام مولَّدة ولا تخص أحداً. يُشغَّل على قاعدة فارغة فيها حساب المدير:
 *   ADMIN_PASSWORD=... DATABASE_URL=... node demo/seed.cjs
 */
const { execSync } = require('node:child_process');
const crypto = require('node:crypto');
const { call, createStaff, PASSWORD } = require('../e2e/lib.cjs');

// مولّد أرقام ثابت البذرة: البيانات نفسها في كل تشغيل.
let seed = 20261114;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const MEN = ['أحمد', 'محمد', 'علي', 'عمر', 'خالد', 'ياسين', 'مصطفى', 'حسين', 'إبراهيم', 'يوسف', 'سعد', 'حاتم', 'جاسم', 'كريم', 'ماجد', 'نبيل', 'رعد', 'ثامر', 'وليد', 'فراس', 'عثمان', 'زياد', 'هاشم', 'قاسم'];
const WOMEN = ['فاطمة', 'زينب', 'مريم', 'عائشة', 'سعاد', 'نور', 'هدى', 'إيمان', 'رقية', 'سلمى', 'وفاء', 'منى', 'أسماء', 'خديجة', 'بشرى', 'شيماء', 'رنا', 'سهى', 'ابتسام', 'نجلاء', 'آمنة', 'حنان', 'سميرة', 'انتصار'];
const FATHERS = ['عبد الله', 'محمود', 'حسن', 'صالح', 'كاظم', 'جبار', 'خليل', 'إسماعيل', 'عبد الرحمن', 'طه', 'فاضل', 'عدنان', 'مزهر', 'حميد', 'سلمان', 'شاكر', 'نوري', 'عبد الكريم'];
const GRANDS = ['حمد', 'خلف', 'عبيد', 'مطر', 'نايف', 'عواد', 'فرحان', 'شلال', 'محيسن', 'ضاحي', 'سرحان', 'رشيد'];
const CLANS = ['الدليمي', 'الجميلي', 'الحلبوسي', 'العيساوي', 'الفهداوي', 'المحمدي', 'الكبيسي', 'الزوبعي', 'العلواني', 'الراوي', 'الفلاحي', 'الجنابي'];
const MAHALLAS = ['الجولان', 'الشهداء', 'النزال', 'الأندلس', 'المعلمين', 'الرسالة', 'الضباط', 'الجمهورية'];
const used = new Set();
const unique = (make) => { for (;;) { const v = make(); if (!used.has(v)) { used.add(v); return v; } } };
const nid = () => unique(() => `19${int(60, 99)}${String(int(0, 99999999)).padStart(8, '0')}`);
const phone = () => unique(() => `07${pick(['7', '8', '9'])}${int(0, 9)}${String(int(0, 9999999)).padStart(7, '0')}`);
const born = (minAge, maxAge) => `${2026 - int(minAge, maxAge)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`;
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const day = (d) => d.toISOString().slice(0, 10);

async function ok(path, token, body, method) {
  const r = await call(path, token, body, method);
  if (r && r.statusCode >= 400) throw new Error(`${method ?? (body === undefined ? 'GET' : 'POST')} ${path}: ${JSON.stringify(r).slice(0, 300)}`);
  return r;
}

/** أسرة وهمية: أرملة بأيتام، أو أسرة بمعيل قليل الدخل، أو ذو إعاقة، أو مسنّ. */
function family(i) {
  const clan = pick(CLANS), mahalla = MAHALLAS[i % MAHALLAS.length];
  const kind = ['WIDOW', 'WIDOW', 'POOR', 'POOR', 'DISABLED', 'SICK', 'DIVORCED', 'ELDER'][i % 8];
  const husband = pick(MEN), hFather = pick(FATHERS), hGrand = pick(GRANDS);
  const members = [], tags = [], incomes = [];
  const child = (orphan) => {
    const boy = rnd() < 0.5;
    members.push({ relation: boy ? 'SON' : 'DAUGHTER', fullName: `${pick(boy ? MEN : WOMEN)} ${husband} ${hFather} ${clan}`, gender: boy ? 'M' : 'F', birthDate: born(1, 17), isOrphan: orphan, documents: [] });
  };
  if (kind === 'WIDOW' || kind === 'DIVORCED') {
    members.push({ relation: 'HEAD', fullName: `${pick(WOMEN)} ${pick(FATHERS)} ${pick(GRANDS)} ${pick(CLANS)}`, gender: 'F', birthDate: born(26, 55), documents: [{ type: 'NATIONAL_CARD', number: nid() }] });
    const kids = int(1, 5);
    for (let k = 0; k < kids; k++) child(kind === 'WIDOW');
    tags.push(kind === 'WIDOW' ? 'WIDOW' : 'DIVORCED');
    if (kind === 'WIDOW') tags.push('ORPHANS');
    if (rnd() < 0.35) incomes.push({ kind: 'SOCIAL_WELFARE', amountIqd: pick([125000, 175000, 225000]) });
  } else {
    members.push({ relation: 'HEAD', fullName: `${husband} ${hFather} ${hGrand} ${clan}`, gender: 'M', birthDate: born(kind === 'ELDER' ? 62 : 28, kind === 'ELDER' ? 80 : 58), documents: [{ type: 'NATIONAL_CARD', number: nid() }],
      ...(kind === 'DISABLED' ? { disability: pick(['بتر في الساق', 'شلل نصفي', 'فقد البصر']) } : {}), ...(kind === 'SICK' ? { chronicIllness: pick(['فشل كلوي', 'سكري وضغط', 'أمراض القلب']) } : {}) });
    members.push({ relation: 'SPOUSE', fullName: `${pick(WOMEN)} ${pick(FATHERS)} ${pick(GRANDS)} ${pick(CLANS)}`, gender: 'F', birthDate: born(24, 60), documents: [] });
    const kids = kind === 'ELDER' ? int(0, 1) : int(1, 6);
    for (let k = 0; k < kids; k++) child(false);
    tags.push(kind === 'DISABLED' ? 'DISABLED' : kind === 'SICK' ? 'SICK' : 'NEEDY');
    if (kind === 'POOR') incomes.push({ kind: 'WORK', amountIqd: pick([150000, 200000, 250000, 350000]) });
    if (kind === 'ELDER' && rnd() < 0.6) incomes.push({ kind: 'PENSION', amountIqd: pick([300000, 400000]) });
  }
  return {
    tags, housing: pick(['RENTED', 'RENTED', 'OWNED', 'OTHER']), phone1: phone(), address: { mahalla, landmark: pick(['قرب الجامع', 'خلف المدرسة', 'مقابل السوق', 'قرب المركز الصحي']) },
    members, incomes, proxies: rnd() < 0.3 ? [{ fullName: `${pick(MEN)} ${pick(FATHERS)} ${clan}`, relation: pick(['الأخ', 'الخال', 'العم']) }] : [],
  };
}

(async () => {
  const admin = (await ok('/auth/login', null, { username: 'admin', password: process.env.ADMIN_PASSWORD })).token;
  const staff = {};
  const people = [
    ['researcher', 'FIELD_RESEARCHER', 'سامر خليل الدليمي'], ['researcher2', 'FIELD_RESEARCHER', 'هدى فاضل الجميلي'], ['supervisor', 'BENEFICIARY_SUPERVISOR', 'أم عمر العيساوي'],
    ['manager', 'DISTRIBUTION_MANAGER', 'ماجد حميد الفهداوي'], ['manager2', 'DISTRIBUTION_MANAGER', 'رعد سلمان الكبيسي'], ['distributor', 'DISTRIBUTOR', 'ثامر عدنان المحمدي'],
    ['keeper', 'STOREKEEPER', 'نبيل شاكر الراوي'], ['accountant', 'ACCOUNTANT', 'وليد نوري العلواني'], ['projects', 'PROJECT_SUPERVISOR', 'فراس طه الزوبعي'],
    ['projects2', 'PROJECT_SUPERVISOR', 'زياد صالح الجنابي'], ['auditor', 'AUDITOR', 'هاشم كاظم الفلاحي'],
    ['agent', 'DISTRIBUTION_AGENT', 'أبو أحمد الحلبوسي', '07701234567'], ['agent2', 'DISTRIBUTION_AGENT', 'أبو مصطفى الجميلي', '07809876543'],
  ];
  for (const [username, role, fullName, ph] of people) staff[username] = await createStaff(admin, { username, fullName, role, phone: ph });
  const users = await ok('/users', admin);
  const uid = (u) => users.find((x) => x.username === u).id;
  console.log('staff', Object.keys(staff).length);

  // ---------- العوائل ----------
  const fams = [];
  for (let i = 0; i < 46; i++) {
    const f = await ok('/families', i % 3 ? staff.researcher : staff.researcher2, family(i));
    fams.push(f);
  }
  const approved = fams.slice(0, 40);
  for (const f of approved) await ok(`/families/${f.id}/approve`, staff.supervisor, {});
  await ok(`/families/${fams[45].id}/reject`, staff.supervisor, { note: 'تبيّن أنها مسجَّلة عند مركز آخر في المحافظة' });
  console.log('families', fams.length, 'approved', approved.length);

  // ---------- المخزن والصناديق والبرامج ----------
  const basket = await ok('/inventory/items', staff.keeper, { name: 'سلة غذائية', unit: 'سلة' });
  const blanket = await ok('/inventory/items', staff.keeper, { name: 'بطانية شتوية', unit: 'بطانية' });
  const flour = await ok('/inventory/items', staff.keeper, { name: 'طحين', unit: 'كيس' });
  const p1 = await ok('/points', admin, { name: 'الجولان' });
  const p2 = await ok('/points', admin, { name: 'الشهداء' });
  const stock0 = await ok('/inventory/stock', admin);
  const main = stock0.warehouses.find((w) => w.main).id;
  const whOf = (pointId) => stock0.warehouses.find((w) => w.pointId === pointId)?.id;
  const d1 = await ok('/donors', staff.accountant, { name: 'مؤسسة الفرات الخيرية' });
  const d2 = await ok('/donors', staff.accountant, { name: 'الحاج عبد الستار الكبيسي' });
  await ok('/inventory/moves', staff.keeper, { kind: 'RECEIPT', itemId: basket.id, toWarehouseId: main, quantity: 120, source: 'مؤسسة الفرات الخيرية', expiry: day(daysAgo(-150)) });
  await ok('/inventory/moves', staff.keeper, { kind: 'RECEIPT', itemId: blanket.id, toWarehouseId: main, quantity: 200, source: 'متبرع كريم' });
  await ok('/inventory/moves', staff.keeper, { kind: 'RECEIPT', itemId: flour.id, toWarehouseId: main, quantity: 300, source: 'مطحنة الفرات', expiry: day(daysAgo(-25)) });

  const food = await ok('/programs', admin, { name: 'السلة الغذائية الشهرية', kind: 'IN_KIND', unit: 'سلة', rules: {}, amount: { type: 'FIXED', value: 1 }, minGapDays: 25, itemId: basket.id });
  const cashP = await ok('/programs', admin, { name: 'المساعدة النقدية', kind: 'MONEY', unit: 'دينار', rules: {}, amount: { type: 'FIXED', value: 100000 }, minGapDays: 25 });
  const winter = await ok('/programs', admin, { name: 'كسوة الشتاء', kind: 'IN_KIND', unit: 'بطانية', rules: { hasOrphans: true }, amount: { type: 'FIXED', value: 2 }, minGapDays: 300, itemId: blanket.id });
  const flourP = await ok('/programs', admin, { name: 'طحين رمضان', kind: 'IN_KIND', unit: 'كيس', rules: {}, amount: { type: 'FIXED', value: 2 }, minGapDays: 20, itemId: flour.id });

  const general = (await ok('/accounting/summary', staff.accountant)).funds[0];
  const cashFund = await ok('/accounting/funds', staff.accountant, { name: 'صندوق المساعدة النقدية', programId: cashP.id });
  const houseFund = await ok('/accounting/funds', staff.accountant, { name: 'صندوق بناء المنازل' });
  await ok('/accounting/receipts', staff.accountant, { fundId: general.id, amount: 4500000, description: 'تبرع عام للمركز', donorId: d1.id });
  await ok('/accounting/receipts', staff.accountant, { fundId: cashFund.id, amount: 6000000, description: 'للمساعدة النقدية للأرامل', donorId: d2.id });
  await ok('/accounting/receipts', staff.accountant, { fundId: houseFund.id, amount: 30000000, description: 'لبناء منزل لعائلة أيتام', donorId: d1.id });
  await ok('/accounting/receipts', staff.accountant, { fundId: general.id, amount: 750000, party: 'فاعل خير', description: 'زكاة مال' });
  const pay1 = await ok('/accounting/payments', staff.accountant, { fundId: general.id, amount: 350000, party: 'مكتبة النور', description: 'قرطاسية وأحبار للطباعة', category: 'مصاريف إدارية' });
  await ok(`/accounting/entries/${pay1.id}/approve`, admin, {});
  await ok('/accounting/payments', staff.accountant, { fundId: general.id, amount: 600000, party: 'شركة النقل السريع', description: 'أجور نقل السلال إلى النقاط', category: 'نقل' });
  await ok('/accounting/custody/issue', staff.accountant, { fundId: cashFund.id, userId: uid('distributor'), amount: 2500000 });
  console.log('stock, funds, programs');

  // ---------- المتعهدون والصناديق ----------
  const agentPoint = await ok(`/agents/${uid('agent')}/point`, admin, {});
  await ok(`/agents/${uid('agent2')}/point`, admin, {});
  const box1 = await ok('/boxes', staff.accountant, { location: 'أسواق الجولان', address: 'شارع المستشفى', hostName: 'أبو عمر', hostPhone: phone(), fundId: general.id, agentId: uid('agent'), installedOn: day(daysAgo(120)) });
  const box2 = await ok('/boxes', staff.accountant, { location: 'صيدلية الشفاء', address: 'حي الأندلس', hostName: 'الدكتور قاسم', hostPhone: phone(), fundId: general.id, agentId: uid('agent'), installedOn: day(daysAgo(90)) });
  await ok('/boxes', staff.accountant, { location: 'مخبز الرسالة', address: 'حي الرسالة', hostName: 'أبو ياسين', hostPhone: phone(), fundId: general.id, agentId: uid('agent2'), installedOn: day(daysAgo(45)) });
  for (const [box, ago, amount] of [[box1, 95, 85000], [box1, 64, 92000], [box1, 33, 78000], [box1, 3, 31000], [box2, 60, 54000], [box2, 28, 61000]]) {
    await ok(`/boxes/${box.id}/collections`, staff.agent, { amount, collectedAt: daysAgo(ago).toISOString(), sealNo: `خ-${ago}`, clientOpId: crypto.randomUUID() });
  }
  await ok('/agent-donations', staff.agent, { kind: 'CASH', donorName: 'حاتم عبد الله', donorPhone: phone(), amount: 250000, purpose: 'كفالة يتيم' });
  const inKind = await ok('/agent-donations', staff.agent, { kind: 'IN_KIND', donorName: 'مطحنة الفرات', itemText: 'طحين صفر', quantity: 40, unit: 'كيس' });
  await ok('/agent-donations', staff.agent2, { kind: 'IN_KIND', donorName: 'محل الأمين للأقمشة', itemText: 'بطانيات', quantity: 15, unit: 'بطانية' });
  await ok(`/agent-donations/${inKind.id}/receive`, staff.keeper, { itemId: flour.id, warehouseId: main, quantity: 40 });
  await ok('/accounting/custody/receive', staff.accountant, { fundId: general.id, userId: uid('agent'), amount: 300000, note: 'تسليم أول الشهر' });
  await ok('/quick-requests', staff.agent, { headName: 'كريم جبار سلمان الدليمي', mahalla: 'الجولان', note: 'أرملة وخمسة أيتام، يسكنون غرفة واحدة', membersCount: 6 });
  await ok('/quick-requests', staff.distributor, { headName: 'سعاد محمود خلف العيساوي', mahalla: 'النزال', phone: phone(), note: 'حضرت إلى النقطة تطلب التسجيل' });
  console.log('agents, boxes, donations');

  // ---------- الحملات ----------
  const today = day(new Date());
  const campaign = async (name, programId, pointIds, extra = {}) => ok('/campaigns', staff.manager, { name, programId, startsOn: day(daysAgo(12)), endsOn: day(daysAgo(-18)), pointIds, ...extra });
  const launch = async (c) => { await ok(`/campaigns/${c.id}/submit`, staff.manager, {}); await ok(`/campaigns/${c.id}/approve`, staff.manager2, {}); return ok(`/campaigns/${c.id}/tokens`, staff.manager); };
  const deliver = async (toks, share, points) => {
    let n = 0;
    for (const [i, t] of toks.entries()) {
      if (rnd() > share) continue;
      await ok('/deliveries/redeem', staff.distributor, { pointId: points[i % points.length], deviceId: 'desk-1', locate: { token: t.token }, receiver: { kind: 'HEAD' }, clientOpId: crypto.randomUUID() });
      n++;
    }
    return n;
  };

  const c1 = await campaign('سلة تشرين الأول', food.id, [p1.id, p2.id]);
  const st = await ok('/inventory/stock', admin);
  const wh = (pointId) => st.warehouses.find((w) => w.pointId === pointId).id;
  const toks1 = await launch(c1);
  await ok('/inventory/moves', staff.keeper, { kind: 'TRANSFER', itemId: basket.id, fromWarehouseId: main, toWarehouseId: wh(p1.id), quantity: 22, campaignId: c1.id });
  await ok('/inventory/moves', staff.keeper, { kind: 'TRANSFER', itemId: basket.id, fromWarehouseId: main, toWarehouseId: wh(p2.id), quantity: 18, campaignId: c1.id });
  const n1 = await deliver(toks1, 0.9, [p1.id, p2.id]);
  await ok(`/campaigns/${c1.id}/close`, staff.manager, {});

  const c2 = await campaign('المساعدة النقدية لشهر تشرين الثاني', cashP.id, [p1.id, p2.id], { fundId: cashFund.id });
  const toks2 = await launch(c2);
  const n2 = await deliver(toks2, 0.45, [p1.id, p2.id]);
  // رمز مستعمل يُعرض ثلاث مرات أخرى في نقطتين: يظهر في إنذارات الحملة.
  const usedTok = toks2.find(() => true);
  const again = (await ok(`/campaigns/${c2.id}/tokens`, staff.manager)).map((t) => t.entitlementId);
  const spent = toks2.find((t) => !again.includes(t.entitlementId));
  if (spent) for (const p of [p1.id, p1.id, p2.id]) await call('/deliveries/check', staff.distributor, { pointId: p, deviceId: 'desk-1', locate: { token: spent.token } });
  void usedTok;

  const c3 = await campaign('كسوة الشتاء للأيتام', winter.id, [p1.id, agentPoint.id]);
  const c4 = await campaign('طحين رمضان', flourP.id, [p1.id, p2.id]);
  await ok(`/campaigns/${c4.id}/submit`, staff.manager, {});
  await ok('/notifications', staff.supervisor, { title: 'موعد التسجيل', body: 'السلام عليكم {الاسم}. يفتح المركز أبوابه لتحديث البيانات يوم السبت من التاسعة صباحاً. رقم العائلة: {رقم_العائلة}', audience: { mahalla: 'الجولان' } });
  console.log('campaigns: delivered', n1, n2, 'draft', !!c3.id);

  // ---------- الجرد والتالف ----------
  await ok('/inventory/moves', staff.keeper, { kind: 'WASTE', itemId: flour.id, fromWarehouseId: main, quantity: 6, note: 'أكياس مبتلّة من تسرّب في السقف' });
  await ok('/inventory/stocktake', staff.keeper, { warehouseId: main, note: 'جرد آخر الشهر', counts: [{ itemId: blanket.id, counted: 197 }, { itemId: basket.id, counted: 80 }] });

  // ---------- الكشف الميداني ----------
  const ALL = ['address', 'housing', 'members', 'head', 'income', 'orphans', 'health', 'phone'];
  const match = (except = {}) => ALL.map((key) => (except[key] ? { key, result: 'MISMATCH', found: except[key] } : { key, result: 'MATCH' }));
  const assign = async (list, inspectors, extra = {}) => (await ok('/inspections', staff.supervisor, { familyIds: list.map((f) => f.id), inspectorIds: inspectors.map(uid), ...extra })).inspections;
  const [i1, i2] = await assign([approved[3], approved[7]], ['agent'], { note: 'نوع السكن وعدد الأيتام' });
  const [i3] = await assign([approved[12]], ['agent', 'agent2']);
  const [i4, i5] = await assign([approved[18], approved[21]], ['agent2']);
  await assign([approved[25], approved[30]], ['agent']);
  const [i6] = await assign([fams[41]], ['agent2']);
  await ok(`/inspections/${i1.id}/report`, staff.agent, { contact: 'FAMILY', checks: match({ housing: 'يسكنون بيتاً طينياً آيلاً للسقوط، لا إيجاراً' }), recommendation: 'RAISE', reason: 'حال السكن أشدّ مما سُجّل', notes: 'الأم تعمل في الخياطة بدخل متقطع.' });
  await ok(`/inspections/${i2.id}/report`, staff.agent, { contact: 'FAMILY', checks: match(), recommendation: 'CONFIRM', notes: 'كل ما في الملف مطابق.' });
  await ok(`/inspections/${i3.id}/report`, staff.agent, { contact: 'FAMILY', checks: match({ income: 'للأب راتب تقاعدي لم يُذكر' }), recommendation: 'LOWER', reason: 'دخل ثابت غير مسجَّل' });
  await ok(`/inspections/${i3.id}/report`, staff.agent2, { contact: 'NEIGHBOR', checks: match({ income: 'الجيران يذكرون راتباً تقاعدياً' }), recommendation: 'LOWER', reason: 'يؤكده الجيران' });
  await ok(`/inspections/${i4.id}/report`, staff.agent2, { contact: 'FAMILY', checks: match({ members: 'انتقل الابن الأكبر للعمل في بغداد' }), recommendation: 'CONFIRM', notes: 'يُحدَّث عدد الأفراد.' });
  await ok(`/inspections/${i6.id}/report`, staff.agent2, { contact: 'FAMILY', checks: match(), recommendation: 'CONFIRM', notes: 'تسجيل جديد، والبيانات مطابقة.' });
  await ok(`/inspections/${i1.id}/decide`, staff.supervisor, { decision: 'APPROVE', effect: 'RAISE', points: 5, note: 'يُرفع لسوء حال السكن' });
  await ok(`/inspections/${i2.id}/decide`, staff.supervisor, { decision: 'APPROVE', effect: 'NONE' });
  void i5;
  console.log('inspections');

  // ---------- طلب تعديل، وإعادة تقييم، وإصدار نقاط معلّق ----------
  await ok(`/families/${approved[5].id}/changes`, staff.researcher, { type: 'SET_INCOMES', payload: { incomes: [] }, reason: 'انقطع الدخل بوفاة المعيل' });
  await ok('/reassessments', staff.supervisor, { familyId: approved[9].id, source: 'STAFF', reason: 'مضى عام على آخر تقييم' });
  const scoring = await ok('/scoring', admin);
  const criteria = JSON.parse(JSON.stringify(scoring.active.criteria));
  criteria.orphans.perUnit = criteria.orphans.perUnit + 2;
  await ok('/scoring/versions', admin, { criteria, thresholds: scoring.active.thresholds, note: 'زيادة وزن الأيتام بعد مراجعة لجنة المستفيدين' });

  // ---------- بناء المنازل ----------
  const contractor = await ok('/housing/contractors', staff.projects, { name: 'جاسم محمد خلف الجميلي', phone: phone() });
  const project = await ok('/housing/projects', staff.projects, { familyId: approved[1].id, contractorId: contractor.id, fundId: houseFund.id, location: 'النزال، قرب الجامع', contractDate: day(daysAgo(40)), durationDays: 120,
    stages: [{ name: 'الأساس', amount: 6000000 }, { name: 'الهيكل والسقف', amount: 12000000 }, { name: 'التشطيب والتسليم', amount: 6000000 }] });
  await ok(`/housing/projects/${project.id}/approve`, staff.projects2, {});
  const stages = (await ok(`/housing/projects/${project.id}`, staff.projects)).stages;
  await ok(`/housing/stages/${stages[0].id}/claim`, staff.projects, { note: 'قال المقاول إن الأساس تمّ' });
  await ok(`/housing/stages/${stages[0].id}/verify`, staff.projects, { note: 'زرت الموقع: الأساس مصبوب ومطابق' });
  await ok(`/housing/stages/${stages[0].id}/approve`, staff.accountant, {});
  await ok(`/housing/stages/${stages[1].id}/claim`, staff.projects, { note: 'الهيكل قائم والسقف يُصبّ هذا الأسبوع' });
  console.log('housing');

  // ---------- تواريخ متفرّقة: ليبدو المركز عاملاً منذ أشهر، لا مولوداً اليوم ----------
  if (process.env.DATABASE_URL) {
    const sql = [
      "update families set created_at = now() - (1 + floor(random() * 230)) * interval '1 day'",
      "update entitlements set delivered_at = delivered_at - floor(random() * 6) * interval '1 day' where status = 'DELIVERED' and campaign_id = (select id from campaigns where name = 'سلة تشرين الأول')",
      "update entitlements set delivered_at = delivered_at - floor(random() * 4) * interval '1 day' - floor(random() * 5) * interval '1 hour' where status = 'DELIVERED' and campaign_id <> (select id from campaigns where name = 'سلة تشرين الأول')",
    ].join('; ');
    execSync(`psql -q "${process.env.DATABASE_URL}" -c "${sql}"`, { stdio: 'inherit' });
  }
  console.log('demo data ready. staff password:', PASSWORD);
})().catch((e) => { console.error('SEED FAILED:', e.message); process.exit(1); });
