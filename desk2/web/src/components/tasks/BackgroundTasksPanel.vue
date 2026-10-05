<script setup lang="ts">
// The real app's Background tasks panel (real-background-tasks-panel.png, measured at 1x), listing
// CliMayte as its workflows: one card per running unit (a CliMayte group, a lone worker, or one of
// this chat's background tasks), its phases with progress squares and the agent table, then the
// finished ones behind 'Finished N'. A worker's own estimate (its `ETA:` line) shows after its time,
// '1m 20s / ~5m', and a running unit says about how long is left by its latest one. Stop cancels the
// unit's active workers through AgentHydra, or stops a Desk chat's background task through the chat
// (a CliMayte chat's worker with it: a worker takes no message to stop one command); Stop all does
// that for every running unit listed. The trash only hides finished units here.
import { computed, effectScope, nextTick, onBeforeUnmount, ref, shallowRef, watch, type EffectScope, type Ref } from 'vue'
import { Check, ChevronDown, ChevronRight, Maximize2, Minimize2, Trash2, X } from '@lucide/vue'
import type { TranscriptItem } from '@shared/protocol'
import { useDesk } from '@/stores/desk'
import { useShellSource } from '@/components/shell/source'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Tip } from '@/components/ui/tooltip'
import { useClock } from '@/lib/clock'
import { cleared, clearFinished } from './api'
import { canStop, elapsedOf, etaLeft, etaShort, formatTokens, openPhase, panelLists, phaseSquares, type AgentState, type TaskAgent, type TaskPhase, type TaskUnit } from './logic'

const props = defineProps<{
  sessionId: string | null | undefined
  workerIds?: readonly string[]
  items: TranscriptItem[]
  /** The Hydra Desk chat the items are of (its tasks get Stop); null for a session outside it. */
  chatId?: string | null
  /** That chat is a CliMayte worker: stopping one of its tasks stops the worker, turn and all. */
  climayte?: boolean
  focusId?: string | null
  expanded?: boolean
}>()
const emit = defineEmits<{ close: []; 'toggle-expand': [] }>()

const src = useShellSource()
const desk = useDesk()

// Opens on 'This chat'; 'All' is one click away and remembered per viewer.
const ALL_KEY = 'hydra-desk.tasks.all'
const readAll = (): boolean => {
  try {
    return localStorage.getItem(ALL_KEY) === '1'
  } catch {
    return false
  }
}
const all = ref(readAll())
function toggleAll() {
  all.value = !all.value
  try {
    localStorage.setItem(ALL_KEY, all.value ? '1' : '0')
  } catch {
    /* storage unavailable: the choice lasts until the panel closes */
  }
}
const lists = computed(() =>
  panelLists({ workers: src.workers.value, items: props.items, sessionId: props.sessionId, workerIds: props.workerIds, all: all.value, cleared: cleared.value, chatId: props.chatId })
)

// The progress squares of every phase on show, worked out once per list change.
const squares = computed(() => {
  const m = new Map<TaskPhase, AgentState[]>()
  for (const u of lists.value.running) for (const p of u.phases) m.set(p, phaseSquares(p))
  return m
})

