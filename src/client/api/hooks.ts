import { useQuery } from '@tanstack/react-query'
import { ApiError, get } from './client'
import type { Live, Me, Radio } from './types'

export const useMe = () =>
  useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await get<{ user: Me; features: { passkeys: boolean } }>('/auth/me')).user
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null
        throw e
      }
    },
    staleTime: 60_000,
  })

// the station state can change from another tab, device or shortcut: refetched when the page comes back to the front, and every
// `pollMs` on screens that show it as live state (the remote)
export const useRadio = (pollMs?: number) =>
  useQuery({ queryKey: ['radio'], queryFn: () => get<Radio>('/app/radio'), refetchOnWindowFocus: true, refetchInterval: pollMs ?? false })

export const useLive = (enabled = true) =>
  useQuery({ queryKey: ['live'], queryFn: () => get<Live>('/app/live'), refetchInterval: 5000, enabled, staleTime: 2000 })
