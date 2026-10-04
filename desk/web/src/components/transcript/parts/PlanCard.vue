<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, ClipboardList, Clock, PencilLine } from '@lucide/vue'
import type { PermissionMode, TranscriptItem } from '@shared/protocol'
import { useDesk } from '@/stores/desk'
import { useTranscript } from '../context'
import MarkdownBlock from './MarkdownBlock.vue'

// Pending, the card lives in the composer dock (docked); the transcript keeps a quiet row.
const props = defineProps<{ item: Extract<TranscriptItem, { kind: 'plan' }>; docked?: boolean }>()

const ctx = useTranscript()
const desk = useDesk()
const busy = ref(false)
const err = ref<string | null>(null)
const revising = ref(false)
const feedback = ref('')
const openKey = computed(() => `${props.item.id}:plan`)
const title = computed(() => {
  const line = props.item.plan.split('\n').find((l) => l.trim()) ?? 'Plan'
  return line.replace(/^#+\s*/, '').slice(0, 120)
})

// Approve goes back to the mode the chat had before plan mode (the server remembers it); 'default' asks
// before each edit instead.
async function respond(approve: boolean, mode?: PermissionMode) {
  busy.value = true
  err.value = null
  try {
    await desk.respondPlan(
      ctx.chatId.value,
      props.item.id,
      approve ? { approve: true, mode } : { approve: false, feedback: feedback.value.trim() || undefined },
    )
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="item.state !== 'pending'">
    <button
      type="button"
      class="tx-status w-full"
      @click="ctx.toggle(openKey)"
    >
      <Check v-if="item.state === 'approved'" class="size-4 shrink-0 text-success-text" />
      <PencilLine v-else-if="item.state === 'rejected'" class="size-4 shrink-0 text-warning-text" />
      <Clock v-else class="size-4 shrink-0 text-text-muted" />
      <span class="shrink-0">{{ item.state === 'approved' ? 'Plan approved' : item.state === 'rejected' ? 'Kept planning' : 'Plan expired' }}</span>
      <span class="min-w-0 truncate text-text">{{ title }}</span>
    </button>
    <div v-if="ctx.isOpen(openKey)" class="ml-[11px] mt-1 border-l border-border pl-4 text-[14px]">
      <MarkdownBlock :text="item.plan" />
    </div>
  </div>

  <div v-else-if="!docked" class="flex h-6 min-w-0 items-center gap-1.5 px-1 text-[14px] text-text-muted">
    <ClipboardList class="size-4 shrink-0 text-warning-text" />
    <span class="shrink-0">Waiting for you</span>
    <span class="min-w-0 truncate text-text">{{ title }}</span>
  </div>

  <div v-else class="tx-ask" role="group" aria-label="Plan ready for review">
    <div class="flex items-center gap-2 border-b border-border px-3 py-2 text-[14px]">
      <ClipboardList class="size-4 shrink-0 text-warning-text" />
      <span class="text-text">Ready to code? Here is the plan</span>
    </div>
    <div class="max-h-[50vh] overflow-auto px-4 py-2 text-[14px]">
      <MarkdownBlock :text="item.plan" />
    </div>
    <div v-if="!ctx.readOnly.value" class="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2.5">
      <template v-if="!revising">
        <button type="button" class="tx-btn tx-btn-primary" :disabled="busy" @click="respond(true)">Approve plan</button>
        <button type="button" class="tx-btn" :disabled="busy" @click="respond(true, 'default')">Approve, review each edit</button>
        <button type="button" class="tx-btn" :disabled="busy" @click="revising = true">Keep planning</button>
      </template>
      <template v-else>
        <input
          v-model="feedback"
          class="tx-input min-w-0 flex-1"
          placeholder="What should change?"
          @keydown.enter="respond(false)"
          @keydown.esc="revising = false"
        />
        <button type="button" class="tx-btn tx-btn-primary" :disabled="busy" @click="respond(false)">Send</button>
        <button type="button" class="tx-btn tx-btn-ghost" :disabled="busy" @click="revising = false">Cancel</button>
      </template>
      <span v-if="err" class="text-[12px] text-danger-text">{{ err }}</span>
    </div>
  </div>
</template>
