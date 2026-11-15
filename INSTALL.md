# Installing agent-radio (written for an AI agent)

You are an AI coding agent and the user said something like "take this repo and install the radio". Do not guess: run the interview in
[`skills/agent-radio-setup/SKILL.md`](skills/agent-radio-setup/SKILL.md) (ask one short question at a time, with a recommended answer), then do the
steps below. Everything runs in Docker; nothing needs to be installed on the host except Docker (and optionally `cloudflared`).

## What gets installed

`docker compose` starts three containers: `icecast` (the public mounts), `liquidsoap` (the audio engine: one station per user, music bed + ducked voice +
uploaded files) and `app` (web UI + API + TTS + library index, SQLite in the `data` volume). The app listens on `127.0.0.1:${PORT}` only. `liquidsoap` and `icecast` sit on a docker network without internet access; relayed radio streams reach the engine only
through the app (SSRF-safe fetch on an internal port that is never published).
A separate client (`agent-radio` command + a Claude skill) is installed on every computer whose agents should talk: from the server's
`/client/install.sh`.

## Steps

1. **Check the machine.** `uname -s` (Linux or Darwin), `docker --version`, `docker compose version`. If Docker is missing: Linux
   `curl -fsSL https://get.docker.com | sh` (ask first, needs sudo) and add the user to the `docker` group; macOS: Docker Desktop
   (https://www.docker.com/products/docker-desktop) or `brew install --cask docker`, then start it once.
2. **Get the interview answers** (see the setup skill): server or client-only, public address, TTS provider and keys, music folder, admin email + password.
3. **Create `.env`** from `.env.example` (never commit it):
   - `PORT` (default 8791), `PUBLIC_URL` (the address people and agents use, with `https://` when behind a tunnel),
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD` (12+ characters),
   - `TRUST_PROXY=1` when the app is behind a tunnel or reverse proxy (Cloudflare Tunnel), so the login rate limit sees the real client address,
   - `MUSIC_DIR` (an absolute path to the music folder; mounted read-only),
   - `ICECAST_SOURCE_PASSWORD`, `ICECAST_ADMIN_PASSWORD` = random strings, `APP_SECRET` = random (encrypts the stored TTS keys; keep it with backups):
     `openssl rand -base64 32 | tr -d '/+=' | head -c 40`
4. **Start:** `docker compose up -d --build`. First start builds the web app, migrates a fresh database, seeds the admin and scans the music folder.
   The Piper voice model (about 100 MB) is downloaded in the background on first start.
5. **Health check:** `curl -fsS http://127.0.0.1:$PORT/healthz` returns `{"ok":true}`; `docker compose ps` shows all three containers up; `docker compose logs app`
   shows `library scan` and `engine sync` lines.
6. **TTS keys (optional):** sign in at `PUBLIC_URL` as the admin > Админка > Голос и TTS > Подключить (Azure: key + region, OpenAI, Gemini), press
   "Проверить голос". Piper works without any key.
7. **Public access:** Cloudflare Tunnel, Tailscale or LAN, see the setup skill. After it works, make sure `PUBLIC_URL` in `.env` matches and run
   `docker compose up -d` again.
8. **First API key:** `docker compose exec app npm run cli -- create-key <admin email> "<computer name>"` prints the key once. Do not store it anywhere
   except the client config.
9. **Client on this machine:** `AGENT_RADIO_KEY=<key> curl -fsSL $PUBLIC_URL/client/install.sh | sh` (or run the script and paste the key at the prompt).
   It installs `agent-radio` to `~/.local/bin` and the skill to `~/.claude/skills/agent-radio/`.
10. **Listen link:** `docker compose exec app npm run cli -- show <admin email>` prints the personal stream link (or use the web UI, "Слушать на телефоне").
    Show a QR code in the terminal when `qrencode` exists: `qrencode -t ansiutf8 "<link>"`. Recommend VLC (iOS / Android) for the phone: it keeps playing with
    the screen off. Safari / Chrome play only in the foreground.
11. **Test:** with the stream open somewhere, `agent-radio say "Радио установлено и работает"`; expect `agent-radio: aired`.
    With nobody listening the answer is `skipped (nobody listening)`, which is also correct.

## Updating, backups, uninstall

- Update: `git pull && docker compose up -d --build`. Migrations run on start.
- Backup: `scripts/backup.sh` (SQLite copy + data volume). Restore: stop the stack, put the `.db` into the `data` volume as `radio.db`, start.
- Uninstall: `docker compose down -v` (removes the database), delete `~/.local/bin/agent-radio`, `~/.claude/skills/agent-radio`, `~/.config/agent-radio`.

## Do not

- Do not open the app port to the internet without TLS; use the tunnel.
- Do not print the API key or `ADMIN_PASSWORD` back to the user after you have written them to their files.
- Do not edit `liquidsoap/radio.liq` to "fix" things before reading `docker compose logs liquidsoap`.
