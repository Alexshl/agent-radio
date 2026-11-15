<p align="center"><img src="src/client/assets/logo.svg" alt="agent-radio" width="140"></p>

# agent-radio

English | [Русский](README.ru.md)

A self-hosted, multi-user "personal radio" for AI agents. Every user has one station: a music bed (a relay of an internet radio, a playlist from the shared
music library, or silence). When your coding agent finishes something it sends a short text summary; the server turns it into speech and plays it into your
station with the music ducked. If nobody is listening, the message is skipped (no TTS, no queue) and kept in the history. Agents can also send finished audio
(a rendered music mix, a voice sample) which plays with the music muted.

## How it works

```
 agents (Claude Code, scripts)                       listeners
   agent-radio say / play                       phone (VLC), browser, any player
            |                                              ^
            v  HTTPS + API key                             | /stream/<id>.mp3?k=<token>
   +--------------------+   text   +-----------+   +-------------+
   |  app (Hono + SQLite)|-------->|    TTS    |   |   Icecast   |
   |  web UI, API, auth, |  clip   | azure /   |   | one mount   |
   |  library, history   |<--------| openai /  |   | per station |
   +--------------------+          | gemini /  |   +------^------+
            | control API          | piper     |          |
            v                      +-----------+          |
   +--------------------+  voice queue (music ducked)     |
   |     Liquidsoap     |  track queue (music muted)  ----+
   | one station / user |  music bed: relay | playlist | silence
   +--------------------+
```

- **Agents** talk to `/api/say` and `/api/play` with a per-computer API key (or use the `agent-radio` command and the Claude skill in `client/`).
- **TTS**: Azure Neural, OpenAI, Gemini or Piper (offline, the default and the fallback). Keys are stored AES-GCM encrypted.
- **Liquidsoap** mixes every station; **Icecast** serves it; the app proxies the stream behind a secret per-user token.
- **Web UI** (React): station control, music library and playlists, agent keys, history, admin. Russian interface (strings in `src/client/i18n`).

## Passkeys, uploads, player

- **Passkeys (WebAuthn)**: add them in the account menu > Безопасность (also the password change); sign-in works without typing an e-mail. RP ID = host of `PUBLIC_URL`.
- **Own music**: the admin (and users, when the admin switches it on in Админка > Фонотека; per-user quota, default 2 GB) can upload mp3/flac/ogg/opus/m4a/wav (up to 95 MB per file) in Фонотека. Files land in `MUSIC_DIR/uploads/<artist>/<album>/`; the admin can delete a track (the file moves to `MUSIC_DIR/.trash`). `MUSIC_DIR` is mounted read-write into the app, read-only into liquidsoap.
- **Player**: one global player bar for track previews, history clips and the live stream; it stays while you move between pages.
- A separate dev stack: `docker compose -p agent-radio-dev up -d --build` with its own `PORT`, `MUSIC_DIR` and volumes; `docker compose -p agent-radio-dev down -v` removes it. The permanent one is the staging stack (see "Release process").

## Quick start

Needs Docker. Or tell your AI agent: "take this repo and install the radio" ([INSTALL.md](INSTALL.md) and `skills/agent-radio-setup` guide it).

```sh
cp .env.example .env     # set ADMIN_EMAIL, ADMIN_PASSWORD (12+ chars), MUSIC_DIR, PUBLIC_URL, icecast passwords
docker compose up -d --build
```

Open `http://localhost:8791`, sign in, then **Подключить агента** > create a key > paste the prompt into Claude on the computer you want to connect
(it runs `curl -fsSL <your server>/client/install.sh | sh`). For access from a phone use a Cloudflare Tunnel or Tailscale (see INSTALL.md) and set `PUBLIC_URL`.
Listen with VLC (it plays with the screen off); browsers play only in the foreground.

```sh
agent-radio status                      # listeners, language to write in
agent-radio say "Build finished, all tests pass"
agent-radio play mix.mp3 "Here is the new mix"
```

## Automatic summaries

