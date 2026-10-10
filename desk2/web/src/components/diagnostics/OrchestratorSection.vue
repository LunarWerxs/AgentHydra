<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { OrchestratorAct, OrchestratorJudgment, OrchestratorMove, OrchestratorPlan, OrchestratorRow } from '@shared/orchestrator'
import type { View } from '@/components/shell/logic'
import { useShellSource } from '@/components/shell/source'
import { usePaneApi } from '@/components/panes/api'
import { relativeTime } from '@/components/sidebar/search'
import { Tip } from '@/components/ui/tooltip'

// Orchestrator: each open chat's next move as the orchestrator sees it, and on request what the CreAitor says the
// owner would answer. Shadow until the owner arms it (here or Settings > General > Orchestrator); armed, a model judges
// each running chat due a peek and each Desk chat an error stopped (server/src/orchestrator/judge.ts), sends the message
// it writes when the hard limits allow (plugins/70-orchestrator.ts), and lists what it did. Nothing else here sends.
const api = usePaneApi()
const src = useShellSource()
const plan = ref<OrchestratorPlan | null>(null)
const error = ref<string | null>(null)
const asking = ref(false)
const arming = ref(false)

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

async function setArmed(armed: boolean): Promise<void> {
  arming.value = true
  try {
    plan.value = await api.diagnostics<OrchestratorPlan>('orchestrator', {}, { armed })
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    arming.value = false
  }
}

const rows = computed(() => (plan.value?.rows ?? []).filter((r) => !QUIET.includes(r.move)))
const quiet = computed(() => QUIET.map((m) => `${plan.value?.counts[m] ?? 0} ${m === 'watch' ? 'working or queued' : 'done'}`).join(' · '))
const knownIds = computed(() => new Set(src.chats.value.map((c) => c.id)))
/** Where a row opens: a Desk chat this window lists, or any outside session (the shell opens its transcript). */
const target = (r: OrchestratorRow): View | null =>
  r.source !== 'desk' ? { kind: 'external', id: r.id } : knownIds.value.has(r.id) ? { kind: 'chat', id: r.id } : null
const SOURCE: Record<OrchestratorRow['source'], string> = { desk: '', desktop: 'Claude Desktop', cli: 'CLI', climayte: 'CliMayte', codex: 'Codex', other: 'outside' }
const where = (r: OrchestratorRow): string => [SOURCE[r.source], r.account].filter(Boolean).join(' ')
const verdictText = (v: string): string => (v === 'decide' ? 'The owner would say' : v === 'reversible' ? 'Take the reversible option' : 'Only the owner can answer')
const armed = computed(() => plan.value?.mode === 'armed')
/** A judgment's line: its verdict and reason, or its error; what the limits held back; the model and when. */
const judgedText = (j: OrchestratorJudgment): string => (j.error ? `The judge failed: ${j.error}` : `${j.verdict}: ${j.why}`)
const judgedWhere = (j: OrchestratorJudgment): string => [j.resolved ?? j.model, relativeTime(j.at)].join(' · ')
const actText = (a: OrchestratorAct): string =>
  a.did === 'nudged'
    ? `Checked in: ${a.detail ?? 'it was going nowhere'}`
    : a.did === 'flagged'
      ? `Flagged: ${a.detail ?? 'it stopped writing'}`
      : `${a.did === 'continued' ? 'Continued' : 'Gave up on'} after an error`
</script>

