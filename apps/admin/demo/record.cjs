/**
 * يسجّل ما يجيب به الخادم لكل شاشة في اللوحة، لتعمل نسخة العرض منه بلا خادم.
 * يدخل مديراً، يزور الصفحات، ثم يكمّل لكل سجل (عائلة، حملة، قيد، كشف…) ما سُجّل لمثيله.
 *   ADMIN_PASSWORD=... node demo/record.cjs demo/public/demo-data.js
 */
const fs = require('node:fs');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
const OUT = process.argv[2];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const get = {}, post = {};

(async () => {
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD }) })).json();
  const token = login.token;
  const direct = async (path) => {
    const res = await fetch(`${BASE}/api${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status !== 200 || !(res.headers.get('content-type') ?? '').includes('json')) return undefined;
    const body = await res.json();
    get[path] = body;
    return body;
  };

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar-IQ' })).newPage();
  page.on('response', async (res) => {
    const u = new URL(res.url());
    if (!u.pathname.startsWith('/api/') || ![200, 201].includes(res.status()) || !(res.headers()['content-type'] ?? '').includes('json')) return;
    const path = u.pathname.slice(4), method = res.request().method();
    const body = await res.json().catch(() => undefined);
    if (body === undefined) return;
    if (method === 'GET') get[path + u.search] = body;
    else if (method === 'POST' && path !== '/auth/login') post[path] = body;
  });
  await page.goto(BASE);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(process.env.ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await page.getByRole('heading', { name: 'الرئيسية' }).waitFor();
  const visit = async (route) => { await page.goto(BASE + route); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(350); };

  for (const r of ['/', '/families', '/requests', '/inspections', '/review', '/scoring', '/programs', '/campaigns', '/desk', '/agents', '/boxes', '/notify', '/warehouse', '/cashbox', '/housing', '/reports', '/users', '/audit', '/settings', '/families/new', '/families/import', '/campaigns/new']) await visit(r);

  const families = await direct('/families?limit=200&offset=0');
  const campaigns = get['/campaigns'] ?? await direct('/campaigns');
  const summary = get['/accounting/summary'] ?? await direct('/accounting/summary');
  const agents = (get['/agents/overview'] ?? await direct('/agents/overview')).agents;
  const projects = get['/housing/projects'] ?? await direct('/housing/projects') ?? [];
  await visit(`/families/${families.find((f) => f.status === 'APPROVED').id}`);
  await visit(`/families/${families.find((f) => f.status !== 'APPROVED').id}`);
  for (const c of campaigns) await visit(`/campaigns/${c.id}`);
  for (const c of campaigns.filter((c) => c.status === 'ACTIVE')) await visit(`/campaigns/${c.id}/tokens`);
  for (const c of campaigns.filter((c) => c.status === 'DRAFT')) for (const step of ['basics', 'rules', 'families', 'points', 'review']) await visit(`/campaigns/${c.id}/edit/${step}`);
  for (const a of agents) await visit(`/agents/${a.id}`);
  for (const f of summary.funds) await visit(`/cashbox/funds/${f.id}`);
  for (const p of Array.isArray(projects) ? projects : projects.projects ?? []) await visit(`/housing/${p.id}`);
  await browser.close();

  // ما يُفتح في نوافذ ولا يُزار بعنوان: يُطلب مباشرة.
  const entries = get['/accounting/entries'] ?? await direct('/accounting/entries');
  for (const e of entries) await direct(`/accounting/entries/${e.id}`);
  const boxes = (get['/boxes'] ?? await direct('/boxes')).boxes;
  for (const b of boxes) await direct(`/boxes/${b.id}`);
  const inspections = new Map();
  for (const s of ['WAITING', 'ASSIGNED', 'SUBMITTED', 'DECIDED', 'ALL', 'OPEN', 'DONE', 'APPROVED', 'REJECTED', 'CANCELLED']) for (const i of (await direct(`/inspections?status=${s}`)) ?? []) inspections.set(i.id, i);
  for (const id of inspections.keys()) await direct(`/inspections/${id}`);
  for (const role of ['', 'ADMIN', 'BENEFICIARY_SUPERVISOR', 'FIELD_RESEARCHER', 'DISTRIBUTION_MANAGER', 'DISTRIBUTOR', 'STOREKEEPER', 'ACCOUNTANT', 'PROJECT_SUPERVISOR', 'AUDITOR', 'DISTRIBUTION_AGENT']) await direct(`/users/brief${role ? `?role=${role}` : ''}`);
  for (const q of ['', '?kind=IN_KIND&status=REPORTED', '?kind=CASH', '?kind=IN_KIND']) await direct(`/agent-donations${q}`);
  for (const s of ['OPEN', 'NEW', 'COMPLETED', 'DISMISSED']) await direct(`/quick-requests?status=${s}`);
  for (const c of campaigns) for (const s of ['', '?status=PENDING', '?status=DELIVERED', '?status=CANCELLED']) await direct(`/campaigns/${c.id}/families${s}`);

  // لكل عنوان فيه معرّف سجل: يُطلب مثله لكل سجل من جنسه، فتُفتح كل عائلة وكل حملة لا المزارة وحدها.
  const groups = [families.map((f) => f.id), campaigns.map((c) => c.id), agents.map((a) => a.id), summary.funds.map((f) => f.id), [...inspections.keys()], entries.map((e) => e.id), boxes.map((b) => b.id)];
  for (const key of Object.keys(get)) {
    const ids = key.match(UUID) ?? [];
    if (ids.length !== 1) continue;
    const group = groups.find((g) => g.includes(ids[0]));
    if (!group) continue;
    for (const id of group) { const k = key.replace(ids[0], id); if (!(k in get)) await direct(k); }
  }

  const me = get['/auth/me'];
  const data = { recordedAt: new Date().toISOString(), me, families, get, post };
  fs.writeFileSync(OUT, `window.__EYWAA_DEMO__ = ${JSON.stringify(data)};\n`);
  const patterns = [...new Set(Object.keys(get).map((k) => k.replace(UUID, ':id').replace(/=[^&]*/g, '=…')))].sort();
  console.log(`recorded ${Object.keys(get).length} GET, ${Object.keys(post).length} POST → ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
  console.log(patterns.join('\n'));
  console.log('POST:', Object.keys(post).join(' '));
})().catch((e) => { console.error('RECORD FAILED:', e); process.exit(1); });
