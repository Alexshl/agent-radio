import { LANG, LANGS, LANG_NAMES, S, type Lang, setLang } from '../i18n'

// Interface language picker (a select); choosing one saves it and reloads the page.
export function LanguageSwitch({ variant }: { variant: 'menu' | 'auth' }) {
  const select = (
    <select
      className="inp"
      aria-label={S.common.interfaceLanguage}
      value={LANG}
      style={variant === 'menu' ? { width: '100%' } : { width: 'auto', minWidth: 140 }}
      onChange={(e) => setLang(e.target.value as Lang)}
    >
      {LANGS.map((l) => (
        <option key={l} value={l} lang={l}>
          {LANG_NAMES[l]}
        </option>
      ))}
    </select>
  )
  if (variant === 'auth') return select
  return (
    <div style={{ padding: '6px 9px' }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
        {S.common.interfaceLanguage}
      </div>
      {select}
    </div>
  )
}
