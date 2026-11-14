#!/usr/bin/env bash
# استرجاع نسخة احتياطية إلى قاعدة فارغة ومجلد مرفقات فارغ.
#   DATABASE_URL=<قاعدة فارغة> STORAGE_DIR=<مجلد فارغ> BACKUP_PASSPHRASE_FILE=... scripts/restore.sh <ملف النسخة>
set -euo pipefail
: "${DATABASE_URL:?}" "${STORAGE_DIR:?}" "${BACKUP_PASSPHRASE_FILE:?}"
file="${1:?اذكر ملف النسخة}"
[ -f "$file.sha256" ] && (cd "$(dirname "$file")" && sha256sum --check --quiet "$(basename "$file").sha256")
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$file" | tar -C "$work" -xf -
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$DATABASE_URL" "$work/db.dump"
mkdir -p "$STORAGE_DIR"
tar -C "$STORAGE_DIR" -xf "$work/storage.tar"
echo "restored"
