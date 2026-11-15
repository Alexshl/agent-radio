import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'
const KEY = 'ar-theme'

export function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

export function setTheme(t: Theme) {
  document.documentElement.setAttribute('data-theme', t)
  try {
    localStorage.setItem(KEY, t)
  } catch {
    // private mode: the choice just is not remembered
  }
}

export function useTheme(): [Theme, () => void] {
  const [theme, set] = useState<Theme>(currentTheme)
  useEffect(() => {
    const obs = new MutationObserver(() => set(currentTheme()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return [theme, () => setTheme(theme === 'dark' ? 'light' : 'dark')]
}
