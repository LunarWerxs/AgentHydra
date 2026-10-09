<script setup lang="ts">
import { computed, ref, shallowRef, watch, onUnmounted } from 'vue'
import type { DesktopMessageRequest, DesktopMessageResult, TranscriptItem } from '@shared/protocol'
import { useShellSource } from '@/components/shell/source'
import { usePaneApi } from '@/components/panes/api'
import { externalGlyph, glyphDotClass, sourceLabel } from '@/components/sidebar/logic'
import { useDesk } from '@/stores/desk'
import { outsideTasks } from '@/components/tasks/api'
import TranscriptView from '@/components/transcript/TranscriptView.vue'
import WorkingMark from '@/components/transcript/parts/WorkingMark.vue'
import { nowDoing, runningFor } from '@/components/transcript/lib/now-doing'
import { useClock } from '@/lib/clock'
import Composer from '@/components/composer/Composer.vue'
import SessionHeader from '@/components/session-header/SessionHeader.vue'
import { displayItems, type FindHit } from '@/components/session-header/logic'
import { displayPrefs } from '@/components/session-header/state'
import { continueLine, externalChat, holderOf, knownResumeAccount, resumable, whereLabel } from './logic'

// A session running outside Hydra Desk, in the same column as a chat. A Claude Code session from Claude
// Desktop or a terminal opens like one of its own chats: idle there, the live composer, whose first
// message imports and resumes it (on the CLI instance that holds it, else as a copy under the account
// it lands on), a quiet line over it saying which; working there, a quiet line until it settles.
// Anything else (Codex, CliMayte workers) stays read-only: nothing here can resume it.
// Hydra Desk 2: AgentHydra's session header lies over the top of the transcript (components/session-header):
// it slides away and back on a transform, and the transcript keeps its first row clear of it with a top
// inset rather than shrinking, so folding it lays nothing out again. Its Display choices pick what the
// transcript shows.
const props = defineProps<{ sessionId: string; /** A page (AgentHydra, Dev servers) covers the view. */ paused?: boolean }>()

