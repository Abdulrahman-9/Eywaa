# Eywaa — نظام إدارة المركز الإغاثي

نظام لإدارة العوائل المستفيدة واستحقاقاتها وتوزيع المساعدات عليها، يحفظ لكل عائلة حقها ويمنع التكرار.

- الخطة والتحليل: [`docs/PLAN.md`](docs/PLAN.md)
- خارطة التنفيذ: [`docs/ROADMAP.md`](docs/ROADMAP.md)
- الخادم: [`apps/api`](apps/api) — NestJS و PostgreSQL
- لوحة الإدارة: [`apps/admin`](apps/admin) — React و Vite و Tailwind

## تشغيل الخادم

يلزم Node 22 و pnpm و PostgreSQL 16.

```bash
pnpm install
cd apps/api
cp .env.example .env        # ثم املأ المفاتيح: openssl rand -base64 32
pnpm build
set -a && . ./.env && set +a
pnpm migrate                # ينشئ الجداول
pnpm seed                   # ينشئ حساب المدير الأول
pnpm start
```

## تشغيل لوحة الإدارة

والخادم يعمل على المنفذ 3000:

```bash
cd apps/admin
pnpm dev                    # ثم افتح العنوان الذي يطبعه
# اختبار القبول في المتصفح (بعد pnpm build && pnpm preview):
ADMIN_PASSWORD=... node e2e/smoke.cjs
```

## الاختبارات

تحتاج قاعدة فارغة تُمحى في كل تشغيل؛ عنوانها في `TEST_DATABASE_URL`
(الافتراضي `postgres://eywaa:eywaa@localhost:5432/eywaa_test`).

```bash
cd apps/api
pnpm test
# معيار قبول كشف التكرار على 10,000 عائلة (بضع دقائق):
pnpm jest --rootDir . --testMatch '**/*.bench.ts' --testTimeout 900000
```
