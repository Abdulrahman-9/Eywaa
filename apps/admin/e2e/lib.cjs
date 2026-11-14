/** أدوات مشتركة لاختبارات المتصفح. */
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
const SHOTS = process.argv[2];
const PASSWORD = 'staff-demo-password';
const RUN = Date.now().toString().slice(-6);

async function call(path, token, body, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

async function login(page, username, password = PASSWORD) {
  await page.goto(BASE);
  await page.getByLabel('اسم المستخدم').fill(username);
  await page.getByLabel('كلمة المرور').fill(password);
  await page.getByRole('button', { name: 'دخول' }).click();
  await page.getByRole('heading', { name: 'الرئيسية' }).waitFor();
}

/** ينشئ مستخدمين بأدوارهم ويعيد رموز دخولهم مع رمز المدير. */
async function setupUsers(roles) {
  const admin = (await call('/auth/login', null, { username: 'admin', password: process.env.ADMIN_PASSWORD })).token;
  const tokens = { admin };
  const names = {};
  for (const [key, role, fullName] of roles) {
    names[key] = `${key}${RUN}`;
    await call('/users', admin, { username: names[key], fullName, password: PASSWORD, role });
    tokens[key] = (await call('/auth/login', null, { username: names[key], password: PASSWORD })).token;
  }
  return { tokens, names };
}

/** عائلة معتمدة عبر الواجهة البرمجية. */
async function approvedFamily(tokens, { name, nid, tags = ['NEEDY'], housing = 'RENTED', kids = 0, orphans = false, income = 0, phone }) {
  const members = [{ relation: 'HEAD', fullName: name, gender: 'F', documents: [{ type: 'NATIONAL_CARD', number: nid }] }];
  for (let i = 0; i < kids; i++) members.push({ relation: 'SON', fullName: `ولد ${i + 1} ${name}`, gender: 'M', isOrphan: orphans, documents: [] });
  const f = await call('/families', tokens.researcher, { tags, housing, phone1: phone, members, incomes: income ? [{ kind: 'WORK', amountIqd: income }] : [], proxies: [] });
  if (!f.id) throw new Error('family create failed: ' + JSON.stringify(f));
  return call(`/families/${f.id}/approve`, tokens.supervisor ?? tokens.admin, {});
}

/** يشغّل خطوات الاختبار ويلتقط صورة عند الفشل. */
async function run(main) {
  const steps = [];
  const pages = [];
  const errors = [];
  const browser = await chromium.launch();
  const newPage = async (viewport = { width: 1440, height: 900 }) => {
    const page = await (await browser.newContext({ viewport, deviceScaleFactor: Number(process.env.DSF ?? 2), locale: 'ar-IQ' })).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    pages.push(page);
    return page;
  };
  const step = async (name, fn) => { await fn(); steps.push(name); console.log(`✓ ${name}`); };
  const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  try {
    await main({ step, shot, newPage });
    await step('لا أخطاء برمجية في المتصفح', async () => { if (errors.length) throw new Error(errors.join('\n')); });
    console.log(`\n${steps.length} خطوات نجحت`);
  } catch (err) {
    console.error(`✗ فشل بعد ${steps.length} خطوة:\n`, err.message);
    if (SHOTS) for (const [i, p] of pages.entries()) await p.screenshot({ path: `${SHOTS}/fail-${i}.png` }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

module.exports = { BASE, RUN, PASSWORD, call, login, setupUsers, approvedFamily, run };
