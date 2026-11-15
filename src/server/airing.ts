// What an uploaded file is doing on a station right now (in memory: it only matters while the file plays).
export class Airing {
  private items = new Map<string, { title: string; endsAt: number }>()

  start(stationId: string, title: string, durationSec: number) {
    this.items.set(stationId, { title, endsAt: Date.now() + durationSec * 1000 })
  }

  current(stationId: string): { title: string; endsAt: number } | null {
    const a = this.items.get(stationId)
    if (!a) return null
    if (a.endsAt <= Date.now()) {
      this.items.delete(stationId)
      return null
    }
    return a
  }
}
