// Lyrics in time with the stream: which line is sung now, and where the song is for this listener.
export interface TimedLine {
  ms: number | null
}

// Index of the line sung at posMs (the last one that has started); -1 before the first line or when the lines have no timing.
// Lines without a time (null) are ignored, the rest are assumed to be in time order.
export function currentLineIndex(lines: TimedLine[], posMs: number): number {
  let lo = 0
  let hi = lines.length - 1
  let found = -1
  // binary search over the timed lines; an untimed line splits the order, so fall back to a scan for it
  if (lines.some((l) => l.ms === null)) {
    for (let i = 0; i < lines.length; i++) {
      const ms = lines[i]?.ms
      if (ms !== null && ms !== undefined && ms <= posMs) found = i
    }
    return found
  }
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (((lines[mid] as TimedLine).ms as number) <= posMs) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

// server clock - local clock, from one request: the server stamped serverNowMs somewhere between the send and the receive,
// so it is compared with the middle of the round trip
export function clockOffset(serverNowMs: number, sentAtMs: number, receivedAtMs: number): number {
  return serverNowMs - (sentAtMs + receivedAtMs) / 2
}

export const DEFAULT_DELAY_S = 3
export const SYNC_RANGE_S = 5

// Where the song is for the listener, in ms: the server time (local clock + offset) minus the song start, minus what the listener's audio is
// behind the live edge (browser buffer, measured by the player), the stream's own delay (encoder, icecast) and the listener's correction.
// A positive user offset makes the text come later.
export function songPositionMs(args: {
  nowMs: number
  clockOffsetMs: number
  startedAtMs: number
  lagS: number
  userOffsetS: number
  defaultDelayS?: number
}): number {
  const delay = args.lagS + (args.defaultDelayS ?? DEFAULT_DELAY_S) + args.userOffsetS
  return args.nowMs + args.clockOffsetMs - args.startedAtMs - delay * 1000
}
