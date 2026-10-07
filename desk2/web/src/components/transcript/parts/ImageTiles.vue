<script setup lang="ts">
// A message's pictures as a responsive gallery (rule: lib/gallery.ts): one stays large, several share the row
// width at their own aspect ratio and wrap into rows that fit the column, whatever its width. A tile opens the
// viewer on click or Space; the viewer steps through this message's pictures. A ref with nothing to load
// (history without bytes) is a name chip.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ImageIcon } from '@lucide/vue'
import type { ImageRef } from '@shared/protocol'
import { aspectOf, galleryLayout } from '../lib/gallery'
import { imageSrc, openLightbox, tileKey } from '../lib/media'

const props = defineProps<{ images: ImageRef[]; align?: 'start' | 'end' }>()

const root = ref<HTMLElement | null>(null)
const width = ref(0)
// Each picture's aspect ratio once it has loaded; until then 4:3.
const aspects = ref<Record<number, number>>({})

const pictures = computed(() => props.images.flatMap((img, i) => (imageSrc(img) ? [{ i, src: imageSrc(img)!, alt: img.name ?? '' }] : [])))
const sizes = computed(() =>
  galleryLayout(
    pictures.value.map((p) => aspects.value[p.i] ?? aspectOf(0, 0)),
    width.value || 480,
  ),
)
const sizeOf = computed(() => new Map(pictures.value.map((p, k) => [p.i, sizes.value[k]!])))

function onLoad(i: number, e: Event) {
  const el = e.target as HTMLImageElement
  aspects.value = { ...aspects.value, [i]: aspectOf(el.naturalWidth, el.naturalHeight) }
}
function open(src: string, alt: string) {
  openLightbox(
    src,
    alt,
    pictures.value.map((p) => ({ src: p.src, alt: p.alt })),
  )
}

let observer: ResizeObserver | null = null
onMounted(() => {
  if (!root.value) return
  width.value = root.value.clientWidth
  if (typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver((entries) => {
    const w = Math.floor(entries[0]?.contentRect.width ?? 0)
    if (w > 0 && w !== width.value) width.value = w
  })
  observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div ref="root" class="tx-gallery flex w-full flex-wrap gap-2" :class="align === 'end' ? 'justify-end' : 'justify-start'" data-testid="image-gallery">
    <template v-for="(img, i) in images" :key="i">
      <button
        v-if="imageSrc(img)"
        type="button"
        class="tx-tile"
        :data-reveal-path="img.path"
        :style="sizeOf.get(i) ? { width: `${sizeOf.get(i)!.width}px`, height: `${sizeOf.get(i)!.height}px` } : undefined"
        :aria-label="`Open ${img.name || 'picture'}`"
        @click="open(imageSrc(img)!, img.name ?? '')"
        @keydown="tileKey($event, () => open(imageSrc(img)!, img.name ?? ''))"
        @keyup="tileKey($event, () => {})"
      >
        <img :src="imageSrc(img)!" :alt="img.name || 'picture'" loading="lazy" @load="onLoad(i, $event)" />
      </button>
      <span v-else class="inline-flex h-6 items-center gap-1 rounded-6 bg-fill-5 px-2 text-[12px] text-text-muted">
        <ImageIcon class="size-4" />{{ img.name || 'image' }}
      </span>
    </template>
  </div>
</template>
