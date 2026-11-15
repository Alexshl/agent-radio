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
- A separate dev stack: `docker compose -p agent-radio-dev up -d --build` with its own `PORT`, `MUSIC_DIR` and volumes; `docker compose -p agent-radio-dev down -v` removes it.

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

## API reference

Agent endpoints use `Authorization: Bearer ar_...` (create keys in the web UI). Errors are `{"error": "<code>", "message": "..."}`.

### `POST /api/say`

```sh
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     -d '{"session":"invoa","host":"devbox","text":"Migration finished"}' $URL/api/say
```
`text` up to 2000 characters. Answer `{"status":"aired"|"skipped","listeners":N}`. With nobody listening: `skipped`, no TTS. A slow voice (more than 15 s) answers `202 {"status":"queued","listeners":N}` and airs when ready. Limits: 10 per minute per key and
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

`{"up","listeners","title","lang","speakSession","chime","voice","station":{...}}`. `lang` (`uk`, `ru`, `en`) is the language summaries should be written in.

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

The stream engine (Liquidsoap) and Icecast hold every listener's connection: restarting them cuts all players. Ship app changes with
`docker compose up -d --build app` only; touch `liquidsoap`/`icecast` only when `liquidsoap/radio.liq` or their image changed, and then announce it.
The web player reconnects by itself (1 s, 2 s, 5 s, then every 10 s for about 5 minutes, also when the tab is visible again or the network returns);
VLC and other players usually do not: listeners press play again. Never remove the `data` / `shared` volumes (`down -v` is for the dev stack only).

## Security notes

- Invite-only accounts; passwords PBKDF2-SHA256; httpOnly SameSite=Lax session cookie (Secure behind https); Origin check on every cookie-authenticated mutation;
  login rate limit per IP + email. API keys and invite links are stored as hashes. Provider keys are encrypted with `APP_SECRET`.
- The app listens on 127.0.0.1 by default; put TLS in front (Cloudflare Tunnel, Tailscale). Do not expose the app port directly.
- Stream URLs (presets and users' own links) are fetched by the app, not by the engine: the engine runs on a docker network without internet access. The app
  accepts only public addresses (every DNS answer is checked, the connection is pinned to the checked address, redirects are re-checked) and relays the audio
  to the engine over an internal port that is not published.
- Report vulnerabilities privately via GitHub Security Advisories ("Report a vulnerability" on the repository's Security tab).

## Operations

`scripts/backup.sh` (database + data volume), `docker compose logs -f app`, update with `git pull && docker compose up -d --build`. Development: Node 22,
`npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run dev:client`.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md): free for personal, family, research and other noncommercial use; commercial use is not permitted.

Third-party models downloaded at install time keep their own licenses (see the local voices table above): for example Silero v5 is CC BY-NC-SA 4.0, StyleTTS2 Ukrainian is MIT, ESpeech F5-TTS is Apache-2.0, Piper voices vary per voice.
