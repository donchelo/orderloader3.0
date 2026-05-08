#!/bin/bash
# Copia la BD de la VM al local via rsync/SSH.
# Configura VM_HOST y VM_PATH en .env.local antes de usar.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -f "$ROOT_DIR/.env.local" ]; then
  export $(grep -E '^VM_HOST|^VM_PATH' "$ROOT_DIR/.env.local" | xargs)
fi

VM_HOST="${VM_HOST:-}"
VM_PATH="${VM_PATH:-~/orderLoader/.data}"

if [ -z "$VM_HOST" ]; then
  echo "Error: VM_HOST no está definido."
  echo "Agrega VM_HOST=user@ip en .env.local"
  exit 1
fi

echo "Sincronizando BD desde $VM_HOST:$VM_PATH ..."
# Usar SQLite backup via Python para evitar corrupción por WAL mode
ssh "$VM_HOST" "python3 -c \"
import sqlite3, shutil
src = '$VM_PATH/orderloader.db'
dst = '/tmp/orderloader_backup.db'
conn = sqlite3.connect(src)
backup = sqlite3.connect(dst)
conn.backup(backup)
backup.close()
conn.close()
print('Backup OK')
\""
rsync -av --whole-file --progress "${VM_HOST}:/tmp/orderloader_backup.db" "$ROOT_DIR/.data/orderloader.db"
echo "Listo. BD local actualizada."
