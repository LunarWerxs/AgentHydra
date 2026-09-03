// useBodySearch — advanced (body) search: server-side, streams every transcript's raw content.
// Deliberately independent of the plain client-side filter beside it in the view; this is a
// slower opt-in path that only runs when the user explicitly submits it, and jumping from a hit
// back into the normal transcript view is part of the same feature, not a separate one.

import type { Ref } from 'vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type {
  SessionSearchResponse,
  SessionSearchResult,
  SessionSource,
  SessionSourceScope,
  SessionSummary,
} from '@/lib/api'
import * as api from '@/lib/api'

export function useBodySearch(deps: {
  sessions: Ref<SessionSummary[]>
  sessionInstanceFilter: Ref<string>
  sessionSourceFilter: Ref<SessionSourceScope>
  advancedCaseSensitive: Ref<boolean>
  selectedId: Ref<string | null>
  selectedSource: Ref<SessionSource | null>
  selected: Ref<SessionSummary | null>
  select: (s: SessionSummary) => void
  loadTail: (opts?: { silent?: boolean }) => Promise<void>
}) {
  const { t } = useI18n()

  const advancedOpen = ref(false)
  const advancedQuery = ref('')
  const advancedRegex = ref(false)
  const bodySearching = ref(false)
  const bodySearchActive = ref(false)
  const bodySearchQueryUsed = ref('')
  const bodyResults = ref<SessionSearchResult[]>([])
  // Kept beside the results, because "nothing matched" and "the server gave up after 7 seconds"
  // look identical in a list of zero rows, and only one of them means the text isn't there.
  const bodySearchResponse = ref<SessionSearchResponse | null>(null)

  async function runBodySearch(opts: { everything?: boolean } = {}) {
    const q = advancedQuery.value.trim() || bodySearchQueryUsed.value
    if (!q) return
    bodySearching.value = true
    try {
      const r = await api.searchSessionBodies(q, {
        regex: advancedRegex.value,
        caseSensitive: deps.advancedCaseSensitive.value,
        instance: deps.sessionInstanceFilter.value || undefined,
        source:
          deps.sessionSourceFilter.value === 'all' ? undefined : deps.sessionSourceFilter.value,
        everything: opts.everything,
      })
      bodyResults.value = r.results
      bodySearchResponse.value = r
      bodySearchQueryUsed.value = q
      bodySearchActive.value = true
      advancedOpen.value = false
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      toast.error(msg || t('sessions.searchFailed'))
    } finally {
      bodySearching.value = false
    }
  }

  /**
   * The one line that says what was actually searched.
   *
   * There are three honest answers and they are not interchangeable: the index answered completely
   * but only over conversation; the scan ran out of time; or the hit list was capped. Saying nothing
   * would let any of the three read as "that text is nowhere on this machine".
   */
  const bodySearchNotice = computed(() => {
    const r = bodySearchResponse.value
    if (!r) return null
    if (r.searched === 'index') return t('sessions.searchedConversation')
    if (r.budgetExhausted)
      return t('sessions.searchBudgetExhausted', {
        seconds: Math.round(r.budgetMs / 1000),
        searched: r.filesSearched,
        total: r.filesTotal,
      })
    if (r.limitReached) return t('sessions.searchLimitReached', { n: r.results.length })
    return null
  })

  /** Offer the exhaustive path exactly when the answer we gave did not cover everything. */
  const canSearchEverything = computed(() => {
    const r = bodySearchResponse.value
    return !!r && (r.conversationOnly || r.budgetExhausted)
  })

  function exitBodySearch() {
    bodySearchActive.value = false
    bodyResults.value = []
    bodySearchResponse.value = null
  }

  /** Jump from a body-search hit to the full transcript, same as clicking it in the plain list. */
  async function selectFromBodyResult(r: SessionSearchResult) {
    const s = deps.sessions.value.find(
      (x) => x.session_id === r.session_id && x.source === r.source,
    )
    if (s) {
      exitBodySearch()
      deps.select(s)
      return
    }
    // Not in the currently-loaded metadata window (e.g. older than the 200-session cap); still
    // open the transcript directly by id so the hit isn't a dead end.
    exitBodySearch()
    deps.selectedId.value = r.session_id
    deps.selectedSource.value = r.source
    deps.selected.value = null
    void deps.loadTail()
    try {
      const summary = await api.getSession(r.session_id, r.source)
      if (deps.selectedId.value === r.session_id && deps.selectedSource.value === r.source)
        deps.selected.value = summary
    } catch {
      toast.error(t('sessions.searchFailed'))
    }
  }

  return {
    advancedOpen,
    advancedQuery,
    advancedRegex,
    bodySearching,
    bodySearchActive,
    bodySearchQueryUsed,
    bodyResults,
    bodySearchResponse,
    runBodySearch,
    bodySearchNotice,
    canSearchEverything,
    exitBodySearch,
    selectFromBodyResult,
  }
}