const src = useShellSource()
const desk = useDesk()
const api = usePaneApi()
// Replaced whole on each read, never edited in place: a shallow ref keeps a big transcript out of deep proxies.
const items = shallowRef<TranscriptItem[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
let pollInterval: ReturnType<typeof setInterval> | null = null

const session = computed(() => src.external.value.find((s) => s.id === props.sessionId))
const isWorking = computed(() => session.value?.status === 'working' || session.value?.status === 'needs_you')
const usable = computed(() => !!session.value && resumable(session.value))
const shown = computed(() => displayItems(items.value, displayPrefs.value))
const find = ref<{ query: string; active: FindHit | null } | null>(null)
/** How much of the top the session header (and its Find bar) covers right now. */
const inset = ref(0)
const standIn = computed(() =>
  session.value?.canResume ? externalChat(session.value, src.accounts.value, desk.externalPatch(session.value.id), desk.landingOf(session.value.id)) : null
)
// A Claude Desktop chat that is working or waiting on you keeps its composer: a message goes into that chat
// (AgentHydra queues it there; it runs when the turn ends), text only. A terminal session has no such way in.
const desktopChat = computed(() => {
  const s = session.value
  if (standIn.value || !s || s.source !== 'desktop' || !isWorking.value) return null
  return externalChat(s, src.accounts.value)
})
const INTO_WHY = 'Text only: a message into a working Claude Desktop chat has no pictures or voice.'
const queued = ref<{ id: number; text: string }[]>([])
let queuedId = 0
async function sendInto(text: string): Promise<void> {
  const res = await fetch(`/api/external/sessions/${encodeURIComponent(props.sessionId)}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text } satisfies DesktopMessageRequest)
  })
  const body = (await res.json().catch(() => null)) as (Partial<DesktopMessageResult> & { error?: string }) | null
  if (!res.ok || !body?.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  queued.value = [...queued.value, { id: ++queuedId, text }]
}
// A queued message is shown as queued until the transcript shows it (once per matching message).
watch(items, (list) => {
  if (!queued.value.length) return
  const seen = list.filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text.trim())
  queued.value = queued.value.filter((q) => {
    const at = seen.indexOf(q.text.trim())
    if (at < 0) return true
    seen.splice(at, 1)
    return false
  })
})
watch(() => props.sessionId, () => (queued.value = []))
const glyph = computed(() => (session.value ? externalGlyph(session.value) : null))
const where = computed(() => {
  const s = session.value
  if (!s) return ''
  return `${sourceLabel(s.source)}${s.instance ? ` ${s.instance}` : ''}`
})
const dotClass = computed(() => glyphDotClass(glyph.value ?? { shape: 'ring', tone: 'muted', motion: 'none' }))
// Working there, the window's orange working mark stands in for the blinking dot (owner, 2026-10-08: "a fun ...
// orange animation"); waiting on you keeps the amber dot, and anything else its own dot.
const working = computed(() => session.value?.status === 'working')
// Working there, the line under the transcript says what it is doing now, in a size a person reads, and how long since
// the person last wrote, as Claude Desktop's working line does (owner, 2026-10-08: "make the text a little larger ...
// dynamically change ... what task it's running right now" and "a timer for how long ... since the last human-written
// message"). Where it runs is in the tooltip.
const clock = useClock()
const doing = computed(() => nowDoing(items.value, session.value?.cwd))
const liveText = computed(() => {
  const s = session.value
  if (!s) return ''
  return s.status === 'needs_you' ? 'Waiting for you' : doing.value.text || s.activity || 'Working'
})
const liveFor = computed(() => (isWorking.value && doing.value.since ? runningFor(clock.value - doing.value.since) : ''))
const liveWhere = computed(() => (session.value ? `${session.value.status === 'needs_you' ? 'Waiting for you' : 'Working'} in ${whereLabel(session.value)}` : ''))
// Said before the first message: in place or as a copy, and on which account (the title bar's menu changes it).
const continueNote = computed(() => {
  const s = session.value
  if (!standIn.value || !s) return ''
  const picked = desk.externalPatch(s.id).accountId
  const account = knownResumeAccount(s, src.accounts.value, picked, desk.landingOf(s.id))
  return continueLine(s, account, !!account && account.id === picked)
})

/**
 * Whether a fresh read says nothing new: same length, same id and status on every item, the same last item
 * in full, and the same tasks and checklist in full (their notices change them where they stand).
 */
function sameItems(a: TranscriptItem[], b: TranscriptItem[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.id !== y.id || (x as { status?: string }).status !== (y as { status?: string }).status) return false
    if ((x.kind === 'task' || x.kind === 'todos') && JSON.stringify(x) !== JSON.stringify(y)) return false
  }
  return a.length === 0 || JSON.stringify(a[a.length - 1]) === JSON.stringify(b[b.length - 1])
}

async function loadItems(quiet = false) {
  try {
    if (!quiet) loading.value = true
    error.value = null
    const next = await api.externalItems(props.sessionId)
    if (quiet && sameItems(items.value, next)) return
    items.value = next
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load session items'
  } finally {
    loading.value = false
  }
}

function stopPolling() {
  if (pollInterval) clearInterval(pollInterval)
  pollInterval = null
}

watch(() => props.sessionId, () => loadItems(), { immediate: true })
// Where a session no signed-in CLI instance holds lands (the stand-in's account, the line over its
// composer), again when Settings' default changes or the accounts arrive: the named default is only
// found among them, and a holder's sign-in shows there.
watch(
  () =>
    [
      props.sessionId,
      session.value?.canResume,
      session.value?.accountId ?? null,
      src.settings.value?.defaultAccountId,
      src.accounts.value.map((a) => `${a.id}:${a.signedIn}`).join(',')
    ] as const,
  ([id, can, owner]) => {
    if (can && !holderOf({ accountId: owner }, src.accounts.value)) void desk.ensureLanding(id)
  },
  { immediate: true }
)
// The Background tasks panel reads this session's transcript from here.
watch(
  [items, () => props.sessionId],
  () => (outsideTasks.value = { sessionId: props.sessionId, items: items.value }),
  { immediate: true }
)
// A session sits idle while its background Bash runs, so a running task keeps a slower poll going
// until it finishes (owner, 2026-10-05: "there actually is one running and one finished").
const tasksRunning = computed(() => items.value.some((i) => i.kind === 'task' && i.status === 'running'))
let pollMs = 0
watch(
  () => [isWorking.value, tasksRunning.value] as const,
  ([working, running], before) => {
    const ms = working ? 3000 : running ? 10000 : 0
    if (ms !== pollMs) {
      stopPolling()
      // A hidden window, or a view a page covers, rests; it reads once on return (below).
      if (ms) pollInterval = setInterval(() => !document.hidden && !props.paused && loadItems(true), ms)
      pollMs = ms
    }
    if (!working && before?.[0]) void loadItems(true)
  },
  { immediate: true }
)
function onVisible() {
  if (!document.hidden && !props.paused && pollMs) void loadItems(true)
}
document.addEventListener('visibilitychange', onVisible)
watch(() => props.paused, onVisible)
onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisible)
  stopPolling()
  if (outsideTasks.value?.sessionId === props.sessionId) outsideTasks.value = null
})
</script>

<template>
  <div class="flex h-full flex-col bg-(--bg-page) text-[13px] leading-[19.5px] text-(--text)">
    <!-- The header is clipped here: folded, it slides up out of this box, never over the title bar. -->
    <div class="relative min-h-0 flex-1 overflow-hidden">
      <SessionHeader
        :session-id="sessionId"
        :session="session ?? null"
        :items="items"
        :shown="shown"
        @update:find="(f) => (find = f)"
        @update:inset="(h: number) => (inset = h)"
      />
      <div v-if="loading" class="flex h-full items-center justify-center text-(--text-muted)" :style="{ paddingTop: `${inset}px` }">Loading transcript…</div>
      <div
        v-else-if="error && !items.length"
        class="flex h-full flex-col items-center justify-center gap-1 px-6 text-center"
        :style="{ paddingTop: `${inset}px` }"
      >
        <div class="font-medium">Could not load this session</div>
        <div class="text-(--text-muted)">{{ error }}</div>
      </div>
      <TranscriptView
        v-else
        :chat-id="sessionId"
        :items="shown"
        :read-only="!standIn"
        :chat="standIn"
        :find="find"
        :compact="displayPrefs.compact"
        :inset-top="inset"
        :running="isWorking"
      />
    </div>

    <template v-if="standIn">
      <!-- In place or as a copy, and on which account: the info mark in the composer's toolbar says it on hover. -->
      <Composer :key="standIn.id" :chat="standIn" :note="continueNote || undefined" />
    </template>

    <template v-else-if="desktopChat && session">
      <!-- Room below (owner, 2026-10-08: "it's too close" to the composer); above, the transcript's own 20px is the gap, a
           turn's, as between any two rows (owner, 2026-10-08: the last ones had "way too big of gaps"). -->
      <div class="shrink-0 px-8 pb-4 pt-1">
        <p class="mx-auto flex h-6 w-full max-w-3xl items-center gap-1.25 px-2 text-[14px] leading-5 text-(--text-muted)" role="status" :title="liveWhere">
          <span class="flex size-6 shrink-0 items-center justify-center">
            <WorkingMark v-if="working" :label="glyph?.label ?? 'Working'" />
            <span v-else role="img" :aria-label="glyph?.label" class="size-1.5 rounded-full" :class="dotClass" />
          </span>
          <span class="min-w-0 truncate" :class="working ? 'tx-shimmer' : 'text-warning-text'">{{ liveText }}</span>
          <span v-if="liveFor" class="ms-0.5 shrink-0 tabular-nums text-[13px]" aria-hidden="true">{{ liveFor }}</span>
          <span class="sr-only">{{ liveWhere }}</span>
        </p>
        <ul v-if="queued.length" class="mx-auto flex w-full max-w-3xl flex-col gap-0.5 px-2 pt-1 ps-8 text-[12px] leading-4 text-(--text-muted)" aria-label="Queued messages">
          <li v-for="q in queued" :key="q.id" class="truncate" role="status">Queued, runs when this turn ends: {{ q.text }}</li>
        </ul>
      </div>
      <Composer :key="desktopChat.id" :chat="desktopChat" :into="{ send: sendInto, why: INTO_WHY }" />
    </template>

    <div v-else-if="session && usable" class="shrink-0 px-8 py-3">
      <p class="mx-auto flex h-10 w-full max-w-3xl items-center gap-1.25 px-2 text-(--text-muted)" role="status">
        <span class="flex size-6 shrink-0 items-center justify-center">
          <WorkingMark v-if="working" :label="glyph?.label ?? 'Working'" />
          <span v-else role="img" :aria-label="glyph?.label" class="size-1.5 rounded-full" :class="dotClass" />
        </span>
        <template v-if="isWorking">
          <span class="min-w-0 truncate text-[14px] leading-5" :class="working ? 'tx-shimmer' : 'text-warning-text'" :title="liveWhere">{{ liveText }}</span>
          <span v-if="liveFor" class="ms-0.5 shrink-0 tabular-nums text-[13px]" aria-hidden="true">{{ liveFor }}</span>
          <span class="sr-only">{{ liveWhere }}</span>
        </template>
        <span v-else class="min-w-0 flex-1 truncate">{{ liveWhere }}</span>
      </p>
    </div>

    <div v-else-if="session" class="shrink-0 px-8 py-3">
      <div
        class="mx-auto flex h-10 w-full max-w-3xl items-center gap-1.25 rounded-(--radius-10) bg-(--fill-5) p-2"
        role="status"
      >
        <span class="flex size-6 shrink-0 items-center justify-center">
          <WorkingMark v-if="working" :label="glyph?.label ?? 'Working'" />
          <span v-else role="img" :aria-label="glyph?.label" class="size-1.5 rounded-full" :class="dotClass" />
        </span>
        <span class="min-w-0 flex-1 truncate text-(--text-2)">
          <span>{{ isWorking ? 'Running in' : 'Read-only from' }} {{ where }}</span>
          <span v-if="isWorking" class="text-(--text-muted)"> · {{ liveText }}</span>
        </span>
        <span v-if="liveFor" class="shrink-0 tabular-nums text-[13px] text-(--text-muted)" aria-hidden="true">{{ liveFor }}</span>
        <span v-if="error" class="max-w-[40%] shrink truncate text-(--danger-text)" :title="error">{{ error }}</span>
      </div>
    </div>
  </div>
</template>
