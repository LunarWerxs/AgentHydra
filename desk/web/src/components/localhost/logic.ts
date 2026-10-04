// Labels for the globe button's panel (SPEC "Localhost").
import type { LocalServer } from '@shared/protocol'

/** "4m", "2h 5m", "3d": how long a server has run. Empty when unknown. */
export function uptimeLabel(startedAt: number | null, now: number): string {
  if (!startedAt || startedAt > now + 60_000) return ''
  const s = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d`
}

/** The last folder name of a path. */
export function folderName(path: string | null): string {
  if (!path) return ''
  const parts = path.replace(/[\/]+$/, '').split(/[\/]/)
  return parts[parts.length - 1] || path
}

/** What a row is called: its page title, else its project folder, else its process. */
export function serverTitle(s: LocalServer): string {
  return s.http?.title || folderName(s.project) || folderName(s.cwd) || s.process || `pid ${s.pid}`
}

/** "128 MB", "1.2 GB". */
export function memoryLabel(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return ''
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/** The port's URL as a browser opens it. */
export function openUrl(s: LocalServer): string {
  return `http://localhost:${s.port}/`
}
