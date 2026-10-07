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
  /** A short 1-3 word name; '' when ReDesign gave none (the card then says "Option N"). */
  name: string
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
    return { n, name: str(o.name).trim().slice(0, 40), src: str(o.image) ? designImageUrl(run, n) : null }
  })
  return { ...base, state: 'done', error: '', run, options }
}

/** What an option is called on screen: its name, else "Option N". */
export const optionLabel = (o: { n: number; name: string }): string => o.name || `Option ${o.n}`

/** The names of the options that have landed, read off a running call's progress line ("Option 2 of 4 is ready · Card stack · Minimal list"). */
export function landedNames(progress: string | undefined): string[] {
  return (progress ?? '').split(' · ').slice(1).map((s) => s.trim()).filter(Boolean)
}

export interface RedesignSetup {
  kind: 'no-key' | 'not-running'
  title: string
  line: string
}

/** A failure that is ReDesign's setup rather than a bad run: no provider key yet, or ReDesign not running. null = show the raw error. */
export function redesignSetup(error: string): RedesignSetup | null {
  if (/no working provider key|add one in ReDesign|Keys page/i.test(error)) {
    return { kind: 'no-key', title: 'ReDesign needs an AI key', line: 'Add one in ReDesign (Settings → Models & keys), or borrow a few from HSwarm, then ask the AI to try again.' }
  }
  if (/ReDesign is not (running|installed|answering)|ECONNREFUSED|fetch failed/i.test(error)) {
    return { kind: 'not-running', title: 'ReDesign is not running', line: 'Start it in Settings → Connectors → ReDesign, then ask the AI to try again.' }
  }
  return null
}

/** The message the card posts after the keys were copied, so the AI retries the call. */
export const RETRY_MESSAGE = `${REDESIGN_PREFIX} the keys are in now, please run design_options again.`

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
  /** The chosen option's name, when it has one. */
  name: string
  more: boolean
  /** "Other" is the choice: `text` is what the person typed. */
  other: boolean
  text: string
}

/** The choice the card shows selected: an option number, "other", or nothing. */
export type RedesignChoice = number | 'other' | null

/** The reply the card sends for a choice: free text counts only under Other. */
export function replyFor(choice: RedesignChoice, name: string, text: string, more = false): RedesignReply {
  const none = { pick: null, name: '', more: false, other: false, text: '' }
  if (more) return { ...none, more: true }
  if (choice === 'other') return { ...none, other: true, text }
  if (choice === null) return none
  return { ...none, pick: choice, name }
}

/** The option number the card counts as picked: the person's choice while they can still choose, else the AI's design_pick or the person's sent pick. */
export function pickedOption(s: { editable: boolean; choice: RedesignChoice; aiPick: number | null; sentChip: { kind: string; n?: number } | null }): number | null {
  if (s.editable) return typeof s.choice === 'number' ? s.choice : null
  if (s.aiPick !== null) return s.aiPick
  return s.sentChip?.kind === 'pick' && typeof s.sentChip.n === 'number' ? s.sentChip.n : null
}

/** Something to send: an option, a request for more, or (under Other) words. */
export const canSendReply = (r: RedesignReply): boolean => r.more || r.pick !== null || (r.other && r.text.trim() !== '')

/** The one message the card posts: `ReDesign: I pick option 2, Card stack.`, `ReDesign: more options please.`, or the typed words. */
export function composeRedesignReply(r: RedesignReply): string {
  const text = r.text.trim()
  if (r.more) return `${REDESIGN_PREFIX} more options please.`
  if (r.pick !== null) {
    const name = r.name.trim().replace(/[.\n]+$/g, '')
    return `${REDESIGN_PREFIX} I pick option ${r.pick}${name ? `, ${name}` : ''}.`
  }
  return `${REDESIGN_PREFIX} ${text}`.trim()
}

/** How a "ReDesign:" message reads as a chip, and the quiet line under the card. */
export interface ReplyChip {
  kind: 'more' | 'pick' | 'other' | 'retry'
  /** The option number of a pick. */
  n?: number
  /** The short chip text: "More options", "Picked Card stack", "Keys added", or the typed words. */
  label: string
  /** The card footer: "Asked for 4 more designs", "Picked: Card stack", "Keys added", or the typed words. */
  line: (more?: number) => string
}

export function parseReplyChip(text: string): ReplyChip | null {
  const t = text.trim()
  if (!t.startsWith(REDESIGN_PREFIX)) return null
  const body = t.slice(REDESIGN_PREFIX.length).trim()
  if (/^more options please\.?$/i.test(body)) {
    return { kind: 'more', label: 'More options', line: (n) => (n ? `Asked for ${n} more designs` : 'Asked for more designs') }
  }
  const m = /^I pick option (\d+)(?:,\s*(.+?))?\.?$/.exec(body)
  if (m) {
    const label = m[2] || `option ${m[1]}`
    return { kind: 'pick', n: Number(m[1]), label: `Picked ${label}`, line: () => `Picked: ${label}` }
  }
  if (body === RETRY_MESSAGE.slice(REDESIGN_PREFIX.length).trim()) return { kind: 'retry', label: 'Keys added, try again', line: () => 'Keys added, asked to try again' }
  return { kind: 'other', label: body, line: () => `Asked: ${body}` }
}
