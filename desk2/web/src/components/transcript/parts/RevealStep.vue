<script setup lang="ts">
// The working line's ">" (owner, 2026-10-08, after Claude Desktop's): opens the step the line names in the transcript
// (TranscriptView's revealStep). Drawn after the line's words, on WorkingFooter and ExternalSessionView's live lines.
import { ChevronRight } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
</script>

<template>
  <Tip label="Show this step">
    <button
      type="button"
      class="-mx-0.5 grid size-5 shrink-0 place-items-center rounded text-text-muted transition-colors duration-60 hover:bg-fill-hover hover:text-text"
      aria-label="Show this step"
    >
      <ChevronRight class="size-3.5" />
    </button>
  </Tip>
</template>
