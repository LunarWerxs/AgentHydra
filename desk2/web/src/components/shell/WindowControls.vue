<script setup lang="ts">
// Minimize, maximize and close at the title bar's right end, drawn as Windows 11 draws them (46 wide, the title row
// high, Segoe Fluent Icons glyphs, a red Close on hover), once the host has taken its own caption off
// (lib/host-window.ts). Above everything, dialogs included, as Windows' own were. Not tab stops: Alt + Space opens the
// window menu, as it always has. A 4px strip along the top edge starts the host's resize drag there, the corners
// diagonally; Windows keeps the left, right and bottom edges.
import { closeWindow, maximized, minimizeWindow, resizeFrom, toggleMaximize } from '@/lib/host-window'

const BTN = 'flex h-full w-[46px] items-center justify-center text-text-2 transition-colors duration-[60ms] hover:bg-fill-hover hover:text-text active:bg-fill-selected'
const edge = (e: PointerEvent, at: 'n' | 'ne' | 'nw') => {
  if (e.button !== 0) return
  e.preventDefault()
  resizeFrom(at)
}
</script>

<template>
  <div class="no-drag fixed right-0 top-0 z-70 flex h-9 select-none font-[Segoe_Fluent_Icons,Segoe_MDL2_Assets] text-[10px]" data-testid="window-controls">
    <button type="button" tabindex="-1" aria-label="Minimize" :class="BTN" @click="minimizeWindow">&#xE921;</button>
    <button type="button" tabindex="-1" :aria-label="maximized ? 'Restore' : 'Maximize'" :class="BTN" @click="toggleMaximize">
      {{ maximized ? '' : '' }}
    </button>
    <button type="button" tabindex="-1" aria-label="Close" :class="[BTN, 'hover:bg-[#c42b1c] hover:text-white active:bg-[#c42b1c]/90']" @click="closeWindow">&#xE8BB;</button>
  </div>
  <template v-if="!maximized">
    <div class="no-drag fixed left-0 top-0 z-71 h-1 w-2 cursor-nwse-resize" aria-hidden="true" @pointerdown="edge($event, 'nw')" />
    <div class="no-drag fixed left-2 right-2 top-0 z-71 h-1 cursor-ns-resize" aria-hidden="true" @pointerdown="edge($event, 'n')" />
    <div class="no-drag fixed right-0 top-0 z-71 h-1 w-2 cursor-nesw-resize" aria-hidden="true" @pointerdown="edge($event, 'ne')" />
  </template>
</template>
