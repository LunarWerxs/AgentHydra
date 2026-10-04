<script setup lang="ts">
// One work row: a run of tool calls, tool results and reasoning between two messages, folded into
// a single quiet line ("Read 3 files, ran 2 commands") that opens into its steps, and each step
// into its input and output. The way the Claude desktop app shows a turn's work, so the transcript
// reads as the conversation it was, with the work one click away rather than spread across it.
// The grouping and the counts are lib/transcript-groups.ts; this file only turns them into words.
import {
  Bot,
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  FilePen,
  FileText,
  Globe,
  ListTodo,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
} from '@lucide/vue'
import { useNow } from '@vueuse/core'
import type { Component } from 'vue'
import { computed, defineAsyncComponent, inject, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { OPEN_TRANSCRIPT } from '@/composables/openTranscript'
import type { TranscriptTurn } from '@/composables/useTranscriptDisplay'
import {
  formatElapsed,
  mcpParts,
  summarizeWork,
  type ToolCategory,
  type WorkGroup,
  type WorkStep,
} from '@/lib/transcript-groups'
import ExpandTransition from '@/shell/ExpandTransition.vue'

const props = defineProps<{
  group: WorkGroup<TranscriptTurn>
  open: boolean
  /** The newest row of a session still at work: shimmers, names the step in hand, ticks a timer. */
  live: boolean
  isStepOpen: (step: WorkStep<TranscriptTurn>) => boolean
  copiedIdx: number | null
  /** Drawn inside a subagent's run: carries no data-turn marks, which belong to the open
   *  session's own turns (the find bar and the search landing look them up). */
  nested?: boolean
}>()

const emit = defineEmits<{
  toggle: []
  toggleStep: [key: string]
  copy: [i: number, text: string]
}>()

const { t, locale } = useI18n()

// Loaded on first use, and it renders turns that may hold work rows of their own (this component),
// so the import is lazy rather than a cycle at module load.
const SubagentTranscript = defineAsyncComponent(() => import('@/components/SubagentTranscript.vue'))
const openTranscript = inject(OPEN_TRANSCRIPT, null)

/** The call id whose subagent run an Agent step can open into. Claude keeps those runs; the other
 *  tools' agents leave nothing to open. */
function agentRunOf(step: WorkStep<TranscriptTurn>): string | null {
  if (step.category !== 'agent' || openTranscript?.value?.source !== 'claude') return null
  return step.call?.tool_use_id ?? null
}

const ICONS: Record<ToolCategory, Component> = {
  read: FileText,
  edit: FilePen,
  command: SquareTerminal,
  search: Search,
  web: Globe,
  agent: Bot,
  plan: ListTodo,
  mcp: Plug,
  other: Wrench,
}

// Literal keys, so the build's i18n check can see every one of them resolve.
const PART_KEYS: Record<ToolCategory, string> = {
  read: 'sessions.work.read',
  edit: 'sessions.work.edit',
  command: 'sessions.work.command',
  search: 'sessions.work.search',
  web: 'sessions.work.web',
  agent: 'sessions.work.agent',
  plan: 'sessions.work.plan',
  mcp: 'sessions.work.mcp',
  other: 'sessions.work.other',
}

const summary = computed(() => summarizeWork(props.group.steps))

const headerIcon = computed<Component>(() =>
  props.group.thinkingOnly ? Brain : ICONS[summary.value.parts[0]?.category ?? 'other'],
)

function stepIcon(step: WorkStep<TranscriptTurn>): Component {
  return step.kind === 'thinking' ? Brain : ICONS[step.category ?? 'other']
}

/** What a step is called: the tool, with an MCP tool shown as "server · tool". */
function stepName(step: WorkStep<TranscriptTurn>): string {
  if (step.kind === 'thinking') return t('sessions.work.thought')
  if (!step.tool) return t('sessions.work.toolResult')
  if (step.category === 'mcp') {
    const { server, tool } = mcpParts(step.tool)
    return tool ? `${server} · ${tool}` : server
  }
  return step.tool
}

const lowerFirst = (s: string) => (s ? s.charAt(0).toLocaleLowerCase(locale.value) + s.slice(1) : s)

const names = (list: string[]) =>
  new Intl.ListFormat(locale.value, { style: 'long', type: 'conjunction' }).format(list)

// Only the live row keeps a clock running, so a second's tick re-renders one row instead of every
// row in the transcript; a finished row's time is fixed by its own timestamps.
const clock = useNow({ interval: 1000, controls: true })
watch(
  () => props.live,
  (live) => (live ? clock.resume() : clock.pause()),
  { immediate: true },
)

const elapsed = computed(() => {
  const g = props.group
  if (g.startedAt === null) return null
  const end = props.live ? clock.now.value.getTime() : g.endedAt
  return end === null ? null : formatElapsed(end - g.startedAt)
})

const label = computed(() => {
  const g = props.group
  if (props.live) {
    const last = g.steps.at(-1)
    return last ? `${t('sessions.work.working')} · ${stepName(last)}` : t('sessions.work.working')
  }
  if (g.thinkingOnly)
    return elapsed.value
      ? t('sessions.work.thoughtFor', { time: elapsed.value })
      : t('sessions.work.thought')
  const s = summary.value
  const parts = s.parts.map((p) =>
    p.category === 'mcp'
      ? t(PART_KEYS.mcp, { names: names(p.names) })
      : t(PART_KEYS[p.category], { n: p.count }, p.count),
  )
  let text = parts.map((p, i) => (i ? lowerFirst(p) : p)).join(', ')
  if (s.more) text += ` ${t('sessions.work.more', { n: s.more })}`
  return text
})

/** The live row names the step in hand after its label; a finished thinking row already says how
 *  long it took in its label, so it carries no trailing time. */
const trailing = computed(() => {
  if (props.live) return props.group.steps.at(-1)?.preview ?? ''
  return ''
})
const showElapsed = computed(() => !!elapsed.value && (props.live || !props.group.thinkingOnly))
</script>

<template>
  <div class="min-w-0" :data-turns="nested ? undefined : group.indices.join(' ')">
    <button
      type="button"
      class="group/work flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-start text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      :aria-expanded="open"
      :title="open ? $t('sessions.work.hideSteps') : $t('sessions.work.showSteps')"
      @click="emit('toggle')"
    >
      <component
        :is="headerIcon"
        class="size-3.5 shrink-0"
        :class="group.failed && !live ? 'text-destructive' : ''"
      />
      <span class="min-w-0 truncate" :class="live && 'work-shimmer'">{{ label }}</span>
      <span v-if="trailing" class="min-w-0 truncate font-mono text-2xs opacity-70">{{ trailing }}</span>
      <ChevronRight
        class="size-3 shrink-0 opacity-60 transition-transform duration-200 group-hover/work:opacity-100"
        :class="open && 'rotate-90'"
      />
      <span v-if="showElapsed" class="ms-auto shrink-0 ps-2 text-2xs tabular-nums opacity-70">
        {{ elapsed }}
      </span>
    </button>

    <ExpandTransition :open="open">
      <ol class="ms-[0.4375rem] mt-1 mb-0.5 space-y-0.5 border-s border-border/70 ps-3">
        <li
          v-for="step in group.steps"
          :key="step.key"
          :data-turn="nested ? undefined : step.index"
          class="group/step min-w-0"
        >
          <button
            type="button"
            class="flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-start text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            :aria-expanded="isStepOpen(step)"
            @click="emit('toggleStep', step.key)"
          >
            <component
              :is="stepIcon(step)"
              class="size-3.5 shrink-0"
              :class="step.failed ? 'text-destructive' : ''"
            />
            <span
              class="shrink-0 font-medium"
              :class="step.kind === 'thinking' ? 'italic' : 'text-foreground/80'"
            >
              {{ stepName(step) }}
            </span>
            <span
              v-if="step.preview"
              class="min-w-0 truncate"
              :class="step.kind === 'thinking' ? 'italic opacity-80' : 'font-mono text-2xs'"
            >
              {{ step.preview }}
            </span>
            <CircleAlert
              v-if="step.failed"
              class="size-3 shrink-0 text-destructive"
              :aria-label="$t('sessions.work.failed')"
            />
          </button>

          <ExpandTransition :open="isStepOpen(step)">
            <!-- reasoning: the model's own prose, so it reads as prose -->
            <div
              v-if="step.kind === 'thinking' && step.call"
              class="relative mt-0.5 mb-1.5 ms-5 rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground italic"
            >
              <!-- the text is HTML-escaped before anything reads it (lib/markdown.ts), and
                   lib/find.ts only ever adds <mark> around already-escaped slices, so no tag
                   here came from the transcript -->
              <!-- eslint-disable-next-line vue/no-v-html -- see the note above -->
              <div
                class="scroll-slim max-h-80 overflow-y-auto wrap-break-word"
                :class="step.call.pre ? 'whitespace-pre-wrap' : 'md'"
                v-html="step.call.html"
              ></div>
            </div>

            <!-- a tool call: what went in, what came out -->
            <div v-else class="mt-0.5 mb-1.5 ms-5 space-y-1.5">
              <section
                v-if="step.call && step.call.text"
                class="relative rounded-md border border-border/60 bg-muted/30"
              >
                <header
                  class="flex items-center px-2.5 pt-1 text-2xs font-semibold tracking-wide text-muted-foreground uppercase"
                >
                  {{ $t('sessions.work.input') }}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    class="ms-auto opacity-0 transition-opacity group-hover/step:opacity-100 has-focus-visible:opacity-100 pointer-coarse:opacity-60"
                    :title="$t('sessions.copyMessage')"
                    @click="emit('copy', step.index, step.call?.text ?? '')"
                  >
                    <Check v-if="copiedIdx === step.index" class="text-success" />
                    <Copy v-else />
                  </Button>
                </header>
                <!-- eslint-disable-next-line vue/no-v-html -- escaped, see the note above -->
                <pre
                  class="scroll-slim max-h-56 overflow-auto px-2.5 pb-2 font-mono text-2xs whitespace-pre-wrap wrap-break-word"
                  v-html="step.call.html"
                ></pre>
              </section>
              <!-- an Agent call: the run it started, nested here the way the desktop app shows it -->
              <section
                v-if="agentRunOf(step)"
                class="rounded-md border border-border/60 bg-background/40"
              >
                <header
                  class="px-2.5 pt-1 text-2xs font-semibold tracking-wide text-muted-foreground uppercase"
                >
                  {{ $t('sessions.work.agentRun') }}
                </header>
                <div class="px-2.5 pt-1 pb-2">
                  <SubagentTranscript :tool-use-id="agentRunOf(step) ?? ''" :live="live" />
                </div>
              </section>
              <section
                class="relative rounded-md border bg-muted/30"
                :class="step.failed ? 'border-destructive/40' : 'border-border/60'"
              >
                <header
                  class="flex items-center px-2.5 pt-1 text-2xs font-semibold tracking-wide uppercase"
                  :class="step.failed ? 'text-destructive' : 'text-muted-foreground'"
                >
                  {{ $t('sessions.work.output') }}
                  <Button
                    v-if="step.result && step.resultIndex !== null"
                    variant="ghost"
                    size="icon-xs"
                    class="ms-auto opacity-0 transition-opacity group-hover/step:opacity-100 has-focus-visible:opacity-100 pointer-coarse:opacity-60"
                    :title="$t('sessions.copyMessage')"
                    @click="emit('copy', step.resultIndex ?? step.index, step.result?.text ?? '')"
                  >
                    <Check v-if="copiedIdx === step.resultIndex" class="text-success" />
                    <Copy v-else />
                  </Button>
                </header>
                <!-- eslint-disable-next-line vue/no-v-html -- escaped, see the note above -->
                <pre
                  v-if="step.result"
                  :data-turn="nested ? undefined : (step.resultIndex ?? undefined)"
                  class="scroll-slim max-h-72 overflow-auto px-2.5 pb-2 font-mono text-2xs whitespace-pre-wrap wrap-break-word"
                  v-html="step.result.html"
                ></pre>
                <p v-else class="px-2.5 pb-2 text-2xs text-muted-foreground italic">
                  {{ $t('sessions.work.noOutput') }}
                </p>
              </section>
            </div>
          </ExpandTransition>
        </li>
      </ol>
    </ExpandTransition>
  </div>
</template>
