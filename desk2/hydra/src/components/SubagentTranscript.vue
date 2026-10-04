<script setup lang="ts">
// What a subagent did, opened inside the Agent step that started it: its own messages and work rows,
// nested under the call the way the Claude desktop app shows an agent's run. Read when the step
// opens, and re-read while the row it sits in is still live; the file is found from the call's id
// (server/src/transcript.ts tailSubagent). Claude only: the other tools keep no such transcript.
import { useIntervalFn } from '@vueuse/core'
import { inject, ref, watch } from 'vue'
import SessionTranscriptTurns from '@/components/SessionTranscriptTurns.vue'
import { OPEN_TRANSCRIPT } from '@/composables/openTranscript'
import { useTranscriptDisplay } from '@/composables/useTranscriptDisplay'
import { getSubagentTail, type TailResult } from '@/lib/api'

const props = defineProps<{
  toolUseId: string
  /** The row holding the Agent step is still at work, so the agent may be too. */
  live: boolean
}>()

const open = inject(OPEN_TRANSCRIPT, null)
const tail = ref<TailResult | null>(null)
const state = ref<'loading' | 'ready' | 'missing'>('loading')

async function load() {
  const s = open?.value
  if (!s) {
    state.value = 'missing'
    return
  }
  try {
    const r = await getSubagentTail(s.id, props.toolUseId, { thinking: s.thinking }, s.locator)
    tail.value = r
    state.value = r.error ? 'missing' : 'ready'
  } catch {
    // A failed re-read keeps what is on screen; only a first read that fails says so.
    if (state.value === 'loading') state.value = 'missing'
  }
}
void load()

// Re-read on the open chat's cadence while the agent may still be running, and once more when the
// row goes quiet, so its last lines are not left behind by the final poll.
const poll = useIntervalFn(load, 4000, { immediate: false })
watch(
  () => props.live,
  (live, was) => {
    if (live) poll.resume()
    else {
      poll.pause()
      if (was) void load()
    }
  },
  { immediate: true },
)

const { items, copiedIdx, copyMessage } = useTranscriptDisplay({ tail, chatEl: ref(null) })

// Its own open rows: a nested run is a glance, not part of the session's remembered layout.
const expanded = ref(new Set<string>())
function toggle(key: string) {
  const next = new Set(expanded.value)
  if (!next.delete(key)) next.add(key)
  expanded.value = next
}
</script>

<template>
  <p v-if="state === 'loading'" class="text-2xs text-muted-foreground italic">
    {{ $t('sessions.work.agentRunLoading') }}
  </p>
  <p v-else-if="state === 'missing' || !items.length" class="text-2xs text-muted-foreground italic">
    {{ $t('sessions.work.agentRunMissing') }}
  </p>
  <div v-else class="min-w-0">
    <SessionTranscriptTurns
      nested
      :items="items"
      :copied-idx="copiedIdx"
      :is-expanded="(key) => expanded.has(key)"
      :find-active="false"
      @copy="copyMessage"
      @toggle-expand="toggle"
    />
  </div>
</template>
