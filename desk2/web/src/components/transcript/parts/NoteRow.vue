<script setup lang="ts">
// A note another program typed into the session as a user turn (an AgentHydra ping): a muted one-line strip
// on the left, never the person's bubble on the right: who sent it, when, and its tally (lib/note.ts). The
// whole text opens under it with Show more (owner, 2026-10-06: pings come so often they must stay small).
import { computed, ref } from 'vue'
import { Bot } from '@lucide/vue'
import type { TranscriptItem } from '@shared/protocol'
import { noteBody, noteSummary } from '../lib/note'

const props = defineProps<{ item: Extract<TranscriptItem, { kind: 'note' }> }>()

const expanded = ref(false)
const body = computed(() => noteBody(props.item.text))
const summary = computed(() => noteSummary(props.item.text))
const time = computed(() => new Date(props.item.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }))
</script>

<template>
  <div class="tx-card max-w-[72%] self-start px-2.5 py-1 text-[12px] leading-5">
    <div class="flex items-center gap-1.5 text-text-muted">
      <Bot class="size-3.5 shrink-0" />
      <span class="truncate text-text-2">{{ item.from }}</span>
      <span class="tnum shrink-0">{{ time }}</span>
      <span v-if="summary" class="min-w-0 flex-1 truncate">{{ summary }}</span>
      <button v-if="body" type="button" class="ml-auto shrink-0 pl-2 hover:text-text" :aria-expanded="expanded" @click="expanded = !expanded">
        {{ expanded ? 'Show less' : 'Show more' }}
      </button>
    </div>
    <p v-if="expanded && body" class="mt-1 whitespace-pre-wrap break-words text-text-2">{{ body }}</p>
  </div>
</template>