// The shared 1 s clock runs only while something here counts up (a running unit, or a unit with a start and no end).
const ticking = computed(() => lists.value.running.length > 0 || lists.value.finished.some((u) => u.startedAt !== null && u.endedAt === null))
const frozenNow = Date.now()
const clock = shallowRef<{ now: Readonly<Ref<number>> } | null>(null)
const now = computed(() => clock.value?.now.value ?? frozenNow)
let clockScope: EffectScope | null = null
watch(
  ticking,
  (on) => {
    if (on && !clockScope) {
      clockScope = effectScope()
      const tick = clockScope.run(() => useClock(1000))
      clock.value = tick ? { now: tick } : null
    } else if (!on && clockScope) {
      clockScope.stop()
      clockScope = null
      clock.value = null
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => clockScope?.stop())

// Phases open: per unit, the first with a running agent unless the user toggled it.
const toggled = ref(new Map<string, string | null>())
const shownPhase = (u: TaskUnit) => (toggled.value.has(u.id) ? toggled.value.get(u.id)! : openPhase(u))
function togglePhase(u: TaskUnit, name: string) {
  const next = new Map(toggled.value)
  next.set(u.id, shownPhase(u) === name ? null : name)
  toggled.value = next
}

const finishedOpen = ref(false)
const body = ref<HTMLElement | null>(null)
async function bringIntoView(id: string | null | undefined) {
  if (!id) return
  const unit = [...lists.value.running, ...lists.value.finished].find((u) => u.id === id || u.keys.includes(id) || u.id === `task:${id}`)
  if (!unit) return
  if (lists.value.finished.includes(unit)) finishedOpen.value = true
  await nextTick()
  body.value?.querySelector(`[data-unit="${CSS.escape(unit.id)}"]`)?.scrollIntoView({ block: 'nearest' })
}
watch(() => props.focusId, bringIntoView, { immediate: true })

// Stop asks first: one unit, or 'all' (every running unit listed that can be stopped).
const stopping = ref<TaskUnit | 'all' | null>(null)
const stopError = ref('')
const stoppableNow = computed(() => lists.value.running.filter(canStop))
const stopUnits = computed(() => (stopping.value === 'all' ? stoppableNow.value : stopping.value ? [stopping.value] : []))
const stopTitle = computed(() => {
  const us = stopUnits.value
  return stopping.value === 'all' ? `Stop ${us.length === 1 ? 'the running task' : `all ${us.length} running tasks`}?` : `Stop ${us[0]?.name ?? ''}?`
})
const stopText = computed(() => {
  const us = stopUnits.value
  const workers = us.reduce((n, u) => n + u.stoppable.length, 0)
  const tasks = us.filter((u) => u.stopTask !== null).length
  const parts: string[] = []
  if (workers) parts.push(`${workers === 1 ? 'Its running agent is' : `${workers} running agents are`} cancelled in AgentHydra.`)
  if (tasks) {
    parts.push(
      props.climayte
        ? "A CliMayte worker cannot stop one command alone, so this chat's worker stops too, its turn with it. Send a message to go on."
        : `${tasks === 1 ? 'The command is' : `${tasks} commands are`} stopped; the chat's turn goes on.`
    )
  }
  return `${parts.join(' ')} Finished work stays.`
})
async function confirmStop() {
  const us = stopUnits.value
  stopping.value = null
  const failed: string[] = []
  const why = (e: unknown) => failed.push(e instanceof Error ? e.message : String(e))
  for (const u of us) {
    for (const id of u.stoppable) await desk.cancelWorker(id).catch(why)
    if (u.stopTask && props.chatId) await desk.stopTask(props.chatId, u.stopTask).catch(why)
  }
  stopError.value = failed.length ? `Not stopped: ${failed[0]}` : ''
}

function openAgent(a: TaskAgent) {
  if (a.sessionId) src.select({ kind: 'external', id: a.sessionId })
}

const SQUARE: Record<AgentState, string> = {
  done: 'bg-[var(--accent)]/75',
  running: 'bg-[var(--accent)]',
  waiting: 'bg-white/20',
  failed: 'bg-[var(--danger)]/70'
}
const ICON_BTN =
  'flex size-6 items-center justify-center rounded-[var(--radius-6)] text-[var(--text)] outline-none transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] focus-visible:shadow-[var(--focus-ring)]'
</script>

<template>
  <section class="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[8px] border border-[var(--border)] bg-[var(--bg-panel)] text-[13px] leading-5" aria-label="Background tasks">
    <header class="flex h-[34px] shrink-0 items-center pl-2 pr-1">
      <h2 class="min-w-0 flex-1 truncate font-normal text-[var(--text-2)]">Background tasks</h2>
      <Tip :label="expanded ? 'Restore' : 'Expand'" side="bottom">
        <button type="button" :class="ICON_BTN" :aria-label="expanded ? 'Restore' : 'Expand'" @click="emit('toggle-expand')">
          <component :is="expanded ? Minimize2 : Maximize2" class="size-3.5" :stroke-width="1.5" />
        </button>
      </Tip>
      <Tip label="Close" side="bottom">
        <button type="button" :class="ICON_BTN" aria-label="Close" @click="emit('close')">
          <X class="size-3.5" :stroke-width="1.75" />
        </button>
      </Tip>
    </header>

    <div ref="body" class="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-1.5">
      <div class="mb-[5px] flex h-5 items-center text-[var(--text-muted)]">
        <span class="flex-1">Running</span>
        <button
          v-if="stoppableNow.length"
          type="button"
          class="rounded-[var(--radius-5)] px-1.5 text-[12px] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] hover:text-[var(--text)]"
          @click="stopping = 'all'"
        >
          Stop all
        </button>
        <button
          v-if="sessionId"
          type="button"
          class="rounded-[var(--radius-5)] px-1.5 text-[12px] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] hover:text-[var(--text)]"
          :class="all ? 'text-[var(--text)]' : ''"
          :aria-pressed="all"
          @click="toggleAll"
        >
          All
        </button>
      </div>

      <p v-if="!lists.running.length" class="mb-2 text-[var(--text-muted)]">Nothing running{{ all ? '' : ' from this chat' }}.</p>
      <p v-if="stopError" class="mb-2 text-[var(--danger-text)]" role="alert">{{ stopError }}</p>

      <div class="flex flex-col gap-2">
        <article
          v-for="u in lists.running"
          :key="u.id"
          :data-unit="u.id"
          class="rounded-[8px] bg-[var(--fill-5)] px-2 pb-2 pt-2"
          :class="focusId && (u.id === focusId || u.keys.includes(focusId)) ? 'shadow-[inset_0_0_0_1px_var(--border-strong)]' : ''"
        >
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <h3 class="truncate font-normal text-[var(--text-2)]">{{ u.name }}</h3>
              <p class="mt-0.5 flex gap-2.5">
                <span class="font-semibold text-[var(--text-2)]">{{ u.label }}</span>
                <span class="tnum text-[var(--text-muted)]">{{ elapsedOf(u.startedAt, u.endedAt, now) }}</span>
                <span v-if="u.etaEndsAt !== null" class="tnum text-[var(--text-muted)]">{{ etaLeft(u.etaEndsAt, now) }}</span>
                <span v-if="u.account" class="text-[var(--text-muted)]">{{ u.account }}</span>
              </p>
              <p v-if="u.agents || u.tokens !== null" class="tnum flex gap-1.5 text-[var(--text-muted)]">
                <span v-if="u.agents"><b class="font-semibold text-[var(--text-2)]">{{ u.agents }}</b> {{ u.agents === 1 ? 'agent' : 'agents' }}</span>
                <span><b class="font-semibold text-[var(--text-2)]">{{ formatTokens(u.tokens) }}</b> tokens</span>
              </p>
            </div>
            <Tip v-if="canStop(u)" :label="`Stop ${u.name}`" side="left">
              <button
                type="button"
                class="flex size-5 shrink-0 items-center justify-center rounded-[4px] bg-white/10 text-[var(--text)] outline-none transition-colors duration-[60ms] hover:bg-white/20 focus-visible:shadow-[var(--focus-ring)]"
                :aria-label="`Stop ${u.name}`"
                @click="stopping = u"
              >
                <svg viewBox="0 0 12 12" class="size-3" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="1" y="1" width="10" height="10" rx="1.5" /></svg>
              </button>
            </Tip>
          </div>

          <p v-if="u.description" class="mt-2.5 leading-[19px] text-[var(--text-muted)]">{{ u.description }}</p>

          <template v-if="u.phases.length">
            <h4 class="mt-[21px] font-semibold text-[var(--text)]">Phases</h4>
            <div v-for="p in u.phases" :key="p.name" class="mt-1">
              <button
                v-if="shownPhase(u) === p.name"
                type="button"
                class="flex w-full flex-col rounded-[6px] bg-[var(--fill-5)] px-2 pb-2 pt-1 text-left"
                :aria-expanded="true"
                @click="togglePhase(u, p.name)"
              >
                <span class="flex h-5 w-full items-center gap-2">
                  <span class="min-w-0 flex-1 truncate text-[var(--text)]">{{ p.name }}</span>
                  <span class="tnum text-[var(--text-muted)]">{{ p.done }}/{{ p.total }}</span>
                  <ChevronDown class="size-4 text-[var(--text-muted)]" :stroke-width="1.5" />
                </span>
                <span class="mt-1.5 flex gap-0.5" aria-hidden="true">
                  <span
                    v-for="(s, i) in squares.get(p)"
                    :key="i"
                    class="size-1.5 rounded-[1.5px]"
                    :class="[SQUARE[s], s === 'running' ? 'animate-[var(--animate-dot-blink)]' : '']"
                  />
                </span>
              </button>
              <button
                v-else
                type="button"
                class="flex h-10 w-full items-center gap-2 rounded-[6px] px-2 text-left transition-colors duration-[60ms] hover:bg-[var(--fill-5)]"
                :aria-expanded="false"
                @click="togglePhase(u, p.name)"
              >
                <span class="min-w-0 flex-1 truncate text-[var(--text-2)]">{{ p.name }}</span>
                <span class="tnum text-[var(--text-muted)]">{{ p.done }}/{{ p.total }}</span>
                <ChevronRight class="size-4 text-[var(--text-muted)]" :stroke-width="1.5" />
              </button>

              <table v-if="shownPhase(u) === p.name" class="tnum mb-1 mt-1.5 w-full table-fixed border-collapse">
                <thead>
                  <tr class="h-5 text-[var(--text-muted)]">
                    <th class="w-7 p-0" />
                    <th class="p-0 text-left font-normal">Agent</th>
                    <th class="w-[64px] p-0 text-left font-normal">Model</th>
                    <th class="w-12 p-0 text-right font-normal">Tokens</th>
                    <th class="w-24 p-0 pr-2 text-right font-normal">Time</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="a in p.agents"
                    :key="a.id"
                    class="h-5"
                    :class="a.state === 'running' || a.state === 'waiting' ? 'font-semibold text-[var(--text-2)]' : 'text-[var(--text-muted)]'"
                    :data-agent="a.id"
                  >
                    <td class="p-0 pl-2">
                      <Check v-if="a.state === 'done'" class="size-3" :stroke-width="1.5" aria-label="done" />
                      <X v-else-if="a.state === 'failed'" class="size-3 text-[var(--danger-text)]" :stroke-width="1.5" aria-label="failed" />
                    </td>
                    <td class="truncate p-0">
                      <button v-if="a.sessionId" type="button" class="max-w-full truncate text-left hover:underline" @click="openAgent(a)">{{ a.name }}</button>
                      <span v-else>{{ a.name }}</span>
                    </td>
                    <td class="truncate p-0">{{ a.model || '–' }}</td>
                    <td class="p-0 text-right">{{ formatTokens(a.tokens) }}</td>
                    <td class="truncate p-0 pr-2 text-right">
                      {{ elapsedOf(a.startedAt, a.endedAt, now) }}<span v-if="a.etaMin !== null" class="font-normal text-[var(--text-muted)]"> / {{ etaShort(a.etaMin) }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </article>
      </div>

      <div class="mt-4 flex h-5 items-center">
        <button
          type="button"
          class="flex items-center gap-1 text-[var(--text-muted)] transition-colors duration-[60ms] hover:text-[var(--text)]"
          :aria-expanded="finishedOpen"
          @click="finishedOpen = !finishedOpen"
        >
          Finished {{ lists.finished.length }}
          <ChevronRight class="size-3 transition-transform duration-150" :class="finishedOpen ? 'rotate-90' : ''" :stroke-width="1.5" />
        </button>
        <Tip v-if="lists.finished.length" label="Clear finished" side="left">
          <button
            type="button"
            class="ml-auto flex size-6 items-center justify-center rounded-[var(--radius-6)] text-[var(--text)] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)]"
            aria-label="Clear finished"
            @click="clearFinished(lists.finished.flatMap((u) => u.keys))"
          >
            <Trash2 class="size-3.5" :stroke-width="1.5" />
          </button>
        </Tip>
      </div>

      <ul v-if="finishedOpen" class="mt-1 flex flex-col" aria-label="Finished">
        <li
          v-for="u in lists.finished"
          :key="u.id"
          :data-unit="u.id"
          class="flex h-8 items-center gap-2 rounded-[6px] px-2 text-[var(--text-muted)] hover:bg-[var(--fill-5)]"
        >
          <Check v-if="!u.failed && u.phases.every((p) => p.agents.every((a) => a.state === 'done'))" class="size-3 shrink-0" :stroke-width="1.5" />
          <X v-else class="size-3 shrink-0 text-[var(--danger-text)]" :stroke-width="1.5" />
          <span class="min-w-0 flex-1 truncate text-[var(--text-2)]">{{ u.name }}</span>
          <span v-if="u.agents > 1" class="tnum shrink-0">{{ u.agents }} agents</span>
          <span class="tnum shrink-0">{{ formatTokens(u.tokens) }}</span>
          <span class="tnum w-[60px] shrink-0 text-right">{{ elapsedOf(u.startedAt, u.endedAt, now) }}</span>
        </li>
      </ul>
    </div>

    <Dialog :open="stopping !== null" @update:open="(o: boolean) => !o && (stopping = null)">
      <DialogContent :show-close-button="false" class="gap-3 rounded-[var(--radius-12)] p-4 shadow-(--shadow-popover) ring-0 sm:max-w-[360px]">
        <DialogTitle class="text-[14px] font-semibold leading-5 text-text">{{ stopTitle }}</DialogTitle>
        <DialogDescription class="text-[13px] leading-[19px] text-text-2">{{ stopText }}</DialogDescription>
        <div class="flex justify-end gap-2 pt-1">
          <button type="button" class="h-7 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-3 text-[13px] text-text hover:bg-[var(--fill-secondary-hover)]" @click="stopping = null">Cancel</button>
          <button type="button" class="h-7 rounded-[var(--radius-6)] bg-danger px-3 text-[13px] font-medium text-white hover:brightness-110" @click="confirmStop">Stop</button>
        </div>
      </DialogContent>
    </Dialog>
  </section>
</template>
