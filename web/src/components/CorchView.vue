<script setup lang="ts">
// Corch view: the tasks a chat handed to the owner's Claude CLI accounts (server/src/corch.ts,
// docs/CORCH.md). A task list grouped by hand-off on the left, the selected task on the right
// (CorchWorkerDetail.vue). Polls every 3 s while a task can still change, every 15 s otherwise,
// and again when the page is shown or the window regains focus.
//
// Layout (2026-09-30 review, three lenses agreeing): the header comes first and says what Corch is;
// the list is one bordered panel with the hand-off as a subheader; the detail pane is sticky so a row
// low in a long list does not open its detail off screen. It sits on the CLI tab under the CLI
// accounts table (CliView.vue), whose Quick add is where an account is added, so it has none of its
// own.
import { CloudOff, Network, RefreshCw } from '@lucide/vue'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import CorchStatusBadge from '@/components/CorchStatusBadge.vue'
import CorchWorkerDetail from '@/components/CorchWorkerDetail.vue'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { CorchWorkerView } from '@/lib/api'
import { type CorchTotals, getCorchTotals, getCorchWorker, listCorchWorkers } from '@/lib/api'
import {
  corchQueuedNote,
  firstLine,
  formatTokens,
  isCorchActive,
  tokenTotal,
} from '@/lib/corch-status'
import { reconcileList, sameData } from '@/lib/reconcile'
import { formatAgo } from '@/lib/relativeTime'

const { t } = useI18n()

const workers = ref<CorchWorkerView[]>([])
const loading = ref(false)
const loaded = ref(false)
const selectedId = ref<string | null>(null)
const detail = ref<(CorchWorkerView & { events: string[] }) | null>(null)
const now = ref(Date.now())
/** The last load failed. Before anything loaded that is an error state (never "No tasks yet");
 *  after, a banner over the last known list, whose spinners would otherwise look alive. */
const unreachable = ref(false)

/** Hand-offs ordered by their newest task, tasks inside newest first. */
const groups = computed(() => {
  const sorted = [...workers.value].sort((a, b) => b.createdAt - a.createdAt)
  const map = new Map<string, CorchWorkerView[]>()
  for (const w of sorted) {
    const list = map.get(w.group)
    if (list) list.push(w)
    else map.set(w.group, [w])
  }
  return [...map.entries()].map(([group, items]) => ({ group, items }))
})

const selected = computed(
  () => detail.value ?? workers.value.find((w) => w.id === selectedId.value) ?? null,
)

let timer: number | null = null
let clock: number | null = null
let alive = true

async function loadDetail() {
  const id = selectedId.value
  if (!id) return
  try {
    const d = await getCorchWorker(id)
    // An unchanged detail keeps the old reference, so a poll with nothing new redraws nothing.
    if (selectedId.value === id && !sameData(detail.value, d)) detail.value = d
  } catch {
    // Keep the last detail; `unreachable` and its banner speak for a daemon that is down.
  }
}

/** What Corch has offloaded so far (owner, 2026-09-30: a running count of sessions and tokens). */
const totals = ref<CorchTotals | null>(null)
const totalsHint = computed(() =>
  totals.value
    ? t('corch.offloadedHint', {
        input: formatTokens(totals.value.tokens.input),
        output: formatTokens(totals.value.tokens.output),
        cacheRead: formatTokens(totals.value.tokens.cacheRead),
        cacheWrite: formatTokens(totals.value.tokens.cacheWrite),
        cost: `$${totals.value.costUsd.toFixed(2)}`,
      })
    : '',
)

async function load(opts: { silent?: boolean } = {}) {
  if (timer !== null) window.clearTimeout(timer)
  timer = null
  if (!opts.silent) loading.value = true
  try {
    const [list, sums] = await Promise.all([listCorchWorkers(), getCorchTotals()])
    workers.value = reconcileList(workers.value, list, (w) => w.id)
    if (!sameData(totals.value, sums)) totals.value = sums
    unreachable.value = false
    now.value = Date.now()
    if (!loaded.value) {
      loaded.value = true
      // First paint: open the newest live task, else the newest one.
      const first =
        [...workers.value].sort((a, b) => b.createdAt - a.createdAt).find(isCorchActive) ??
        groups.value[0]?.items[0]
      if (first) selectedId.value = first.id
    }
    await loadDetail()
  } catch {
    unreachable.value = true
    if (!opts.silent && loaded.value) toast.error(t('corch.loadFailed'))
  } finally {
    if (!opts.silent) loading.value = false
  }
  // 3 s while a task can still change; otherwise 15 s (the server tick's idle rate), because a
  // chat can start new tasks or revive a finished one at any time. Clear again first: a focus
  // reload overlapping a poll must not leave two timers running.
  if (timer !== null) window.clearTimeout(timer)
  timer = null
  if (alive)
    timer = window.setTimeout(
      () => load({ silent: true }),
      workers.value.some(isCorchActive) ? 3000 : 15_000,
    )
}

function onVisible() {
  if (document.visibilityState === 'visible') void load({ silent: true })
}

function select(w: CorchWorkerView) {
  if (selectedId.value === w.id) return
  selectedId.value = w.id
  detail.value = null
  void loadDetail()
}

const startedAgo = (w: CorchWorkerView) => formatAgo(now.value, w.createdAt)

/** The row's hover: the title in full, its account, and the one line that needs attention (a
 *  failure's reason, what a waiting or re-queued task waits for, what a running one is doing). */
