<script setup lang="ts">
// The CLI tab (owner, 2026-09-30): the Claude CLI accounts table, Quick add included, and right under
// it Corch, the tasks chats hand to those same accounts. One scroll area (App.vue's <main>), laid out
// like the Instances tab: no page padding of its own, each section pads itself.
import CliInstancesSection from '@/components/CliInstancesSection.vue'
import CorchView from '@/components/CorchView.vue'
</script>

<template>
  <div class="flex min-h-full flex-col gap-2">
    <CliInstancesSection />
    <CorchView />
  </div>
</template>
