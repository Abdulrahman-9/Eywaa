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

## نسخة العرض (للتجربة وإبداء الملاحظات)

لوحة الإدارة نفسها تعمل **بلا خادم** في صفحة واحدة: كل ما تطلبه من الخادم يُجاب ممّا سُجّل من نظام محلي مُلئ ببيانات وهمية. تُفتح بصفة مدير النظام، والقراءة والبحث والتنقل تعمل كلها؛ والتغيير (حفظ، اعتماد، حذف) يُردّ برسالة تقول إن النسخة لا تحفظ. وفيها زر «اكتب ملاحظة» يحفظ ملاحظة المجرّب على الشاشة التي هو فيها.

```bash
cd apps/admin                       # والخادم واللوحة يعملان محلياً على قاعدة فارغة فيها حساب المدير
ADMIN_PASSWORD=... DATABASE_URL=... pnpm demo:seed     # مركز وهمي: 46 عائلة، أربع حملات، مخازن، صناديق، متعهدون، كشوف، مشروع بناء
ADMIN_PASSWORD=... pnpm demo:record                    # يزور الشاشات ويسجّل أجوبة الخادم في demo/public/demo-data.js
pnpm demo:build                                        # dist-demo/page.html وملفاته: تُنشر كما هي على أي مستضيف ملفات ثابتة
```

هي نسخة للعرض وجمع الملاحظات، لا بيئة اختبار قبول: ما يحتاج حفظاً حقيقياً (تسجيل عائلة حتى تظهر في القائمة، تسليم، قيد) يُجرَّب على النظام نفسه بعد نشره.

## النشر على خادم

يلزم خادم فيه Docker واسم نطاق يشير إليه.

```bash
cp deploy/.env.example .env      # املأ النطاق وكلمة سر القاعدة والمفاتيح الأربعة
docker compose up -d --build     # القاعدة، والتطبيق (الخادم ومعه اللوحة)، و Caddy لشهادة HTTPS
docker compose exec -e ADMIN_PASSWORD='...' app node dist/db/seed.js   # حساب المدير الأول، مرة واحدة
```

المفاتيح في `.env` لا تُبدَّل بعد أول تشغيل، ولا تُحفظ مع النسخ الاحتياطية في موضع واحد.

كلمة المدير التي أُنشئ بها حسابه مؤقتة: يغيّرها عند أول دخول، ثم يفعّل التحقق بعاملين (`REQUIRE_TOTP=1` يُلزمه والمحاسبَ به).

| للمشغِّل | |
|---|---|
| هل الخادم قائم؟ | `GET /api/health` يجيب `{"ok":true,"db":true}`، و503 إن انقطعت القاعدة. به يفحص Docker الحاوية، وبه تُربط المراقبة الخارجية |
| مدير نسي كلمته أو فقد هاتف التحقق، ولا مدير غيره | `docker compose exec app node dist/db/reset-admin.js` يطبع كلمة مؤقتة، ويفكّ القفل، ويعطّل التحقق بعاملين، وينهي الجلسات، ويكتب ذلك في سجل التدقيق |
| مفتاح غير مفتاح القاعدة | الخادم يرفض الإقلاع إن لم يفكّ `FIELD_ENC_KEY` ما في القاعدة (يقع عند استرجاع نسخة بملف بيئة غير ملفها) |
| متغيرات اختيارية | `REQUIRE_TOTP`، `TRUST_PROXY` (عدد الوسطاء أمام الخادم، 1 مع Caddy)، `LOGIN_FAILS_PER_IP` (40 محاولة خاطئة في عشر دقائق من عنوان واحد)، `APP_TIMEZONE` (`Asia/Baghdad`) |

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

**تمرين الاسترجاع** (قبل الإطلاق، ثم كل شهر، وبعد كل تغيير في الخادم أو المفاتيح): يأخذ نسخة، يسترجعها إلى قاعدة ومجلد مؤقتين، يفحص المسترجَع (سلسلة التدقيق، توازن القيود، أن المفاتيح تفكّ ما فيه، وأن الأعداد تطابق الأصل)، ثم يمحو المؤقت ويخرج بغير صفر إن وجد خللاً:

```bash
DATABASE_URL=... STORAGE_DIR=... BACKUP_PASSPHRASE_FILE=... FIELD_ENC_KEY=... FIELD_HMAC_KEY=... scripts/restore-drill.sh
```

النسخ اليومي نفسه (`scripts/backup.sh`) لا يُجدوَل من تلقاء نفسه: أضفه إلى `cron` الخادم، وانقل ملفاته إلى موضع غير الخادم.

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
