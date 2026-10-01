<script setup lang="ts">
// The CLI tab (owner, 2026-09-30): the Claude CLI accounts table, Quick add included, and right under
// it CliMayte, the tasks chats hand to those same accounts. Laid out like the Instances tab: no page
// padding of its own, each section pads itself. On a wide screen the accounts table is as long as its
// rows (owner, 2026-10-01: "just make it long"; it folds to Quick add) and CliMayte takes what the
// window has left, its task list and task scrolling inside themselves. When the table leaves less
// than CliMayte's minimum, the tab scrolls as a whole (App.vue's <main>).
import CliInstancesSection from '@/components/CliInstancesSection.vue'
import CliMayteView from '@/components/CliMayteView.vue'
</script>

<template>
  <div class="flex min-h-full flex-col gap-2 lg:h-full">
    <CliInstancesSection class="shrink-0" />
    <CliMayteView class="lg:min-h-96 lg:flex-1 lg:basis-0" />
  </div>
</template>
