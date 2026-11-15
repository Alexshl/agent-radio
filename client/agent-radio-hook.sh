#!/bin/sh
# agent-radio guard: if someone is listening to the radio and this turn has not sent anything on air yet,
# make the session send a short spoken summary before it asks the user a question or ends its turn.
#   agent-radio-hook.sh stop      -> Stop hook        (blocks the stop once)
#   agent-radio-hook.sh question  -> PreToolUse hook on AskUserQuestion (denies the question once)
# Fast and silent when the radio is offline, nobody listens, or agent-radio is not installed.
MODE="${1:-stop}"
INPUT="$(cat)"
command -v agent-radio >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

STATUS="$(timeout 4 agent-radio status 2>/dev/null)" || exit 0
printf '%s\n' "$STATUS" | grep -q '^listening: yes' || exit 0
LANG_CODE="$(printf '%s\n' "$STATUS" | sed -n 's/^language: //p' | head -1)"

AR_MODE="$MODE" AR_LANG="${LANG_CODE:-uk}" AR_INPUT="$INPUT" python3 - <<'EOF'
import json, os, re, sys

RADIO_CALL = re.compile(r"(^|[;&|(]\s*|\n\s*)(\w+=(\"[^\"]*\"|'[^']*'|\S+)\s+)*agent-radio\s+(say|play)\b")

mode = os.environ["AR_MODE"]
lang = os.environ["AR_LANG"]
try:
    data = json.loads(os.environ.get("AR_INPUT") or "{}")
except Exception:
    sys.exit(0)

# never loop: the Stop hook already pushed once in this stop sequence
if mode == "stop" and data.get("stop_hook_active"):
    sys.exit(0)

path = data.get("transcript_path")
if not path or not os.path.exists(path):
    sys.exit(0)

def entries():
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                yield json.loads(line)
            except Exception:
                continue

ask_ids = set()
events = []  # chronological: ("user_text"|"ask_answer"|"radio")
for e in entries():
    # skip subagents and injected meta messages (hook feedback, skill bodies, reminders)
    if e.get("isSidechain") or e.get("isMeta"):
        continue
    msg = e.get("message") or {}
    content = msg.get("content")
    if e.get("type") == "assistant" and isinstance(content, list):
        for c in content:
            if c.get("type") != "tool_use":
                continue
            if c.get("name") == "AskUserQuestion":
                ask_ids.add(c.get("id"))
            cmd = str((c.get("input") or {}).get("command", ""))
            # a real invocation: at the start of the command or after ; & | ( — not a mention inside quotes
            if c.get("name") == "Bash" and RADIO_CALL.search(cmd):
                events.append("radio")
    elif e.get("type") == "user":
        if isinstance(content, str):
            if not content.startswith("<"):
                events.append("user_text")
        elif isinstance(content, list):
            for c in content:
                if c.get("type") == "tool_result" and c.get("tool_use_id") in ask_ids:
                    events.append("ask_answer")
                elif c.get("type") == "text" and not str(c.get("text", "")).startswith("<"):
                    events.append("user_text")

# anything sent on air since the user last spoke (or last answered a question)?
for ev in reversed(events):
    if ev == "radio":
        sys.exit(0)
    # a question answered inside the turn starts a new window for the next question,
    # but not for the end of the turn: one summary per user message is enough there
    if ev == "user_text" or (ev == "ask_answer" and mode == "question"):
        break

