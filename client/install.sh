#!/bin/sh
# agent-radio client installer, served by the server as {{PUBLIC_URL}}/client/install.sh
#
#   curl -fsSL {{PUBLIC_URL}}/client/install.sh | sh
#
# Installs the `agent-radio` command (~/.local/bin, or ~/bin when only that is in PATH), the Claude skill
# (~/.claude/skills/agent-radio/SKILL.md) and the config file ~/.config/agent-radio/env (chmod 600).
# The API key is asked for on the terminal (not echoed) or taken from AGENT_RADIO_KEY; it is never printed.
# It can also add the voice-summary rule (client/claude-md-snippet*.md) to ~/.claude/CLAUDE.md: only after a y/N answer on the terminal or with
# AGENT_RADIO_CLAUDE_MD=1, and only when the rule's heading is not in the file yet.
# The "radio guard" hook script is installed to ~/.local/share/agent-radio/agent-radio-hook.sh; it is wired into ~/.claude/settings.json
# (Stop + PreToolUse AskUserQuestion) only after a y/N answer on the terminal or with AGENT_RADIO_HOOKS=1 (backup first, idempotent).
# Safe to run again: the command and the skill are replaced, an existing key is kept.
set -eu

URL="${AGENT_RADIO_URL:-{{PUBLIC_URL}}}"
URL="${URL%/}"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/agent-radio"
CONF_FILE="$CONF_DIR/env"
SKILL_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/agent-radio"
CLAUDE_MD="${CLAUDE_MD_FILE:-$HOME/.claude/CLAUDE.md}"
HOOK_DIR="${AGENT_RADIO_HOOK_DIR:-$HOME/.local/share/agent-radio}"
HOOK_FILE="$HOOK_DIR/agent-radio-hook.sh"
SETTINGS="${CLAUDE_SETTINGS_FILE:-$HOME/.claude/settings.json}"

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"

in_path() { case ":$PATH:" in *":$1:"*) return 0 ;; *) return 1 ;; esac; }

if in_path "$HOME/.local/bin"; then
  BIN_DIR="$HOME/.local/bin"
elif in_path "$HOME/bin"; then
  BIN_DIR="$HOME/bin"
else
  BIN_DIR="$HOME/.local/bin"
fi

mkdir -p "$BIN_DIR" "$CONF_DIR" "$SKILL_DIR"

fetch() { curl -fsSL "$URL/client/$1" -o "$2.tmp" && mv "$2.tmp" "$2"; }

fetch agent-radio "$BIN_DIR/agent-radio" || die "could not download the client from $URL"
chmod 755 "$BIN_DIR/agent-radio"
say "client:  $BIN_DIR/agent-radio"

fetch SKILL.md "$SKILL_DIR/SKILL.md" || die "could not download the skill from $URL"
say "skill:   $SKILL_DIR/SKILL.md"

# ---- the voice-summary rule in ~/.claude/CLAUDE.md (asked, never silent; the heading marks it as already added) ----
MARK_RU='# Голосовая сводка в радио agent-radio'
MARK_EN='# Voice summary to the agent-radio'
case "${AGENT_RADIO_LANG:-${LC_ALL:-${LANG:-}}}" in ru*|uk*) SNIPPET=claude-md-snippet.md ;; *) SNIPPET=claude-md-snippet.en.md ;; esac
if [ -f "$CLAUDE_MD" ] && { grep -qxF "$MARK_RU" "$CLAUDE_MD" || grep -qxF "$MARK_EN" "$CLAUDE_MD"; }; then
  say "rule:    already in $CLAUDE_MD"
else
  add_rule=""
  if [ "${AGENT_RADIO_CLAUDE_MD:-}" = 1 ]; then
    add_rule=y
  elif (: </dev/tty) 2>/dev/null; then
    printf 'Add the voice-summary rule to %s (the agent speaks a short summary at the end of a turn)? [y/N] ' "$CLAUDE_MD" >/dev/tty
    read -r add_rule </dev/tty || add_rule=""
  fi
  case $add_rule in
    y|Y|yes|YES)
      if fetch "$SNIPPET" "$CONF_DIR/$SNIPPET"; then
        mkdir -p "$(dirname "$CLAUDE_MD")"
        { [ -s "$CLAUDE_MD" ] && printf '\n'; cat "$CONF_DIR/$SNIPPET"; } >>"$CLAUDE_MD" || true
        rm -f "$CONF_DIR/$SNIPPET"
        say "rule:    added to $CLAUDE_MD"
      else
        say "rule:    could not download $SNIPPET (skipped)"
      fi ;;
    *) say "rule:    not added ($URL/client/claude-md-snippet.md has the text)" ;;
  esac
fi

# ---- the radio guard hook: script always installed, settings.json changed only with consent ----
mkdir -p "$HOOK_DIR"
fetch agent-radio-hook.sh "$HOOK_FILE" || die "could not download the hook from $URL"
chmod 755 "$HOOK_FILE"
say "hook:    $HOOK_FILE"

hook_manual() {
  say "hook:    not enabled. To enable, add to $SETTINGS:"
  say "         \"hooks\": {\"Stop\": [{\"hooks\": [{\"type\": \"command\", \"command\": \"$HOOK_FILE stop\", \"timeout\": 10}]}],"
  say "                    \"PreToolUse\": [{\"matcher\": \"AskUserQuestion\", \"hooks\": [{\"type\": \"command\", \"command\": \"$HOOK_FILE question\", \"timeout\": 10}]}]}"
}

