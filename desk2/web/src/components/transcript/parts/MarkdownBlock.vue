<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { markdown, shikiReady } from '../lib/highlight'
import { openLightbox, tileKey } from '../lib/media'

const props = defineProps<{ text: string; streaming?: boolean }>()

const html = ref(markdown.render(props.text))
const root = ref<HTMLElement | null>(null)

// The markup is set here, not with v-html: a re-render (the reply streams on, shiki arrives) must not recreate a
// <video> the person is watching. A video whose address is still in the new markup keeps its element, so its
// playback and the sound the person gave it survive; the new markup's twin is dropped.
function paint() {
  const el = root.value
  if (!el) return
  const old = new Map<string, HTMLVideoElement[]>()
  for (const v of el.querySelectorAll<HTMLVideoElement>('video.md-video')) {
    const src = v.getAttribute('src') ?? ''
    old.set(src, [...(old.get(src) ?? []), v])
  }
  // Taken out and put back in this one task, so the browser (which pauses a video left out of the document) never sees it out.
  el.innerHTML = html.value
  for (const fresh of el.querySelectorAll('video.md-video')) {
    const keep = old.get(fresh.getAttribute('src') ?? '')?.shift()
    if (keep) fresh.replaceWith(keep)
  }
}
onMounted(paint)
watch(html, paint, { flush: 'post' })

// While the reply streams its text is parsed again at most once per frame, however many chunks arrived; a
// settled message (and the end of a stream) renders at once, so the final markup is the one it always was.
let frame = 0
function render() {
  if (frame) cancelAnimationFrame(frame)
  frame = 0
  html.value = markdown.render(props.text)
}
watch([() => props.text, () => props.streaming, shikiReady], () => {
  // Re-rendered once highlighting is available (shikiReady).
  if (!props.streaming || typeof requestAnimationFrame === 'undefined') return render()
  frame ||= requestAnimationFrame(render)
})
onBeforeUnmount(() => {
  if (frame) cancelAnimationFrame(frame)
})

async function copy(btn: HTMLElement) {
  const code = btn.closest('.md-code')?.querySelector('pre')?.textContent ?? ''
  try {
    await navigator.clipboard.writeText(code)
    btn.classList.add('is-copied')
    btn.setAttribute('aria-label', 'Copied')
    setTimeout(() => {
      btn.classList.remove('is-copied')
      btn.setAttribute('aria-label', 'Copy')
    }, 1500)
  } catch {
    // clipboard refused (no focus or permission): the button stays as it was
  }
}

function onClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  const copyBtn = target.closest<HTMLElement>('[data-copy]')
  if (copyBtn) return void copy(copyBtn)
  const more = target.closest<HTMLElement>('[data-more]')
  if (more) {
    const open = more.closest('.md-code')?.classList.toggle('is-open') ?? false
    more.setAttribute('aria-expanded', String(open))
    more.textContent = open ? 'Show less' : 'Show more'
    return
  }
  const zoom = target.closest<HTMLElement>('[data-zoom]')
  if (zoom) openZoom(zoom)
}
// A picture opens the viewer with the block's other pictures, so Left/Right step through them.
function openZoom(zoom: HTMLElement) {
  const group = [...(zoom.closest('.md')?.querySelectorAll<HTMLElement>('[data-zoom]') ?? [])].map((b) => ({ src: b.dataset.zoom ?? '', alt: b.querySelector('img')?.alt ?? '' }))
  openLightbox(zoom.dataset.zoom ?? '', zoom.querySelector('img')?.alt ?? '', group)
}
function onKey(e: KeyboardEvent) {
  const zoom = (e.target as HTMLElement).closest<HTMLElement>('[data-zoom]')
  if (zoom) tileKey(e, () => openZoom(zoom))
}
</script>

<template>
  <!-- markdown-it runs with html disabled, so the markup set in paint() is only markdown-it's own -->
  <div ref="root" class="md" :class="streaming && 'md-streaming'" @click="onClick" @keydown="onKey" @keyup="onKey" />
</template>
