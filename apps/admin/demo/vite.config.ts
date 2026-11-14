import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/** بناء نسخة العرض: اللوحة نفسها بمدخل آخر (demo/main.tsx)، وعناوين نسبية لتُنشر صفحةً قائمة بذاتها. */
export default defineConfig({
  root: resolve(__dirname),
  base: './',
  publicDir: resolve(__dirname, 'public'),
  plugins: [react(), tailwindcss()],
  build: { outDir: resolve(__dirname, '../dist-demo'), emptyOutDir: true },
});
