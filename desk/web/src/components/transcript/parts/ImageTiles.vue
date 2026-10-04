<script setup lang="ts">
// Picture thumbnails: rounded 8px tiles that open in the lightbox. A ref with nothing to load (history
// without bytes) is a name chip.
import { ImageIcon } from '@lucide/vue'
import type { ImageRef } from '@shared/protocol'
import { imageSrc, openLightbox } from '../lib/media'

defineProps<{ images: ImageRef[]; align?: 'start' | 'end' }>()
</script>

<template>
  <div class="flex flex-wrap gap-2" :class="align === 'end' ? 'justify-end' : 'justify-start'">
    <template v-for="(img, i) in images" :key="i">
      <button
        v-if="imageSrc(img)"
        type="button"
        class="tx-tile"
        :aria-label="`Open ${img.name || 'picture'}`"
        @click="openLightbox(imageSrc(img)!, img.name ?? '')"
      >
        <img :src="imageSrc(img)!" :alt="img.name || 'picture'" loading="lazy" />
      </button>
      <span v-else class="inline-flex h-6 items-center gap-1 rounded-6 bg-fill-5 px-2 text-[12px] text-text-muted">
        <ImageIcon class="size-4" />{{ img.name || 'image' }}
      </span>
    </template>
  </div>
</template>
