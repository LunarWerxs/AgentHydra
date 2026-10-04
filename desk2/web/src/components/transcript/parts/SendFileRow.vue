<script setup lang="ts">
// Files the assistant hands over (SendUserFile), as the real app draws them: with display 'render' a
// picture inline (at most 360 high, r5, 1px ring, zoom on click), the caption as prose, then a file card
// per file. Until the result lands the files are not known; the caption shows alone.
import { computed } from 'vue'
import type { TranscriptItem } from '@shared/protocol'
import { imageSrc, openLightbox } from '../lib/media'
import FileCard from './FileCard.vue'
import MarkdownBlock from './MarkdownBlock.vue'

const props = defineProps<{ item: Extract<TranscriptItem, { kind: 'tool_use' }> }>()

const files = computed(() => props.item.result?.images ?? [])
const caption = computed(() => (typeof props.item.input.caption === 'string' ? props.item.input.caption : ''))
const render = computed(() => props.item.input.display !== 'attach')
const pictures = computed(() => (render.value ? files.value.filter((f) => imageSrc(f)) : []))
</script>

<template>
  <div class="flex flex-col gap-2.5">
    <button
      v-for="(f, i) in pictures"
      :key="`p${i}`"
      type="button"
      class="tx-inline-picture"
      :aria-label="`Open ${f.name || 'picture'}`"
      @click="openLightbox(imageSrc(f)!, f.name ?? '')"
    >
      <img :src="imageSrc(f)!" :alt="f.name || 'picture'" loading="lazy" />
    </button>
    <MarkdownBlock v-if="caption" :text="caption" />
    <div v-if="files.length" class="flex flex-wrap gap-2 pl-0">
      <FileCard v-for="(f, i) in files" :key="`f${i}`" :file="f" />
    </div>
    <div v-else-if="item.status === 'running'" class="px-1 text-[14px] leading-5 text-text-muted"><span class="tx-shimmer">Sending a file</span></div>
    <div v-else-if="item.result?.isError" class="px-1 text-[14px] leading-5 text-danger-text">{{ item.result.text || 'The file could not be sent' }}</div>
  </div>
</template>
