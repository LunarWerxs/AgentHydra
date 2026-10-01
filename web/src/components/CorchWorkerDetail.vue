<script setup lang="ts">
// The selected Corch task (CorchView.vue's right-hand pane): what it is, where it ran, what it did,
// and a box to message or continue it.
//
// Three parts at their natural height: a header (title, Stop, then one row of stat chips: status,
// account, working time, tokens with the cost; the rest of the facts in a hover), a body (accounts
// tried, result, why it stopped, the event log; the long ones scroll in their own box) and a footer
// form. The panel itself does not scroll (owner, 2026-10-01: fewer, better). The
// accounts list is the point of Corch made visible: each account the task tried, in order, and why
// it moved on (limit, signed out, error). The box speaks to what sending actually does
// (server/src/corch.ts corchSend): on a live task it waits until the task finishes its current work
// (a CLI turn is the whole piece of work, not one step), and it is shown until then; on a finished,
// failed or stopped one it continues the SAME conversation as a new turn. "Stop and send now" is
// the urgent send: it stops the running work and continues the session with the message first.
// Stopping keeps the waiting messages (field note 11); they go first when the task continues.
import { Info, RotateCcw, Send, Square, Timer, UserRound, Zap } from '@lucide/vue'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import CorchJournal from '@/components/CorchJournal.vue'
import CorchStatusBadge from '@/components/CorchStatusBadge.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { CorchWorkerView } from '@/lib/api'
import { cancelCorch, sendCorchWorker } from '@/lib/api'
import {
  CORCH_OUTCOME,
  corchAccountLabel,
  corchQueuedNote,
  corchRunLabel,
  formatTokens,
  isCorchActive,
  tokenTotal,
} from '@/lib/corch-status'
import { formatAgo } from '@/lib/relativeTime'

const props = defineProps<{
  worker: (CorchWorkerView & { events?: string[] }) | null
  /** True while the selected task's events have not arrived yet. */
  eventsLoading: boolean
  now: number
}>()
const emit = defineEmits<{ changed: [] }>()

const { t } = useI18n()
const followUp = ref('')
const sending = ref(false)
const stopping = ref(false)
const eventsEl = ref<HTMLElement | null>(null)
/** Follow the log's newest line unless the reader scrolled up to read an older one. */
const stickToBottom = ref(true)

const active = computed(() => (props.worker ? isCorchActive(props.worker) : false))
const failed = computed(() => props.worker?.status === 'failed')
// What it asked for (model, effort) and the model the CLI reported at init.
const run = computed(() => (props.worker ? corchRunLabel(props.worker) : null))
// Every turn's closing text, when there was more than one (field note 13: a repo's Stop hook can
// force a turn after the report, whose text would otherwise hide it).
const turnResults = computed(() => props.worker?.results ?? [])
const queuedNote = computed(() => (props.worker ? corchQueuedNote(props.worker, props.now) : null))
/** Its transcript is only on the account it last ran on, so Continue cannot move it elsewhere. */
const stuck = computed(
  () =>
    failed.value && !!props.worker?.error?.startsWith("This session's transcript was not found"),
)
const errorHeading = computed(() => {
  const status = props.worker?.status
  if (status === 'failed') return t('corch.error')
  if (status === 'waiting') return t('corch.whyWaiting')
  if (status === 'cancelled') return t('corch.beforeStopped')
  return t('corch.whyStopped')
})
const stopLabel = computed(() => {
  const n = props.worker?.pending.length ?? 0
  return n ? t('corch.stopKeeps', { n }, n) : t('corch.stop')
})

function duration(totalS: number): string {
  const s = Math.floor(totalS % 60)
  const m = Math.floor(totalS / 60)
  if (m >= 60) return t('corch.hours', { h: Math.floor(m / 60), m: m % 60 })
  return m > 0 ? t('corch.minutes', { m, s }) : t('corch.seconds', { s })
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
    const r = await sendCorchWorker(w.id, text, urgent)
    if (r.ok) {
      followUp.value = ''
      toast.success(r.message)
      emit('changed')
    } else toast.error(r.message || t('corch.sendFailed'))
  } catch {
    toast.error(t('corch.sendFailed'))
  } finally {
    sending.value = false
  }
}

async function onStop() {
  const w = props.worker
  if (!w || stopping.value) return
  stopping.value = true
  try {
    const r = await cancelCorch({ id: w.id })
    const kept = r.keptMessages?.[w.id] ?? 0
    toast.success(kept ? t('corch.stoppedKept', { n: kept }, kept) : t('corch.stopped'))
    emit('changed')
  } catch {
    toast.error(t('corch.stopFailed'))
  } finally {
    stopping.value = false
  }
}
</script>