`install.sh` can add a rule to `~/.claude/CLAUDE.md` (the agent speaks a summary at the end of a task) and, optionally, a "radio guard" hook
(`AGENT_RADIO_HOOKS=1`, or answer `y` when asked). The hook is installed to `~/.local/share/agent-radio/agent-radio-hook.sh` and wired into
`~/.claude/settings.json` as a `Stop` hook and a `PreToolUse` hook for `AskUserQuestion` (existing settings are kept, a backup is made). If you are
listening and the session has not sent `agent-radio say|play` since your last message, it blocks the stop (or the question) once and tells the agent
to send a 1-4 sentence spoken summary first. Without consent `settings.json` is never touched.

## API reference

Agent endpoints use `Authorization: Bearer ar_...` (create keys in the web UI). Errors are `{"error": "<code>", "message": "..."}`.

### `POST /api/say`

```sh
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     -d '{"session":"invoa","host":"devbox","text":"Migration finished"}' $URL/api/say
```
`text` up to 2000 characters. Answer `{"id","status":"aired"|"skipped"|"queued"|"waiting","listeners":N}`; `id` is the message id (see `GET /api/messages/:id`). With nobody listening: `skipped`, no TTS.
A listener who dropped within the last 180 s (a player reconnecting, an app deploy) counts as "recently listening": the message is synthesized and held, the answer is `202 {"status":"waiting"}`, it goes on air when
somebody is back and is `skipped` (`expired`) after 180 s. A slow voice (more than 15 s) answers `202 {"status":"queued"}` and airs when ready. Limits: 10 per minute per key and
the admin's hourly limit per user (`429`). The clip starts with "Session <name>." in the user's language when that switch is on.

### `POST /api/play` (multipart/form-data)

```sh
curl -H "Authorization: Bearer $KEY" -F file=@mix.mp3 -F title="Mix v3" -F intro="Here is the new mix" -F session=tu-mani $URL/api/play
```
Fields: `file` (mp3, wav, flac, ogg, opus, m4a, aac; default max 95 MB (below the 100 MB request limit of Cloudflare) and 20 minutes, admin settings), `title`, `intro` (spoken first), `session`, `host`.
The file is validated with ffprobe, normalised to about -14 LUFS and encoded as 44.1 kHz stereo mp3 192k. It is always saved to the history (kept 7 days) and
goes on air only if somebody listens right now; while it plays the music is muted and voice messages wait. Answer `{"status","listeners","id","title","durationSec"}`;
errors: `400 file_required|no_audio`, `413 too_large|too_long`, `415 unsupported_type`.

### `GET /api/status`

`{"up","listeners","listening","reconnecting","title","lang","speakSession","chime","voice","station":{...}}`. `lang` (`uk`, `ru`, `en`) is the language summaries should be written in.
`listening` is true when `listeners > 0` or somebody was seen within the last 180 s; `reconnecting` is true when `listeners` is 0 but `listening` still is (the CLI prints `listening: yes` and `reconnecting: yes`).

### `GET /api/messages/:id`

Where one of your messages stands: `{"id","status","reason","attempts","createdAt","startedAt","endedAt"}`. `status`: `waiting` (held for a reconnecting listener), `queued` (a slow voice is still synthesizing),
`on_air_queued` (handed to the engine, not started), `playing`, `played` (to the end; `startedAt` / `endedAt` in epoch ms), `skipped` or `failed` (`reason`: `nobody_listening`, `expired`, `tts_failed`,
`push_failed`, `not_started`, `engine_restarted`). The engine confirms when a clip starts and ends; a clip that did not start within 30 s is pushed once more. `agent-radio say --wait` polls this (up to 60 s) and prints
`played` or `not played: <reason>`.

### `PUT /api/station/source`

`{"type":"relay","url":"https://..."}`, `{"type":"playlist","dir":"Jazz"}`, `{"type":"userplaylist","playlistId":"..."}` or `{"type":"silence"}`; applied live.

### Mix levels and speech rate

