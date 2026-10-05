<script setup lang="ts">
import { computed } from 'vue'
import { FolderOpen } from '@lucide/vue'
import type { CliMayteWorker, TranscriptItem } from '@shared/protocol'
import { useDesk } from '@/stores/desk'
import { parseCliMayte, shortPath } from '../lib/tools'
import { useTranscript } from '../context'
import ToolHeader from './ToolHeader.vue'
import OutputBlock from './OutputBlock.vue'

type ToolItem = Extract<TranscriptItem, { kind: 'tool_use' }>
const props = defineProps<{ item: ToolItem }>()

const ctx = useTranscript()
const desk = useDesk()
const open = computed(() => ctx.isOpen(props.item.id))
const info = computed(() => parseCliMayte(props.item.name, props.item.input, props.item.result?.text))
const inputJson = computed(() => JSON.stringify(props.item.input, null, 2))
const workers = computed(() => {
  const all = desk.workers.value as CliMayteWorker[]
  return info.value.workerIds.map((id) => ({ id, worker: all.find((w) => w.id === id) ?? null }))
})

function dot(w: CliMayteWorker | null): string {
  if (!w) return 'bg-text-muted'
  if (w.active) return w.status === 'waiting' ? 'bg-warning' : 'bg-brand animate-pulse'
  return w.status === 'done' ? 'bg-success' : w.status === 'failed' ? 'bg-danger' : 'bg-text-muted'
}
</script>

<template>
  <div class="tx-card shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--brand)_35%,transparent)]">
    <div class="px-1 pt-0.5" :class="!info.tasks.length && !workers.length && 'pb-0.5'">
      <ToolHeader :item="item" :open="open" @toggle="ctx.toggle(item.id)" />
    </div>
    <div v-if="info.tasks.length || workers.length" class="space-y-1 px-3 pb-2 pl-8 text-[13px]">
      <div v-for="(t, i) in info.tasks" :key="i" class="flex min-w-0 items-center gap-2">
        <span class="w-4 shrink-0 text-right font-mono text-[11px] text-text-muted">{{ i + 1 }}</span>
        <span class="min-w-0 truncate text-text">{{ t.title }}</span>
        <span v-if="t.kind" class="shrink-0 rounded bg-fill-hover px-1.5 text-[11px] text-text-muted">{{ t.kind }}</span>
        <span v-if="t.cwd" class="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-text-muted">
          <FolderOpen class="size-3" />{{ shortPath(t.cwd).split('/').pop() }}
        </span>
      </div>
      <div v-if="workers.length" class="flex flex-wrap items-center gap-1.5 pt-0.5">
        <span class="text-[11px] text-text-muted">Workers</span>
        <span
          v-for="w in workers"
          :key="w.id"
          class="inline-flex items-center gap-1.5 rounded-md bg-fill-hover px-1.5 py-0.5 font-mono text-[11px] text-text-muted"
          :title="w.worker ? `${w.worker.title} · ${w.worker.status}` : w.id"
        >
          <span class="size-1.5 rounded-full" :class="dot(w.worker)" />{{ w.id.slice(0, 10) }}
          <span v-if="w.worker" class="font-sans text-text-muted">{{ w.worker.status }}</span>
        </span>
      </div>
    </div>
    <div v-if="open" class="border-t border-brand/20">
      <OutputBlock :id="`${item.id}:in`" :text="inputJson" :max-lines="16" />
      <OutputBlock
        v-if="item.result"
        :id="item.id"
        :text="item.result.text"
        :error="item.result.isError"
        :server-truncated="item.result.truncated"
        class="border-t border-brand/20"
      />
    </div>
  </div>
</template>
