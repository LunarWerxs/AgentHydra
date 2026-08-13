import { Ban, CheckCircle2, Clock, CloudOff, Loader2, TriangleAlert, XCircle } from '@lucide/vue'
import type { Component } from 'vue'
import type { QueueStatus } from './api'

export function timeAgo(ts: number | string | null): string {
  if (ts == null) return '—'
  const ms = typeof ts === 'string' ? Date.parse(ts) : ts
  if (Number.isNaN(ms)) return '—'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ms).toLocaleDateString()
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function shortId(id: string): string {
  return id.slice(0, 8)
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** Kit Badge variant names (from components/ui/badge). */
export type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'primary'
  | 'success'
  | 'warning'
  | 'info'
  | 'outline'
  | 'ghost'

interface StatusMeta {
  label: string
  icon: Component
  variant: BadgeVariant
  spin?: boolean
}

const QUEUE_STATUS: Record<QueueStatus, StatusMeta> = {
  queued: { label: 'Queued', icon: Clock, variant: 'secondary' },
  running: { label: 'Running', icon: Loader2, variant: 'info', spin: true },
  completed: { label: 'Completed', icon: CheckCircle2, variant: 'success' },
  failed: { label: 'Failed', icon: XCircle, variant: 'destructive' },
  rate_limited: { label: 'Rate limited', icon: TriangleAlert, variant: 'warning' },
  // Anthropic's servers were saturated (529) — NOT your usage limit, and not a broken run. It is
  // retried automatically first, so a row only reads this once the overload outlasted the backoff.
  // 'info', not 'warning': nothing is wrong with the user's account or their prompt.
  overloaded: { label: 'Overloaded', icon: CloudOff, variant: 'info' },
  canceled: { label: 'Canceled', icon: Ban, variant: 'secondary' },
}

export function queueStatusMeta(status: QueueStatus): StatusMeta {
  return QUEUE_STATUS[status] ?? QUEUE_STATUS.queued
}

export const MODELS = [
  { value: '', label: 'Default (inherit)' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
]

export const EFFORTS = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
]

export const PERMISSION_MODES = [
  { value: '', label: 'Default' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'bypassPermissions', label: 'Bypass permissions' },
  { value: 'plan', label: 'Plan' },
]

/** Short local label for a scheduled run time — "14:30" today, "Jul 12, 14:30" otherwise. */
export function formatRunAt(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return hm
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${hm}`
}

/** Format a byte count as a short human string ("128 KB", "1.4 GB"). Null/invalid -> "—". */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—'
  if (n === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exp = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  const value = n / 1024 ** exp
  return `${exp === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[exp]}`
}

/** A large count, shortened for a dense meta row ("1.2M", "845K", "312"). */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
    n,
  )
}

/** A dollar figure for display. Deliberately locked to USD: these are Anthropic's published list
 *  prices, not an amount converted into the reader's currency. A non-zero amount under a cent
 *  reads "<$0.01" rather than "$0.00", which would look like the feature is broken. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const money = (v: number) =>
    new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(v)
  return n > 0 && n < 0.01 ? `<${money(0.01)}` : money(n)
}

/** Format an ISO start-time string as a short elapsed-time string ("3m", "2h 14m").
 *  Null/invalid -> "—". */
export function formatUptime(startTime: string | null | undefined): string {
  if (!startTime) return '—'
  const start = Date.parse(startTime)
  if (!Number.isFinite(start)) return '—'
  const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000))
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}
