<script setup lang="ts">
import { computed } from 'vue'
import { markdown, shikiReady } from '../lib/highlight'
import { openLightbox } from '../lib/media'

const props = defineProps<{ text: string; streaming?: boolean }>()

const html = computed(() => {
  void shikiReady.value // re-render once highlighting is available
  return markdown.render(props.text)
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
  if (zoom) openLightbox(zoom.dataset.zoom ?? '', zoom.querySelector('img')?.alt ?? '')
}
</script>

<template>
  <!-- markdown-it runs with html disabled, so v-html only ever holds markdown-it's own markup -->
  <div class="md" :class="streaming && 'md-streaming'" @click="onClick" v-html="html" />
</template>
