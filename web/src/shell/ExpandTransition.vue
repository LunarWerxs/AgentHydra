<script setup lang="ts">
// Animated expand/collapse for plain v-if toggles: the CSS grid-rows 0fr↔1fr trick, so
// content animates to its natural height with no JS measurement. Wrap any block that used
// to hard-toggle with v-if and pass the flag as `open` instead:
//   <ExpandTransition :open="showHistory"> ...body... </ExpandTransition>
// For reka-ui Collapsible surfaces keep CollapsibleContent's data-state animation; this is
// for the bare-boolean toggles that never had a Collapsible root.
// The kit-expand-* rules live in styles/base.css (synced as kit-base.css).
defineProps<{ open: boolean }>();
</script>

<template>
  <Transition name="kit-expand">
    <div v-if="open" class="kit-expand-grid">
      <div class="min-h-0 overflow-hidden"><slot /></div>
    </div>
  </Transition>
</template>
