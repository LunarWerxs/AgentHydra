<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import type { TranscriptItem } from '@shared/protocol'
import { useShellSource } from '@/components/shell/source'
import { usePaneApi } from '@/components/panes/api'
import { externalGlyph, glyphDotClass, sourceLabel } from '@/components/sidebar/logic'
import { useDesk } from '@/stores/desk'
import TranscriptView from '@/components/transcript/TranscriptView.vue'
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
const props = defineProps<{ sessionId: string }>()

const src = useShellSource()
const desk = useDesk()
const api = usePaneApi()
const items = ref<TranscriptItem[]>([])
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
const glyph = computed(() => (session.value ? externalGlyph(session.value) : null))
const where = computed(() => {
  const s = session.value
  if (!s) return ''
  return `${sourceLabel(s.source)}${s.instance ? ` ${s.instance}` : ''}`
})
const dotClass = computed(() => glyphDotClass(glyph.value ?? { shape: 'ring', tone: 'muted', motion: 'none' }))
// Said before the first message: in place or as a copy, and on which account (the title bar's menu changes it).
const continueNote = computed(() => {
  const s = session.value
  if (!standIn.value || !s) return ''
  const picked = desk.externalPatch(s.id).accountId
  const account = knownResumeAccount(s, src.accounts.value, picked, desk.landingOf(s.id))
  return continueLine(s, account, !!account && account.id === picked)
})

async function loadItems(quiet = false) {
  try {
    if (!quiet) loading.value = true
    error.value = null
    items.value = await api.externalItems(props.sessionId)
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
watch(
  isWorking,
  (working, before) => {
    if (working && !pollInterval) pollInterval = setInterval(() => loadItems(true), 3000)
    else if (!working) {
      stopPolling()
      if (before) void loadItems(true)
    }
  },
  { immediate: true }
)
onUnmounted(stopPolling)
</script>

<template>
  <div class="flex h-full flex-col bg-[var(--bg-page)] text-[13px] leading-[19.5px] text-[var(--text)]">
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
      <div v-if="loading" class="flex h-full items-center justify-center text-[var(--text-muted)]" :style="{ paddingTop: `${inset}px` }">Loading transcript…</div>
      <div
        v-else-if="error && !items.length"
        class="flex h-full flex-col items-center justify-center gap-1 px-6 text-center"
        :style="{ paddingTop: `${inset}px` }"
      >
        <div class="font-medium">Could not load this session</div>
        <div class="text-[var(--text-muted)]">{{ error }}</div>
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
      />
    </div>

    <template v-if="standIn">
      <div v-if="continueNote" class="shrink-0 px-8">
        <p class="mx-auto w-full max-w-[768px] truncate px-2 text-[12px] leading-4 text-[var(--text-muted)]" role="status">{{ continueNote }}</p>
      </div>
      <Composer :key="standIn.id" :chat="standIn" />
    </template>

    <div v-else-if="session && usable" class="shrink-0 px-8 pb-3 pt-1.5">
      <p class="mx-auto flex h-10 w-full max-w-[768px] items-center gap-[5px] px-2 text-[var(--text-muted)]" role="status">
        <span class="flex size-6 shrink-0 items-center justify-center">
          <span role="img" :aria-label="glyph?.label" class="size-1.5 rounded-full" :class="dotClass" />
        </span>
        <span class="min-w-0 flex-1 truncate">{{ session.status === 'needs_you' ? 'Waiting for you' : 'Working' }} in {{ whereLabel(session) }}</span>
      </p>
    </div>

    <div v-else-if="session" class="shrink-0 px-8 pb-3 pt-1.5">
      <div
        class="mx-auto flex h-10 w-full max-w-[768px] items-center gap-[5px] rounded-[var(--radius-10)] bg-[var(--fill-5)] p-2"
        role="status"
      >
        <span class="flex size-6 shrink-0 items-center justify-center">
          <span role="img" :aria-label="glyph?.label" class="size-1.5 rounded-full" :class="dotClass" />
        </span>
        <span class="min-w-0 flex-1 truncate text-[var(--text-2)]">
          <span>{{ isWorking ? 'Running in' : 'Read-only from' }} {{ where }}</span>
          <span v-if="session.activity" class="text-[var(--text-muted)]"> · {{ session.activity }}</span>
        </span>
        <span v-if="error" class="max-w-[40%] shrink truncate text-[var(--danger-text)]" :title="error">{{ error }}</span>
      </div>
    </div>
  </div>
</template>