function rowHint(w: CorchWorkerView): string {
  const note = corchQueuedNote(w, now.value)
  const line =
    (w.status === 'failed' || w.status === 'waiting') && w.error
      ? firstLine(w.error)
      : note
        ? t(note.key, note.values ?? {})
        : w.status === 'running'
          ? w.lastActivity
          : null
  return [w.title, w.account ?? t('corch.noAccount'), line, new Date(w.createdAt).toLocaleString()]
    .filter(Boolean)
    .join('\n')
}

onMounted(() => {
  void load()
  // Keeps "Started 3m ago" honest between the slow idle polls.
  clock = window.setInterval(() => {
    now.value = Date.now()
  }, 30_000)
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', onVisible)
})
onUnmounted(() => {
  alive = false
  document.removeEventListener('visibilitychange', onVisible)
  window.removeEventListener('focus', onVisible)
  if (timer !== null) window.clearTimeout(timer)
  if (clock !== null) window.clearInterval(clock)
  timer = null
  clock = null
})
</script>

<template>
  <div class="flex flex-col gap-5 p-4">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex min-w-0 flex-col gap-1">
        <h2 class="flex items-center gap-2 text-base font-semibold">
          <Network class="size-4.5" />
          {{ $t('corch.title') }}
          <span v-if="workers.length" class="font-normal text-muted-foreground">({{ workers.length }})</span>
        </h2>
        <p class="max-w-2xl text-xs text-muted-foreground">{{ $t('corch.subtitle') }}</p>
        <!-- The running count of what Corch has taken off the chats that handed it work. -->
        <p
          v-if="totals && totals.tasks > 0"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
          :title="totalsHint"
        >
          <span>
            <span class="font-semibold tabular-nums">{{ totals.tasks }}</span>
            {{ $t('corch.offloadedTasks', totals.tasks) }}
          </span>
          <span aria-hidden="true" class="text-muted-foreground">·</span>
          <span>
            <span class="font-semibold tabular-nums">{{ totals.sessions }}</span>
            {{ $t('corch.offloadedSessions', totals.sessions) }}
          </span>
          <span aria-hidden="true" class="text-muted-foreground">·</span>
          <span>
            <span class="font-semibold tabular-nums">{{ formatTokens(tokenTotal(totals.tokens)) }}</span>
            {{ $t('corch.offloadedTokens') }}
          </span>
        </p>
      </div>
      <Button
        variant="outline"
        size="icon"
        :disabled="loading"
        :aria-label="$t('corch.refresh')"
        :title="$t('corch.refresh')"
        @click="load()"
      >
        <RefreshCw :class="loading ? 'animate-spin' : ''" />
      </Button>
    </header>

    <p
      v-if="loaded && unreachable"
      role="status"
      class="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
    >
      <CloudOff class="size-3.5 shrink-0" />
      {{ $t('corch.staleBanner') }}
    </p>

    <div v-if="!loaded && loading" class="flex flex-col gap-2 lg:max-w-80" aria-busy="true">
      <Skeleton v-for="i in 3" :key="i" class="h-16 rounded-lg" />
    </div>

    <div
      v-else-if="!loaded && unreachable"
      role="alert"
      class="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center"
    >
      <CloudOff class="size-7 text-muted-foreground" />
      <p class="text-sm font-medium">{{ $t('corch.loadFailedTitle') }}</p>
      <p class="max-w-md text-xs text-muted-foreground">{{ $t('corch.loadFailedBody') }}</p>
      <Button variant="outline" class="mt-2" @click="load()">
        <RefreshCw /> {{ $t('corch.retry') }}
      </Button>
    </div>

    <div
      v-else-if="workers.length === 0"
      class="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center"
    >
      <Network class="size-7 text-muted-foreground" />
      <p class="text-sm font-medium">{{ $t('corch.emptyTitle') }}</p>
      <p class="max-w-md text-xs text-muted-foreground">{{ $t('corch.empty') }}</p>
    </div>

    <div v-else class="grid items-start gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <div class="divide-y overflow-hidden rounded-lg border bg-card">
        <section v-for="g in groups" :key="g.group" :aria-label="g.group">
          <h3
            class="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1.5 text-2xs font-medium text-muted-foreground"
          >
            <span class="mono truncate" :title="g.group">{{ g.group }}</span>
            <span class="shrink-0 tabular-nums">{{ g.items.length }}</span>
          </h3>
          <ul class="divide-y">
            <li v-for="w in g.items" :key="w.id">
              <!-- One line per task (owner, 2026-09-30): the status as an icon, the title, when it
                   started. The account and what it is doing or why it stopped ride on the hover;
                   the detail pane has all of it. -->
              <button
                type="button"
                class="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-start text-sm transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                :class="w.id === selectedId ? 'bg-accent shadow-[inset_3px_0_0_var(--color-primary)]' : ''"
                :aria-current="w.id === selectedId ? 'true' : undefined"
                :title="rowHint(w)"
                @click="select(w)"
              >
                <CorchStatusBadge :status="w.status" icon-only />
                <span class="min-w-0 flex-1 truncate font-medium">{{ w.title }}</span>
                <time
                  class="shrink-0 text-xs text-muted-foreground tabular-nums"
                  :datetime="new Date(w.createdAt).toISOString()"
                >{{ startedAgo(w) }}</time>
              </button>
            </li>
          </ul>
        </section>
      </div>

      <CorchWorkerDetail
        :worker="selected"
        :events-loading="!!selectedId && !detail"
        :now="now"
        @changed="load({ silent: true })"
      />
    </div>
  </div>
</template>