add_hooks=""
if [ "${AGENT_RADIO_HOOKS:-}" = 1 ]; then
  add_hooks=y
elif (: </dev/tty) 2>/dev/null; then
  printf 'Enable the radio guard hook in %s (reminds the agent to send a spoken summary when you listen)? [y/N] ' "$SETTINGS" >/dev/tty
  read -r add_hooks </dev/tty || add_hooks=""
fi
case $add_hooks in
  y|Y|yes|YES)
    if ! command -v python3 >/dev/null 2>&1; then
      say "hook:    python3 is missing, cannot edit settings.json automatically"
      hook_manual
    else
      mkdir -p "$(dirname "$SETTINGS")"
      AR_SETTINGS="$SETTINGS" AR_HOOK="$HOOK_FILE" python3 - <<'PYEOF' || say "hook:    settings.json was not changed"
import json, os, shutil, sys

path, hook = os.environ["AR_SETTINGS"], os.environ["AR_HOOK"]
data = {}
if os.path.exists(path) and os.path.getsize(path) > 0:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        assert isinstance(data, dict)
    except Exception:
        print("hook:    %s is not valid JSON, left untouched" % path)
        sys.exit(1)

def has(entries, cmd):
    return any(
        h.get("command") == cmd
        for e in entries if isinstance(e, dict)
        for h in (e.get("hooks") or []) if isinstance(h, dict)
    )

hooks = data.setdefault("hooks", {})
if not isinstance(hooks, dict):
    print("hook:    unexpected 'hooks' value in %s, left untouched" % path)
    sys.exit(1)
changed = False
for event, matcher, mode in (("Stop", None, "stop"), ("PreToolUse", "AskUserQuestion", "question")):
    cmd = "%s %s" % (hook, mode)
    entries = hooks.setdefault(event, [])
    if not isinstance(entries, list):
        print("hook:    unexpected hooks.%s in %s, left untouched" % (event, path))
        sys.exit(1)
    if has(entries, cmd):
        continue
    entry = {"hooks": [{"type": "command", "command": cmd, "timeout": 10}]}
    if matcher:
        entry = {"matcher": matcher, **entry}
    entries.append(entry)
    changed = True

if not changed:
    print("hook:    already enabled in %s" % path)
    sys.exit(0)
text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
json.loads(text)
if os.path.exists(path):
    shutil.copy2(path, path + ".agent-radio.bak")
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    f.write(text)
os.replace(tmp, path)
print("hook:    enabled in %s (backup: %s.agent-radio.bak)" % (path, path))
PYEOF
    fi ;;
  *) hook_manual ;;
esac

if ! in_path "$BIN_DIR"; then
  say "note:    $BIN_DIR is not in your PATH; add this to your shell profile:  export PATH=\"$BIN_DIR:\$PATH\""
fi

# ---- config ----
# values are written single-quoted; a ' inside a value becomes '\'' (the client reads the file as text, it never sources it)
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

existing_key=""
if [ -r "$CONF_FILE" ]; then
  existing_key=$(sed -n 's/^AGENT_RADIO_KEY=//p' "$CONF_FILE" | head -n 1)
  case $existing_key in
    \'*\') existing_key=${existing_key#\'}; existing_key=${existing_key%\'} ;;
    \"*\") existing_key=${existing_key#\"}; existing_key=${existing_key%\"} ;;
  esac
fi

key="${AGENT_RADIO_KEY:-}"
if [ -z "$key" ] && [ -z "$existing_key" ]; then
  # `curl | sh` has no stdin, so ask on the terminal itself; echo is switched back on whatever happens
  if (: </dev/tty) 2>/dev/null; then
    trap 'stty echo </dev/tty 2>/dev/null || true' EXIT INT TERM HUP
    printf 'API key (create one on the "Подключить агента" page; input is hidden): ' >/dev/tty
    stty -echo </dev/tty 2>/dev/null || true
    read -r key </dev/tty || key=""
    stty echo </dev/tty 2>/dev/null || true
    printf '\n' >/dev/tty
  fi
fi
[ -n "$key" ] || key="$existing_key"

# always rewritten: a URL given in AGENT_RADIO_URL replaces the stored one, an existing key is kept
umask 077
{
  printf 'AGENT_RADIO_URL=%s\n' "$(shq "$URL")"
  printf 'AGENT_RADIO_KEY=%s\n' "$(shq "$key")"
} >"$CONF_FILE.tmp"
chmod 600 "$CONF_FILE.tmp"
mv "$CONF_FILE.tmp" "$CONF_FILE"

if [ -z "$key" ]; then
  say "config:  $CONF_FILE written without a key."
  say "         Put your key into it:  AGENT_RADIO_KEY='ar_...'   (or run: AGENT_RADIO_KEY=ar_... sh install.sh)"
  exit 0
fi
if [ -n "${AGENT_RADIO_KEY:-}" ] || [ -z "$existing_key" ]; then
  say "config:  $CONF_FILE (key saved, mode 600)"
else
  say "config:  $CONF_FILE (existing key kept)"
fi

say "check:   $("$BIN_DIR/agent-radio" status 2>&1 | head -n 3 | tr '\n' ' ')"
say "done. Try:  agent-radio say \"Агент на этом компьютере подключён\""
