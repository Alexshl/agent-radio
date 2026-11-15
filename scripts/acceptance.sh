#!/usr/bin/env bash
# Acceptance test of a running agent-radio stack. Usage:  scripts/acceptance.sh <base_url> <api_key>
#
#   1. listener capture            a listener is connected, `agent-radio say --wait` -> played
#   2. app redeploy               the app container is recreated while a listener captures: the stream has no gap (byte rate + chunk timestamps)
#   3. disconnect / reconnect      nobody listens, say within the 180 s grace -> 202 waiting, the listener returns -> played
#   4. liquidsoap restart          station + mix levels are back within 15 s, the next say is played
#   5. lag guards                  the stream title has a "[HH:MM]" lag marker; a listener frozen for 90 s (SIGSTOP, like VLC after Pause) is
#                                  either dropped by the server or at most 10 s behind live when it continues
#
# Steps 2 and 4 need to control the stack: set ACCEPT_COMPOSE to the docker compose command of THAT stack
# (scripts/deploy.sh staging does). Without it they are reported as SKIPPED and the run counts as failed (ACCEPT_ALLOW_PARTIAL=1 accepts that).
# The test is disruptive (it recreates the app and restarts the engine, which cuts listeners): never point it at production.
# Needs: bash, curl, python3 (+ the agent-radio CLI of this checkout). Exit code 0 = all steps passed.
set -uo pipefail

BASE=${1:-}
KEY=${2:-}
[ -n "$BASE" ] && [ -n "$KEY" ] || { echo 'usage: scripts/acceptance.sh <base_url> <api_key>' >&2; exit 2; }
BASE=${BASE%/}
HERE=$(cd "$(dirname "$0")/.." && pwd)
CLI="$HERE/client/agent-radio"
PROBE="$HERE/scripts/stream-probe.py"
COMPOSE=${ACCEPT_COMPOSE:-}
[ "${ACCEPT_PROJECT:-}" = agent-radio ] && { echo 'refusing to run against the production project (agent-radio)' >&2; exit 2; }
export AGENT_RADIO_URL=$BASE AGENT_RADIO_KEY=$KEY AGENT_RADIO_SESSION=acceptance AGENT_RADIO_CONFIG=/dev/null

WORK=$(mktemp -d)
FAILS=0
STEPS=()
t0=$SECONDS
log() { printf '[%3ss] %s\n' $((SECONDS - t0)) "$*"; }
pass() { log "PASS  $*"; STEPS+=("PASS  $*"); }
fail() { log "FAIL  $*"; STEPS+=("FAIL  $*"); FAILS=$((FAILS + 1)); }
skip() { log "SKIP  $*"; STEPS+=("SKIP  $*"); [ "${ACCEPT_ALLOW_PARTIAL:-0}" = 1 ] || FAILS=$((FAILS + 1)); }

