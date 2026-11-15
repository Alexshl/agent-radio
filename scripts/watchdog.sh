#!/usr/bin/env bash
# agent-radio watchdog: one pass of health checks, healing and alerting. Run it every 60 s from a systemd --user timer
# (deploy/systemd/, see README "Watchdog"). Nothing here is specific to one machine: everything comes from the environment.
#
# Checks (a problem is "down" after WATCHDOG_FAILS consecutive failed passes, default 2):
#   front    GET <base>/__front/healthz        the Caddy front is answering
#   app      GET <base>/healthz                the app is answering (through the front)
#   engine   app's /internal/health            the engine runs every station of the database (liquidsoap reachable)
#   stream   5 s read of the public stream     >= 20 KB of valid MP3, no stalls. It uses the monitor User-Agent: icecast's listener count
#            (and so "listening: yes" and the grace window) does not see this connection
#   tts      app's /internal/tts-test          a real synthesis (at most once per WATCHDOG_TTS_EVERY seconds, default 3600)
# Healing: `docker compose -p <project> restart <service>` (front -> front, app -> app, engine -> liquidsoap or app, stream -> liquidsoap, then
# icecast, then front on repeated failure, tts -> app), at most once per 5 minutes per problem.
# Alerting: WATCHDOG_ALERT_CMD (a shell command; the text is in $WATCHDOG_MESSAGE and in $1) after the problem is down, a "recovered" message when
# it clears, at most one alert per problem per 30 minutes.
#
# Environment:
#   WATCHDOG_REPO         checkout that holds compose.yaml (and .env) of the stack      (default: the checkout this script is in)
#   WATCHDOG_PROJECT      compose project                                               (default: agent-radio)
#   WATCHDOG_ENV_FILE     compose --env-file                                            (default: <repo>/.env)
#   WATCHDOG_BASE_URL     the front as seen from the host                               (default: http://127.0.0.1:<PORT from the env file or 8790>)
#   WATCHDOG_STREAM_URL   a full listen URL (with token) to probe                       (default: read from the stack's database)
#   WATCHDOG_ALERT_CMD    e.g. 'curl -s -d "$WATCHDOG_MESSAGE" https://ntfy.sh/my-topic'
#   WATCHDOG_STATE_DIR    counters                                                      (default: ~/.local/state/agent-radio-watchdog/<project>)
#   WATCHDOG_FAILS, WATCHDOG_TTS_EVERY, WATCHDOG_ALERT_EVERY (1800), WATCHDOG_HEAL_EVERY (300)
# Flags:
#   --dry-run              run the real checks, but restart nothing and run no alert command (it prints what it would do)
#   --simulate a=fail,b=ok replace the real checks (names above) by these results, for testing the logic; restarts are printed, alerts are real
#   --test-alert           send one test alert through WATCHDOG_ALERT_CMD and exit
set -uo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=${WATCHDOG_REPO:-$HERE}
PROJECT=${WATCHDOG_PROJECT:-agent-radio}
ENV_FILE=${WATCHDOG_ENV_FILE:-$REPO/.env}
FAILS_NEEDED=${WATCHDOG_FAILS:-2}
TTS_EVERY=${WATCHDOG_TTS_EVERY:-3600}
ALERT_EVERY=${WATCHDOG_ALERT_EVERY:-1800}
HEAL_EVERY=${WATCHDOG_HEAL_EVERY:-300}
STATE=${WATCHDOG_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agent-radio-watchdog/$PROJECT}
ALERT_CMD=${WATCHDOG_ALERT_CMD:-}
NOW=${WATCHDOG_NOW:-$(date +%s)}

DRY=0
SIM=""
TEST_ALERT=0
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY=1 ;;
    --simulate)
      SIM=${2:-}
      shift
      ;;
    --test-alert) TEST_ALERT=1 ;;
    *)
      echo "watchdog: unknown option $1" >&2
      exit 2
      ;;
  esac
  shift
done

mkdir -p "$STATE"
log() { printf '%s watchdog[%s]: %s\n' "$(date +%FT%T)" "$PROJECT" "$*"; }

alert() { # <text>
  local msg="[agent-radio $PROJECT@$(hostname -s)] $1"
  if [ -z "$ALERT_CMD" ]; then
    log "ALERT (no WATCHDOG_ALERT_CMD set): $msg"
    return 0
  fi
  if [ $DRY = 1 ] && [ -z "$SIM" ]; then
    log "dry run, would alert: $msg"
    return 0
  fi
  log "ALERT: $msg"
  WATCHDOG_MESSAGE=$msg timeout 30 sh -c "$ALERT_CMD" watchdog "$msg" >/dev/null 2>&1 || log 'the alert command failed'
}

if [ $TEST_ALERT = 1 ]; then
  alert 'test alert: the watchdog can reach you'
  exit 0
fi

exec 9>"$STATE/lock"
flock -n 9 || {
  log 'another pass is still running'
  exit 0
}

