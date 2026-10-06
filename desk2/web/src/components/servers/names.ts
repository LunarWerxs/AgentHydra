// Short names and chip lists for the New tab's saved browsers.

import type { BrowserProfile } from '@shared/browser'

export const NAME_MAX = 28
export const CHIPS_SHOWN = 5

const BRANDS: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  paypal: 'PayPal',
  openai: 'OpenAI',
  aws: 'AWS',
  amazonaws: 'AWS',
  stackoverflow: 'Stack Overflow',
  x: 'X',
  twitter: 'Twitter',
  microsoftonline: 'Microsoft',
  live: 'Microsoft',
  office: 'Microsoft'
}
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu'])

/** 'github.com' is 'GitHub', 'admin.shop.example.co.uk' is 'Shop'; null when the host has no usable label. */
export function siteBrand(host: string): string | null {
  const parts = host
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/:?#].*$/, '')
    .split('.')
    .filter(Boolean)
  if (parts.length < 2) return null
  let i = parts.length - 2
  if (i > 0 && SECOND_LEVEL.has(parts[i] as string) && (parts[parts.length - 1] as string).length === 2) i--
  const label = parts[i] as string
  if (!/[a-z]/.test(label)) return null
  return BRANDS[label] ?? label.charAt(0).toUpperCase() + label.slice(1)
}

const clip = (s: string, max: number): string => {
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const at = cut.lastIndexOf(' ')
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, '')}…`
}

/** The note's first few words: up to its first sentence break, at most NAME_MAX characters. */
export function noteWords(note: string | null | undefined): string | null {
  const first = (note ?? '').trim().split(/(?<=[.!?])\s+|\r?\n|\s[-–—]\s|:\s/)[0]?.replace(/[.!?:]+$/, '').trim()
  return first ? clip(first, NAME_MAX) : null
}

const UUID_TAIL = /([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_TAIL = /([-_.])([0-9a-z]{8})[0-9a-z]{4,}$/i

/** A profile name with a long id tail shortened: company-28574de0-8d66-… is company-28574de0. */
export function shortId(name: string): string {
  let out = name.replace(UUID_TAIL, '$1')
  if (out === name) out = name.replace(ID_TAIL, (m, sep: string, head: string) => (/\d/.test(m) ? `${sep}${head}` : m))
  return clip(out, NAME_MAX)
}

/** The name shown for a saved browser: its title when the AI set one; else the brand of its first login site
 *  (the first chip, then the first site the ledger saw); else the note's first few words; else its name, id tail shortened. */
export function shortName(p: Pick<BrowserProfile, 'name' | 'title' | 'note' | 'sessionHosts' | 'sites'>): string {
  const title = p.title?.trim()
  if (title) return clip(title, NAME_MAX + 12)
  const host = p.sessionHosts[0] ?? p.sites[0]?.host
  return (host ? siteBrand(host) : null) ?? noteWords(p.note) ?? shortId(p.name)
}

/** The chips to draw and those folded into '+N' (whose hover lists them). */
export function splitChips(hosts: string[], max = CHIPS_SHOWN): { shown: string[]; more: string[] } {
  return hosts.length > max ? { shown: hosts.slice(0, max), more: hosts.slice(max) } : { shown: hosts, more: [] }
}
