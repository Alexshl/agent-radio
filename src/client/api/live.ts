import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useMe } from './hooks'

// the query keys that each server event (src/server/live.ts) makes stale
const KEYS: Record<string, string[]> = {
  messages: ['history', 'radio'],
  station: ['radio', 'live', 'learn-now'],
  learn: ['learn-now', 'learn-archive', 'learn-song', 'radio'],
  live: ['live', 'learn-now'],
}

// Live updates over Server-Sent Events (GET /api/app/events), mounted once for the signed-in user. The events are only hints: the matching
// queries are refetched. EventSource reconnects by itself; after a break everything is refetched once (events may have been missed).
export function useLiveEvents() {
  const qc = useQueryClient()
  const { data: me } = useMe()
  const signedIn = !!me
  useEffect(() => {
    if (!signedIn || typeof EventSource === 'undefined') return
    const invalidate = (topics: string[]) => {
      for (const key of new Set(topics.flatMap((t) => KEYS[t] ?? []))) qc.invalidateQueries({ queryKey: [key] })
    }
    const es = new EventSource('/api/app/events')
    let broken = false
    es.onerror = () => {
      broken = true
    }
    es.onopen = () => {
      if (!broken) return
      broken = false
      invalidate(Object.keys(KEYS))
    }
    for (const topic of Object.keys(KEYS)) es.addEventListener(topic, () => invalidate([topic]))
    return () => es.close()
  }, [signedIn, qc])
}
