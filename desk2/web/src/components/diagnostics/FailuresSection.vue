<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { FailuresResponse } from '@shared/protocol'
import { useShellSource } from '@/components/shell/source'
import { usePaneApi } from '@/components/panes/api'
import { Tip } from '@/components/ui/tooltip'
import { causeLabel, dayStart, duration, ranked } from './failures'

// Failures: counts by cause (today, 7 days), by account over 7 days (a dead account stands out), the latest rows.
const api = usePaneApi()
const src = useShellSource()
const today = ref<FailuresResponse | null>(null)
const week = ref<FailuresResponse | null>(null)
const error = ref<string | null>(null)

async function load(): Promise<void> {
  const now = Date.now()
  try {
    const [t, w] = await Promise.all([
      api.diagnostics<FailuresResponse>('failures', { since: dayStart(now, 0), limit: 1 }),
      api.diagnostics<FailuresResponse>('failures', { since: dayStart(now, 6), limit: 50 })
    ])
    today.value = t
    week.value = w
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}
onMounted(load)

const blocks = computed(() =>
  today.value && week.value
    ? [
        { h: 'By cause, today', d: today.value.byCause, n: today.value.total, account: false },
        { h: 'By cause, 7 days', d: week.value.byCause, n: week.value.total, account: false },
        { h: 'By account, 7 days', d: week.value.byAccount, n: week.value.total, account: true }
      ]
    : []
)
const when = (ts: number): string => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const acct = (r: { accountNumber: number | null; accountId: string }): string => (r.accountNumber !== null ? `#${r.accountNumber}` : r.accountId)
const knownIds = computed(() => new Set(src.chats.value.map((c) => c.id)))
const known = (id: string): boolean => knownIds.value.has(id)
</script>

<template>
  <div class="text-[13px]/4.75" data-testid="failures">
    <p v-if="error" class="text-danger-text">Could not load failures: {{ error }}</p>
    <p v-else-if="!week" class="text-text-muted">Loading…</p>
    <template v-else>
      <div class="grid gap-6 sm:grid-cols-3">
        <div v-for="b in blocks" :key="b.h">
          <h3 class="text-[13px] font-semibold leading-5 text-text">{{ b.h }} <span class="tnum font-normal text-text-muted">({{ b.n }})</span></h3>
          <p v-if="!b.n" class="mt-1 text-text-muted">None</p>
          <ul v-else class="mt-1">
            <li v-for="[k, n] in ranked(b.d)" :key="k" class="flex justify-between gap-3 border-b border-border py-1 last:border-b-0">
              <span class="truncate text-text-2">{{ b.account ? k : causeLabel(k) }}</span>
              <span class="tnum text-text">{{ n }}</span>
            </li>
          </ul>
        </div>
      </div>

      <h3 class="mt-8 text-[13px] font-semibold leading-5 text-text">Latest failures</h3>
      <p v-if="!week.rows.length" class="mt-1 text-text-muted">No failures in the last 7 days.</p>
      <ul v-else>
        <li v-for="r in week.rows" :key="r.id" class="border-b border-border py-2 last:border-b-0">
          <div class="flex flex-wrap items-baseline gap-x-3">
            <span class="text-text">{{ causeLabel(r.cause) }}</span>
            <span class="tnum text-text-muted">{{ when(r.ts) }}</span>
            <span class="text-text-muted">{{ acct(r) }} · {{ r.kind }} · {{ duration(r.durationMs) }}</span>
            <span v-if="r.recovered" class="text-success-text">moved to {{ r.movedToAccountId }}</span>
            <button
              v-if="known(r.chatId)"
              type="button"
              class="ms-auto cursor-default text-text-2 underline-offset-2 hover:text-text hover:underline"
              @click="src.select({ kind: 'chat', id: r.chatId })"
            >
              {{ r.title || 'Open chat' }}
            </button>
            <span v-else class="ms-auto truncate text-text-muted">{{ r.title }}</span>
          </div>
          <Tip :label="r.message"><div class="mt-0.5 truncate font-mono text-[12px] text-text-muted">{{ r.message }}</div></Tip>
        </li>
      </ul>
    </template>
  </div>
</template>
