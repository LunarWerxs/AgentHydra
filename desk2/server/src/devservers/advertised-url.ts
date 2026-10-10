// The address a dev server prints for itself ("Local: http://localhost:5174/"), read from its output. The port in
// .devwebui is only what was asked for: Vite moves to the next free port when its own is taken, and a server can
// serve under a path, so the declared URL can be wrong. Idea from stablyai/orca's advertised-URL capture (MIT);
// written fresh here.

import { stripAnsi } from './ansi'

/** The most a process's unfinished line may hold: a chatty server that never ends a line costs this much, no more. */
const PENDING_CAP = 4096

/** An http(s) address up to whitespace or a quote; trailing punctuation is trimmed after the match. */
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi

/** Operating-system and terminal sequences a dev server prints: OSC (`ESC ] ... BEL` or `ESC ] ... ESC \`). CSI is stripAnsi's. */
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

export interface AdvertisedUrl {
  url: string
  /** The port the address names (the scheme's default when none is written). */
  port: number
  /** 0 loopback, 1 private LAN, 2 anything else: the lower is preferred. */
  rank: number
  /** Printed on a `Local:` line, the label Vite, Next, Astro, Nuxt and SvelteKit give their own address. */
  labelled: boolean
}

/** The server's own address line. Any other address a server prints (an API it proxies to, a docs link) is only a
 *  fallback, so an earlier "proxying /api to http://localhost:8080" does not become the server's URL. */
const LOCAL_LABEL = /\blocal\s*:/i

/** Lower is better: a labelled address beats any unlabelled one, then loopback beats LAN beats the rest. */
const score = (a: AdvertisedUrl) => (a.labelled ? 0 : 3) + a.rank

/** Loopback first, then a private LAN address, then anything else: the address a person on this PC opens first. */
export function rankHost(host: string): number {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h.startsWith('127.')) return 0
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return 1
  return 2
}

function parseAddress(raw: string, labelled: boolean): AdvertisedUrl | null {
  const trimmed = raw.replace(/[.,;:)\]]+$/, '')
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return null
  }
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  return { url: trimmed, port, rank: rankHost(u.hostname), labelled }
}

/**
 * One process's capture: feed it each stdout or stderr chunk as it arrives. Only complete lines are read, so an
 * address split across two chunks is read whole; a line with no http is skipped before any regex runs.
 */
export class UrlCapture {
  private pending = ''
  private best: AdvertisedUrl | null = null

  feed(chunk: string): void {
    // Nothing outranks a labelled loopback address, so once it is seen there is nothing left to read.
    if (this.best && score(this.best) === 0) return
    const text = this.pending + chunk
    const cut = text.lastIndexOf('\n') + 1
    this.pending = text.slice(cut).slice(-PENDING_CAP)
    if (cut === 0) return
    const lines = text.slice(0, cut)
    if (!lines.includes('http')) return
    for (const line of stripAnsi(lines.replace(OSC, '')).split('\n')) {
      const labelled = LOCAL_LABEL.test(line)
      for (const m of line.matchAll(URL_RE)) {
        const found = parseAddress(m[0], labelled)
        if (found && (!this.best || score(found) < score(this.best))) this.best = found
        if (this.best && score(this.best) === 0) return
      }
    }
  }

  /** The best address printed so far, or null when none was. */
  get(): AdvertisedUrl | null {
    return this.best
  }
}