<template>
  <div class="text-[13px]/4.75" data-testid="orchestrator">
    <p v-if="armed" class="text-text-muted">
      What the orchestrator does next in each open chat. Armed: a model judges the running chats and the Desk chats an error stopped, and sends the message it writes when the limits allow; the rest it only plans. A usage limit's stop is the babysitter's.
    </p>
    <p v-else class="text-text-muted">What the orchestrator would do next in each open chat. Shadow: it only plans, nothing is sent.</p>
    <p v-if="error" class="mt-2 text-danger-text">Could not load the plan: {{ error }}</p>
    <p v-else-if="!plan" class="mt-2 text-text-muted">Loading…</p>
    <template v-else>
      <div class="mt-2 flex flex-wrap items-baseline gap-x-3">
        <span class="text-text-2">{{ rows.length }} to act on · {{ quiet }} · last {{ plan.days }} days</span>
        <span class="ms-auto flex gap-x-3">
          <button
            v-if="plan.creaitor"
            type="button"
            class="cursor-default text-text-2 underline-offset-2 hover:text-text hover:underline disabled:text-text-muted"
            :disabled="asking"
            @click="load(true)"
          >
            {{ asking ? 'Asking the CreAitor…' : 'Ask the CreAitor' }}
          </button>
          <Tip :label="armed ? 'Stop acting; it goes back to only planning' : 'Continue Desk chats a limit or an error stopped, until Desk stops'">
            <button
              type="button"
              class="cursor-default text-text-2 underline-offset-2 hover:text-text hover:underline disabled:text-text-muted"
              :disabled="arming"
              @click="setArmed(!armed)"
            >
              {{ armed ? 'Disarm' : 'Arm' }}
            </button>
          </Tip>
        </span>
      </div>
      <p v-if="!rows.length" class="mt-2 text-text-muted">Nothing waits on the orchestrator.</p>
      <ul v-else class="mt-2">
        <li v-for="r in rows" :key="r.id" class="border-b border-border py-2 last:border-b-0">
          <div class="flex flex-wrap items-baseline gap-x-3">
            <span class="text-text">{{ LABEL[r.move] }}</span>
            <span class="text-text-muted">{{ r.reason }}</span>
            <span v-if="r.source !== 'desk'" class="ms-auto text-text-muted">{{ where(r) }}</span>
            <button
              v-if="target(r)"
              type="button"
              class="cursor-default truncate text-text-2 underline-offset-2 hover:text-text hover:underline"
              :class="{ 'ms-auto': r.source === 'desk' }"
              @click="src.select(target(r)!)"
            >
              {{ r.title || 'Open chat' }}
            </button>
            <span v-else class="ms-auto truncate text-text-muted">{{ r.title }}</span>
          </div>
          <Tip v-if="r.question" :label="r.question"><div class="mt-0.5 truncate text-text-2">{{ r.question }}</div></Tip>
          <div v-if="r.options?.length" class="mt-0.5 truncate text-text-muted">{{ r.options.join(' · ') }}</div>
          <div v-if="r.judgment" class="mt-0.5 text-text-2" :class="{ 'text-danger-text': r.judgment.error }" data-testid="judgment">
            {{ judgedText(r.judgment) }}
            <span class="text-text-muted">({{ judgedWhere(r.judgment) }}{{ r.judgment.held ? `; held: ${r.judgment.held}` : '' }})</span>
            <Tip v-if="r.judgment.message" :label="r.judgment.message"><div class="mt-0.5 truncate text-text-muted">Message: {{ r.judgment.message }}</div></Tip>
          </div>
          <div v-if="r.creaitor && 'error' in r.creaitor" class="mt-0.5 text-danger-text">{{ r.creaitor.error }}</div>
          <div v-else-if="r.creaitor" class="mt-0.5 text-text-2">
            {{ verdictText(r.creaitor.verdict) }}: {{ r.creaitor.option || r.creaitor.answer || r.creaitor.needLine }}
            <span class="tnum text-text-muted">({{ Math.round(r.creaitor.confidence * 100) }}%, {{ r.creaitor.mode }})</span>
          </div>
        </li>
      </ul>
      <template v-if="plan.acts.length">
        <p class="mt-3 text-text-2">What it did</p>
        <ul class="mt-1">
          <li v-for="a in plan.acts" :key="`${a.at}-${a.id}`" class="flex flex-wrap items-baseline gap-x-3 py-1">
            <span class="tnum text-text-muted">{{ relativeTime(a.at) }}</span>
            <span class="text-text">{{ actText(a) }}</span>
            <span v-if="a.error" class="text-danger-text">{{ a.error }}</span>
            <button
              v-if="knownIds.has(a.id)"
              type="button"
              class="ms-auto cursor-default truncate text-text-2 underline-offset-2 hover:text-text hover:underline"
              @click="src.select({ kind: 'chat', id: a.id })"
            >
              {{ a.title || 'Open chat' }}
            </button>
            <span v-else class="ms-auto truncate text-text-muted">{{ a.title }}</span>
          </li>
        </ul>
      </template>
    </template>
  </div>
</template>
