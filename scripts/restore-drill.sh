#!/usr/bin/env bash
# تمرين الاسترجاع: يأخذ نسخة من القاعدة الحيّة ومرفقاتها، يسترجعها إلى قاعدة ومجلد مؤقتين، ثم يفحص المسترجَع:
# سلسلة التدقيق، توازن القيود، أن المفاتيح تفكّ ما فيه، وأن أعداد الجداول والملفات تطابق الأصل. ثم يمحو المؤقت.
# النسخة التي لم تُجرَّب استرجاعاً ليست نسخة: شغّله قبل الإطلاق، ثم كل شهر، وبعد كل تغيير في الخادم أو المفاتيح.
#
#   DATABASE_URL=... STORAGE_DIR=... BACKUP_PASSPHRASE_FILE=... FIELD_ENC_KEY=... FIELD_HMAC_KEY=... scripts/restore-drill.sh
#
# يحتاج صلاحية إنشاء قاعدة على الخادم نفسه (المستخدم في docker-compose يملكها). وإن لم يملكها مستخدم التطبيق
# فأعطِ DRILL_ADMIN_URL عنوان قاعدة الصيانة بمستخدم يملكها.
set -euo pipefail
: "${DATABASE_URL:?}" "${STORAGE_DIR:?}" "${BACKUP_PASSPHRASE_FILE:?}" "${FIELD_ENC_KEY:?}" "${FIELD_HMAC_KEY:?}"
here="$(cd "$(dirname "$0")" && pwd)"
verify="$here/../apps/api/dist/db/verify.js"
[ -f "$verify" ] || { echo "ابنِ الخادم أولاً: (cd apps/api && pnpm build)" >&2; exit 2; }

work="$(mktemp -d)"
drill_db="eywaa_drill_$(date -u +%Y%m%d%H%M%S)"
swap_db() { echo "$1" | sed -E "s#/[^/?]+(\?.*)?\$#/$2\1#"; }
admin_url="${DRILL_ADMIN_URL:-$(swap_db "$DATABASE_URL" postgres)}"
drill_url="$(swap_db "$DATABASE_URL" "$drill_db")"
cleanup() {
  # لا يُمحى إلا ما أنشأه هذا التمرين باسمه.
  psql -q "$admin_url" -c "drop database if exists \"$drill_db\"" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

started=$(date +%s)
echo "1/4 نسخة احتياطية من القاعدة الحيّة…"
file="$("$here/backup.sh" "$work/backups")"
size=$(du -h "$file" | cut -f1)

echo "2/4 استرجاعها إلى قاعدة مؤقتة ($drill_db)…"
psql -q "$admin_url" -c "create database \"$drill_db\""
DATABASE_URL="$drill_url" STORAGE_DIR="$work/storage" "$here/restore.sh" "$file" >/dev/null

echo "3/4 فحص المسترجَع (التدقيق، القيود، المفاتيح)…"
restored_ok=0
DATABASE_URL="$drill_url" node "$verify" > "$work/restored.json" || restored_ok=$?
node "$verify" > "$work/live.json" || true
live_files=$(find "$STORAGE_DIR" -type f 2>/dev/null | wc -l)
restored_files=$(find "$work/storage" -type f | wc -l)

echo "4/4 المقارنة بالأصل…"
node - "$work/live.json" "$work/restored.json" "$live_files" "$restored_files" "$restored_ok" "$size" "$(( $(date +%s) - started ))" <<'JS'
const fs = require('fs');
const [live, restored] = [2, 3].map((i) => JSON.parse(fs.readFileSync(process.argv[i], 'utf8')));
const [liveFiles, restoredFiles, verifyExit] = [4, 5, 6].map((i) => Number(process.argv[i]));
const problems = [];
if (verifyExit !== 0) problems.push('فحص المسترجَع أخفق (سلسلة التدقيق، أو القيود، أو المفاتيح)');
if (!restored.auditOk) problems.push(`سلسلة التدقيق في المسترجَع مكسورة عند السطر ${restored.auditBrokenAtSeq}`);
if (!restored.ledgerBalanced || restored.ledgerEntriesBroken) problems.push('قيود المسترجَع غير متوازنة');
if (restored.keys === 'mismatch') problems.push('المفاتيح المعطاة لا تفكّ ما في المسترجَع');
// النظام قد يعمل والتمرين جارٍ، فيزيد الأصل سطوراً بعد أخذ النسخة: المسترجَع لا يزيد على الأصل، ولا ينقص عنه إلا بما جدّ.
for (const [t, n] of Object.entries(restored.counts)) {
  if (n > live.counts[t]) problems.push(`جدول ${t}: في المسترجَع ${n} وفي الأصل ${live.counts[t]}`);
}
if (restoredFiles > liveFiles) problems.push(`المرفقات: في المسترجَع ${restoredFiles} وفي الأصل ${liveFiles}`);
const lag = Object.entries(restored.counts).filter(([t, n]) => n < live.counts[t]).map(([t, n]) => `${t} ${n}/${live.counts[t]}`);
console.log(JSON.stringify({
  backupSize: process.argv[7], seconds: Number(process.argv[8]),
  restored: { audit: restored.auditOk, auditEntries: restored.auditEntries, ledgerBalanced: restored.ledgerBalanced, keys: restored.keys, files: restoredFiles, counts: restored.counts },
  liveMovedMeanwhile: lag, sameLastAuditHash: restored.lastAuditHash === live.lastAuditHash,
  result: problems.length ? 'FAILED' : 'OK', problems,
}, null, 2));
process.exit(problems.length ? 1 : 0);
JS
