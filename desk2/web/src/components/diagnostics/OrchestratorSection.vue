<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { OrchestratorMove, OrchestratorPlan } from '@shared/orchestrator'
import { useShellSource } from '@/components/shell/source'
import { usePaneApi } from '@/components/panes/api'

// Orchestrator (shadow): each open chat's next move as the orchestrator sees it, and on request what the CreAitor
// says the owner would answer. Read-only: nothing here sends, answers or moves anything.
const api = usePaneApi()
const src = useShellSource()
const plan = ref<OrchestratorPlan | null>(null)
const error = ref<string | null>(null)
const asking = ref(false)

const LABEL: Record<OrchestratorMove, string> = {
  'answer-question': 'Answer its question',
  'answer-need': 'Answer its NEED',
  'retry-error': 'Retry after an error',
  'resume-after-limit': 'Resume after the limit',
  watch: 'Watch',
  leave: 'Leave to a person',
  done: 'Done'
}
/** Rows worth a line each; the rest are only counted. */
const QUIET: OrchestratorMove[] = ['watch', 'done']

async function load(ask = false): Promise<void> {
  asking.value = ask
  try {
    plan.value = await api.diagnostics<OrchestratorPlan>('orchestrator', ask ? { ask: 1 } : {})
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    asking.value = false
  }
}
onMounted(() => load())

const rows = computed(() => (plan.value?.rows ?? []).filter((r) => !QUIET.includes(r.move)))
const quiet = computed(() => QUIET.map((m) => `${plan.value?.counts[m] ?? 0} ${m === 'watch' ? 'working or queued' : 'done'}`).join(' · '))
const knownIds = computed(() => new Set(src.chats.value.map((c) => c.id)))
const verdictText = (v: string): string => (v === 'decide' ? 'The owner would say' : v === 'reversible' ? 'Take the reversible option' : 'Only the owner can answer')
</script>

<template>
  <div class="text-[13px] leading-[19px]" data-testid="orchestrator">
    <p class="text-text-muted">What the orchestrator would do next in each open chat. Shadow: it only plans, nothing is sent.</p>
    <p v-if="error" class="mt-2 text-danger-text">Could not load the plan: {{ error }}</p>
    <p v-else-if="!plan" class="mt-2 text-text-muted">Loading…</p>
    <template v-else>
      <div class="mt-2 flex flex-wrap items-baseline gap-x-3">
        <span class="text-text-2">{{ rows.length }} to act on · {{ quiet }} · last {{ plan.days }} days</span>
        <button
          v-if="plan.creaitor"
          type="button"
          class="ml-auto cursor-default text-text-2 underline-offset-2 hover:text-text hover:underline disabled:text-text-muted"
          :disabled="asking"
          @click="load(true)"
        >
          {{ asking ? 'Asking the CreAitor…' : 'Ask the CreAitor' }}
        </button>
      </div>
      <p v-if="!rows.length" class="mt-2 text-text-muted">Nothing waits on the orchestrator.</p>
      <ul v-else class="mt-2">
        <li v-for="r in rows" :key="r.id" class="border-b border-border py-2 last:border-b-0">
          <div class="flex flex-wrap items-baseline gap-x-3">
            <span class="text-text">{{ LABEL[r.move] }}</span>
            <span class="text-text-muted">{{ r.reason }}</span>
            <button
              v-if="knownIds.has(r.id)"
              type="button"
              class="ml-auto cursor-default truncate text-text-2 underline-offset-2 hover:text-text hover:underline"
              @click="src.select({ kind: 'chat', id: r.id })"
            >
              {{ r.title || 'Open chat' }}
            </button>
            <span v-else class="ml-auto truncate text-text-muted">{{ r.title }}</span>
          </div>
          <div v-if="r.question" class="mt-0.5 truncate text-text-2" :title="r.question">{{ r.question }}</div>
          <div v-if="r.options?.length" class="mt-0.5 truncate text-text-muted">{{ r.options.join(' · ') }}</div>
          <div v-if="r.creaitor && 'error' in r.creaitor" class="mt-0.5 text-danger-text">{{ r.creaitor.error }}</div>
          <div v-else-if="r.creaitor" class="mt-0.5 text-text-2">
            {{ verdictText(r.creaitor.verdict) }}: {{ r.creaitor.option || r.creaitor.answer || r.creaitor.needLine }}
            <span class="tnum text-text-muted">({{ Math.round(r.creaitor.confidence * 100) }}%, {{ r.creaitor.mode }})</span>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>
