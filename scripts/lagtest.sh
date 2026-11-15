#!/usr/bin/env bash
# Stalled-listener experiment (it only READS a stream). A player that stops reading (VLC after Pause, a phone in the background) must not come
# back to minutes-old audio: either the server drops it (so the player reconnects at live) or the audio is at most a few seconds behind.
#   scripts/lagtest.sh <label> <stream_url | prod> <outdir> [stop_secs=120] [post_secs=60]
# 1. capture A reads for 20 s, then stops reading for <stop_secs>, then reads again; 2. at that moment a fresh capture B starts (it is live);
# 3. B's first seconds are searched in A's post-resume audio (loudness envelope, scripts/lagcmp.py): the position is how stale A is.
# LAG_MODE=net (default when LAG_COMPOSE is set): A is scripts/stalled-client.py with a 64 KB receive buffer, run INSIDE the stack's network (in the app
#   container, straight to the front on front:8080), so neither the host's docker-proxy nor a big loopback buffer hides what the server does.
#   LAG_COMPOSE is the stack's docker compose command (scripts/acceptance.sh passes ACCEPT_COMPOSE).
# LAG_MODE=rcvbuf: the same client on the host (a loopback test: the host's docker-proxy buffers MBs on its own)
# LAG_MODE=stop: A is curl frozen with SIGSTOP (the client's kernel may buffer MBs of audio: it measures the client's own buffers)
# "prod" reads the stream URL from the API with the key in ~/.config/agent-radio/env (the key is never printed).
# Last line: RESULT lag=<seconds>|dropped|unknown
set -uo pipefail
LABEL=$1
OUT=$3
STOP=${4:-120}
POST=${5:-60}
MODE=${LAG_MODE:-$([ -n "${LAG_COMPOSE:-}" ] && echo net || echo rcvbuf)}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
URL=$2
if [ "$URL" = prod ]; then
  CONF=$HOME/.config/agent-radio/env
  val() { sed -n "s/^$1=//p" "$CONF" | tail -n 1 | sed -e "s/^['\"]//" -e "s/['\"]$//"; }
  BASE=$(val AGENT_RADIO_URL)
  KEY=$(val AGENT_RADIO_KEY)
  URL=$(printf 'header = "Authorization: Bearer %s"\n' "$KEY" | curl -sS -m 20 -K - "$BASE/api/status" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["station"]["listenUrl"])')
fi
echo "[$LABEL] stream: $(printf '%s' "$URL" | sed 's/?k=.*//') (client: $MODE)"
size() { stat -c %s "$1" 2>/dev/null || echo 0; }

A_REMOTE=/tmp/lag-A.mp3
a_size() { if [ "$MODE" = net ]; then $LAG_COMPOSE exec -T app sh -c "stat -c %s $A_REMOTE 2>/dev/null || echo 0" | tr -d '\r'; else size "$OUT/A.mp3"; fi; }
if [ "$MODE" = net ]; then
  # the same URL, but straight to the front inside the stack's network
  AURL="http://front:8080/${URL#*://*/}"
  $LAG_COMPOSE exec -T app rm -f $A_REMOTE
  $LAG_COMPOSE exec -T app python3 - "$AURL" $A_REMOTE --read 20 --stall "$STOP" --after $((POST + 30)) <"$HERE/stalled-client.py" 2>"$OUT/A.err" &
  APID=$!
elif [ "$MODE" = stop ]; then
  curl -sN -A agent-radio-lagtest -m $((STOP + POST + 60)) "$URL" -o "$OUT/A.mp3" &
  APID=$!
else
  python3 "$HERE/stalled-client.py" "$URL" "$OUT/A.mp3" --read 20 --stall "$STOP" --after $((POST + 30)) 2>"$OUT/A.err" &
  APID=$!
fi
sleep 20
echo "[$LABEL] A bytes before the stall: $(a_size)"
[ "$MODE" = stop ] && kill -STOP $APID
S_STOP=$(a_size)
sleep "$STOP"
[ "$MODE" = stop ] && kill -CONT $APID
curl -sN -A agent-radio-lagtest -m $((POST + 20)) "$URL" -o "$OUT/B.mp3" &
BPID=$!
for t in 1 2 5 10 20; do
  sleep $((t == 1 ? 1 : t == 2 ? 1 : t == 5 ? 3 : t == 10 ? 5 : 10))
  echo "[$LABEL] +${t}s after resume: A grew $(($(a_size) - S_STOP)) bytes, B has $(size "$OUT/B.mp3") bytes"
done
sleep $((POST - 20))
A_ALIVE=0
kill -0 $APID 2>/dev/null && A_ALIVE=1
echo "[$LABEL] capture A still connected at the end: $A_ALIVE"
kill $APID $BPID 2>/dev/null
wait 2>/dev/null
[ "$MODE" = net ] && $LAG_COMPOSE cp app:$A_REMOTE "$OUT/A.mp3" >/dev/null 2>&1
tail -c +$((S_STOP + 1)) "$OUT/A.mp3" >"$OUT/A_post.mp3"
echo "[$LABEL] A total $(size "$OUT/A.mp3") bytes, post-resume part $(size "$OUT/A_post.mp3") (= $(($(size "$OUT/A_post.mp3") / 24000)) s of audio at 192 kbps), B $(size "$OUT/B.mp3"); stalled ${STOP}s"
python3 -I "$HERE/lagcmp.py" "$OUT/A_post.mp3" "$OUT/B.mp3" "$LABEL" "$A_ALIVE" | tee "$OUT/result.txt"
