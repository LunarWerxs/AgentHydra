// The stats card's tiles and footer line, from what Hydra Desk really knows about its own chats. The
// real card counts messages and tokens across Claude Code; Hydra Desk keeps neither per chat yet, so
// those tiles show a dash instead of a made-up figure.
import type { DeskStats } from './logic'

export interface StatsTile {
  label: string
  value: string
  strong: boolean
  title?: string
}

const UNKNOWN = '–'
const count = (n: number) => n.toLocaleString('en-US')
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`

export function statsTiles(s: DeskStats): StatsTile[] {
  return [
    { label: 'Sessions', value: count(s.sessions), strong: true },
    { label: 'Messages', value: UNKNOWN, strong: true, title: 'Hydra Desk does not count messages yet' },
    { label: 'Total tokens', value: UNKNOWN, strong: true, title: `Hydra Desk does not count tokens yet; these sessions cost ${s.totalCost}` },
    { label: 'Active days', value: count(s.activeDays), strong: true },
    { label: 'Peak hour', value: s.peakHour, strong: true },
    { label: 'Favorite model', value: s.favoriteModel, strong: false }
  ]
}

/** One sentence like the real "You've used ~N× more tokens than …", built from real figures only. */
export function statsFooter(s: DeskStats): string {
  if (!s.sessions) return 'No sessions in this range yet.'
  const where = `${plural(s.sessions, 'session', 'sessions')} in ${plural(s.folders, 'folder', 'folders')}`
  const when = `over ${plural(s.activeDays, 'day', 'days')}`
  return s.totalCost === '$0.00' ? `You've run ${where} ${when}.` : `You've run ${where} ${when}, ${s.totalCost} in all.`
}
