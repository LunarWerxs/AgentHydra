// useTranscriptDisplay — everything about how the OPEN transcript's body renders: markdown/escape
// per turn, long-message capping and expand, per-message copy, and client-side find-in-transcript
// (the loaded window only, no server round-trip). Split out of SessionsView.vue because all of it
// operates on the same `tail` data and exists only while a session is open, and none of it is the
// filter/search/migration machinery that surrounds it.

import type { ComponentPublicInstance, Ref } from 'vue'
import { computed, nextTick, ref, watch } from 'vue'
import type { TailResult } from '@/lib/api'
import { highlightHtml } from '@/lib/find'
import { escapeHtml, looksLikeMarkdown, renderMarkdown } from '@/lib/markdown'

const LONG_CHARS = 1000
const LONG_LINES = 16

export function useTranscriptDisplay(deps: {
  tail: Ref<TailResult | null>
  chatEl: Ref<HTMLElement | null>
}) {
  const isLong = (text: string) => text.length > LONG_CHARS || text.split('\n').length > LONG_LINES

  /**
   * Every turn as HTML, ONCE per tail load.
   *
   * Both branches escape the text before anything else looks at it, so nothing below can carry a
   * tag the transcript wrote. `pre` records which branch ran, because the two want different
   * whitespace handling: markdown owns its own layout, plain prose must keep its line breaks.
   *
   * Split from the find pass below so that typing in the find bar re-highlights without re-parsing
   * every message's markdown on each keystroke.
   */
  const rendered = computed(() =>
    (deps.tail.value?.events ?? []).map((ev) => {
      const md = ev.kind === 'text' && looksLikeMarkdown(ev.text) ? renderMarkdown(ev.text) : null
      return { ...ev, long: isLong(ev.text), html: md ?? escapeHtml(ev.text), pre: md === null }
    }),
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