dc() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$REPO/compose.yaml" "$@"; }
app_node() { timeout 40 docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$REPO/compose.yaml" exec -T app node --input-type=module -e "$1"; }

PORT=$(sed -n 's/^PORT=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)
BASE=${WATCHDOG_BASE_URL:-http://127.0.0.1:${PORT:-8790}}

# ---- the checks: each prints a reason on failure and returns non-zero
check_front() { curl -fsS -m 5 -o /dev/null "$BASE/__front/healthz" 2>&1; }
check_app() { curl -fsS -m 5 -o /dev/null "$BASE/healthz" 2>&1; }
check_engine() {
  app_node "const r = await fetch('http://127.0.0.1:' + (process.env.PORT ?? 8790) + '/internal/health'); const j = await r.json(); console.log(JSON.stringify(j)); process.exit(r.ok ? 0 : 1)" 2>&1
}
check_stream() {
  local url=${WATCHDOG_STREAM_URL:-}
  if [ -z "$url" ]; then
    url=$(app_node "
import Database from 'better-sqlite3'
const db = new Database((process.env.DATA_DIR ?? '/data') + '/radio.db', { readonly: true })
const s = db.prepare('select id, listen_token as t from stations limit 1').get()
if (s) console.log('$BASE/stream/' + s.id + '.mp3?k=' + s.t)
" 2>/dev/null)
  fi
  [ -n "$url" ] || return 0 # no station yet: nothing to probe
  python3 "$HERE/scripts/stream-probe.py" "$url" --secs 5 --min-bytes 20000 --max-gap 3 2>&1
}
check_tts() {
  app_node "const r = await fetch('http://127.0.0.1:' + (process.env.PORT ?? 8790) + '/internal/tts-test', { method: 'POST' }); console.log(await r.text()); process.exit(r.ok ? 0 : 1)" 2>&1
}

sim_result() { # <name> -> ok | fail | "" (not simulated)
  local kv
  for kv in ${SIM//,/ }; do
    [ "${kv%%=*}" = "$1" ] && {
      echo "${kv#*=}"
      return
    }
  done
  # with --simulate everything not named is fine
  [ -n "$SIM" ] && echo ok
}

get() { cat "$STATE/$1.$2" 2>/dev/null || echo "${3:-0}"; }
put() { printf '%s\n' "$3" >"$STATE/$1.$2"; }

heal() { # <problem> <service...>: restart the service chosen by how many times it was tried already
  local p=$1
  shift
  local tries
  tries=$(get "$p" heals)
  local svcs=("$@")
  local idx=$((tries < ${#svcs[@]} ? tries : ${#svcs[@]} - 1))
  local svc=${svcs[$idx]}
  if [ $((NOW - $(get "$p" healed_at))) -lt "$HEAL_EVERY" ]; then
    return 0
  fi
  put "$p" healed_at "$NOW"
  put "$p" heals $((tries + 1))
  HEALED="$svc"
  if [ $DRY = 1 ] || [ -n "$SIM" ]; then
    log "dry run, would run: docker compose -p $PROJECT restart $svc"
  else
    log "healing $p: docker compose -p $PROJECT restart $svc"
    dc restart "$svc" >/dev/null 2>&1 || log "restart of $svc failed"
  fi
}

# one problem: run its check, keep the counters, heal, alert
HEALED=""
run_check() { # <name> <check fn> <heal services...>
  local name=$1 fn=$2
  shift 2
  local out rc sim
  sim=$(sim_result "$name")
  if [ -n "$sim" ]; then
    if [ "$sim" = ok ]; then
      out=''
      rc=0
    else
      out='simulated failure'
      rc=1
    fi
  else
    out=$($fn)
    rc=$?
  fi
  if [ $rc -eq 0 ]; then
    if [ -f "$STATE/$name.down" ]; then
      alert "RECOVERED: $name is healthy again"
      rm -f "$STATE/$name.down"
    fi
    put "$name" fails 0
    put "$name" heals 0
    return 0
  fi
  local fails
  fails=$(($(get "$name" fails) + 1))
  put "$name" fails "$fails"
  log "$name check failed ($fails/$FAILS_NEEDED): $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)"
  [ "$fails" -lt "$FAILS_NEEDED" ] && return 1
  HEALED=""
  heal "$name" "$@"
  touch "$STATE/$name.down"
  if [ $((NOW - $(get "$name" alerted_at))) -ge "$ALERT_EVERY" ]; then
    put "$name" alerted_at "$NOW"
    alert "PROBLEM: $name failed $fails times in a row${HEALED:+; restarted $HEALED}. Last: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"
  fi
  return 1
}

# ---- one pass
if ! run_check front check_front front; then
  log 'front is down: the checks that go through it are skipped'
  exit 1
fi
status=0
run_check app check_app app || status=1
if [ $status -eq 0 ]; then
  # the engine problem is liquidsoap when it cannot be reached, the app (re-sync) when stations are missing
  run_check engine check_engine liquidsoap app || status=1
  run_check stream check_stream liquidsoap icecast front || status=1
fi
# the voice test is expensive: once an hour (or when forced by a simulation)
last_tts=$(get tts checked_at)
if [ -n "$(sim_result tts)" ] || [ $((NOW - last_tts)) -ge "$TTS_EVERY" ]; then
  put tts checked_at "$NOW"
  run_check tts check_tts app || status=1
fi
[ $status -eq 0 ] && log 'all checks passed'
exit $status