<template>
  <section class="flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card" :aria-label="worker?.title">
    <p v-if="!worker" class="px-4 py-12 text-center text-sm text-muted-foreground">
      {{ $t('corch.selectHint') }}
    </p>
    <template v-else>
      <header class="flex flex-col gap-3 border-b px-4 py-3">
        <div class="flex items-start justify-between gap-3">
          <div class="flex min-w-0 flex-col items-start gap-1.5">
            <h3 class="line-clamp-2 break-words text-sm font-semibold" :title="worker.title">
              {{ worker.title }}
            </h3>
            <p v-if="queuedNote" class="text-xs text-muted-foreground">
              {{ $t(queuedNote.key, queuedNote.values ?? {}) }}
            </p>
          </div>
          <Button
            v-if="active"
            variant="outline"
            class="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
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
            <CorchStatusBadge :status="worker.status" />
            <Badge
              variant="outline"
              class="h-5 max-w-[14rem] text-2xs"
              :title="`${$t('corch.detailAccount')}: ${worker.account ?? $t('corch.noAccount')}`"
            >
              <UserRound aria-hidden="true" />
              <span class="truncate">{{ worker.account ?? $t('corch.noAccount') }}</span>
            </Badge>
            <Badge variant="muted" class="h-5 text-2xs tabular-nums" :title="$t('corch.detailRan')">
              <Timer aria-hidden="true" />
              {{ duration(worker.ranS) }}
            </Badge>
          </div>
          <div class="ms-auto flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger as-child>
                <button
                  type="button"
                  class="flex items-baseline gap-1.5 rounded-md px-1.5 py-0.5 tabular-nums transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <template v-if="worker.tokens">
                    <span class="text-base font-semibold leading-none">{{ formatTokens(tokenTotal(worker.tokens)) }}</span>
                    <span class="text-xs text-muted-foreground">{{ $t('corch.offloadedTokens') }}</span>
                    <span aria-hidden="true" class="text-xs text-muted-foreground">·</span>
                    <span class="text-xs text-muted-foreground">${{ worker.costUsd.toFixed(2) }}</span>
                  </template>
                  <span v-else class="text-base font-semibold leading-none">${{ worker.costUsd.toFixed(2) }}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end" class="flex-col items-start gap-0.5">
                <span v-if="worker.tokens">
                  {{
                    $t('corch.tokensBreakdown', {
                      input: formatTokens(worker.tokens.input),
                      output: formatTokens(worker.tokens.output),
                      cacheRead: formatTokens(worker.tokens.cacheRead),
                      cacheWrite: formatTokens(worker.tokens.cacheWrite),
                    })
                  }}
                </span>
                <span>{{ $t('corch.detailCost') }} ${{ worker.costUsd.toFixed(2) }}: {{ $t('corch.detailCostHint') }}</span>
              </TooltipContent>
            </Tooltip>
            <Popover :open="moreOpen" @update:open="onMoreOpenChange">
              <PopoverTrigger as-child>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  :class="run?.differs ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'"
                  :aria-label="$t('corch.detailMore')"
                  @mouseenter="onMoreEnter"
                  @mouseleave="onMoreLeave"
                >
                  <Info />
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
                  <dt class="text-muted-foreground">{{ $t('corch.detailStarted') }}</dt>
                  <dd>
                    <time
                      :datetime="new Date(worker.createdAt).toISOString()"
                      :title="new Date(worker.createdAt).toLocaleString()"
                    >{{ formatAgo(now, worker.createdAt) }}</time>
                  </dd>
                  <dt class="text-muted-foreground">{{ $t('corch.detailTurns') }}</dt>
                  <dd class="tabular-nums">{{ worker.turns }}</dd>
                  <dt class="text-muted-foreground">{{ $t('corch.detailModel') }}</dt>
                  <dd
                    :class="run?.differs ? 'text-amber-600 dark:text-amber-400' : ''"
                    :title="[worker.model, worker.reportedModel].filter(Boolean).join(' / ')"
                  >
                    {{
                      run?.differs
                        ? $t('corch.modelAskedRan', { asked: run.model, ran: run.ran })
                        : (run?.ran ?? run?.model ?? $t('corch.runDefault'))
                    }}
                  </dd>
                  <dt class="text-muted-foreground">{{ $t('corch.detailEffort') }}</dt>
                  <dd>{{ worker.effort ?? $t('corch.runDefault') }}</dd>
                  <dt class="text-muted-foreground">{{ $t('corch.detailGroup') }}</dt>
                  <dd class="mono break-all">{{ worker.group }}</dd>
                </dl>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </header>

      <div class="flex flex-col gap-4 px-4 py-3">
        <div v-if="worker.attempts.length" class="flex flex-col gap-1.5">
          <h4 class="flex items-baseline justify-between gap-2 text-xs font-medium">
            {{ $t('corch.attempts') }}
            <span class="font-normal text-muted-foreground">{{ $t('corch.switchedAccount', worker.moves) }}</span>
          </h4>
          <ol class="flex flex-col gap-1 text-xs">
            <li v-for="(a, i) in worker.attempts" :key="i" class="flex min-w-0 items-center gap-2">
              <span class="w-4 shrink-0 text-end tabular-nums text-muted-foreground">{{ i + 1 }}.</span>
              <span class="max-w-[14rem] shrink-0 truncate font-medium" :title="corchAccountLabel(a.account)">
                {{ corchAccountLabel(a.account) }}
              </span>
              <Badge :variant="CORCH_OUTCOME[a.outcome].variant" class="shrink-0">
                {{ $t(CORCH_OUTCOME[a.outcome].label) }}
              </Badge>
              <span v-if="a.notice" class="min-w-0 truncate text-muted-foreground" :title="a.notice">
                {{ a.notice }}
              </span>
            </li>
          </ol>
        </div>

        <div v-if="worker.pending.length" class="flex flex-col gap-1.5">
          <h4 class="text-xs font-medium">{{ $t('corch.pending', { n: worker.pending.length }) }}</h4>
          <ol class="flex flex-col gap-1 text-xs">
            <li
              v-for="(m, i) in worker.pending"
              :key="i"
              class="whitespace-pre-wrap break-words rounded-md bg-muted p-2"
            >{{ m }}</li>
          </ol>
        </div>

        <div v-if="worker.result" class="flex flex-col gap-1.5">
          <h4 class="text-xs font-medium">{{ $t('corch.result') }}</h4>
          <!-- One bounded box for the whole report, every turn in it, so the panel never grows a
               scroll of its own and no box scrolls inside another. -->
          <div
            v-if="turnResults.length > 1"
            class="scroll-slim flex max-h-96 flex-col gap-3 overflow-auto rounded-md bg-muted p-2.5"
          >
            <div v-for="(text, i) in turnResults" :key="i" class="flex flex-col gap-1">
              <span class="text-[11px] text-muted-foreground">
                {{ $t('corch.resultTurn', { n: i + 1, total: turnResults.length }) }}
              </span>
              <pre class="mono whitespace-pre-wrap break-words text-xs">{{ text }}</pre>
            </div>
          </div>
          <pre v-else class="mono scroll-slim max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2.5 text-xs">{{ worker.result }}</pre>
        </div>

        <!-- A stopped or waiting task keeps the reason it could not go on in `error`. Only a real
             failure is red; "no account was free" on a task you stopped is information. -->
        <div v-if="worker.error" class="flex flex-col gap-1.5">
          <h4 class="text-xs font-medium" :class="failed ? 'text-destructive' : ''">
            {{ errorHeading }}
          </h4>
          <pre
            class="mono scroll-slim max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md p-2.5 text-xs"
            :class="failed ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'"
          >{{ worker.error }}</pre>
        </div>

        <div class="flex flex-col gap-1.5">
          <h4 class="text-xs font-medium">{{ $t('corch.events') }}</h4>
          <ul
            v-if="worker.events?.length"
            ref="eventsEl"
            class="mono scroll-slim max-h-72 overflow-auto rounded-md bg-muted p-2.5 text-xs"
            @scroll.passive="onEventsScroll"
          >
            <li v-for="(e, i) in worker.events" :key="i" class="whitespace-pre-wrap break-words">{{ e }}</li>
          </ul>
          <p v-else class="text-xs text-muted-foreground">
            {{ eventsLoading ? $t('corch.loadingEvents') : $t('corch.noEvents') }}
          </p>
        </div>

        <CorchJournal :worker-id="worker.id" :group="worker.group" :updated-at="worker.updatedAt" />
      </div>

      <form class="flex flex-col gap-1.5 border-t px-4 py-3" @submit.prevent="onSend()">
        <label for="corch-follow-up" class="text-xs font-medium">
          {{ active ? $t('corch.messageLabel') : $t('corch.continueLabel') }}
        </label>
        <Textarea
          id="corch-follow-up"
          v-model="followUp"
          rows="2"
          class="min-h-14 resize-y"
          :placeholder="$t('corch.messagePlaceholder')"
          :disabled="sending"
          @keydown.ctrl.enter.prevent="onSend()"
          @keydown.meta.enter.prevent="onSend()"
        />
        <div class="flex items-center justify-between gap-3">
          <span class="text-2xs text-muted-foreground">
            {{
              active ? $t('corch.messageHint') : stuck ? $t('corch.continueHintStuck') : $t('corch.continueHint')
            }}
            <span class="hidden sm:inline">· {{ $t('corch.sendShortcut') }}</span>
          </span>
          <div class="flex shrink-0 items-center gap-1.5">
            <Button
              v-if="worker.status === 'running'"
              type="button"
              variant="outline"
              class="shrink-0"
              :disabled="sending || !followUp.trim()"
              :title="$t('corch.sendNowHint')"
              @click="onSend(true)"
            >
              <Zap /> {{ $t('corch.sendNow') }}
            </Button>
            <Button type="submit" class="shrink-0" :disabled="sending || !followUp.trim()">
              <Send v-if="active" />
              <RotateCcw v-else />
              {{ active ? $t('corch.send') : $t('corch.continue') }}
            </Button>
          </div>
        </div>
      </form>
    </template>
  </section>
</template>