REASONS = {
    "ru": (
        "agent-radio: пользователь сейчас слушает радио. Перед тем как {action}, "
        "отправь в эфир короткую сводку этого хода по-русски: "
        "AGENT_RADIO_SESSION=\"<проект и роль этой сессии, 2–3 слова, напр. shop оркестратор>\" agent-radio say \"…\" — 1–4 разговорных предложения: что сделано и что нужно от пользователя, "
        "без markdown, кода, путей и URL. Потом продолжи как собирался. Пользователю об этой проверке не пиши.",
        {"question": "задать вопрос", "stop": "закончить ход"},
    ),
    "uk": (
        "agent-radio: користувач зараз слухає радіо. Перш ніж {action}, "
        "надішли в ефір коротку зведення цього ходу українською: "
        "AGENT_RADIO_SESSION=\"<проєкт і роль цієї сесії, 2–3 слова, напр. shop оркестратор>\" agent-radio say \"…\" — 1–4 розмовні речення: що зроблено і що потрібно від користувача, "
        "без markdown, коду, шляхів і URL. Потім продовжуй, як збирався. Користувачу про цю перевірку не пиши.",
        {"question": "поставити питання", "stop": "завершити хід"},
    ),
    "en": (
        "agent-radio: the user is listening to the radio right now. Before you {action}, "
        "send a short summary of this turn on air in English: "
        "AGENT_RADIO_SESSION=\"<project and role of this session, 2-3 words, e.g. shop orchestrator>\" agent-radio say \"...\" - 1-4 spoken-style sentences: what was done and what you need from the user, "
        "no markdown, code, paths or URLs. Then carry on as planned. Do not mention this check to the user.",
        {"question": "ask a question", "stop": "end your turn"},
    ),
    "lv": (
        "agent-radio: lietotājs šobrīd klausās radio. Pirms {action}, "
        "nosūti ēterā īsu šī gājiena kopsavilkumu latviešu valodā: "
        "AGENT_RADIO_SESSION=\"<šīs sesijas projekts un loma, 2–3 vārdi, piem. shop orķestrētājs>\" agent-radio say \"…\" — 1–4 sarunvalodas teikumi: kas izdarīts un ko vajag no lietotāja, "
        "bez markdown, koda, ceļiem un URL. Pēc tam turpini, kā plānoji. Lietotājam par šo pārbaudi nerakstī.",
        {"question": "uzdot jautājumu", "stop": "pabeigt gājienu"},
    ),
    "et": (
        "agent-radio: kasutaja kuulab praegu raadiot. Enne kui {action}, "
        "saada eetrisse lühike kokkuvõte sellest käigust eesti keeles: "
        "AGENT_RADIO_SESSION=\"<selle sessiooni projekt ja roll, 2–3 sõna, nt shop orkestraator>\" agent-radio say \"…\" — 1–4 kõnekeelset lauset: mis sai tehtud ja mida on kasutajalt vaja, "
        "ilma markdowni, koodi, teede ja URL-ideta. Seejärel jätka nagu kavatsesid. Kasutajale sellest kontrollist ei kirjuta.",
        {"question": "küsid küsimuse", "stop": "lõpetad käigu"},
    ),
    "lt": (
        "agent-radio: vartotojas dabar klausosi radijo. Prieš {action}, "
        "išsiųsk į eterį trumpą šio etapo santrauką lietuvių kalba: "
        "AGENT_RADIO_SESSION=\"<šios sesijos projektas ir vaidmuo, 2–3 žodžiai, pvz. shop orkestratorius>\" agent-radio say \"…\" — 1–4 šnekamosios kalbos sakiniai: kas padaryta ir ko reikia iš vartotojo, "
        "be markdown, kodo, kelių ir URL. Tada tęsk, kaip planavai. Vartotojui apie šį patikrinimą nerašyk.",
        {"question": "užduodamas klausimą", "stop": "baigdamas etapą"},
    ),
    "de": (
        "agent-radio: Der Nutzer hört gerade Radio. Bevor du {action}, "
        "sende eine kurze Zusammenfassung dieses Durchgangs auf Deutsch auf Sendung: "
        "AGENT_RADIO_SESSION=\"<Projekt und Rolle dieser Sitzung, 2–3 Wörter, z. B. shop Orchestrator>\" agent-radio say \"…\" – 1–4 gesprochene Sätze: was erledigt wurde und was du vom Nutzer brauchst, "
        "ohne Markdown, Code, Pfade und URLs. Mach dann wie geplant weiter. Erwähne diese Prüfung dem Nutzer gegenüber nicht.",
        {"question": "eine Frage stellst", "stop": "den Durchgang beendest"},
    ),
    "sv": (
        "agent-radio: användaren lyssnar på radion just nu. Innan du {action}, "
        "skicka en kort sammanfattning av den här vändan i etern på svenska: "
        "AGENT_RADIO_SESSION=\"<projekt och roll för den här sessionen, 2–3 ord, t.ex. shop orkestrerare>\" agent-radio say \"…\" – 1–4 talspråkliga meningar: vad som är gjort och vad du behöver av användaren, "
        "utan markdown, kod, sökvägar och URL:er. Fortsätt sedan som planerat. Nämn inte den här kontrollen för användaren.",
        {"question": "ställer en fråga", "stop": "avslutar vändan"},
    ),
}
template, actions = REASONS.get(lang, REASONS["en"])
reason = template.format(action=actions["question" if mode == "question" else "stop"])
if mode == "question":
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}, ensure_ascii=False))
else:
    print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
EOF
exit 0
