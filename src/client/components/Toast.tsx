import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

type Kind = 'info' | 'danger'
interface Item {
  id: number
  text: string
  kind: Kind
}
type ToastFn = (text: string, kind?: Kind) => void

const Ctx = createContext<ToastFn>(() => {})
export const useToast = () => useContext(Ctx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([])
  const toast = useCallback<ToastFn>((text, kind = 'info') => {
    const id = Date.now() + Math.random()
    setItems((l) => [...l, { id, text, kind }])
    setTimeout(() => setItems((l) => l.filter((i) => i.id !== id)), 4500)
  }, [])
  const value = useMemo(() => toast, [toast])
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="ar-toasts" role="status" aria-live="polite">
        {items.map((i) => (
          <div key={i.id} className={`toast${i.kind === 'danger' ? ' t-danger' : ''}`}>
            {i.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}
