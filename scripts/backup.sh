#!/usr/bin/env bash
# نسخة احتياطية مشفّرة: قاعدة البيانات ومجلد المرفقات في ملف واحد.
#   DATABASE_URL=... STORAGE_DIR=... BACKUP_PASSPHRASE_FILE=... scripts/backup.sh <مجلد النسخ>
# المرفقات مشفّرة بمفتاح الحقول، فلا تنفع النسخة بلا FIELD_ENC_KEY؛ احفظ المفاتيح في موضع غير موضع النسخ.
set -euo pipefail
: "${DATABASE_URL:?}" "${STORAGE_DIR:?}" "${BACKUP_PASSPHRASE_FILE:?}"
out_dir="${1:?اذكر مجلد النسخ}"
mkdir -p "$out_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

pg_dump --format=custom --no-owner --no-privileges --file="$work/db.dump" "$DATABASE_URL"
mkdir -p "$STORAGE_DIR"
tar -C "$STORAGE_DIR" -cf "$work/storage.tar" .
tar -C "$work" -cf - db.dump storage.tar \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$BACKUP_PASSPHRASE_FILE" -out "$out_dir/eywaa-$stamp.tar.enc"
sha256sum "$out_dir/eywaa-$stamp.tar.enc" > "$out_dir/eywaa-$stamp.tar.enc.sha256"
echo "$out_dir/eywaa-$stamp.tar.enc"
