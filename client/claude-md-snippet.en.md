# Voice summary to the agent-radio

Before the last action of a turn (that is, before the final `AskUserQuestion`), run `agent-radio status` if the `agent-radio` command is installed.
- If the answer has `listening: yes`, send `agent-radio say "..."`: 1-4 conversational sentences about what was done and what is needed from the user. Take the language from the `language:` line of the status. No markdown, code, paths or URLs. Details: the `agent-radio` skill.
- If `listening: no`, `offline`, or the command is missing, send nothing and do not mention it.
- A finished audio file (a mix, a render) goes through `agent-radio play <file> "a short intro"`.
- `Agent` sub-agents do not speak to the radio; the calling session does.
