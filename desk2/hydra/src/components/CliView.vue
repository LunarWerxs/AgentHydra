<script setup lang="ts">
// The CLI page (owner, 2026-09-30): the Claude CLI accounts table, Quick add included. CliMayte, the
// tasks chats hand to those accounts, has its own tab. No page padding of its own: the table pads
// itself, and App.vue's <main> scrolls the page when the table is longer than the window.
import CliInstancesSection from '@/components/CliInstancesSection.vue'
</script>

<template>
  <CliInstancesSection />
</template>
