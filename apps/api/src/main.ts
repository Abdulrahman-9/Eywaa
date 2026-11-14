import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { AppModule } from './app.module';
import { loadConfig } from './config';

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  // خلف Caddy: عنوان الطالب الحق في ترويسة الوسيط. بغير هذا يبدو الناس كلهم عنواناً واحداً فيُكبحون معاً.
  if (config.TRUST_PROXY) app.getHttpAdapter().getInstance().set('trust proxy', config.TRUST_PROXY);
  // ترويسات تحمي المتصفح: لا تُعرض الصفحات داخل إطار، ولا يُخمَّن نوع المحتوى، ولا يُحفظ ما فيه بيانات.
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  // تطبيق الجوال (يُنصَّب من المتصفح) يُخدم تحت /m. ملف عامل الخدمة لا يُحفظ في المتصفح، ليصل التحديث إلى الأجهزة.
  const mobileDist = process.env.MOBILE_DIST ? resolve(process.env.MOBILE_DIST) : null;
  if (mobileDist && existsSync(join(mobileDist, 'index.html'))) {
    app.use('/m/assets', express.static(join(mobileDist, 'assets'), { immutable: true, maxAge: '365d', fallthrough: false,
      setHeaders: (res: { setHeader: (k: string, v: string) => void }) => res.setHeader('Cache-Control', 'public, max-age=31536000, immutable') }));
    app.use('/m', express.static(mobileDist, { index: false }));
    app.use('/m', (req: { method: string }, res: { sendFile: (p: string) => void }, next: () => void) =>
      req.method === 'GET' ? res.sendFile(join(mobileDist, 'index.html')) : next());
  }
  // في النشر يخدم الخادم نفسه لوحة الإدارة المبنيّة، فيكفي النظامَ حاويةٌ واحدة وعنوان واحد.
  const adminDist = process.env.ADMIN_DIST ? resolve(process.env.ADMIN_DIST) : null;
  if (adminDist && existsSync(join(adminDist, 'index.html'))) {
    // الملفات المبنيّة تحمل بصمة محتواها في أسمائها، فتُحفظ في المتصفح سنة.
    app.use('/assets', express.static(join(adminDist, 'assets'), { immutable: true, maxAge: '365d', fallthrough: false,
      setHeaders: (res: { setHeader: (k: string, v: string) => void }) => res.setHeader('Cache-Control', 'public, max-age=31536000, immutable') }));
    app.use(express.static(adminDist, { index: false }));
    app.use((req: { method: string; path: string }, res: { sendFile: (p: string) => void }, next: () => void) =>
      req.method === 'GET' && !req.path.startsWith('/api/') ? res.sendFile(join(adminDist, 'index.html')) : next());
  }
  app.enableShutdownHooks();
  await app.listen(config.PORT);
}

bootstrap();
