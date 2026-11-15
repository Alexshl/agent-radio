#!/bin/sh
# Backup of agent-radio: a consistent copy of the SQLite database plus the data volume (app-secret, uploads, clips; piper models are skipped,
# they are downloaded again). Run from the repo folder while the stack is up:  scripts/backup.sh [target-dir]
# Keep app-secret together with the database: the TTS provider keys inside the database are encrypted with it.
set -eu
cd "$(dirname "$0")/.."
OUT="${1:-./backups}"
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"

docker compose exec -T app node --input-type=module -e "
import Database from 'better-sqlite3'
const db = new Database(process.env.DB_PATH ?? (process.env.DATA_DIR ?? '/data') + '/radio.db', { readonly: true })
await db.backup('/tmp/backup.db')
"
docker compose cp app:/tmp/backup.db "$OUT/radio-$TS.db"
docker compose exec -T app rm -f /tmp/backup.db

docker compose exec -T app tar czf - -C /data --exclude='./radio.db*' --exclude=./piper . >"$OUT/data-$TS.tar.gz"
chmod 600 "$OUT/radio-$TS.db" "$OUT/data-$TS.tar.gz"
echo "backup: $OUT/radio-$TS.db  $OUT/data-$TS.tar.gz"
