import { Loader2, Pause, Play } from 'lucide-react'
import { useState } from 'react'
import { post } from '../api/client'
import type { HistoryMessage } from '../api/types'
import { S } from '../i18n'
import { fmtTime } from '../lib/format'
import { usePlayer } from './Player'
import { useErrorToast } from './ui'

export const messageKey = (m: { id: string }) => `msg:${m.id}`

// Replays a history message through the global player: stored clip when there is one, otherwise it is synthesized on demand first.
export function useReplay(onChanged?: () => void) {
  const player = usePlayer()
  const [busy, setBusy] = useState<string | null>(null)
  const fail = useErrorToast()

  const replay = async (m: HistoryMessage) => {
    const source = {
      key: messageKey(m),
      kind: m.type === 'audio' ? ('track' as const) : ('voice' as const),
      src: `/api/app/history/${m.id}/audio`,
      title: m.type === 'audio' ? m.text : S.player.voiceTitle(m.session, fmtTime(m.createdAt)),
      subtitle: m.type === 'audio' ? m.session : m.text.slice(0, 120),
      href: '/history',
    }
    // playing or paused already: only toggles
    if (player.current?.key === source.key) return player.toggle(source)
    try {
      if (!m.hasClip) {
        setBusy(m.id)
        await post(`/app/history/${m.id}/synthesize`)
        onChanged?.()
      }
      player.toggle(source)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }
  return { isPlaying: (m: { id: string }) => player.isPlaying(messageKey(m)), busy, replay }
}

export function ReplayButton({ playing, busy, onClick }: { playing: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn icon ghost sm"
      aria-label={playing ? S.history.pause : S.history.replay}
      title={busy ? S.history.synthesizing : undefined}
      onClick={onClick}
      disabled={busy}
    >
      {busy ? (
        <Loader2 size={15} className="spin" aria-hidden="true" />
      ) : playing ? (
        <Pause size={15} aria-hidden="true" />
      ) : (
        <Play size={15} aria-hidden="true" />
      )}
    </button>
  )
}
