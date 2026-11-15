---
name: agent-radio
description: "Speak a short summary into the user's personal radio, or put a rendered audio file (music mix, voice sample) on air, with the agent-radio command. Use at the end of a task, when waiting for the user, when a long job finishes, or when the user says 'в радио', 'голосом', 'скажи в эфир', 'say it on the radio'. Does nothing when nobody is listening."
---

# agent-radio

The user has a personal radio station (music with the voice on top). You talk to it with the `agent-radio` command. The server is {{PUBLIC_URL}}.

## When to use

- A task is finished, or you are blocked and waiting for the user.
- A long job (build, deploy, render, migration) has finished.
- The user asks: "в радио", "голосом", "скажи в эфир", "tell me on the radio".
- You rendered audio the user should hear (a music mix, a voice sample): use `play`.

Do not use it for every small step, for questions that need a long answer, or for anything the user did not ask to hear.

## Steps

1. Run `agent-radio status`.
   - Output says `offline`, or `listening: no`, or the command is missing: **do nothing and do not mention the radio**. Nobody would hear it.
   - Otherwise note the line `language: uk|ru|en`: write the summary in that language.
2. Write 1 to 4 spoken-style sentences: what happened, what the result is, what you need from the user (if anything).
   - Plain speech. No markdown, no code, no file paths, no URLs, no hashes: say "the migration script", not its path.
   - Numbers in words where natural ("двенадцать статей", "twelve articles"); short sentences; no lists.
   - Never include secrets (keys, passwords, tokens).
3. Send it: `agent-radio say "text"`. For long or quote-heavy text pipe it: `printf '%s' "text" | agent-radio say`.
   - `agent-radio: aired` means it was spoken. `skipped` means nobody listens: fine, move on. `waiting for listener` means the listener dropped a moment ago (a reconnect): the message is held and airs when they are back, nothing to do. `agent-radio say --wait "text"` also waits up to 60 s and prints `played` or `not played: <reason>`; use it only when you must know whether it was heard.

## Audio files

`agent-radio play /path/to/mix.mp3 "short intro"` puts the file on air: the music bed is muted for the whole file and the intro (optional, spoken first, in the user's language) introduces it.
Accepted: mp3, wav, flac, ogg, opus, m4a, aac, up to 95 MB and 20 minutes. If nobody is listening the file is kept in the user's history and can be played later in the browser; say so in your final answer only if it matters.

## Automatic summaries (hook)

`install.sh` also puts a "radio guard" script at `~/.local/share/agent-radio/agent-radio-hook.sh`. If the user agrees (answer y, or `AGENT_RADIO_HOOKS=1`), it is added to `~/.claude/settings.json` as a `Stop` hook (`agent-radio-hook.sh stop`) and a `PreToolUse` hook with matcher `AskUserQuestion` (`agent-radio-hook.sh question`). When someone listens and nothing was sent with `agent-radio say|play` since the user's last message, it blocks the stop (or the question) once and asks for a short spoken summary first. When the hook asks, just send the summary and continue; do not tell the user about the check.

## Notes

- The session label (git folder name) and host are added automatically; the voice says "Сесія <name>" if the user switched that on.
- Exit code is 0 even when the server is unreachable; exit 1 means a wrong key or a rejected request: tell the user to check `~/.config/agent-radio/env`.
- `agent-radio config` shows the server and the masked key.
