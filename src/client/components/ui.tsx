import type { KeyboardEvent, ReactNode } from 'react'
import { useToast } from './Toast'
import { ApiError } from '../api/client'
import { errorText, S } from '../i18n'

export function Switch({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`sw${on ? ' on' : ''}`}
      onClick={() => onChange(!on)}
    />
  )
}

// The segmented control of the design system (spans, role=tab).
export function Seg<T extends string>({
  value,
  options,
  onChange,
  label,
  style,
  className,
}: {
  value: T
  options: { id: T; label: ReactNode }[]
  onChange: (v: T) => void
  label?: string
  style?: React.CSSProperties
  className?: string
}) {
  const key = (id: T) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onChange(id)
    }
  }
  return (
    <div className={className ? `seg ${className}` : 'seg'} role="tablist" aria-label={label} style={style}>
      {options.map((o) => (
        <span
          key={o.id}
          role="tab"
          tabIndex={0}
          aria-selected={value === o.id}
          className={value === o.id ? 'on' : ''}
          onClick={() => onChange(o.id)}
          onKeyDown={key(o.id)}
        >
          {o.label}
        </span>
      ))}
    </div>
  )
}

export function useErrorToast() {
  const toast = useToast()
  return (e: unknown) => toast(e instanceof ApiError ? errorText(e.code, e.message) : S.common.error, 'danger')
}

export function Loading() {
  return (
    <div className="muted" style={{ padding: 24 }}>
      {S.common.loading}
    </div>
  )
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="banner t-danger" role="alert">
      <div>{error instanceof ApiError ? errorText(error.code, error.message) : S.common.error}</div>
      {onRetry && (
        <button type="button" className="btn sm" onClick={onRetry}>
          {S.common.retry}
        </button>
      )}
    </div>
  )
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

export function PageHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="row between wrap" style={{ gap: 12 }}>
      <div>
        <div className="h1">{title}</div>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {actions}
    </div>
  )
}
