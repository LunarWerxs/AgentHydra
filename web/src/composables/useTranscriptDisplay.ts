// useTranscriptDisplay — everything about how the OPEN transcript's body renders: markdown/escape
// per turn, long-message capping and expand, per-message copy, and client-side find-in-transcript
// (the loaded window only, no server round-trip). Split out of SessionsView.vue because all of it
// operates on the same `tail` data and exists only while a session is open, and none of it is the
// filter/search/migration machinery that surrounds it.

import type { ComponentPublicInstance, Ref } from 'vue'
import { computed, nextTick, ref, watch } from 'vue'
import type { TailEvent, TailResult } from '@/lib/api'
import { highlightHtml } from '@/lib/find'
import { escapeHtml, looksLikeMarkdown, renderMarkdown } from '@/lib/markdown'
import { buildDisplayItems, formatToolInput } from '@/lib/transcript-groups'

const LONG_CHARS = 1000
const LONG_LINES = 16

/** How many rendered turns to remember across polls. A window is at most a few hundred events
 *  (TAIL_MAX turns plus the tool traffic between them), so this holds a couple of sessions' worth
 *  and the oldest fall out first. */
const RENDER_CACHE_MAX = 1500

interface RenderedBody {
  long: boolean
  html: string
  pre: boolean
}

export function useTranscriptDisplay(deps: {
  tail: Ref<TailResult | null>
  chatEl: Ref<HTMLElement | null>
}) {
  const isLong = (text: string) => text.length > LONG_CHARS || text.split('\n').length > LONG_LINES

  // The open chat re-reads its tail every 4 s and almost every turn in the answer is one it already
  // rendered, so the markdown pass is remembered by what it depends on (the kind and the text) and
  // a poll that brings one new turn renders one turn. A Map keeps insertion order, which makes
  // "drop the oldest" a matter of deleting its first key.
  const renderCache = new Map<string, RenderedBody>()
  function renderBody(ev: TailEvent): RenderedBody {
    const key = `${ev.kind}\u0000${ev.text}`
    const hit = renderCache.get(key)
    if (hit) return hit
    // Prose (messages and reasoning) may be markdown; a tool's input is laid out one argument a
    // line; its output stays verbatim. Copy still takes ev.text, the input exactly as sent.
    const prose = ev.kind === 'text' || ev.kind === 'thinking'
    const md = prose && looksLikeMarkdown(ev.text) ? renderMarkdown(ev.text) : null
    const plain = ev.kind === 'tool_use' ? formatToolInput(ev.text) : ev.text
    const body = { long: isLong(ev.text), html: md ?? escapeHtml(plain), pre: md === null }
    renderCache.set(key, body)
    if (renderCache.size > RENDER_CACHE_MAX) renderCache.delete(renderCache.keys().next().value!)
    return body
  }

  /**
   * Every turn as HTML, ONCE per tail load (and, through the cache above, once per distinct turn).
   *
   * Both branches escape the text before anything else looks at it, so nothing below can carry a
   * tag the transcript wrote. `pre` records which branch ran, because the two want different
   * whitespace handling: markdown owns its own layout, plain prose must keep its line breaks.
   *
   * Split from the find pass below so that typing in the find bar re-highlights without re-parsing
   * every message's markdown on each keystroke.
   */
  const rendered = computed(() =>
    (deps.tail.value?.events ?? []).map((ev) => ({ ...ev, ...renderBody(ev) })),
  )

  // --- find within the open session (client-side; the loaded window, no server round-trip) -----
  const findOpen = ref(false)
  const findQuery = ref('')
  const findIndex = ref(0)
  // A template ref on <Input> yields the COMPONENT, not the element — the kit's Input is a
  // single-root wrapper, so the <input> is reached through $el.
  const findInput = ref<ComponentPublicInstance | null>(null)
  function focusFindInput() {
    const el = findInput.value?.$el
    if (el instanceof HTMLInputElement) el.focus()
  }

  /** The turns as rendered, with matches wrapped. `hits` is per message; `findTotal` sums them. */
  const events = computed(() => {
    const q = findOpen.value ? findQuery.value : ''
    if (!q) return rendered.value.map((ev) => ({ ...ev, hits: 0 }))
    let seen = 0
    return rendered.value.map((ev) => {
      const r = highlightHtml(ev.html, q, seen, findIndex.value)
      seen += r.count
      return { ...ev, html: r.html, hits: r.count }
    })
  })

  const findTotal = computed(() => events.value.reduce((n, ev) => n + ev.hits, 0))

  /** The turns as the viewer lays them out: messages on their own, and each run of tool calls and
   *  reasoning between two messages folded into one collapsible work row (lib/transcript-groups). */
  const items = computed(() => buildDisplayItems(events.value))

  /** Clamp into range and scroll the current hit into view. Wraps at both ends, like every find
   *  bar. */
  async function goToMatch(next: number) {
    const total = findTotal.value
    if (total === 0) return
    findIndex.value = ((next % total) + total) % total
    await nextTick()
    deps.chatEl.value
      ?.querySelector(`[data-find="${findIndex.value}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  function openFind() {
    findOpen.value = true
    void nextTick(focusFindInput)
  }
  function closeFind() {
    findOpen.value = false
    findQuery.value = ''
    findIndex.value = 0
  }
  // A new query starts from the first hit rather than wherever the last one left off.
  watch(findQuery, () => {
    findIndex.value = 0
    void nextTick(() => void goToMatch(0))
  })

  const copiedIdx = ref<number | null>(null)
  let copiedTimer: number | undefined
  function copyMessage(i: number, text: string) {
    navigator.clipboard?.writeText(text).catch(() => {})
    copiedIdx.value = i
    window.clearTimeout(copiedTimer)
    copiedTimer = window.setTimeout(() => {
      copiedIdx.value = null
    }, 1200)
  }

  return {
    rendered,
    events,
    items,
    findTotal,
    findOpen,
    findQuery,
    findIndex,
    findInput,
    focusFindInput,
    goToMatch,
    openFind,
    closeFind,
    copiedIdx,
    copyMessage,
  }
}

/** One turn as the transcript renders it: escaped or markdown HTML, find-highlighted, with its
 *  long-message flag. What components/SessionTranscriptTurns.vue draws. */
export type TranscriptTurn = ReturnType<typeof useTranscriptDisplay>['events']['value'][number]
