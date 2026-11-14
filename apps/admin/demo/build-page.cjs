/**
 * يحوّل ما بناه Vite (dist-demo/index.html) إلى صفحة تُنشر: محتوى بلا هيكل الوثيقة (يضيفه الناشر)،
 * ويطبع قائمة الملفات المرافقة.
 */
const fs = require('node:fs');
const path = require('node:path');
const dist = path.resolve(__dirname, '../dist-demo');
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const head = /<head>([\s\S]*?)<\/head>/.exec(html)[1];
const body = /<body>([\s\S]*?)<\/body>/.exec(html)[1];
const title = /<title>[\s\S]*?<\/title>/.exec(head)[0];
const tags = (head.match(/<(?:script|link)\b[^>]*>(?:<\/script>)?/g) ?? []).join('\n');
fs.writeFileSync(path.join(dist, 'page.html'), `${title}\n${tags}\n${body.trim()}\n`);
const files = [];
const walk = (dir) => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) walk(p); else if (!['index.html', 'page.html'].includes(path.relative(dist, p))) files.push(path.relative(dist, p)); } };
walk(dist);
fs.writeFileSync(path.join(dist, 'files.json'), JSON.stringify(files, null, 1));
console.log(`page.html + ${files.length} files, ${(files.reduce((s, f) => s + fs.statSync(path.join(dist, f)).size, 0) / 1024).toFixed(0)} KB`);
