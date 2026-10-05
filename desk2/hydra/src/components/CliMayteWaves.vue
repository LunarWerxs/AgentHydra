<script setup lang="ts">
// Waves in the CliMayte view (docs/CLIMAYTE.md, "Manager"): a manager worker dispatches and follows a
// set of keyed tasks. Each live wave (running or reported), and a finished one from the last 24 h,
// is one header line (id, status, counts, its group; the group is cut, the counts hide when the box
// is narrow, the line never wraps). The whole box and each wave start collapsed, live ones too, and
// both remember what the owner opened. Opened, a wave lists each key with its proof, the
// escalations with their reasons, and the report (collapsed), scrolling inside a max height.
// The view loads the waves with its own refresh cycle and passes them in; there is no timer here.
import { Check, ChevronRight, CircleAlert, Minus, Network, X } from '@lucide/vue'
import { useStorage } from '@vueuse/core'
import { computed, ref } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type {
  CliMayteWave,
  CliMayteWaveStatus,
  CliMayteWaveTaskState,
  CliMayteWorkerView,
} from '@/lib/api'
import InfoHint from '@/shell/InfoHint.vue'

const props = defineProps<{
  waves: CliMayteWave[]
  workers: CliMayteWorkerView[]
  /** `workers` may leave out older finished tasks: a manager not among them may still be there. */
  more?: boolean
  now: number
}>()
const emit = defineEmits<{ selectWorker: [id: string] }>()

const DAY_MS = 24 * 3600 * 1000
const STATE_ORDER: CliMayteWaveTaskState[] = ['pending', 'running', 'passed', 'failed', 'escalated']
const STATE_TONE: Record<CliMayteWaveTaskState, string> = {
  pending: 'text-muted-foreground',
  running: 'text-info',
  passed: 'text-success',
  failed: 'text-destructive',
  escalated: 'text-warning',
}
const STATUS_VARIANT: Record<
  CliMayteWaveStatus,
  'info' | 'warning' | 'success' | 'destructive' | 'outline'
> = {
  running: 'info',
  reported: 'warning',
  verified: 'success',
  rejected: 'destructive',
  failed: 'destructive',
  cancelled: 'outline',
}

const live = (w: CliMayteWave) => w.status === 'running' || w.status === 'reported'
/** Live waves, and a finished one for 24 h after it last changed, newest first. */
const shown = computed(() => props.waves.filter((w) => live(w) || props.now - w.updatedAt < DAY_MS))

// Everything starts collapsed (a live wave auto-opening was noise); a click is remembered here.
const wavesOpen = useStorage('agenthydra.climayte.wavesOpen', false)
const open = useStorage<Record<string, boolean>>('agenthydra.climayte.waveOpen', {})
const reportOpen = ref<Record<string, boolean>>({})

/** Per wave, once per change of the waves (not per render or clock tick): the count of each task
 *  state, the escalations by key, and the ones on a key the plan no longer lists (none is dropped). */
const derived = computed(() => {
  const out = new Map<
    string,
    {
      counts: { state: CliMayteWaveTaskState; n: number }[]
      escalations: Map<string, CliMayteWave['escalations']>
      strays: CliMayteWave['escalations']
    }
  >()
  for (const w of props.waves) {
    const tally = new Map<CliMayteWaveTaskState, number>()
    const keys = new Set<string>()
    for (const k of w.tasks) {
      tally.set(k.state, (tally.get(k.state) ?? 0) + 1)
      keys.add(k.key)
    }
    const escalations = new Map<string, CliMayteWave['escalations']>()
    const strays: CliMayteWave['escalations'] = []
    for (const e of w.escalations) {
      const list = escalations.get(e.key)
      if (list) list.push(e)
      else escalations.set(e.key, [e])
      if (!keys.has(e.key)) strays.push(e)
    }
    out.set(w.id, {
      counts: STATE_ORDER.map((state) => ({ state, n: tally.get(state) ?? 0 })).filter(
        (c) => c.n > 0,
      ),
      escalations,
      strays,
    })
  }
  return out
})
const counts = (w: CliMayteWave) => derived.value.get(w.id)?.counts ?? []
const managerIds = computed(() => new Set(props.workers.map((x) => x.id)))
const hasManager = (w: CliMayteWave) => managerIds.value.has(w.managerId) || props.more === true
const short = (sha: string) => sha.slice(0, 7)
const escalationsOf = (w: CliMayteWave, key: string) => derived.value.get(w.id)?.escalations.get(key) ?? []
const strays = (w: CliMayteWave) => derived.value.get(w.id)?.strays ?? []
</script>

