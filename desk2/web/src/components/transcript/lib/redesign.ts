// ReDesign in the transcript: what a design_options call shows, and the one message the card sends back. Pure: no Vue, no DOM.
import type { TranscriptItem } from '@shared/protocol'

type ToolItem = Extract<TranscriptItem, { kind: 'tool_use' }>

export const isDesignOptions = (name: string): boolean => /^mcp__.+__design_options$/.test(name)
export const isDesignPick = (name: string): boolean => /^mcp__.+__design_pick$/.test(name)

/** Every message the card sends starts with this, so the transcript can tell which call a reply answers. */
export const REDESIGN_PREFIX = 'ReDesign:'

export const designImageUrl = (run: string, n: number): string => `/api/redesign/image/${encodeURIComponent(run)}/option-${n}.png`

export interface DesignOption {
  n: number
  description: string
  src: string | null
}

export interface DesignOptionsView {
  brief: string
  askOwner: boolean
  state: 'running' | 'done' | 'error'
  error: string
  run: string
  options: DesignOption[]
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function parseDesignOptions(item: ToolItem): DesignOptionsView {
  const base = { brief: str(item.input.brief).trim(), askOwner: item.input.ask_owner === true, run: '', options: [] as DesignOption[] }
  const text = item.result?.text ?? ''
  if (item.status === 'running' || (!item.result && item.status !== 'error' && item.status !== 'denied')) return { ...base, state: 'running', error: '' }
  if (item.status === 'error' || item.status === 'denied' || item.result?.isError) {
    return { ...base, state: 'error', error: (text || (item.status === 'denied' ? 'Not allowed' : 'Failed')).trim().slice(0, 400) }
  }
  const at = text.indexOf('{')
  let data: { run?: unknown; options?: unknown } | null = null
  if (at >= 0) {
    try {
      data = JSON.parse(text.slice(at))
    } catch {
      data = null
    }
  }
  const run = str(data?.run)
  if (!run || !Array.isArray(data?.options)) return { ...base, state: 'error', error: text.trim().slice(0, 400) || 'ReDesign gave no options' }
  const options = (data.options as Record<string, unknown>[]).map((o, i) => {
    const n = Number(o.option) >= 1 ? Math.round(Number(o.option)) : i + 1
    return { n, description: str(o.description), src: str(o.image) ? designImageUrl(run, n) : null }
  })
  return { ...base, state: 'done', error: '', run, options }
}

export interface RedesignState {
  /** run id -> the option design_pick was called with (the last call wins). */
  picks: Map<string, number>
  /** design_options tool id -> the text of the first "ReDesign:" message the person sent after it. */
  replies: Map<string, string>
}

export function redesignState(items: TranscriptItem[]): RedesignState {
  const picks = new Map<string, number>()
  const replies = new Map<string, string>()
  let waiting: string | null = null
  for (const it of items) {
    if (it.kind === 'tool_use') {
      if (isDesignPick(it.name)) {
        const run = str(it.input.run)
        const n = Math.round(Number(it.input.option))
        if (run && n >= 1) picks.set(run, n)
      } else if (isDesignOptions(it.name) && it.input.ask_owner === true) waiting = it.id
    } else if (it.kind === 'user' && waiting && it.text.trimStart().startsWith(REDESIGN_PREFIX)) {
      replies.set(waiting, it.text.trim())
      waiting = null
    }
  }
  return { picks, replies }
}

export interface RedesignReply {
  /** The chosen option number, or null. */
  pick: number | null
  /** Option number -> note. */
  notes: Record<number, string>
  more: boolean
  text: string
}

/** Something to send: a choice, a request for more, or words. */
export const canSendReply = (r: RedesignReply): boolean => r.more || r.pick !== null || r.text.trim() !== ''

/** The one message the card posts: `ReDesign: I pick option 2. Notes: option 2: "tighter spacing"; option 1: "bigger logo". <free text>`. */
export function composeRedesignReply(r: RedesignReply): string {
  const text = r.text.trim()
  const parts: string[] = []
  if (r.more) parts.push('more options please.')
  else if (r.pick !== null) parts.push(`I pick option ${r.pick}.`)
  const notes = Object.entries(r.notes)
    .map(([n, v]) => [Number(n), v.trim().replace(/"/g, "'")] as const)
    .filter(([, v]) => v)
    .sort((a, b) => a[0] - b[0])
    .map(([n, v]) => `option ${n}: "${v}"`)
  if (notes.length) parts.push(`Notes: ${notes.join('; ')}.`)
  if (text) parts.push(text)
  return `${REDESIGN_PREFIX} ${parts.join(' ')}`.trim()
}
