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

## تطبيق الميدان (الجوال)

تطبيق ويب يُنصَّب على هاتف أندرويد من المتصفح (PWA) ويعمل بلا شبكة. يخدمه الخادم نفسه تحت `/m`.

```bash
cd apps/mobile
pnpm build                       # الناتج في dist، ويخدمه الخادم إن ضُبط MOBILE_DIST
MOBILE_DIST=$PWD/dist node ../api/dist/main.js
```

على الهاتف: افتح `https://عنوان-الخادم/m/` في Chrome، ثم من القائمة «إضافة إلى الشاشة الرئيسية». **يلزم HTTPS**: الكاميرا وعامل الخدمة والتشفير لا تعمل في المتصفح بدونه.

## النشر على خادم

يلزم خادم فيه Docker واسم نطاق يشير إليه.

```bash
cp deploy/.env.example .env      # املأ النطاق وكلمة سر القاعدة والمفاتيح الأربعة
docker compose up -d --build     # القاعدة، والتطبيق (الخادم ومعه اللوحة)، و Caddy لشهادة HTTPS
docker compose exec -e ADMIN_PASSWORD='...' app node dist/db/seed.js   # حساب المدير الأول، مرة واحدة
```

المفاتيح في `.env` لا تُبدَّل بعد أول تشغيل، ولا تُحفظ مع النسخ الاحتياطية في موضع واحد.

## ربط مزوّد الرسائل

الافتراضي محاكاة: تُسجَّل كل رسالة ولا تُرسل. للإرسال الحقيقي اضبط `MSG_GATEWAY_URL` و`MSG_GATEWAY_TOKEN` في ملف البيئة (شرحها في `deploy/.env.example`) وأعد التشغيل؛ تظهر في صفحة التنبيهات عبارة «بوّابة ...» بدل «محاكاة».

المزوّد يلزمه أن يقبل طلباً بهذا الشكل، أو يُكتب له وسيط صغير يحوّله:

```
POST <MSG_GATEWAY_URL>
Authorization: Bearer <MSG_GATEWAY_TOKEN>
{"channel": "SMS", "to": "+9647701234567", "text": "..."}
→ 200 {"id": "مرجع الرسالة"}
```

**واتساب**: الرسالة التي يبدؤها المركز لا تكون نصاً حراً؛ يلزمها قالب معتمد عند Meta. فالوسيط هو الذي يقابل نص النظام بالقالب.

## النسخ الاحتياطي والاسترجاع

```bash
DATABASE_URL=... STORAGE_DIR=... BACKUP_PASSPHRASE_FILE=... scripts/backup.sh /backups    # ملف واحد مشفّر
DATABASE_URL=<قاعدة فارغة> STORAGE_DIR=<مجلد فارغ> BACKUP_PASSPHRASE_FILE=... scripts/restore.sh /backups/eywaa-....tar.enc
DATABASE_URL=... node apps/api/dist/db/verify.js     # سلسلة التدقيق، وتوازن القيود، وأعداد الجداول
```

## الاختبارات

تحتاج قاعدة فارغة تُمحى في كل تشغيل؛ عنوانها في `TEST_DATABASE_URL`
(الافتراضي `postgres://eywaa:eywaa@localhost:5432/eywaa_test`).

```bash
cd apps/api
pnpm test
# معايير القبول بالأحجام الكبيرة (كشف التكرار، النقاط، التنبيهات، الحمل):
pnpm jest --rootDir . --testMatch '**/*.bench.ts' --testTimeout 900000

# اختبارات المتصفح، كل ملف على قاعدة فارغة والخادم واللوحة يعملان:
cd ../admin && ADMIN_PASSWORD=... node e2e/families.cjs
```

اختبارات المتصفح تحتاج Playwright ومتصفحه على الجهاز، وهو **ليس في حزم المشروع**:
`npm i -g playwright && npx playwright install chromium`. وهي لا تجري في CI بعد: تُشغَّل باليد.
والاختبارات تمحو قاعدتها كلها في كل تشغيل، فترفض أن تعمل على قاعدة لا ينتهي اسمها بـ`_test`.

اختبار تطبيق الميدان (على قاعدة فارغة، والخادم يخدم `apps/mobile/dist`):

```bash
cd apps/mobile
ADMIN_PASSWORD=... BASE_URL=http://localhost:3000 node e2e/mobile.cjs    # 21 خطوة: متصلاً ومنقطعاً والمزامنة
ADMIN_PASSWORD=... BASE_URL=http://localhost:3000 node e2e/scan.cjs      # الماسح بكاميرا وهمية
ADMIN_PASSWORD=... BASE_URL=http://localhost:3000 node e2e/agent.cjs     # المتعهد: حصته والتخويل (يحتاج اللوحة على ADMIN_URL)
ADMIN_PASSWORD=... BASE_URL=http://localhost:3000 node e2e/collector.cjs # المتعهد محصِّلاً: الصناديق والتبرعات والذمة والطلبات
ADMIN_PASSWORD=... BASE_URL=http://localhost:3000 node e2e/inspect.cjs   # الكشف الميداني من الهاتف دون اتصال
```