<template>
  <section v-if="shown.length" :aria-label="$t('climayte.waves')">
    <Collapsible v-model:open="wavesOpen" class="flex flex-col gap-1.5">
      <div class="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
        <CollapsibleTrigger as-child>
          <button
            type="button"
            class="group flex items-center gap-1.5 rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              class="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90"
              aria-hidden="true"
            />
            <Network class="size-3.5" aria-hidden="true" />
            {{ $t('climayte.waves') }}
            <span class="font-normal tabular-nums">({{ shown.length }})</span>
          </button>
        </CollapsibleTrigger>
        <InfoHint :text="$t('climayte.wavesInfo')" />
      </div>
      <CollapsibleContent>
    <div class="scroll-slim max-h-80 divide-y overflow-y-auto rounded-lg border bg-card text-xs">
      <Collapsible
        v-for="w in shown"
        :key="w.id"
        :open="open[w.id] ?? false"
        @update:open="(v: boolean) => (open[w.id] = v)"
      >
        <CollapsibleTrigger as-child>
          <button
            type="button"
            class="group @container flex w-full min-w-0 flex-nowrap items-center gap-x-2 overflow-hidden whitespace-nowrap bg-muted/40 px-3 py-1.5 text-start transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            :title="$t('climayte.waveHint', { rounds: w.rounds, max: w.maxRounds })"
          >
            <ChevronRight
              class="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
              aria-hidden="true"
            />
            <span class="mono shrink-0 text-2xs font-medium">{{ w.id }}</span>
            <Badge :variant="STATUS_VARIANT[w.status]" class="shrink-0">
              <span class="text-2xs">{{ $t(`climayte.waveStatus.${w.status}`) }}</span>
            </Badge>
            <span class="hidden shrink-0 items-center gap-x-2 text-2xs tabular-nums @[19rem]:flex">
              <span v-for="c in counts(w)" :key="c.state" :class="STATE_TONE[c.state]">
                {{ c.n }} {{ $t(`climayte.waveState.${c.state}`) }}
              </span>
            </span>
            <span class="min-w-0 flex-1 truncate text-2xs text-muted-foreground" :title="w.group">{{ w.group }}</span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div class="scroll-slim flex max-h-64 flex-col gap-2 overflow-y-auto px-3 py-2">
            <p class="flex flex-wrap items-center gap-x-1.5 text-2xs text-muted-foreground">
              {{ $t('climayte.waveManager') }}
              <button
                v-if="hasManager(w)"
                type="button"
                class="mono rounded px-1 text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="emit('selectWorker', w.managerId)"
              >
                {{ w.managerId }}
              </button>
              <span v-else class="mono">{{ w.managerId }}</span>
            </p>
            <ul class="divide-y rounded-md border">
              <li v-for="k in w.tasks" :key="k.key" class="flex flex-col gap-0.5 px-2.5 py-1.5">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="mono shrink-0 text-2xs text-muted-foreground">{{ k.key }}</span>
                  <span class="min-w-0 flex-1 truncate font-medium" :title="k.title">{{ k.title }}</span>
                  <span class="shrink-0 text-2xs" :class="STATE_TONE[k.state]">{{
                    $t(`climayte.waveState.${k.state}`)
                  }}</span>
                </div>
                <div
                  v-if="k.proof"
                  class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground"
                >
                  <span class="flex items-center gap-1">
                    {{ $t('climayte.waveProofCheck') }}
                    <Check
                      v-if="k.proof.check === true"
                      class="size-3 text-success"
                      :aria-label="$t('climayte.waveProofPass')"
                    />
                    <X
                      v-else-if="k.proof.check === false"
                      class="size-3 text-destructive"
                      :aria-label="$t('climayte.waveProofFail')"
                    />
                    <Minus v-else class="size-3" :aria-label="$t('climayte.waveProofNone')" />
                  </span>
                  <span class="flex items-center gap-1">
                    {{ $t('climayte.waveProofPaths') }}
                    <Check
                      v-if="k.proof.paths === true"
                      class="size-3 text-success"
                      :aria-label="$t('climayte.waveProofOk')"
                    />
                    <X
                      v-else-if="k.proof.paths === false"
                      class="size-3 text-destructive"
                      :aria-label="$t('climayte.waveProofNotOk')"
                    />
                    <Minus v-else class="size-3" :aria-label="$t('climayte.waveProofNone')" />
                  </span>
                  <span v-if="k.proof.commits.length" class="mono">{{
                    k.proof.commits.map(short).join(' ')
                  }}</span>
                  <span v-if="k.proof.note" class="min-w-0 wrap-break-word">{{ $pii(k.proof.note) }}</span>
                </div>
                <p
                  v-for="(e, i) in escalationsOf(w, k.key)"
                  :key="i"
                  class="flex items-start gap-1 text-2xs text-warning"
                >
                  <CircleAlert class="mt-px size-3 shrink-0" aria-hidden="true" />
                  <span class="wrap-break-word">{{ $pii(e.reason) }}</span>
                </p>
              </li>
            </ul>
            <p
              v-for="(e, i) in strays(w)"
              :key="`e${i}`"
              class="flex items-start gap-1 text-2xs text-warning"
            >
              <CircleAlert class="mt-px size-3 shrink-0" aria-hidden="true" />
              <span class="wrap-break-word"><span class="mono">{{ e.key }}</span>: {{ $pii(e.reason) }}</span>
            </p>
            <Collapsible
              v-if="w.report"
              :open="reportOpen[w.id] ?? false"
              @update:open="(v: boolean) => (reportOpen[w.id] = v)"
            >
              <CollapsibleTrigger as-child>
                <button
                  type="button"
                  class="group flex items-center gap-1.5 rounded-md py-0.5 text-start text-2xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronRight
                    class="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
                    aria-hidden="true"
                  />
                  <span class="font-medium">{{ $t('climayte.waveReport') }}</span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre
                  class="mono scroll-slim mt-1 max-h-60 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted p-2.5 text-xs text-muted-foreground"
                >{{ $pii(w.report) }}</pre>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
      </CollapsibleContent>
    </Collapsible>
  </section>
</template>
