<script setup lang="ts">
// Corch view: the workers a chat started through Corch (server/src/corch.ts, docs/CORCH.md).
// Grouped by run group, newest first. Selecting a row shows its events, result or error, a
// follow-up box (POST /send) and Stop (POST /cancel). Polls every 3 s only while a worker is active.
import { Network, RefreshCw, Send, Square } from '@lucide/vue'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Badge } from '@/components/ui/badge'
import type { BadgeVariants } from '@/components/ui/badge/badge-variants'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { CorchStatus, CorchWorkerView } from '@/lib/api'
import { cancelCorch, getCorchWorker, listCorchWorkers, sendCorchWorker } from '@/lib/api'

const { t } = useI18n()

const workers = ref<CorchWorkerView[]>([])
const loading = ref(false)
const selectedId = ref<string | null>(null)
const detail = ref<(CorchWorkerView & { events: string[] }) | null>(null)
const followUp = ref('')
const sending = ref(false)
const stopping = ref(false)

const ACTIVE: CorchStatus[] = ['queued', 'running', 'waiting']
const isActive = (w: CorchWorkerView) => ACTIVE.includes(w.status)

const STATUS_VARIANT: Record<CorchStatus, BadgeVariants['variant']> = {
  queued: 'muted',
  running: 'info',
  waiting: 'warning',
  done: 'success',
  failed: 'destructive',
  cancelled: 'outline',
}
const STATUS_KEY: Record<CorchStatus, string> = {
  queued: 'corch.statusQueued',
  running: 'corch.statusRunning',
  waiting: 'corch.statusWaiting',
  done: 'corch.statusDone',
  failed: 'corch.statusFailed',
  cancelled: 'corch.statusCancelled',
}

/** Groups ordered by their newest worker, workers inside newest first. */
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

const elapsed = (s: number) => t('corch.elapsed', { m: Math.floor(s / 60), s: Math.floor(s % 60) })

let timer: number | null = null
let alive = true

async function loadDetail() {
  const id = selectedId.value
  if (!id) return
  try {
    const d = await getCorchWorker(id)
    if (selectedId.value === id) detail.value = d
  } catch {
    // Keep the last detail; the list error toast already speaks for the daemon being down.
  }
}

async function load(opts: { silent?: boolean } = {}) {
  if (timer !== null) window.clearTimeout(timer)
  timer = null
  if (!opts.silent) loading.value = true
  try {
    workers.value = await listCorchWorkers()
    await loadDetail()
  } catch {
    if (!opts.silent) toast.error(t('corch.loadFailed'))
  } finally {
    if (!opts.silent) loading.value = false
  }
  // Poll only while something can still change.
  if (alive && workers.value.some(isActive))
    timer = window.setTimeout(() => load({ silent: true }), 3000)
}

function select(w: CorchWorkerView) {
  selectedId.value = w.id
  detail.value = null
  followUp.value = ''
  void loadDetail()
}

async function onSend() {
  const id = selectedId.value
  const text = followUp.value.trim()
  if (!id || !text || sending.value) return
  sending.value = true
  try {
    const r = await sendCorchWorker(id, text)
    if (r.ok) {
      followUp.value = ''
      await load({ silent: true })
    } else toast.error(r.message || t('corch.sendFailed'))
  } catch {
    toast.error(t('corch.sendFailed'))
  } finally {
    sending.value = false
  }
}

async function onStop() {
  const id = selectedId.value
  if (!id || stopping.value) return
  stopping.value = true
  try {
    await cancelCorch({ id })
    toast.success(t('corch.stopped'))
    await load({ silent: true })
  } catch {
    toast.error(t('corch.stopFailed'))
  } finally {
    stopping.value = false
  }
}

onMounted(() => load())
onUnmounted(() => {
  alive = false
  if (timer !== null) window.clearTimeout(timer)
  timer = null
})
</script>