api() { curl -sS -m 20 -H "Authorization: Bearer $KEY" "$@"; }
jfield() { python3 -c 'import json,sys
try:
    v = json.load(sys.stdin)
    for k in sys.argv[1].split("."):
        v = v[k]
    print(str(v).lower() if isinstance(v, bool) else v)
except Exception:
    print("")' "$1"; }
appjs() { $COMPOSE exec -T app node --input-type=module -e "$1"; }

LISTEN_PID=""
listener() { # <secs> <name> [probe options]: a listener in the background; result in $WORK/<name>.json
  local secs=$1 name=$2
  shift 2
  python3 "$PROBE" "$LISTEN_URL" --secs "$secs" --ua agent-radio-acceptance --out "$WORK/$name.mp3" "$@" >"$WORK/$name.json" 2>&1 &
  LISTEN_PID=$!
}
listener_done() { wait "$LISTEN_PID" 2>/dev/null; cat "$WORK/$1.json"; }
probe_ok() { [ "$(jfield ok <"$WORK/$1.json")" = true ]; }
wait_listeners() { # <min|zero> <seconds>
  local end=$((SECONDS + $2)) n
  while [ $SECONDS -lt $end ]; do
    n=$(api "$BASE/api/status" | jfield listeners)
    if [ "$1" = zero ] && [ "${n:-1}" = 0 ]; then return 0; fi
    if [ "$1" = min ] && [ "${n:-0}" -ge 1 ] 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}
say_wait() { "$CLI" say --wait "$1" 2>&1; }

ORIG_LEVELS=""
cleanup() {
  [ -n "$LISTEN_PID" ] && kill "$LISTEN_PID" 2>/dev/null
  if [ -n "$ORIG_LEVELS" ] && [ -n "$COMPOSE" ]; then
    appjs "
import Database from 'better-sqlite3'
const [m, v, t] = '$ORIG_LEVELS'.split(',').map(Number)
const db = new Database('/data/radio.db')
const s = db.prepare('select id from stations limit 1').get()
db.prepare('update stations set music_gain_db = ?, voice_gain_db = ?, track_gain_db = ? where id = ?').run(m, v, t, s.id)
await fetch('http://liquidsoap:8080/station/set_levels', { method: 'POST', body: JSON.stringify({ id: s.id, music_db: m, voice_db: v, track_db: t }) })
" >/dev/null 2>&1
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---- preflight
log "acceptance of $BASE"
STATUS=$(api "$BASE/api/status") || { echo "cannot reach $BASE/api/status" >&2; exit 2; }
[ "$(printf '%s' "$STATUS" | jfield up)" = true ] || { echo "the station is not up: $STATUS" >&2; exit 2; }
LISTEN_URL=$(printf '%s' "$STATUS" | jfield station.listenUrl)
[ -n "$LISTEN_URL" ] || { echo 'no listen URL in /api/status' >&2; exit 2; }
STATION_ID=$(printf '%s' "$STATUS" | jfield station.id)
log "station $STATION_ID, stream $(printf '%s' "$LISTEN_URL" | sed 's/?k=.*//')"
if [ -n "$COMPOSE" ]; then
  log 'warming up the voice (the first synthesis may download the model) ...'
  end=$((SECONDS + 300))
  until [ "$(appjs "const r = await fetch('http://127.0.0.1:' + (process.env.PORT ?? 8790) + '/internal/tts-test', { method: 'POST' }); console.log(r.ok)" 2>/dev/null)" = true ]; do
    [ $SECONDS -ge $end ] && { echo 'the voice does not work (tts-test failed for 300 s)' >&2; exit 2; }
    sleep 5
  done
fi

# ---- 1. listener capture + say --wait
log '--- 1. listener capture, say --wait'
listener 40 s1 --min-bytes 200000 --max-gap 3
if wait_listeners min 15; then
  S=$(api "$BASE/api/status")
  if [ "$(printf '%s' "$S" | jfield listening)" = true ]; then pass 'status: listening with a connected listener'; else fail "status does not say listening: $S"; fi
else
  fail 'the connected listener never showed up in /api/status'
fi
OUT=$(say_wait 'Приймальний тест: перше повідомлення.')
log "say --wait: $(printf '%s' "$OUT" | tr '\n' '|')"
if printf '%s' "$OUT" | grep -q '^agent-radio: played$'; then pass 'say --wait -> played'; else fail "say --wait did not end in played: $OUT"; fi
listener_done s1 >/dev/null
if probe_ok s1; then pass "capture is valid MP3 ($(jfield bytes <"$WORK/s1.json") bytes, max gap $(jfield max_gap_s <"$WORK/s1.json") s)"; else fail "capture problems: $(cat "$WORK/s1.json")"; fi

# ---- 2. app redeploy under a listener
log '--- 2. app redeploy during a capture'
if [ -z "$COMPOSE" ]; then
  skip 'app redeploy (ACCEPT_COMPOSE not set)'
else
  # 24000 B/s at the default 192 kbps; allow icecast burst and jitter: at least 70 % over 50 s
  listener 50 s2 --min-bytes 840000 --min-rate 16800 --max-gap 3
  sleep 8
  RE0=$SECONDS
  $COMPOSE up -d --build --force-recreate --no-deps app >"$WORK/redeploy.log" 2>&1 || { fail "could not redeploy the app: $(tail -n 3 "$WORK/redeploy.log")"; }
  DOWN0=$SECONDS
  end=$((SECONDS + 120))
  until curl -fsS -m 3 -o /dev/null "$BASE/healthz" 2>/dev/null; do
    [ $SECONDS -ge $end ] && break
    sleep 1
  done
  log "app recreated and healthy again after $((SECONDS - RE0)) s (health wait $((SECONDS - DOWN0)) s)"
  listener_done s2 >/dev/null
  log "capture: $(cat "$WORK/s2.json")"
  if probe_ok s2; then pass 'no gap in the stream across the app redeploy'; else fail "stream broke during the app redeploy: $(cat "$WORK/s2.json")"; fi
fi

# ---- 3. disconnect, say within the grace window, reconnect
log '--- 3. disconnect -> say -> waiting -> reconnect -> played'
if wait_listeners zero 20; then pass 'listener disconnected (0 listeners)'; else fail 'listeners did not drop to 0'; fi
S=$(api "$BASE/api/status")
if [ "$(printf '%s' "$S" | jfield listening)" = true ] && [ "$(printf '%s' "$S" | jfield reconnecting)" = true ]; then
  pass 'status: listening + reconnecting during the grace window'
else
  fail "status during the grace window: $S"
fi
HOLD=$(curl -sS -m 20 -w '\n%{http_code}' -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"session":"acceptance","text":"Приймальний тест: повідомлення чекало на слухача."}' "$BASE/api/say")
HOLD_CODE=$(printf '%s' "$HOLD" | tail -n 1)
HOLD_BODY=$(printf '%s' "$HOLD" | sed '$d')
HOLD_ID=$(printf '%s' "$HOLD_BODY" | jfield id)
if [ "$HOLD_CODE" = 202 ] && [ "$(printf '%s' "$HOLD_BODY" | jfield status)" = waiting ] && [ -n "$HOLD_ID" ]; then
  pass "say with 0 listeners within the grace -> 202 waiting ($HOLD_ID)"
else
  fail "expected 202 waiting, got $HOLD_CODE $HOLD_BODY"
fi
CLI_OUT=$("$CLI" say 'Приймальний тест: друге повідомлення чекає.' 2>&1)
if printf '%s' "$CLI_OUT" | grep -q 'waiting for listener'; then pass 'CLI: "waiting for listener"'; else fail "CLI output: $CLI_OUT"; fi
sleep 3
[ "$(api "$BASE/api/messages/$HOLD_ID" | jfield status)" = waiting ] && pass 'still waiting while nobody is connected' || fail 'the held message left the waiting state without a listener'
listener 30 s3 --min-bytes 100000 --max-gap 3
end=$((SECONDS + 25))
ST=""
while [ $SECONDS -lt $end ]; do
  ST=$(api "$BASE/api/messages/$HOLD_ID" | jfield status)
  [ "$ST" = played ] && break
  sleep 1
done
if [ "$ST" = played ]; then pass 'held message played after the listener reconnected'; else fail "held message ended as '$ST' after the reconnect"; fi
listener_done s3 >/dev/null

# ---- 4. liquidsoap restart
log '--- 4. liquidsoap restart'
if [ -z "$COMPOSE" ]; then
  skip 'liquidsoap restart (ACCEPT_COMPOSE not set)'
else
  ORIG_LEVELS=$(appjs "
import Database from 'better-sqlite3'
const db = new Database('/data/radio.db', { readonly: true })
const s = db.prepare('select music_gain_db m, voice_gain_db v, track_gain_db t from stations limit 1').get()
console.log([s.m, s.v, s.t].join(','))
")
  log "levels before: $ORIG_LEVELS; setting -7 / +3 / -2"
  appjs "
import Database from 'better-sqlite3'
const db = new Database('/data/radio.db')
const s = db.prepare('select id from stations limit 1').get()
db.prepare('update stations set music_gain_db = -7, voice_gain_db = 3, track_gain_db = -2 where id = ?').run(s.id)
await fetch('http://liquidsoap:8080/station/set_levels', { method: 'POST', body: JSON.stringify({ id: s.id, music_db: -7, voice_db: 3, track_db: -2 }) })
" >/dev/null
  levels() { appjs "const r = await (await fetch('http://liquidsoap:8080/station/levels')).json(); const s = r.stations.find((x) => x.id === '$STATION_ID'); console.log(s ? [s.music_db, s.voice_db, s.track_db].join(',') : 'none')" 2>/dev/null; }
  BEFORE=$(levels)
  [ "$BEFORE" = '-7,3,-2' ] && pass "engine runs the test levels ($BEFORE)" || fail "engine levels before the restart: $BEFORE"
  R0=$SECONDS
  $COMPOSE restart liquidsoap >/dev/null 2>&1 || fail 'could not restart liquidsoap'
  BACK=""
  while [ $((SECONDS - R0)) -le 40 ]; do
    BACK=$(levels)
    [ "$BACK" = '-7,3,-2' ] && break
    sleep 1
  done
  ELAPSED=$((SECONDS - R0))
  if [ "$BACK" = '-7,3,-2' ] && [ "$ELAPSED" -le 15 ]; then pass "station and levels restored in ${ELAPSED} s (limit 15 s)"; else fail "after the restart: levels '$BACK' after ${ELAPSED} s (limit 15 s)"; fi
  listener 30 s4 --min-bytes 100000 --max-gap 4
  if wait_listeners min 20; then pass 'a listener can connect after the engine restart'; else fail 'no listener after the engine restart'; fi
  OUT=$(say_wait 'Приймальний тест: після перезапуску рушія.')
  log "say --wait: $(printf '%s' "$OUT" | tr '\n' '|')"
  if printf '%s' "$OUT" | grep -q '^agent-radio: played$'; then pass 'next say after the engine restart -> played'; else fail "say after the restart: $OUT"; fi
  listener_done s4 >/dev/null
fi

# ---- 5. lag guards
log '--- 5. lag guards'
if TITLES=$(python3 "$HERE/scripts/icy-title.py" "$LISTEN_URL" 6 2>&1); then
  log "ICY titles: $(printf '%s' "$TITLES" | tr '\n' '|')"
  if printf '%s' "$TITLES" | grep -Eq '\[[0-9]{2}:[0-9]{2}\]$'; then pass 'stream title carries the [HH:MM] lag marker'; else fail "no lag marker in the ICY title: $TITLES"; fi
else
  fail "no ICY metadata: $TITLES"
fi
if [ -z "$COMPOSE" ]; then
  skip 'stalled listener (ACCEPT_COMPOSE not set: the stack is not ours to judge)'
else
  log 'a listener is frozen for 90 s (SIGSTOP), then continued; a fresh capture starts at that moment ...'
  RES=$(LAG_COMPOSE="$COMPOSE" "$HERE/scripts/lagtest.sh" acceptance "$LISTEN_URL" "$WORK/lag" 90 60 2>&1)
  printf '%s\n' "$RES" | sed 's/^/        /'
  LAGRES=$(printf '%s' "$RES" | sed -n 's/^RESULT //p' | tail -n 1)
  case $LAGRES in
    dropped)
      STALE=$(printf '%s' "$RES" | sed -n 's/.*(= \([0-9]*\) s of audio.*/\1/p' | tail -n 1)
      if [ "${STALE:-999}" -le 30 ]; then pass "the frozen listener was dropped by the server after ${STALE} s of stale audio (its player reconnects at live)"; else fail "the frozen listener was dropped only after ${STALE} s of stale audio (limit 30 s)"; fi
      ;;
    lag=*) if [ "${LAGRES#lag=}" -le 10 ]; then pass "the frozen listener is only ${LAGRES#lag=} s behind live after the resume"; else fail "the frozen listener came back ${LAGRES#lag=} s behind live (limit 10 s)"; fi ;;
    *) fail "stalled-listener experiment inconclusive: $LAGRES" ;;
  esac
fi

echo
echo '================ acceptance summary ================'
for s in "${STEPS[@]}"; do echo "$s"; done
if [ "$FAILS" -eq 0 ]; then
  echo "RESULT: PASS ($(($SECONDS - t0)) s)"
  exit 0
fi
echo "RESULT: FAIL ($FAILS problem(s))"
exit 1