`PATCH /api/app/settings` (web session) takes `musicGainDb` (-30..+6, the music bed before ducking), `voiceGainDb` (-12..+12, spoken messages),
`trackGainDb` (-12..+6, uploaded files), `duckDb` (0..40) and `speechRate` (0.8..1.6). Levels are applied live in Liquidsoap (`/station/set_levels`, no stream
interruption) and restored after an engine restart; a limiter on the station output keeps +12 dB voice from clipping. `GET /api/status` returns them
(`station.musicGainDb|voiceGainDb|trackGainDb|duckDb`, `speechRate`). Defaults for new stations / users: Админка > Голос и TTS.
Speech rate is native for Piper (`--length-scale`), Azure (SSML prosody) and OpenAI (`speed`); other providers use ffmpeg `atempo`.

### Piper voices

Админка > Голос и TTS > Голоса Piper lists the official catalog (`rhasspy/piper-voices`, cached in the data volume, refreshed daily): download (md5 verified),
delete, test, enable for users. Only downloaded and enabled voices (every speaker of a multi-speaker model separately) appear in the voice select.

### Local neural voices (optional sidecar)

`tts-local` is a CPU-only Python 3.11 service (no GPU: an AMD gfx803 card is not supported by ROCm / PyTorch) that serves neural voices over HTTP on an
internal network (`GET /voices`, `POST /synthesize {engine, voice, text, rate}` returns a WAV; one request at a time per engine, timeouts, a queue of 3).
It is opt-in: set `COMPOSE_PROFILES=local-tts` in `.env` and run `docker compose up -d --build tts-local` (the app starts without it; an unreachable
sidecar only means the voices are not offered, and a failing local voice falls back to Piper). The first start downloads several GB of models into the
`ttsmodels` volume, so the container needs internet access then (it sits on the `edge` network next to the app; it publishes no port). Limits:
`TTS_LOCAL_CPUS` (default 6), `TTS_LOCAL_MEM` (default 10g).

Admin > Голос и TTS > "Локальные нейро-голоса" shows every engine with its status (model loading / loaded), a test through the global player and the
switch that offers it to users (off by default). Speech rate is native for StyleTTS2 and F5, ffmpeg `atempo` for Silero.
`POST /api/say` answers `202 {"status":"queued"}` when the speech is not ready within 15 s (`SAY_SYNC_WAIT_MS`); the clip goes on air when it is
ready, unless the listeners left meanwhile (then it stays in the history as skipped). The `agent-radio` CLI treats 202 as success.

| Engine (`TTS_LOCAL_ENGINES`)          | Language | Voices                              | License of the models / code                                                                                                                                                               |
| ------------------------------------- | -------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `styletts2` (default)                 | uk       | 31 speakers                         | MIT: patriotyk/styletts2_ukrainian_multispeaker_hifigan, patriotyk/styletts2-inference, ukrainian-word-stress (lang-uk), ipa-uk                                                            |
| `silero` (opt-in)                     | ru       | aidar, baya, kseniya, xenia, eugene | **CC BY-NC-SA 4.0** (snakers4/silero-models): non-commercial use only, enable it only if that fits your installation                                                                       |
| `f5` (`TTS_LOCAL_F5=1`, experimental) | ru       | one reference voice                 | Apache-2.0: ESpeech/ESpeech-TTS-1_RL-V2 + RUAccent for stress; F5-TTS code is MIT. The reference clip (`tts-local/ref/ru.wav`, 7 s) is a segment of ESpeech/ESpeech-webinars2 (Apache-2.0) |

The Ukrainian front-end is the model author's: stress marks (ukrainian-word-stress with stanza) and IPA (ipa-uk). Write numbers as words: the author's
neural verbalizer is not included. F5-TTS is far too slow on a CPU for live use (see the benchmark below); it is there for evaluation.

Benchmark on the production host (12 cores, the sidecar limited to 6 CPUs, same two sentences, warm models; real-time factor = synthesis time / audio time):

| Voice                                  | Synthesis, s | Audio, s | RTF   |
| -------------------------------------- | ------------ | -------- | ----- |
| StyleTTS2 uk (Денис Денисенко)         | 5.29         | 7.37     | 0.72  |
| Silero v5 ru (xenia)                   | 0.11         | 6.78     | 0.02  |
| F5-TTS ru (ESpeech, 32 steps)          | 168.30       | 6.42     | 26.21 |
| F5-TTS ru (ESpeech, 16 steps, default) | 79.50        | 6.42     | 12.38 |
| Piper mykyta high uk                   | 4.37         | 8.84     | 0.49  |
| Piper dmitri medium ru                 | 1.18         | 6.59     | 0.18  |
| Piper irina medium ru                  | 1.26         | 7.50     | 0.17  |

