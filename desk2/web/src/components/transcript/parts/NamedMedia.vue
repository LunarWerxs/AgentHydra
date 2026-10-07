<script setup lang="ts">
// Pictures and videos a finished reply only names (a path in backticks, prose or a link; the server found and
// cached them, item.media): videos play in place like a markdown-image video, pictures are the message's
// usual lightbox tiles.
import { computed } from 'vue'
import type { ImageRef } from '@shared/protocol'
import { imageSrc, videoSrc } from '../lib/media'
import ImageTiles from './ImageTiles.vue'

const props = defineProps<{ media: ImageRef[] }>()

const videos = computed(() => props.media.filter((f) => videoSrc(f)))
const pictures = computed(() => props.media.filter((f) => imageSrc(f)))
</script>

<template>
  <div class="flex flex-col gap-2.5" data-testid="named-media">
    <video
      v-for="(f, i) in videos"
      :key="`v${i}`"
      class="tx-inline-video"
      :src="videoSrc(f)!"
      :aria-label="f.name || 'video'"
      :title="f.name || 'video'"
      controls
      autoplay
      muted
      loop
      playsinline
      preload="metadata"
    />
    <ImageTiles v-if="pictures.length" :images="pictures" />
  </div>
</template>
