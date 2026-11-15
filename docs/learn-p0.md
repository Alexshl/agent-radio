# Learn mode, P0: Liquidsoap 2.4.6 checks

Checked in throwaway containers of `savonet/liquidsoap:v2.4.6` (no published ports, removed afterwards; the real stacks were not touched), first with a tiny script, then with the real `radio.liq`.

| Question | Result |
|---|---|
| `request.queue` push | `q.push.uri("annotate:msg_id=\"X\":/path")` works. `interactive=false` is fine. |
| Flush | `q.set_queue([])` empties the queue (verified: pushed songs never played). It does not touch the song that plays. A request the queue has already prepared (the next one, shortly before it is needed) may still play, so the app flushes before it switches learn mode on. `q.length()` counts the waiting requests. |
| `fallback(track_sensitive=true, [queue, playlist])` | Switches only on track boundaries: a song pushed in the middle of a playlist track starts when that track ends. When the queue is empty the playlist plays again at once. `transition_length=0.` is set (as in the existing final fallback). |
| Per request volume | `amplify(1.0, queue)` reads the `liq_amplify` annotation: `liq_amplify="-20 dB"` measured exactly -20 dB (RMS 11584 -> 1158); no annotation = unchanged. Plan fallback (`intro_q`) was not needed. |
| Metadata | `queue.on_metadata` sees `msg_id` (and `liq_amplify`, `title`), `source.on_end` on the queue gets the `msg_id` of the finished request, `on_track` on the output carries it too. The existing `clip_watcher` / `clip_ended` give queued -> playing -> done. |
| `annotate` quoting | `title="Ab \"q\" \\ — é"` arrives intact (backslash and quote escaped, UTF-8 fine). |
| Replacing the source | `set_source` queue -> queue -> playlist on one station: no errors; the queue (created once per station) survives and keeps its content. Leaving learn mode: flush first, then the old content does not come back. |

Language gotchas hit while writing the real script (2.4.6):
- passing the queue (after `amplify`) and the playlist into one `fallback` list needs the playlist cast to `source` (`(pl : source)`), otherwise the list is typed with the methods of `mksafe(playlist)` (`selected`) that the queue lacks;
- call the queue methods (`push`, `set_queue`, `length`) through closures made where the queue is created: after it went through `amplify`, the methods are gone from its type;
- `spec.mode` must be read as `(spec.mode ?? "")` in a separate helper (`playlist_source`), the old inline `spec.mode == "normal"` does not type-check once the same code is used twice.
The existing `playlist` branch now calls the same helper (same behaviour).

Not verified here: the loudness of an intro against real clips (the app passes `amplify_db = voice gain - music gain` so that the intro sounds at the level of a spoken message); the gap-free behaviour on a real stream is covered by the learn section of `scripts/acceptance.sh`.