Piper numbers include starting the `piper` process and loading the model for every message (that is how the app calls it); the sidecar keeps its models in memory.

Memory of the sidecar: about 3 GB with StyleTTS2 + Silero loaded, about 7.5 GB with F5-TTS as well; CPU about 5 cores while synthesizing, idle otherwise.

### Streams

`GET /stream/<stationId>.mp3?k=<listenToken>` and `.m3u`. A wrong token answers 404. "Change link" in the UI makes a new token.

## Deploy without dropping listeners

The public port belongs to a small front proxy (service `front`, Caddy 2.8, `deploy/Caddyfile`), not to the app. `/stream/<id>.mp3?k=<token>` goes
`front` -> (the app only checks the token: `forward_auth` to the internal `/internal/stream-auth`) -> the icecast mount, byte for byte (`flush_interval -1`), so an open stream does
not depend on the app at all. Everything else goes to the app, and the front waits up to 10 s for it while it restarts. `/internal/*` is answered 404 by the front; the app itself publishes no port.
Query strings are removed from the front's access log (they carry the listen token).

- App changes: `docker compose up -d --build app` (or `scripts/deploy.sh prod`). Open streams keep playing; players that reconnect during the few seconds the app is down are retried by the front, and
  the "recently listening" grace (180 s) keeps `listening: yes` and holds messages meanwhile.
- `front` (new image or compose change), `icecast`, `liquidsoap` (changed `liquidsoap/radio.liq` or image) still cut the stream when they restart. `scripts/deploy.sh prod` refuses to restart them without
  `--allow-listener-drop` and prints a big warning. A changed `deploy/Caddyfile` alone is applied with `caddy reload` (graceful, no drop).
- The web player reconnects by itself (1 s, 2 s, 5 s, then every 10 s for about 5 minutes, also when the tab is visible again or the network returns); VLC and other players usually do not.
- Never remove the `data` / `shared` volumes (`down -v` is for the staging/dev stacks only).
- Migrations are additive (`ALTER TABLE ... ADD` only) and run when the app starts, before it serves anything: an older app image runs fine on a newer database, so a rollback never needs a restore.

### One-time cut-over of an existing install (before the front existed)

The app used to publish the port itself; the first deploy that introduces `front` moves the port to it, which cuts the stream once (about 20-40 s). From the main checkout, after the commit passed staging:

1. Tell the listeners. Check the stack is healthy: `docker compose ps`, `scripts/backup.sh`.
2. `git pull` (the commit that passed `scripts/deploy.sh staging`), then `scripts/deploy.sh prod --dry-run` and read the plan.
3. `scripts/deploy.sh prod --allow-listener-drop --smoke-say`. The script backs up the database, keeps the old app image as `agent-radio-app:previous`, rebuilds the app (this frees port 8790), starts `front`
   on it, restarts liquidsoap (new clip confirmation), waits until everything is healthy and smoke-tests the stream.
4. Expect: one drop of the stream, players reconnect within a minute (web player automatically, others: press play). Held messages wait 180 s.
5. Rollback: `scripts/deploy.sh rollback` puts `agent-radio-app:previous` back (the database stays, migrations are additive). If the front itself misbehaves, the old layout is
   `git checkout <previous commit> && docker compose up -d --build` (the app publishes the port again; `front` is removed with `--remove-orphans`).

## Release process: worktree -> staging -> prod

Work happens in a git worktree/branch, never straight on the production checkout.

