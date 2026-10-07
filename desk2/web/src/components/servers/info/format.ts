// How the info pane words numbers: uptime, bytes, CPU, durations, clock times and "how long ago".
export function uptime(startedAt: number | null, now = Date.now()): string {
  if (startedAt === null) return '–'
  const s = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '–'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

/** Percent of one core. */
export const cpu = (n: number | null | undefined): string => (n === null || n === undefined ? '–' : `${n.toFixed(n >= 100 ? 0 : 1)}%`)

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

/** A span of time for a sentence: "30 s", "2 min", "1 min 30 s", "1 h 5 min". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}

/** The clock time of a moment, with the day when it is not today: "14:05", "Oct 6, 14:05". */
export function clockTime(ts: number, now = Date.now()): string {
  const d = new Date(ts)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

/** Megabytes for a field that takes them (an alert's memory limit). */
export const toMb = (b: number): number => Math.round(b / 1024 / 1024)
export const fromMb = (mb: number): number => Math.round(mb * 1024 * 1024)
