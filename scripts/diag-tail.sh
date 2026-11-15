#!/bin/sh
# Player diagnostics of one user (read-only): prints /data/diag/<userId>.jsonl of the running app container as "time  type  data".
# Usage:  scripts/diag-tail.sh <userEmail> [lines]      (PROJECT=agent-radio-staging for staging; default agent-radio)
set -eu
[ $# -ge 1 ] || { echo "usage: $0 <userEmail> [lines]" >&2; exit 2; }
cd "$(dirname "$0")/.."

docker compose -p "${PROJECT:-agent-radio}" exec -T -e DIAG_EMAIL="$1" -e DIAG_LINES="${2:-200}" app node --input-type=module -e "
import Database from 'better-sqlite3'
import { existsSync, readFileSync } from 'node:fs'
const dataDir = process.env.DATA_DIR ?? '/data'
const db = new Database(process.env.DB_PATH ?? dataDir + '/radio.db', { readonly: true })
const user = db.prepare('select id from users where lower(email) = lower(?)').get(process.env.DIAG_EMAIL)
if (!user) { console.error('no such user'); process.exit(1) }
const file = dataDir + '/diag/' + String(user.id).replace(/[^A-Za-z0-9_-]/g, '_') + '.jsonl'
if (!existsSync(file)) { console.error('no diag log yet for this user'); process.exit(0) }
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-Number(process.env.DIAG_LINES))
let lastUa = ''
for (const l of lines) {
  let e
  try { e = JSON.parse(l) } catch { continue }
  if (e.ua && e.ua !== lastUa) { console.log('# ' + e.ua); lastUa = e.ua }
  const time = new Date(e.t).toISOString().slice(11, 23)
  const { perf, ...rest } = e.data ?? {}
  console.log(time + '  ' + String(e.type).padEnd(26) + ' ' + (perf !== undefined ? 'p=' + perf + ' ' : '') + JSON.stringify(rest))
}
"
