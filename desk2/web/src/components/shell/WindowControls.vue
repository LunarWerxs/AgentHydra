<script setup lang="ts">
// Minimize, maximize and close at the title bar's right end, drawn as Windows 11 draws them (46 wide, the title row
// high, Segoe Fluent Icons glyphs, a red Close on hover), once the host has taken its own caption off
// (lib/host-window.ts). Above everything, dialogs included, as Windows' own were. Not tab stops: Alt + Space opens the
// window menu, as it always has. A 4px strip along the top edge starts the host's resize drag there, the corners
// diagonally; Windows keeps the left, right and bottom edges.
// The host lays a see-through window of its own over the three (its caption sink), placed from where they are here,
// so Windows knows Maximize for Maximize and shows its snap layouts there (owner, 2026-10-08). The pointer is the
// host's over them then: it clicks them itself and says which one is hovered or held, which is what is drawn; the
// CSS hover stays for a host without the sink. The top strip is left out of the sink, so it still resizes.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { captionHover, captionPressed, closeWindow, maximized, minimizeWindow, placeButtons, resizeFrom, toggleMaximize, type CaptionButton } from '@/lib/host-window'

const BTN = 'flex h-full w-[46px] items-center justify-center text-text-2 transition-colors duration-[60ms] hover:bg-fill-hover hover:text-text active:bg-fill-selected'
const CLOSE = 'hover:bg-[#c42b1c] hover:text-white active:bg-[#c42b1c]/90'
/** What the host says the pointer is doing on a button, drawn as the CSS hover and press would be. */
const state = (b: CaptionButton) =>
  captionPressed.value === b
    ? b === 'close' ? 'bg-[#c42b1c]/90 text-white' : 'bg-fill-selected text-text'
    : captionHover.value === b
      ? b === 'close' ? 'bg-[#c42b1c] text-white' : 'bg-fill-hover text-text'
      : ''
const edge = (e: PointerEvent, at: 'n' | 'ne' | 'nw') => {
  if (e.button !== 0) return
  e.preventDefault()
  resizeFrom(at)
}

/** The resize strip's height (h-1): the sink starts below it unless maximized, when there is no top edge to drag. */
const STRIP = 4
const bar = ref<HTMLElement | null>(null)
let frame = 0
function place() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    const r = bar.value?.getBoundingClientRect()
    if (!r) return
    const top = maximized.value ? 0 : STRIP
    placeButtons({ left: r.left, top: r.top + top, width: r.width, height: r.height - top })
  })
}
watch(maximized, place)
onMounted(() => {
  place()
  // A move to a screen of another scale fires one as well.
  window.addEventListener('resize', place)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  window.removeEventListener('resize', place)
  placeButtons(null)
})
</script>

<template>
  <div ref="bar" class="no-drag fixed right-0 top-0 z-70 flex h-9 select-none font-[Segoe_Fluent_Icons,Segoe_MDL2_Assets] text-[10px]" data-testid="window-controls">
    <button type="button" tabindex="-1" aria-label="Minimize" :class="[BTN, state('minimize')]" @click="minimizeWindow">&#xE921;</button>
    <button type="button" tabindex="-1" :aria-label="maximized ? 'Restore' : 'Maximize'" :class="[BTN, state('maximize')]" @click="toggleMaximize">
      {{ maximized ? '' : '' }}
    </button>
    <button type="button" tabindex="-1" aria-label="Close" :class="[BTN, CLOSE, state('close')]" @click="closeWindow">&#xE8BB;</button>
  </div>
  <template v-if="!maximized">
    <div class="no-drag fixed left-0 top-0 z-71 h-1 w-2 cursor-nwse-resize" aria-hidden="true" @pointerdown="edge($event, 'nw')" />
    <div class="no-drag fixed inset-x-2 top-0 z-71 h-1 cursor-ns-resize" aria-hidden="true" @pointerdown="edge($event, 'n')" />
    <div class="no-drag fixed right-0 top-0 z-71 h-1 w-2 cursor-nesw-resize" aria-hidden="true" @pointerdown="edge($event, 'ne')" />
  </template>
</template>
