<script setup lang="ts">
// The CLI tab (owner, 2026-09-30): the Claude CLI accounts table, Quick add included, and right under
// it CliMayte, the tasks chats hand to those same accounts. Laid out like the Instances tab: no page
// padding of its own, each section pads itself. On a wide screen the tab fits the window and the page
// does not scroll (owner, 2026-10-01): the accounts table keeps its height (it folds to Quick add),
// CliMayte fills the rest, and its task list and task scroll inside themselves. A window too short
// for CliMayte's minimum falls back to App.vue's <main> scrolling.
import CliInstancesSection from '@/components/CliInstancesSection.vue'
import CliMayteView from '@/components/CliMayteView.vue'
</script>

<template>
  <div class="flex min-h-full flex-col gap-2 lg:h-full">
    <CliInstancesSection class="shrink-0" />
    <CliMayteView class="lg:min-h-[24rem] lg:flex-1 lg:basis-0" />
  </div>
</template>
