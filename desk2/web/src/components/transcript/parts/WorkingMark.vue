<script setup lang="ts">
// The orange mark of a chat at work, in one of four looks (lib/working-mark.ts; the window's choice unless a
// variant is given, as Settings does to show them side by side). Every look fits a 16x20 cell, the cell the
// Claude Code spinner had, so the text after it stands where it always did. working-mark.css draws them.
import { computed } from 'vue'
import { workingMark, type WorkingMarkVariant } from '../lib/working-mark'
import '../working-mark.css'

const props = defineProps<{ variant?: WorkingMarkVariant; /** Said to a screen reader; without it the mark is decoration. */ label?: string }>()
const shown = computed(() => props.variant ?? workingMark.value)
const GLYPHS = ['·', '✢', '✳', '✶', '✻']
</script>

<template>
  <span class="wm" :data-variant="shown" :role="label ? 'img' : undefined" :aria-label="label" :aria-hidden="label ? undefined : 'true'">
    <span v-if="shown === 'spark'" class="wm-strip"><span v-for="g in GLYPHS" :key="g">{{ g }}</span></span>
    <span v-else class="wm-box">
      <span v-for="n in shown === 'breathe' ? 1 : 3" :key="n" class="wm-dot" />
    </span>
    <span class="wm-still" />
  </span>
</template>
