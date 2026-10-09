<script setup lang="ts">
// The orange mark of a chat at work, in one of seven looks (lib/working-mark.ts picks the window's one for the
// current five-minute slot; a `variant` shows a chosen look, as a gallery of them side by side would). Every look
// fits a 16x20 cell, the cell the Claude Code spinner had, so the text after it stands where it always did.
// working-mark.css draws them.
import { computed } from 'vue'
import { workingMark, type WorkingMarkVariant } from '../lib/working-mark'
import '../working-mark.css'

const props = defineProps<{ variant?: WorkingMarkVariant; /** Said to a screen reader; without it the mark is decoration. */ label?: string }>()
const shown = computed(() => props.variant ?? workingMark.value)
/** The dots each look draws (working-mark.css places them); Spark draws its star instead. */
const DOTS: Record<Exclude<WorkingMarkVariant, 'spark'>, number> = { square: 3, orbit: 3, wave: 3, ripple: 3, breathe: 1, tumble: 1 }
</script>

<template>
  <span class="wm" :data-variant="shown" :role="label ? 'img' : undefined" :aria-label="label" :aria-hidden="label ? undefined : 'true'">
    <span v-if="shown === 'spark'" class="wm-glyph">✻</span>
    <span v-else class="wm-box">
      <span v-for="n in DOTS[shown]" :key="n" class="wm-dot" />
    </span>
    <span class="wm-still" />
  </span>
</template>
