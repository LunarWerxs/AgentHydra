<script setup lang="ts">
// The selected CliMayte task (CliMayteView.vue's right-hand pane): what it is, where it ran, what it did,
// and a box to message or continue it.
//
// Three parts at their natural height: a header (title, Stop, then one row of stat chips: status,
// account, working time, tokens with the cost; the rest of the facts in a hover), a body (accounts
// tried, result, why it stopped, the event log; the long ones scroll in their own box) and a footer
// form. The panel itself does not scroll (owner, 2026-10-01: fewer, better). The
// accounts list is the point of CliMayte made visible: each account the task tried, in order, and why
// it moved on (limit, signed out, error). The box speaks to what sending actually does
// (server/src/climayte.ts climayteSend): on a live task it waits until the task finishes its current work
// (a CLI turn is the whole piece of work, not one step), and it is shown until then; on a finished,
// failed or stopped one it continues the SAME conversation as a new turn. "Stop and send now" is
// the urgent send: it stops the running work and continues the session with the message first.
// Stopping keeps the waiting messages (field note 11); they go first when the task continues.
//
// A finished task gets a thumbs up or down (a verdict), so CliMayte learns which model and thinking
// level each kind of task needs; thumbs down sends it back one rung up the ladder with the note.
import {
  Info,
  RotateCcw,
  Send,
  Square,
  ThumbsDown,
  ThumbsUp,
  Timer,
  UserRound,
  Zap,
} from '@lucide/vue'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import CliMayteJournal from '@/components/CliMayteJournal.vue'
import CliMayteStatusBadge from '@/components/CliMayteStatusBadge.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { CliMayteWorkerView } from '@/lib/api'
import { cancelCliMayte, postCliMayteVerdict, sendCliMayteWorker } from '@/lib/api'
import {
  CLIMAYTE_OUTCOME,
  climayteAccountLabel,
  climayteFailedStory,
  climayteQueuedNote,
  climayteRunLabel,
  climayteStoryLines,
  climayteVerdictMark,
  formatTokens,
  isCliMayteActive,
  modelName,
  tokenTotal,
} from '@/lib/climayte-status'
import { formatUsd } from '@/lib/kit'
import { formatAgo } from '@/lib/relativeTime'

const props = defineProps<{
  worker: (CliMayteWorkerView & { events?: string[] }) | null
  /** Every loaded task: a failed task's story looks for the one that was started again after it. */
  tasks: CliMayteWorkerView[]
  /** True while the selected task's events have not arrived yet. */
  eventsLoading: boolean
  now: number
}>()
const emit = defineEmits<{ changed: [] }>()

const { t } = useI18n()
const followUp = ref('')
const sending = ref(false)
const stopping = ref(false)
/** A verdict is being posted; the thumbs-down popover and its note. */
const judging = ref(false)
const failOpen = ref(false)
const failNote = ref('')
const eventsEl = ref<HTMLElement | null>(null)
/** Follow the log's newest line unless the reader scrolled up to read an older one. */
const stickToBottom = ref(true)

const active = computed(() => (props.worker ? isCliMayteActive(props.worker) : false))
const failed = computed(() => props.worker?.status === 'failed')
// What it asked for (model, effort) and the model the CLI reported at init.
const run = computed(() => (props.worker ? climayteRunLabel(props.worker) : null))
// Every turn's closing text, when there was more than one (field note 13: a repo's Stop hook can
// force a turn after the report, whose text would otherwise hide it).
const turnResults = computed(() => props.worker?.results ?? [])
const queuedNote = computed(() =>
  props.worker ? climayteQueuedNote(props.worker, props.now) : null,
)
/** A failed task's story, the same four lines its icon shows on hover in the list (owner,
 *  2026-10-02: what failed, what happened next, the end result). */
