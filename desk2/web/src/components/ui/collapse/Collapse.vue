<script setup lang="ts">
import { Transition } from 'vue'
import { CLOSE_MS } from '@/lib/row-leave'

// Folds the slot shut when it leaves, so the rows under it close up instead of snapping. With reduced
// motion asked for, or the window hidden (its animations do not run), it goes at once.

function leave(el: Element, done: () => void) {
  const box = el as HTMLElement
  if (typeof box.animate !== 'function' || document.visibilityState === 'hidden' || matchMedia('(prefers-reduced-motion: reduce)').matches) return done()
  box.style.overflow = 'hidden'
  let ended = false
  const end = () => {
    if (ended) return
    ended = true
    clearTimeout(timer)
    done()
  }
  // The timer ends it anyway, should the animation never finish (a window hidden halfway).
  const timer = setTimeout(end, CLOSE_MS + 200)
  const close = box.animate([{ height: `${box.offsetHeight}px` }, { height: '0px' }], {
    duration: CLOSE_MS,
    easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
    fill: 'forwards'
  })
  close.onfinish = close.oncancel = end
}
</script>

<template>
  <Transition :css="false" @leave="leave">
    <slot />
  </Transition>
</template>
