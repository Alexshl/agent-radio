---

name: agent-radio-setup
description: "Install and configure the agent-radio server (and client) from this repository by interviewing the user first. Use when the user says 'install the radio', 'set up agent-radio', 'установи радио', 'поставь радио', 'take this repo and install'. Covers Docker, public access (Cloudflare Tunnel / Tailscale / LAN), TTS provider and keys, music folder, first admin, first API key, client skill, listen link and a test message."
---

# agent-radio setup interview

Goal: a working radio on this machine (or a client-only setup), with as few questions as possible. Ask **one question at a time**, each with a recommended answer
the user can accept with one word. Never ask something you can detect yourself. Read `INSTALL.md` for the exact commands after the interview.

## 0. Detect (no questions)

- OS: `uname -s` (Linux / Darwin) and architecture `uname -m`.
- Docker: `docker --version` and `docker compose version`; is the daemon running (`docker info`)?
- Is this repo's `.env` already there? (then offer to reuse it)
- Is `cloudflared` or `tailscale` installed? Is `qrencode` installed?

## 1. Role

"Install the whole radio server here, or only connect this computer to an existing server?"

- Client-only: ask for the server address and the API key (the user creates it on the "Подключить агента" page), then run
  `AGENT_RADIO_KEY=<key> curl -fsSL <server>/client/install.sh | sh` and jump to step 8.
- Server (recommended on an always-on machine): continue.

## 2. Docker

If missing, say how: Linux `curl -fsSL https://get.docker.com | sh` (needs sudo, ask before running), macOS Docker Desktop. Wait until `docker info` works.

## 3. Public access

"Who will listen, and from where?"

- **Only this computer or the home network** (recommended to start): `PUBLIC_URL=http://<LAN ip or localhost>:8791`; for other devices on the network set
  `BIND_ADDR=0.0.0.0` in `.env`. No TLS: fine at home, not on the internet.
- **Phone / other places, own domain on Cloudflare** (recommended for daily use): Cloudflare Tunnel, no open ports.
  1. Install `cloudflared` (Linux: package from https://pkg.cloudflare.com; macOS: `brew install cloudflared`).
  2. `cloudflared tunnel login` (opens a browser; pick the domain).
  3. `cloudflared tunnel create agent-radio` (prints the tunnel UUID and writes `~/.cloudflared/<UUID>.json`).
  4. `cloudflared tunnel route dns agent-radio radio.example.com` (creates the CNAME; use the user's real hostname).
  5. `~/.cloudflared/config.yml`:

     ```
     tunnel: <UUID>
     credentials-file: /home/<user>/.cloudflared/<UUID>.json
     ingress:
       - hostname: radio.example.com
         service: http://localhost:8791
       - service: http_status:404
     ```

     One hostname to the app port is enough: the app serves the UI, API and the audio streams itself; no path rules.
  6. Run it as a service: `sudo cloudflared service install` (Linux) / `sudo cloudflared service install` (macOS, launchd), or `cloudflared tunnel run agent-radio` in a spare terminal.
  7. `PUBLIC_URL=https://radio.example.com`. Check `curl -I https://radio.example.com/healthz`.
- **Tailscale** (no domain needed): `tailscale serve --bg 8791` gives `https://<machine>.<tailnet>.ts.net` for the tailnet devices (install the Tailscale app on the phone);
  `tailscale funnel 8791` makes it public. Use that URL as `PUBLIC_URL`.

## 4. Voice (TTS)

"Which voice engine?"

- **Piper** (offline, free, robotic but fine): nothing to configure, default.
- **Azure Neural** (recommended: very natural Ukrainian / Russian voices, free tier of 500 thousand characters a month): the user creates an "Azure AI Speech"
  resource, copies a key and the region (for example `westeurope`). Enter them later in the web admin (Админка > Голос и TTS), not in `.env`.
- OpenAI (`gpt-4o-mini-tts`) or Gemini (`gemini-3.8-flash-tts`): an API key.
  The keys are typed by the user into the admin page; do not ask the user to paste secrets into the chat. Piper stays as the fallback in any case.

## 5. Music

"Which folder holds your music?" (absolute path; mounted read-only; subfolders are scanned; mp3, flac, ogg, m4a, opus, wav). If none, use an empty folder:
the radio also relays internet stations and can play silence between messages.

## 6. First admin

Ask for the admin email. Generate a strong password yourself (`openssl rand -base64 18 | tr -d '/+='`), put it into `.env` as `ADMIN_PASSWORD`, show it to the user **once**
and tell them to change nothing but keep it safe. Other people join by invite links (admin page).

## 7. Do it

Follow `INSTALL.md` steps 3 to 11: write `.env` (random `APP_SECRET`, icecast passwords), `docker compose up -d --build`, health check, create the first API key
(`docker compose exec app npm run cli -- create-key <email> "<this computer>"`), run the client installer with `AGENT_RADIO_KEY` set (so the key is never echoed),
show the listen link and a QR code (`qrencode -t ansiutf8 "<link>"` when installed; otherwise just the link).

## 8. Finish

- Tell the user: open the link in **VLC** (iOS / Android: Network stream) to listen with the screen off; browsers (Safari) play only in the foreground.
- Test: `agent-radio status`, then with the stream open `agent-radio say "Радио установлено и работает"`. `skipped (nobody listening)` means no listener yet: ask them to start the stream and retry.
- Summarise in three lines: the address, where `.env` and the backups script are, how to invite someone.

## Rules

- Never print secrets back after writing them; never commit `.env`.
- If a step fails, read the logs (`docker compose logs app liquidsoap icecast`) before changing anything.
- Do not run `sudo` or install system packages without asking.