const failedStory = computed(() => {
  const s = props.worker ? climayteFailedStory(props.worker, props.tasks) : null
  return s ? climayteStoryLines(s, (key, values) => t(key, values)) : null
})
/** Its transcript is only on the account it last ran on, so Continue cannot move it elsewhere. */
const stuck = computed(
  () =>
    failed.value && !!props.worker?.error?.startsWith("This session's transcript was not found"),
)
const errorHeading = computed(() => {
  const status = props.worker?.status
  if (status === 'failed') return t('climayte.error')
  if (status === 'waiting') return t('climayte.whyWaiting')
  if (status === 'cancelled') return t('climayte.beforeStopped')
  return t('climayte.whyStopped')
})
const stopLabel = computed(() => {
  const n = props.worker?.pending.length ?? 0
  return n ? t('climayte.stopKeeps', { n }, n) : t('climayte.stop')
})
/** Only a finished task can be judged: done or failed (a stopped one never finished its work). */
const finished = computed(
  () => props.worker?.status === 'done' || props.worker?.status === 'failed',
)
const verdicts = computed(() => props.worker?.verdicts ?? [])
const latestVerdict = computed(() => verdicts.value[verdicts.value.length - 1] ?? null)
/** The same mark the task list shows (lib/climayte-status.ts): a failed verdict on a task still
 *  working reads as another round, never as Failed beside Running. */
const verdictMark = computed(() => {
  const m = props.worker ? climayteVerdictMark(props.worker) : null
  if (!m) return null
  const said = t(m.key, m.values)
  return { kind: m.kind, hint: m.note ? `${said}: ${m.note}` : said }
})
/** `Opus 5.5 · xhigh` for one verdict's setting; the CLI default where it asked for none. */
const verdictRun = (v: { model: string | null; effort: string | null }) =>
  `${v.model ? modelName(v.model) : t('climayte.runDefault')} · ${v.effort ?? t('climayte.runDefault')}`

/** Why a round started, in words: each one after the first was the same session sent back (server
 *  climayte-lib attemptCause), which a bare list of the same account read as a stuck task. */
function becauseText(b: {
  cause: 'check' | 'sent-back' | 'follow-up'
  detail: string | null
}): string {
  if (b.cause === 'check')
    return b.detail
      ? t('climayte.becauseCheckDetail', { detail: b.detail })
      : t('climayte.becauseCheck')
  if (b.cause === 'sent-back')
    return b.detail
      ? t('climayte.becauseSentBackDetail', { detail: b.detail })
      : t('climayte.becauseSentBack')
  return t('climayte.becauseFollowUp')
}

const copied = ref(false)
async function copyId(): Promise<void> {
  if (!props.worker) return
  try {
    await navigator.clipboard.writeText(props.worker.id)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    // No clipboard (an insecure origin): the id is on screen to read.
  }
}

function duration(totalS: number): string {
  const s = Math.floor(totalS % 60)
  const m = Math.floor(totalS / 60)
  if (m >= 60) return t('climayte.hours', { h: Math.floor(m / 60), m: m % 60 })
  return m > 0 ? t('climayte.minutes', { m, s }) : t('climayte.seconds', { s })
}

// The details popover (started, turns, model, thinking, group) opens on hover like UsageBadge's,
// with the same delays so passing over it does not strobe; a click pins it open.
const OPEN_DELAY_MS = 130
const CLOSE_DELAY_MS = 220
const moreOpen = ref(false)
const morePinned = ref(false)
let moreTimer: number | null = null

function clearMoreTimer() {
  if (moreTimer !== null) window.clearTimeout(moreTimer)
  moreTimer = null
}
onUnmounted(clearMoreTimer)

function onMoreEnter() {
  clearMoreTimer()
  if (moreOpen.value) return
  moreTimer = window.setTimeout(() => {
    moreOpen.value = true
  }, OPEN_DELAY_MS)
}

function onMoreLeave() {
  clearMoreTimer()
  if (morePinned.value) return
  moreTimer = window.setTimeout(() => {
    moreOpen.value = false
  }, CLOSE_DELAY_MS)
}

/** Click, Escape and outside-click; only a click arrives with `v` true (hover sets `moreOpen`). */
function onMoreOpenChange(v: boolean) {
  clearMoreTimer()
  moreOpen.value = v
  morePinned.value = v
}

