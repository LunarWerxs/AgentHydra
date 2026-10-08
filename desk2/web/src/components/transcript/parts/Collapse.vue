<script setup lang="ts">
// What a status row or tool header opens, sliding open and shut (owner, 2026-10-08: "have a slight
// animation. They're a little bit rough"): height and opacity from nothing to the content's own height over
// COLLAPSE_MS, ease-out, and back. The content still mounts only when open (a long transcript has thousands of
// closed rows). The animation is the Web Animations API on the box, so nothing is left inline when it ends:
// the box is at its natural height again, and the transcript's ResizeObserver measures that last.
// The box is a flow-root so its children's margins stay inside it and the height it animates to is the
// height it ends at.
import { COLLAPSE_MS, reducedMotion } from '../lib/motion'

defineProps<{ open: boolean }>()

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

function slide(el: Element, from: number, to: number, done: () => void) {
  const box = el as HTMLElement
  // A row toggled again mid-way starts from where the last slide had it.
  box.getAnimations().forEach((a) => a.cancel())
  if (reducedMotion()) return done()
  box.style.overflow = 'hidden'
  const run = box.animate(
    [
      { height: `${from}px`, opacity: from ? 1 : 0 },
      { height: `${to}px`, opacity: to ? 1 : 0 }
    ],
    { duration: COLLAPSE_MS, easing: EASE }
  )
  const end = () => {
    box.style.overflow = ''
    done()
  }
  run.onfinish = end
  run.oncancel = end
}

const onEnter = (el: Element, done: () => void) => slide(el, 0, (el as HTMLElement).scrollHeight, done)
const onLeave = (el: Element, done: () => void) => slide(el, (el as HTMLElement).getBoundingClientRect().height, 0, done)
</script>

<template>
  <Transition :css="false" @enter="onEnter" @leave="onLeave">
    <div v-if="open" class="tx-collapse"><slot /></div>
  </Transition>
</template>