1. Develop and test in the worktree (Node only in containers: `docker run --rm -v "$PWD":/app -w /app node:22-bookworm npm test`; also `npm run lint`, `npm run typecheck`).
2. Commit, then `scripts/deploy.sh staging`. It builds exactly that checkout into the permanent staging stack (compose project `agent-radio-staging`, volumes `agent-radio-staging_*`, front on
   `127.0.0.1:8796`, `.env.staging` with random secrets, `COMPOSE_PROFILES` empty = no tts-local, piper only, a small sample music folder), waits until it is healthy and runs `scripts/acceptance.sh`
   against it. On PASS (and a clean tree) it writes the stamp `.deploy/passed-<commit sha>` in the main checkout (`.deploy/` is git-ignored and shared by all worktrees). Staging keeps running, so you can open
   `http://127.0.0.1:8796` (admin: `staging-admin@example.test`, password in `.env.staging`) or use the staging API key in `.deploy/staging-api-key`.
3. Merge to `main`, `git pull` in the main checkout. `scripts/deploy.sh prod` refuses unless the working tree is clean, `HEAD == origin/main` and the stamp for `HEAD` exists. It backs up the database
   (`scripts/backup.sh`), rebuilds only the services whose inputs changed (the app by default; `front`, `icecast`, `liquidsoap` only with `--allow-listener-drop`), waits until healthy, smoke-tests (`/healthz`,
   a 5 s stream read, with `--smoke-say` a `say --wait`) and prints how to roll back (`scripts/deploy.sh rollback`).
4. Production (project `agent-radio`, port 8790) and staging never touch each other's volumes: every command of the script goes through its own compose project and env file.

`scripts/acceptance.sh <base_url> <api_key>` (needs `ACCEPT_COMPOSE`, set by deploy.sh) checks: a listener capture and `say --wait` -> played; an app redeploy during a capture -> no gap in the stream;
disconnect -> say within the grace -> `waiting` -> played after the reconnect; liquidsoap restart -> station and mix levels back within 15 s, the next say is played. It is disruptive: staging only.

## Watchdog

`scripts/watchdog.sh` is one health pass; a systemd `--user` timer runs it every 60 s (`deploy/systemd/agent-radio-watchdog.{service,timer}`). It checks the front (`/__front/healthz`), the app (`/healthz`),
that the engine runs every station of the database, that the public stream delivers at least 20 KB of valid MP3 in 5 s, and once an hour a real TTS synthesis. The stream probe sends the User-Agent
`agent-radio-monitor`, which the app subtracts from icecast's listener count (it needs `ICECAST_ADMIN_PASSWORD`, already passed to the app by compose), so the watchdog is never counted as a listener
and never refreshes the "recently listening" grace. A problem is "down" after 2 consecutive failed passes; it is healed with `docker compose -p <project> restart <service>` (at most once per 5 min) and
reported through `WATCHDOG_ALERT_CMD` (the text is in `$WATCHDOG_MESSAGE`), with a "recovered" message later and at most one alert per problem per 30 min.

Install (the main session / the owner does this, nothing is installed by the repository):

```sh
mkdir -p ~/.config/agent-radio ~/.config/systemd/user
printf 'WATCHDOG_REPO=/path/to/checkout\nWATCHDOG_PROJECT=agent-radio\nWATCHDOG_ALERT_CMD=curl -s -d "$WATCHDOG_MESSAGE" https://ntfy.sh/your-topic\n' > ~/.config/agent-radio/watchdog.env
cp deploy/systemd/agent-radio-watchdog.* ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now agent-radio-watchdog.timer
scripts/watchdog.sh --test-alert      # sends one test alert
scripts/watchdog.sh --dry-run         # real checks, no restarts, no alerts
journalctl --user -u agent-radio-watchdog -n 20
```

`loginctl enable-linger $USER` keeps the timer running without a login session. `--simulate app=fail,stream=ok` replaces the checks (used by the tests).

## Stale audio after an interruption (lag)

A player that stops reading the stream for a while (iOS interrupts the audio session when you dictate, a phone in the background, VLC after Pause) and then resumes plays the audio it
buffered, so it stays behind the live broadcast by the length of the interruption, and every further interruption adds to it. Measured with `scripts/lagtest.sh` (a listener that reads 20 s, stops
reading for N s, reads again; a fresh capture started at that moment is searched in its audio by the loudness envelope):

