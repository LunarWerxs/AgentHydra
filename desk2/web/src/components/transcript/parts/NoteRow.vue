<script setup lang="ts">
// A note another program typed into the session as a user turn (an AgentHydra ping): a muted status line in the
// reply's flow, like "CliMayte moved this chat ..." and "Thought process", never a card or the person's bubble.
// Who sent it and its tally (lib/note.ts); the chevron opens the whole text under it. Owner, 2026-10-06: pings
// come so often they must stay small; 2026-10-08: "treated like a little notification", not a box.
import { computed } from 'vue'
import { Bot } from '@lucide/vue'
import type { TranscriptItem } from '@shared/protocol'
import { Tip } from '@/components/ui/tooltip'
import { useTranscript } from '../context'
import { noteBody, noteSummary } from '../lib/note'
import StatusRow from './StatusRow.vue'
import Collapse from './Collapse.vue'

const props = defineProps<{ item: Extract<TranscriptItem, { kind: 'note' }> }>()

const ctx = useTranscript()
const open = computed(() => ctx.isOpen(props.item.id))
const body = computed(() => noteBody(props.item.text))
const summary = computed(() => noteSummary(props.item.text))
const when = computed(() => new Date(props.item.ts).toLocaleString(undefined, { hour12: false }))
</script>

<template>
  <div class="text-text-muted">
    <StatusRow v-if="body" :open="open" :title="when" @toggle="ctx.toggle(item.id)">
      <Bot class="size-4 shrink-0" />
      <span class="min-w-0 truncate">{{ item.from }}<template v-if="summary"> · {{ summary }}</template></span>
    </StatusRow>
    <Tip v-else :label="when">
      <div class="flex h-6 items-center gap-1.5 px-1 text-[14px]">
        <Bot class="size-4 shrink-0" />
        <span class="min-w-0 truncate">{{ item.from }}</span>
      </div>
    </Tip>
    <Collapse :open="open && !!body">
      <div class="mb-1 ms-1 mt-1.5 whitespace-pre-wrap wrap-break-word border-s border-border ps-3 text-[13px] leading-5">{{ body }}</div>
    </Collapse>
  </div>
</template>
