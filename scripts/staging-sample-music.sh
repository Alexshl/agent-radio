#!/usr/bin/env bash
# Three synthetic 10-minute "tracks" for the staging music folder: tones whose pitch and loudness drift with several incommensurate periods (no repeat within minutes), so a capture of the
# stream can be matched against another one by its loudness envelope (the lag experiment in scripts/lagtest.sh). Needs ffmpeg on the host.
# Usage: scripts/staging-sample-music.sh <dir> [force]
set -euo pipefail
DIR=${1:?usage: staging-sample-music.sh <dir> [force]}
mkdir -p "$DIR"
for i in 1 2 3; do
  f="$DIR/tone-$i.mp3"
  if [ -s "$f" ] && [ "$(stat -c %s "$f")" -gt 5000000 ] && [ "${2:-}" != force ]; then continue; fi
  ffmpeg -loglevel error -y -f lavfi \
    -i "aevalsrc=sin(2*PI*(200+80*sin(0.0${i}521*t)+40*sin(0.1${i}31*t))*t)*(0.35+0.15*sin(0.0${i}731*t)+0.12*sin(0.1${i}913*t+1)+0.08*sin(0.4${i}77*t+2))|sin(2*PI*(300+60*sin(0.0${i}337*t))*t)*(0.3+0.2*sin(0.2${i}13*t)+0.1*sin(0.0${i}61*t)):d=600:s=44100" \
    -b:a 128k -metadata title="Sample tone $i" "$DIR/.new-$i.mp3"
  mv "$DIR/.new-$i.mp3" "$f"
done
chmod a+rw "$DIR"/*.mp3 2>/dev/null || true
