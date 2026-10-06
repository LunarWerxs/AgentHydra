<script setup lang="ts">
// The CLI page (owner, 2026-09-30): the Claude CLI accounts table, Quick add included. CliMayte, the
// tasks chats hand to those accounts, is a node of the HSwarm tab's tree. No page padding of its own: the
// table pads itself, and App.vue's <main> scrolls the page when the table is longer than the window.
import CliInstancesSection from '@/components/CliInstancesSection.vue'
</script>

<template>
  <CliInstancesSection />
</template>
