<script setup lang="ts">
// The real file card (real-markdown-and-file-card.png): 120x120, r8, #20201f with a 1px white-20% ring,
// a type badge top left ("PNG", 18 high, the same ring), the name (13px primary) and size (12px
// secondary) at the bottom. A picture opens in the lightbox.
import type { ImageRef } from '@shared/protocol'
import { fileBadge, formatSize, imageSrc, openLightbox } from '../lib/media'

const props = defineProps<{ file: ImageRef }>()

function open() {
  const src = imageSrc(props.file)
  if (src) openLightbox(src, props.file.name ?? '')
}
</script>

<template>
  <component
    :is="imageSrc(file) ? 'button' : 'div'"
    :type="imageSrc(file) ? 'button' : undefined"
    class="tx-file-card"
    :aria-label="imageSrc(file) ? `Open ${file.name || 'file'}` : undefined"
    @click="open"
  >
    <span class="tx-file-badge">{{ fileBadge(file) }}</span>
    <span class="mt-auto flex min-w-0 flex-col items-start">
      <span class="w-full truncate text-left text-[13px] leading-[18px] text-text">{{ file.name || 'file' }}</span>
      <span class="text-[12px] leading-4 text-text-2 tabular-nums">{{ formatSize(file.bytes) }}</span>
    </span>
  </component>
</template>
