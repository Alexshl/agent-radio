// The system prompt of the intro / notes model call. The editable part is a template (the admin section "Учи язык" can override it, the
// override lives in the setting `learn.prompt`; no override = DEFAULT_PROMPT). The JSON answer contract is NOT editable: code appends it
// after the template, so an admin edit cannot break the parsing of the answer.
//
// Template syntax (a tiny mustache subset):
//   {{targetLanguage}}  English name of the listener's language ("Ukrainian")
//   {{targetCode}}      its code ("uk")
//   {{maxIntroChars}}   the longest intro in characters
//   {{#lyrics}}...{{/lyrics}}  the text is kept only when the song has lyrics
//   {{^lyrics}}...{{/lyrics}}  the text is kept only when the song has NO lyrics
// Sections do not nest.

export const MAX_INTRO_CHARS = 900
export const MAX_PROMPT_CHARS = 8000

export const LANG_NAME: Record<string, string> = {
  uk: 'Ukrainian',
  ru: 'Russian',
  en: 'English',
  lv: 'Latvian',
  et: 'Estonian',
  lt: 'Lithuanian',
  de: 'German',
  sv: 'Swedish',
}

export const PLACEHOLDERS = [
  { name: 'targetLanguage', description: 'English name of the listener language, e.g. Ukrainian' },
  { name: 'targetCode', description: 'code of the listener language, e.g. uk' },
  { name: 'maxIntroChars', description: 'maximum length of the spoken intro in characters' },
  { name: '#lyrics ... /lyrics', description: '{{#lyrics}}text{{/lyrics}}: kept only when the song has lyrics' },
  { name: '^lyrics ... /lyrics', description: '{{^lyrics}}text{{/lyrics}}: kept only when the song has no lyrics' },
] as const

export const DEFAULT_PROMPT = `You are a friendly language teacher who hosts a radio show. Before a song you prepare the listener so that, while it plays, they catch
words and expressions of the original language and understand more of it. The listener knows the target language, not the song's language.
Target language of everything you write: {{targetLanguage}} (code {{targetCode}}).
The "intro_script" is what you say on air before the song, in the target language, natural spoken style (it is read by a speech synthesizer:
no lists, no brackets, no emoji), 3-6 sentences, at most {{maxIntroChars}} characters. Say the artist and the title, then in one plain
sentence what the song is about emotionally (for example: it is a love song, he is suffering because she left). {{#lyrics}}Then, as a teacher, point out 2-3 things from the lyrics worth listening for, preferring idioms, set phrases, phrasal verbs and
colloquial turns over plain words: quote each in the original language (in quotes, at most 6 words), say what it literally says if that
differs, and what it really means here (for example: here he sings "break my heart", an idiom: to hurt someone deeply in love). Only use
phrases that really are in the lyrics below.{{/lyrics}}{{^lyrics}}You have no lyrics: do not quote anything and do not invent the content; only say the artist and the title and, if you are sure, one general remark.{{/lyrics}}`

const KNOWN_VARS = new Set(['targetLanguage', 'targetCode', 'maxIntroChars'])
const SECTION = /\{\{([#^])lyrics\}\}([\s\S]*?)\{\{\/lyrics\}\}/g

// null = fine, else what is wrong with the template
export function promptProblem(template: string): string | null {
  if (!template.trim()) return 'The prompt is empty'
  if (template.length > MAX_PROMPT_CHARS) return `The prompt is longer than ${MAX_PROMPT_CHARS} characters`
  const rest = template.replace(SECTION, (_m, _k, body: string) => body)
  for (const m of rest.matchAll(/\{\{([^}]*)\}\}/g)) {
    const name = (m[1] ?? '').trim()
    if (!KNOWN_VARS.has(name)) return `Unknown or unbalanced placeholder: {{${name}}}`
  }
  return null
}

export function renderPrompt(template: string, lang: string, hasLyrics: boolean): string {
  const vars: Record<string, string> = {
    targetLanguage: LANG_NAME[lang] ?? lang,
    targetCode: lang,
    maxIntroChars: String(MAX_INTRO_CHARS),
  }
  return template
    .replace(SECTION, (_m, kind: string, body: string) => ((kind === '#') === hasLyrics ? body : ''))
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name: string) => vars[name] ?? m)
}

// the fixed part: the keys the code reads from the answer
export function contractBlock(lang: string, hasLyrics: boolean): string {
  return `Answer contract (fixed, always applies). Return JSON with the keys:
- "original_lang": ISO 639-1 code of the language the song is sung in.
- "summary": 2-3 sentences in the target language (${LANG_NAME[lang] ?? lang}) about what the song is about.
- "intro_script": the spoken intro, in the target language, plain text for a speech synthesizer, at most ${MAX_INTRO_CHARS} characters.
- "hooks": the original phrases quoted in the intro (array of strings).
- "translations": ${
    hasLyrics
      ? 'an array with the translation of EVERY numbered line of the lyrics into the target language, in the same order and the same count; an empty array if the song is already in the target language.'
      : 'an empty array.'
  }`
}

export function buildSystem(template: string, lang: string, hasLyrics: boolean): string {
  return `${renderPrompt(template, lang, hasLyrics).trim()}\n\n${contractBlock(lang, hasLyrics)}`
}
