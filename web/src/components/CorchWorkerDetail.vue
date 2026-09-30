<script setup lang="ts">
// The selected Corch task (CorchView.vue's right-hand pane): what it is, where it ran, what it did,
// and a box to message or continue it.
//
// Three parts, so the message box never scrolls away: a header (status, title, Stop, the facts), one
// scrolling body (accounts tried, result, why it stopped, the event log) and a footer form. The
// accounts list is the point of Corch made visible: each account the task tried, in order, and why
// it moved on (limit, signed out, error). The box speaks to what sending actually does
// (server/src/corch.ts corchSend): on a live task it queues for after the current step; on a
// finished, failed or stopped one it continues the SAME conversation as a new turn.
import { RotateCcw, Send, Square } from '@lucide/vue'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import CorchStatusBadge from '@/components/CorchStatusBadge.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { CorchWorkerView } from '@/lib/api'
import { cancelCorch, sendCorchWorker } from '@/lib/api'
import { CORCH_OUTCOME, corchAccountLabel, isCorchActive } from '@/lib/corch-status'
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

function duration(totalS: number): string {
  const s = Math.floor(totalS % 60)
  const m = Math.floor(totalS / 60)
  if (m >= 60) return t('corch.hours', { h: Math.floor(m / 60), m: m % 60 })
  return m > 0 ? t('corch.minutes', { m, s }) : t('corch.seconds', { s })
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

async function onSend() {
  const w = props.worker
  const text = followUp.value.trim()
  if (!w || !text || sending.value) return
  sending.value = true
  try {
    const r = await sendCorchWorker(w.id, text)
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
    await cancelCorch({ id: w.id })
    toast.success(t('corch.stopped'))
    emit('changed')
  } catch {
    toast.error(t('corch.stopFailed'))
  } finally {
    stopping.value = false
  }
}
</script>

<template>
  <section
    class="flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card lg:sticky lg:top-4 lg:max-h-[calc(100dvh-7rem)]"
    :aria-label="worker?.title"
  >
    <p v-if="!worker" class="px-4 py-12 text-center text-sm text-muted-foreground">
      {{ $t('corch.selectHint') }}
    </p>
    <template v-else>
      <header class="flex flex-col gap-3 border-b px-4 py-3">
        <div class="flex items-start justify-between gap-3">
          <div class="flex min-w-0 flex-col items-start gap-1.5">
            <CorchStatusBadge :status="worker.status" />
            <h3 class="line-clamp-2 break-words text-sm font-semibold" :title="worker.title">
              {{ worker.title }}
            </h3>
          </div>
          <Button
            v-if="active"
            variant="outline"
            class="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
            :disabled="stopping"
            :aria-label="`${$t('corch.stop')}: ${worker.title}`"
            @click="onStop"
          >
            <Square /> {{ $t('corch.stop') }}
          </Button>
        </div>
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
          <dt class="text-muted-foreground">{{ $t('corch.detailAccount') }}</dt>
          <dd class="truncate" :title="worker.account ?? undefined">
            {{ worker.account ?? $t('corch.noAccount') }}
          </dd>
          <dt class="text-muted-foreground">{{ $t('corch.detailStarted') }}</dt>
          <dd>
            <time
              :datetime="new Date(worker.createdAt).toISOString()"
              :title="new Date(worker.createdAt).toLocaleString()"
            >{{ formatAgo(now, worker.createdAt) }}</time>
          </dd>
          <dt class="text-muted-foreground">{{ $t('corch.detailRan') }}</dt>
          <dd class="tabular-nums">{{ duration(worker.elapsedS) }}</dd>
          <dt class="text-muted-foreground">{{ $t('corch.detailGroup') }}</dt>
          <dd class="mono truncate" :title="worker.group">{{ worker.group }}</dd>
        </dl>
      </header>

      <div class="scroll-slim flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-3">
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

        <div v-if="worker.result" class="flex flex-col gap-1.5">
          <h4 class="text-xs font-medium">{{ $t('corch.result') }}</h4>
          <pre class="mono scroll-slim max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2.5 text-xs">{{ worker.result }}</pre>
        </div>

        <!-- A stopped or waiting task keeps the reason it could not go on in `error`. Only a real
             failure is red; "no account was free" on a task you stopped is information. -->
        <div v-if="worker.error" class="flex flex-col gap-1.5">
          <h4 class="text-xs font-medium" :class="failed ? 'text-destructive' : ''">
            {{ failed ? $t('corch.error') : $t('corch.whyStopped') }}
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
      </div>

      <form class="flex flex-col gap-1.5 border-t px-4 py-3" @submit.prevent="onSend">
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
          @keydown.ctrl.enter.prevent="onSend"
          @keydown.meta.enter.prevent="onSend"
        />
        <div class="flex items-center justify-between gap-3">
          <span class="text-2xs text-muted-foreground">
            {{ active ? $t('corch.messageHint') : $t('corch.continueHint') }}
            <span class="hidden sm:inline">· {{ $t('corch.sendShortcut') }}</span>
          </span>
          <Button type="submit" class="shrink-0" :disabled="sending || !followUp.trim()">
            <Send v-if="active" />
            <RotateCcw v-else />
            {{ active ? $t('corch.send') : $t('corch.continue') }}
          </Button>
        </div>
      </form>
    </template>
  </section>
</template>