<template>
  <div class="flex flex-col gap-3 p-3">
    <div class="flex items-center justify-between gap-2">
      <h2 class="flex items-center gap-2 text-sm font-semibold">
        <Network class="size-4" />
        {{ $t('corch.title') }}
        <span class="text-muted-foreground">({{ workers.length }})</span>
      </h2>
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
    </div>

    <p v-if="!loading && workers.length === 0" class="text-sm text-muted-foreground">
      {{ $t('corch.empty') }}
    </p>

    <div v-else class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div class="flex flex-col gap-3">
        <section v-for="g in groups" :key="g.group" class="flex flex-col gap-1">
          <h3 class="px-1 text-xs font-medium text-muted-foreground">
            {{ $t('corch.group', { group: g.group }) }}
          </h3>
          <button
            v-for="w in g.items"
            :key="w.id"
            type="button"
            class="flex flex-col gap-1 rounded-md border px-3 py-2 text-start text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            :class="w.id === selectedId ? 'bg-accent' : ''"
            :aria-pressed="w.id === selectedId"
            @click="select(w)"
          >
            <div class="flex min-w-0 items-center gap-2">
              <Badge :variant="STATUS_VARIANT[w.status]">{{ $t(STATUS_KEY[w.status]) }}</Badge>
              <span class="truncate font-medium">{{ w.title }}</span>
            </div>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span>{{ w.account ?? $t('corch.noAccount') }}</span>
              <span class="tabular-nums">{{ elapsed(w.elapsedS) }}</span>
              <span v-if="w.moves > 0">{{ $t('corch.moves', { n: w.moves }) }}</span>
            </div>
            <div v-if="w.lastActivity" class="truncate text-xs text-muted-foreground">
              {{ w.lastActivity }}
            </div>
          </button>
        </section>
      </div>

      <div class="flex min-w-0 flex-col gap-3 rounded-md border p-3">
        <p v-if="!selected" class="text-sm text-muted-foreground">{{ $t('corch.selectHint') }}</p>
        <template v-else>
          <div class="flex items-center justify-between gap-2">
            <div class="flex min-w-0 items-center gap-2">
              <Badge :variant="STATUS_VARIANT[selected.status]">
                {{ $t(STATUS_KEY[selected.status]) }}
              </Badge>
              <span class="truncate text-sm font-medium">{{ selected.title }}</span>
            </div>
            <Button
              v-if="isActive(selected)"
              variant="outline"
              size="sm"
              :disabled="stopping"
              @click="onStop"
            >
              <Square /> {{ $t('corch.stop') }}
            </Button>
          </div>

          <div v-if="selected.result" class="flex flex-col gap-1">
            <h4 class="text-xs font-medium text-muted-foreground">{{ $t('corch.result') }}</h4>
            <pre class="mono max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs scroll-slim">{{ selected.result }}</pre>
          </div>
          <div v-if="selected.error" class="flex flex-col gap-1">
            <h4 class="text-xs font-medium text-destructive">{{ $t('corch.error') }}</h4>
            <pre class="mono max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-destructive/10 p-2 text-xs text-destructive scroll-slim">{{ selected.error }}</pre>
          </div>

          <div class="flex flex-col gap-1">
            <h4 class="text-xs font-medium text-muted-foreground">{{ $t('corch.events') }}</h4>
            <ul
              v-if="detail?.events.length"
              class="mono max-h-80 overflow-auto rounded-md bg-muted p-2 text-xs scroll-slim"
            >
              <li v-for="(e, i) in detail.events" :key="i" class="whitespace-pre-wrap">{{ e }}</li>
            </ul>
            <p v-else class="text-xs text-muted-foreground">{{ $t('corch.noEvents') }}</p>
          </div>

          <form class="flex items-center gap-2" @submit.prevent="onSend">
            <Input
              v-model="followUp"
              class="flex-1"
              :placeholder="$t('corch.followUp')"
              :aria-label="$t('corch.followUp')"
              :disabled="sending"
            />
            <Button type="submit" size="sm" :disabled="sending || !followUp.trim()">
              <Send /> {{ $t('corch.send') }}
            </Button>
          </form>
        </template>
      </div>
    </div>
  </div>
</template>
