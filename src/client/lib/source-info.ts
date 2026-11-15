import type { Radio } from '../api/types'
import type { PlayerSource } from './player-controller'
import { S } from '../i18n'

export function hostOf(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function sourceInfo(r: Radio): { name: string; badge: string } {
  const src = r.station.source
  if (src.type === 'relay') {
    const preset = r.presets.find((p) => p.url === src.url)
    return { name: preset?.name ?? src.name ?? hostOf(src.url), badge: S.radio.sourceTypeRelay }
  }
  if (src.type === 'userplaylist') {
    const pl = r.playlists.find((p) => p.id === src.playlistId)
    return { name: pl?.name ?? S.radio.sourceTypePlaylist, badge: S.radio.sourceTypePlaylist }
  }
  if (src.type === 'playlist') return { name: src.dir || S.library.allTracks, badge: S.radio.sourceTypeFolder }
  return { name: S.radio.silenceName, badge: S.radio.sourceTypeSilence }
}

// The user's own station stream as a player source (the bar adds the ICY title of the moment).
export function liveSource(r: Radio): PlayerSource {
  return {
    key: 'live',
    kind: 'live',
    src: r.station.webStreamPath,
    title: S.player.liveTitle(sourceInfo(r).name),
    subtitle: S.player.live,
    href: '/',
  }
}
