<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

// The real app shows no browser-native tooltips. One listener turns every title="" in the window
// into the same tooltip Tip draws (#20201f on #f0efec, 500ms in, below the control, flipped above
// at the window's edge), so a control that only sets a title still looks like the real thing.
const SHOW_MS = 500
const EDGE = 8
const GAP = 4

const text = ref('')
const open = ref(false)
const pos = ref({ x: 0, y: 0 })
const tip = ref<HTMLElement | null>(null)
let target: HTMLElement | null = null
let timer: ReturnType<typeof setTimeout> | null = null

function labelOf(el: HTMLElement): string {
  const own = el.getAttribute('title')
  if (own !== null) {
    el.removeAttribute('title')
    if (own) el.dataset.titleTip = own
  }
  return el.dataset.titleTip ?? ''
}

function hide() {
  if (timer) clearTimeout(timer)
  timer = null
  target = null
  open.value = false
}

async function show(el: HTMLElement, label: string) {
  text.value = label
  open.value = true
  await nextTick()
  const box = tip.value
  if (!box || target !== el) return
  const r = el.getBoundingClientRect()
  const x = r.left + r.width / 2 - box.offsetWidth / 2
  const below = r.bottom + GAP
  pos.value = {
    x: Math.max(EDGE, Math.min(window.innerWidth - box.offsetWidth - EDGE, x)),
    y: below + box.offsetHeight > window.innerHeight - EDGE ? r.top - box.offsetHeight - GAP : below,
  }
}

function onOver(e: PointerEvent) {
  const el = (e.target as Element | null)?.closest<HTMLElement>('[title], [data-title-tip]') ?? null
  if (el === target) return
  hide()
  if (!el) return
  const label = labelOf(el)
  if (!label) return
  target = el
  timer = setTimeout(() => show(el, label), SHOW_MS)
}

onMounted(() => {
  document.addEventListener('pointerover', onOver, true)
  document.addEventListener('pointerdown', hide, true)
  document.addEventListener('keydown', hide, true)
  document.addEventListener('scroll', hide, true)
  window.addEventListener('blur', hide)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerover', onOver, true)
  document.removeEventListener('pointerdown', hide, true)
  document.removeEventListener('keydown', hide, true)
  document.removeEventListener('scroll', hide, true)
  window.removeEventListener('blur', hide)
  hide()
})
</script>

<template>
  <!-- Over every menu and dialog (z 50, added to body when they open): a title in a menu showed behind it (owner, 2026-10-05). -->
  <Teleport to="body">
    <div
      v-if="open"
      ref="tip"
      role="tooltip"
      class="pointer-events-none fixed z-[100] max-w-80 whitespace-pre-line rounded-[var(--radius-6)] bg-bg-popover px-2 py-1 text-[12px] leading-4 text-text shadow-(--shadow-menu-ringed)"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
    >
      {{ text }}
    </div>
  </Teleport>
</template>