| path                                                                                    | stall           | audio played after the resume                                                                                                                         |
| --------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| production behind Cloudflare Tunnel (read-only run)                                     | 120 s           | the whole backlog, about 118 s behind live (2.9 MB delivered in the first second)                                                                     |
| production behind Cloudflare Tunnel                                                     | 240 s and 420 s | about 61 s of stale audio, then the connection is closed (Cloudflare cut the stalled connection; the 61 s was the capture client's own kernel buffer) |
| staging, host loopback (docker-proxy and a big client buffer absorb it)                 | 90 s            | about 88 s behind live: the server cannot see such a client                                                                                           |
| staging, client inside the stack's network (64 KB receive buffer) with the guards below | 90 s            | 14 s of stale audio, then the server drops the connection: the player reconnects at live                                                              |

What the server does about it (`compose.yaml`, `deploy/Caddyfile`): icecast keeps 10 s of audio per client (`queue-size` = bitrate * 10 s, 240000 bytes at 192 kbps; `burst-size` = 2 s), the kernel send / receive buffers
of `icecast` and `front` are capped at 64 KB (`net.ipv4.tcp_wmem` / `tcp_rmem`, otherwise they autotune to several MB = minutes of audio), the stream is sent with `Cache-Control: no-store, no-transform`
and `flush_interval -1`, and the stream title carries the broadcast minute (`"<track> [14:32]"`, container time zone `STREAM_TZ`, UTC by default) so a listener can see in VLC how far behind it is.
A client that cannot keep up fills the 10 s queue, is dropped, and its player reconnects at the live edge. `scripts/acceptance.sh` step 5 checks this on staging.

What the server cannot do: Cloudflare accepts the stream from the tunnel at real-time speed and keeps what the phone has not read (at least 2 minutes of audio were held in the 120 s run), so neither
icecast nor the app ever sees a slow reader and nothing can be dropped from the server. A "bytes read versus wall clock" check in the app proxy would never fire behind Cloudflare. Players on such a path
must resync themselves:

- Web player (Radio page and the bar): checks every 2 s; more than 6 s behind the live edge, it jumps to 1.5 s before the end of the buffer (or re-opens the stream when it cannot seek). Play after a pause and a
  tab coming back to the foreground always open a fresh connection. The bar shows `LIVE`, or `-Ns` when it is more than 3 s behind.
- VLC: use Stop, not Pause (after a pause VLC plays its old buffer); the title shows the broadcast time `[HH:MM]`: if it is minutes old, press Stop and Play. A lower network cache (VLC iOS: Settings, Network
  Caching Level, "Lowest latency") shrinks VLC's own cache, but not the kernel and Cloudflare buffers, so it is not a cure.
- The structural fix for Cloudflare paths is HLS (a short sliding playlist: a player that fell out of the window jumps to live by protocol). It is not implemented yet.

## Security notes

- Invite-only accounts; passwords PBKDF2-SHA256; httpOnly SameSite=Lax session cookie (Secure behind https); Origin check on every cookie-authenticated mutation;
  login rate limit per IP + email. API keys and invite links are stored as hashes. Provider keys are encrypted with `APP_SECRET`.
- The app listens on 127.0.0.1 by default; put TLS in front (Cloudflare Tunnel, Tailscale). Do not expose the app port directly.
- Stream URLs (presets and users' own links) are fetched by the app, not by the engine: the engine runs on a docker network without internet access. The app
  accepts only public addresses (every DNS answer is checked, the connection is pinned to the checked address, redirects are re-checked) and relays the audio
  to the engine over an internal port that is not published.
- Report vulnerabilities privately via GitHub Security Advisories ("Report a vulnerability" on the repository's Security tab).

## Operations

`scripts/backup.sh` (database + data volume), `docker compose logs -f app`, ship with `scripts/deploy.sh` (see "Release process"); a plain `docker compose up -d --build app` is the manual equivalent for app-only changes. Development: Node 22,
`npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run dev:client`.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md): free for personal, family, research and other noncommercial use; commercial use is not permitted.

Third-party models downloaded at install time keep their own licenses (see the local voices table above): for example Silero v5 is CC BY-NC-SA 4.0, StyleTTS2 Ukrainian is MIT, ESpeech F5-TTS is Apache-2.0, Piper voices vary per voice.
