import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';

const api = process.env.API_URL ?? 'http://localhost:3000';
const BASE = '/m/';

/**
 * عامل الخدمة: يحفظ ملفات التطبيق كلها عند أول فتح، فيعمل بعدها بلا شبكة.
 * اسم المخزن بصمة الملفات؛ فإن تغيّر ملف نُصّبت نسخة جديدة ومُحيت القديمة.
 */
function serviceWorker(): Plugin {
  return {
    name: 'eywaa-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((f) => /\.(js|css|woff2)$/.test(f)).sort();
      const version = createHash('sha256').update(files.join('|')).digest('hex').slice(0, 12);
      const urls = [BASE, ...files.map((f) => BASE + f), ...['manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'].map((f) => BASE + f)];
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: `const CACHE = 'eywaa-mobile-${version}';
const FILES = ${JSON.stringify(urls)};
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('eywaa-mobile-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith('${BASE}')) return;
  e.respondWith(caches.open(CACHE).then(async (c) =>
    (await c.match(e.request, { ignoreSearch: true })) ?? (e.request.mode === 'navigate' ? (await c.match('${BASE}')) : undefined) ?? fetch(e.request)));
});
`,
      });
    },
  };
}

export default defineConfig({
  base: BASE,
  plugins: [react(), tailwindcss(), serviceWorker()],
  server: { proxy: { '/api': api } },
  preview: { proxy: { '/api': api } },
});
