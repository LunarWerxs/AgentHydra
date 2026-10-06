<script setup lang="ts">
// The AI used its browser: one compact card that opens that browser live in the side pane (DeskFrame listens
// for OPEN_BROWSER_EVENT). A run of browser calls is one card showing the latest (`run`).
import { computed } from 'vue'
import { Globe } from '@lucide/vue'
import type { TranscriptItem } from '@shared/protocol'
import { OPEN_BROWSER_EVENT } from '@shared/browser'
import { browserOpenRequest, parseBrowserCall } from '../lib/tools'
import StatusIcon from './StatusIcon.vue'
import ImageTiles from './ImageTiles.vue'

type ToolItem = Extract<TranscriptItem, { kind: 'tool_use' }>
const props = defineProps<{ item: ToolItem; run?: ToolItem[] }>()

const count = computed(() => props.run?.length ?? 1)
// The latest call's address and profile; a call with no address of its own shows the run's latest one.
const info = computed(() => {
  const own = parseBrowserCall(props.item.name, props.item.input, props.item.result?.text)
  if (own.url || !props.run) return own
  for (let i = props.run.length - 1; i >= 0; i--) {
    const u = parseBrowserCall(props.run[i].name, props.run[i].input, props.run[i].result?.text).url
    if (u) return { ...own, url: u }
  }
  return own
})
const shownUrl = computed(() => {
  const u = info.value.url.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return u.length > 60 ? u.slice(0, 59) + '…' : u
})
const error = computed(() => (props.item.status === 'error' || props.item.result?.isError ? (props.item.result?.text ?? 'Failed').trim().slice(0, 240) : ''))
const images = computed(() => props.item.result?.images ?? [])

function open() {
  window.dispatchEvent(new CustomEvent(OPEN_BROWSER_EVENT, { detail: browserOpenRequest(info.value) }))
}
</script>

<template>
  <div class="tx-card shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--brand)_35%,transparent)]">
    <button
      type="button"
      class="flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-6 px-2 py-0.5 text-left text-[13px] transition-colors duration-[60ms] hover:bg-fill-hover"
      :title="`Watch this browser live${info.url ? ': ' + info.url : ''}`"
      @click="open"
    >
      <Globe class="size-4 shrink-0 text-text-muted" aria-hidden="true" />
      <span class="shrink-0 text-text-2">{{ info.verb }}</span>
      <span v-if="shownUrl" class="min-w-0 truncate font-mono text-[12px] text-text-muted" :title="info.url">{{ shownUrl }}</span>
      <span class="shrink-0 rounded bg-fill-hover px-1.5 text-[11px] text-text-muted">{{ info.profile }}</span>
      <span class="ml-auto flex shrink-0 items-center gap-2 pl-2 text-[12px] tabular-nums text-text-muted">
        <template v-if="count > 1">{{ count }} calls</template>
        <StatusIcon :status="item.status" />
      </span>
    </button>
    <p v-if="error" class="whitespace-pre-wrap break-words px-2 pb-1.5 pl-[30px] text-[12px] text-danger-text">{{ error }}</p>
    <ImageTiles v-if="images.length" :images="images" class="px-2 pb-2 pl-[30px]" />
  </div>
</template>