function onEventsScroll() {
  const el = eventsEl.value
  if (el) stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

watch(
  () => props.worker?.id,
  () => {
    followUp.value = ''
    stickToBottom.value = true
    onMoreOpenChange(false)
    failOpen.value = false
    failNote.value = ''
  },
)
watch(
  () => props.worker?.events?.length,
  async () => {
    if (!stickToBottom.value) return
    await nextTick()
    const el = eventsEl.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

async function onSend(urgent = false) {
  const w = props.worker
  const text = followUp.value.trim()
  if (!w || !text || sending.value) return
  sending.value = true
  try {
    const r = await sendCliMayteWorker(w.id, text, urgent)
    if (r.ok) {
      followUp.value = ''
      toast.success(r.message)
      emit('changed')
    } else toast.error(r.message || t('climayte.sendFailed'))
  } catch {
    toast.error(t('climayte.sendFailed'))
  } finally {
    sending.value = false
  }
}

/** Thumbs up posts a pass; thumbs down (from its popover) a fail with the note, sent back one rung
 *  up the ladder. The toast names the rung it went back on, else says what the server said. */
async function onVerdict(verdict: 'pass' | 'fail') {
  const w = props.worker
  if (!w || judging.value) return
  judging.value = true
  try {
    const note = failNote.value.trim()
    const r = await postCliMayteVerdict(
      w.id,
      verdict === 'pass'
        ? { verdict, by: 'owner' }
        : { verdict, note: note || undefined, retry: true, by: 'owner' },
    )
    if (r.ok) {
      failOpen.value = false
      failNote.value = ''
      toast.success(
        r.next
          ? t('climayte.verdictSentBack', { model: modelName(r.next.model), effort: r.next.effort })
          : r.message || t('climayte.verdictSaved'),
      )
      emit('changed')
    } else toast.error(r.message || t('climayte.verdictSaveFailed'))
  } catch {
    toast.error(t('climayte.verdictSaveFailed'))
  } finally {
    judging.value = false
  }
}

async function onStop() {
  const w = props.worker
  if (!w || stopping.value) return
  stopping.value = true
  try {
    const r = await cancelCliMayte({ id: w.id })
    const kept = r.keptMessages?.[w.id] ?? 0
    toast.success(kept ? t('climayte.stoppedKept', { n: kept }, kept) : t('climayte.stopped'))
    emit('changed')
  } catch {
    toast.error(t('climayte.stopFailed'))
  } finally {
    stopping.value = false
  }
}
</script>

<template>
  <section class="flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card" :aria-label="worker?.title">
    <p v-if="!worker" class="px-4 py-12 text-center text-sm text-muted-foreground">
      {{ $t('climayte.selectHint') }}
    </p>
    <template v-else>
      <header class="flex flex-col gap-3 border-b px-4 py-3">
        <div class="flex items-start justify-between gap-3">
          <div class="flex min-w-0 flex-col items-start gap-1.5">
            <!-- Whole, never clamped (owner, 2026-10-04: "is showing a cut off version of the title?
                 Prompt? Whatever? Should show full one"); the brief itself heads the body below. -->
            <h3 class="wrap-break-word text-sm font-semibold">
              {{ worker.title }}
            </h3>
            <!-- Its id, to name it in chat (owner, 2026-10-02: "should have an ID ... so I can refer to
                 it"); a click copies it. -->
            <button
              type="button"
              class="mono rounded px-1 text-2xs text-muted-foreground transition-colors hover:bg-muted"
              :title="$t('climayte.copyId')"
              @click="copyId"
            >{{ copied ? $t('climayte.idCopied') : worker.id }}</button>
            <p v-if="queuedNote" class="text-xs text-muted-foreground">
              {{ $t(queuedNote.key, queuedNote.values ?? {}) }}
            </p>
            <ul v-if="failedStory" class="flex flex-col gap-0.5 text-xs text-muted-foreground">
              <li
                v-for="(line, i) in failedStory"
                :key="i"
                class="wrap-break-word"
                :class="i === failedStory.length - 1 ? 'font-medium text-foreground' : ''"
              >
                {{ line }}
              </li>
            </ul>
          </div>
          <Button
            v-if="active"
            variant="destructive"
            class="shrink-0"
            :disabled="stopping"
            :aria-label="`${stopLabel}: ${worker.title}`"
            @click="onStop"
          >
            <Square /> {{ stopLabel }}
          </Button>
        </div>
        <!-- The stats row: what it is doing, where, for how long, and what it has cost. Everything
             else is one hover away: the token split on the tokens, the rest behind the info button. -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div class="flex min-w-0 flex-wrap items-center gap-1.5">
            <CliMayteStatusBadge :status="worker.status" :hold="worker.hold" />
            <Badge
              v-if="verdictMark"
              :variant="
                verdictMark.kind === 'pass'
                  ? 'success'
                  : verdictMark.kind === 'retry'
                    ? 'warning'
                    : 'destructive'
              "
              :title="verdictMark.hint"
            >
              <ThumbsUp v-if="verdictMark.kind === 'pass'" aria-hidden="true" />
              <RotateCcw v-else-if="verdictMark.kind === 'retry'" aria-hidden="true" />
              <ThumbsDown v-else aria-hidden="true" />
              <span class="text-2xs">
                {{
                  verdictMark.kind === 'pass'
                    ? $t('climayte.verdictPassed')
                    : verdictMark.kind === 'retry'
                      ? $t('climayte.verdictRetryShort')
                      : $t('climayte.verdictFailed')
                }}
              </span>
            </Badge>
            <Badge
              variant="outline"
              class="max-w-56"
              :title="`${$t('climayte.detailAccount')}: ${worker.account ? $pii(worker.account) : $t('climayte.noAccount')}`"
            >
              <UserRound aria-hidden="true" />
              <span class="truncate text-2xs">{{ worker.account ? $pii(worker.account) : $t('climayte.noAccount') }}</span>
            </Badge>
            <Badge variant="muted" :title="$t('climayte.detailRan')">
              <Timer aria-hidden="true" />
              <span class="text-2xs tabular-nums">{{ duration(worker.ranS) }}</span>
            </Badge>
            <Badge v-if="worker.kind" variant="muted" :title="$t('climayte.detailKind')">
              <span class="text-2xs">{{ worker.kind }}</span>
            </Badge>
          </div>
          <div class="ms-auto flex items-center gap-1">
            <template v-if="finished">
              <Button
                variant="ghost"
                size="icon-sm"
                :disabled="judging"
                :aria-label="$t('climayte.verdictUp')"
                :title="$t('climayte.verdictUp')"
                @click="onVerdict('pass')"
              >
                <ThumbsUp :class="latestVerdict?.verdict === 'pass' ? 'text-success' : 'text-muted-foreground'" />
              </Button>
              <Popover v-model:open="failOpen">
                <PopoverTrigger as-child>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    :disabled="judging"
                    :aria-label="$t('climayte.verdictDown')"
                    :title="$t('climayte.verdictDown')"
                  >
                    <ThumbsDown
                      :class="latestVerdict?.verdict === 'fail' ? 'text-destructive' : 'text-muted-foreground'"
                    />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" class="w-72">
                  <form class="flex flex-col gap-2" @submit.prevent="onVerdict('fail')">
                    <label for="climayte-verdict-note" class="text-xs font-medium">
                      {{ $t('climayte.verdictWhatWrong') }}
                    </label>
                    <Textarea
                      id="climayte-verdict-note"
                      v-model="failNote"
                      rows="1"
                      class="min-h-9 resize-y"
                      :disabled="judging"
                      @keydown.enter.exact.prevent="onVerdict('fail')"
                    />
                    <Button type="submit" size="sm" class="self-end" :disabled="judging">
                      <RotateCcw /> {{ $t('climayte.verdictSendBack') }}
                    </Button>
                  </form>
                </PopoverContent>
              </Popover>
            </template>
            <Tooltip>
              <TooltipTrigger as-child>
                <button
                  type="button"
                  class="flex items-baseline gap-1.5 rounded-md px-1.5 py-0.5 tabular-nums transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <template v-if="worker.tokens">
                    <span class="text-base font-semibold leading-none">{{ formatTokens(tokenTotal(worker.tokens)) }}</span>
                    <span class="text-xs text-muted-foreground">{{ $t('climayte.offloadedTokens') }}</span>
                    <span aria-hidden="true" class="text-xs text-muted-foreground">·</span>
                    <span class="text-xs text-muted-foreground">{{ formatUsd(worker.costUsd) }}</span>
                  </template>
                  <span v-else class="text-base font-semibold leading-none">{{ formatUsd(worker.costUsd) }}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end">
                <div class="flex flex-col items-start gap-0.5">
                  <span v-if="worker.tokens">
                    {{
                      $t('climayte.tokensBreakdown', {
                        input: formatTokens(worker.tokens.input),
                        output: formatTokens(worker.tokens.output),
                        cacheRead: formatTokens(worker.tokens.cacheRead),
                        cacheWrite: formatTokens(worker.tokens.cacheWrite),
                      })
                    }}
                  </span>
                  <span>{{ $t('climayte.detailCost') }} {{ formatUsd(worker.costUsd) }}: {{ $t('climayte.detailCostHint') }}</span>
                </div>
              </TooltipContent>
            </Tooltip>
            <Popover :open="moreOpen" @update:open="onMoreOpenChange">
              <PopoverTrigger as-child>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  :aria-label="$t('climayte.detailMore')"
                  @mouseenter="onMoreEnter"
                  @mouseleave="onMoreLeave"
                >
                  <Info :class="run?.differs ? 'text-warning' : 'text-muted-foreground'" />
                </Button>
              </PopoverTrigger>
              <!-- Opens on hover, so it must not take the caret (same as UsageBadge's popover). -->
              <PopoverContent
                align="end"
                class="w-80"
                :trap-focus="false"
                @open-auto-focus.prevent
                @mouseenter="onMoreEnter"
                @mouseleave="onMoreLeave"
              >
                <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
                  <dt class="text-muted-foreground">{{ $t('climayte.detailStarted') }}</dt>
                  <dd>
                    <time
                      :datetime="new Date(worker.createdAt).toISOString()"
                      :title="new Date(worker.createdAt).toLocaleString()"
                    >{{ formatAgo(now, worker.createdAt) }}</time>
                  </dd>
                  <dt class="text-muted-foreground">{{ $t('climayte.detailTurns') }}</dt>
                  <dd class="tabular-nums">{{ worker.turns }}</dd>
                  <dt class="text-muted-foreground">{{ $t('climayte.detailModel') }}</dt>
                  <dd
                    :class="run?.differs ? 'text-warning' : ''"
                    :title="[worker.model, worker.reportedModel].filter(Boolean).join(' / ')"
                  >
                    {{
                      run?.differs
                        ? $t('climayte.modelAskedRan', { asked: run.model, ran: run.ran })
                        : (run?.ran ?? run?.model ?? $t('climayte.runDefault'))
                    }}
                  </dd>
                  <dt class="text-muted-foreground">{{ $t('climayte.detailEffort') }}</dt>
                  <dd>
                    {{ worker.effort ?? $t('climayte.runDefault') }}
                    <span v-if="worker.auto" class="text-muted-foreground">({{ $t('climayte.pickedByCliMayte') }})</span>
                  </dd>
                  <dt class="text-muted-foreground">{{ $t('climayte.detailGroup') }}</dt>
                  <dd class="mono break-all">{{ worker.group }}</dd>
                </dl>
                <div v-if="verdicts.length" class="mt-3 flex flex-col gap-1.5 border-t pt-2">
                  <h4 class="text-xs font-medium">{{ $t('climayte.verdicts') }}</h4>
                  <ol class="flex flex-col gap-1.5 text-xs">
                    <li v-for="(v, i) in [...verdicts].reverse()" :key="i" class="flex flex-col gap-0.5">
                      <span class="flex flex-wrap items-center gap-x-1.5">
                        <ThumbsUp v-if="v.verdict === 'pass'" class="size-3 text-success" aria-hidden="true" />
                        <ThumbsDown v-else class="size-3 text-destructive" aria-hidden="true" />
                        <span :class="v.verdict === 'pass' ? 'text-success' : 'text-destructive'">
                          {{ v.verdict === 'pass' ? $t('climayte.verdictPassed') : $t('climayte.verdictFailed') }}
                        </span>
                        <time
                          class="text-muted-foreground"
                          :datetime="new Date(v.at).toISOString()"
                          :title="new Date(v.at).toLocaleString()"
                        >{{ formatAgo(now, v.at) }}</time>
                        <span aria-hidden="true" class="text-muted-foreground">·</span>
                        <span>{{ verdictRun(v) }}</span>
                        <template v-if="v.pct !== null">
                          <span aria-hidden="true" class="text-muted-foreground">·</span>
                          <span class="tabular-nums text-muted-foreground">
                            {{ $t('climayte.verdictPct', { pct: v.pct.toFixed(1) }) }}
                          </span>
                        </template>
                      </span>
                      <span v-if="v.note" class="whitespace-pre-wrap wrap-break-word text-muted-foreground">{{ $pii(v.note) }}</span>
                    </li>
                  </ol>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </header>

      <!-- Wide screens: the panel fills the height beside the list, the result, event log and
           journal share what is left, each scrolling in its own box. Only a window too short for
           their minimums scrolls this body. -->
      <div class="flex flex-col gap-4 px-4 py-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        <!-- The whole brief it was sent: a title is often only the brief's first words. The detail
             asks for it in full (lib/api.ts getCliMayteWorker); the list's rows carry 300 characters. -->
        <div v-if="worker.prompt" class="flex flex-col gap-1.5">
          <h4 class="text-xs font-medium">{{ $t('climayte.prompt') }}</h4>
          <p class="scroll-slim max-h-56 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted p-2.5 text-xs">{{ $pii(worker.prompt) }}</p>
        </div>

        <div v-if="worker.attempts.length" class="flex flex-col gap-1.5">
          <h4 class="flex items-baseline justify-between gap-2 text-xs font-medium">
            {{ $t('climayte.attempts') }}
            <span class="font-normal text-muted-foreground">{{ $t('climayte.switchedAccount', worker.moves) }}</span>
          </h4>
          <ol class="flex flex-col gap-1 text-xs">
            <li v-for="(a, i) in worker.attempts" :key="i" class="flex min-w-0 items-center gap-2">
              <span class="w-4 shrink-0 text-end tabular-nums text-muted-foreground">{{ i + 1 }}.</span>
              <span class="max-w-56 shrink-0 truncate font-medium" :title="climayteAccountLabel(a.account)">
                {{ climayteAccountLabel(a.account) }}
              </span>
              <Badge :variant="CLIMAYTE_OUTCOME[a.ceiling ? 'ceiling' : a.outcome].variant" class="shrink-0">
                {{ $t(CLIMAYTE_OUTCOME[a.ceiling ? 'ceiling' : a.outcome].label) }}
              </Badge>
              <span v-if="a.notice" class="min-w-0 truncate text-muted-foreground" :title="a.notice">
                {{ a.notice }}
              </span>
              <span
                v-else-if="a.because"
                class="min-w-0 truncate text-muted-foreground"
                :title="becauseText(a.because)"
              >{{ becauseText(a.because) }}</span>
              <span
                v-if="a.left?.length"
                class="min-w-0 truncate text-warning"
                :title="a.left.join('\n')"
              >{{ $t('climayte.attemptLeft', { list: a.left.join('; ') }) }}</span>
            </li>
          </ol>
        </div>

        <div v-if="worker.pending.length" class="flex flex-col gap-1.5">
          <h4 class="text-xs font-medium">{{ $t('climayte.pending', { n: worker.pending.length }) }}</h4>
          <ol class="flex flex-col gap-1 text-xs">
            <li
              v-for="(m, i) in worker.pending"
              :key="i"
              class="whitespace-pre-wrap wrap-break-word rounded-md bg-muted p-2"
            >{{ $pii(m) }}</li>
          </ol>
        </div>

        <!-- Earlier messages' reports: a follow-up delivered the moment a turn ended used to wipe
             the report before anyone read it. Folded, newest last, the current report below. -->
        <details
          v-for="(r, i) in worker.reports ?? []"
          :key="`report-${i}`"
          class="rounded-md bg-muted/60 px-2.5 py-1.5 text-xs"
        >
          <summary class="cursor-pointer truncate text-muted-foreground">
            {{ $t('climayte.earlierReport', { message: r.message }) }}
          </summary>
          <pre class="mono scroll-slim mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap wrap-break-word">{{ $pii(r.results.join('\n\n')) }}</pre>
        </details>

        <!-- A worker's question (climayte_ask): its turn ended waiting for an answer, which goes
             back with climayte_send. -->
        <div v-if="worker.question" class="flex flex-col gap-1.5">
          <h4 class="text-xs font-medium text-warning">{{ $t('climayte.question') }}</h4>
          <div class="flex flex-col gap-1 rounded-md bg-muted p-2.5 text-xs">
            <p class="wrap-break-word whitespace-pre-wrap">{{ $pii(worker.question.text) }}</p>
            <ul v-if="worker.question.options?.length" class="list-disc pl-4">
              <li v-for="(o, i) in worker.question.options" :key="i">{{ $pii(o) }}</li>
            </ul>
            <p v-if="worker.question.context" class="wrap-break-word text-muted-foreground">
              {{ $pii(worker.question.context) }}
            </p>
            <p class="text-2xs text-muted-foreground">{{ $t('climayte.questionHint') }}</p>
          </div>
        </div>

        <div v-if="worker.result" class="flex flex-col gap-1.5 lg:min-h-20 lg:flex-2">
          <h4 class="text-xs font-medium">{{ $t('climayte.result') }}</h4>
          <!-- One bounded box for the whole report, every turn in it, so the panel never grows a
               scroll of its own and no box scrolls inside another. -->
          <div
            v-if="turnResults.length > 1"
            class="scroll-slim flex max-h-96 flex-col gap-3 overflow-auto rounded-md bg-muted p-2.5 lg:max-h-none lg:min-h-0 lg:flex-1"
          >
            <div v-for="(text, i) in turnResults" :key="i" class="flex flex-col gap-1">
              <span class="text-2xs text-muted-foreground">
                {{ $t('climayte.resultTurn', { n: i + 1, total: turnResults.length }) }}
              </span>
              <pre class="mono whitespace-pre-wrap wrap-break-word text-xs">{{ $pii(text) }}</pre>
            </div>
          </div>
          <pre v-else class="mono scroll-slim max-h-96 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted p-2.5 text-xs lg:max-h-none lg:min-h-0 lg:flex-1">{{ $pii(worker.result) }}</pre>
        </div>

        <!-- A stopped or waiting task keeps the reason it could not go on in `error`. Only a real
             failure is red; "no account was free" on a task you stopped is information. -->
        <div v-if="worker.error" class="flex flex-col gap-1.5">
          <h4 class="text-xs font-medium" :class="failed ? 'text-destructive' : ''">
            {{ errorHeading }}
          </h4>
          <pre
            class="mono scroll-slim max-h-40 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md p-2.5 text-xs"
            :class="failed ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'"
          >{{ $pii(worker.error) }}</pre>
        </div>

        <div class="flex flex-col gap-1.5 lg:min-h-20 lg:flex-1">
          <h4 class="text-xs font-medium">{{ $t('climayte.events') }}</h4>
          <ul
            v-if="worker.events?.length"
            ref="eventsEl"
            class="mono scroll-slim max-h-72 overflow-auto rounded-md bg-muted p-2.5 text-xs lg:max-h-none lg:min-h-0 lg:flex-1"
            @scroll.passive="onEventsScroll"
          >
            <li v-for="(e, i) in worker.events" :key="i" class="whitespace-pre-wrap wrap-break-word">{{ $pii(e) }}</li>
          </ul>
          <p v-else class="text-xs text-muted-foreground">
            {{ eventsLoading ? $t('climayte.loadingEvents') : $t('climayte.noEvents') }}
          </p>
        </div>

        <CliMayteJournal
          class="lg:min-h-20 lg:flex-1"
          fill
          :worker-id="worker.id"
          :group="worker.group"
          :updated-at="worker.updatedAt"
        />
      </div>

      <form class="flex flex-col gap-1.5 border-t px-4 py-3" @submit.prevent="onSend()">
        <label for="climayte-follow-up" class="text-xs font-medium">
          {{ active ? $t('climayte.messageLabel') : $t('climayte.continueLabel') }}
        </label>
        <Textarea
          id="climayte-follow-up"
          v-model="followUp"
          rows="2"
          class="min-h-14 resize-y"
          :placeholder="$t('climayte.messagePlaceholder')"
          :disabled="sending"
          @keydown.ctrl.enter.prevent="onSend()"
          @keydown.meta.enter.prevent="onSend()"
        />
        <div class="flex items-center justify-between gap-3">
          <!-- No standing explainer under the box (owner, 2026-10-04); Stop and send now says the rest on hover. -->
          <span class="text-2xs text-muted-foreground">
            <template v-if="!active && stuck">{{ $t('climayte.continueHintStuck') }}</template>
            <span class="hidden sm:inline">
              <template v-if="!active && stuck"> · </template>{{ $t('climayte.sendShortcut') }}
            </span>
          </span>
          <div class="flex shrink-0 items-center gap-1.5">
            <Button
              v-if="worker.status === 'running'"
              type="button"
              variant="outline"
              class="shrink-0"
              :disabled="sending || !followUp.trim()"
              :title="$t('climayte.sendNowHint')"
              @click="onSend(true)"
            >
              <Zap /> {{ $t('climayte.sendNow') }}
            </Button>
            <Button type="submit" class="shrink-0" :disabled="sending || !followUp.trim()">
              <Send v-if="active" />
              <RotateCcw v-else />
              {{ active ? $t('climayte.send') : $t('climayte.continue') }}
            </Button>
          </div>
        </div>
      </form>
    </template>
  </section>
</template>
