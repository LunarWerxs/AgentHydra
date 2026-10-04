<script setup lang="ts">
import { computed } from 'vue'

const modules = import.meta.glob<{ default: any }>('./sections/*.vue', { eager: true })

const sections = computed(() => {
  const list = Object.entries(modules).map(([path, mod]) => {
    const name = path.match(/\/([^/]+)\.vue$/)?.[1] || 'Unknown'
    return { name, component: mod.default }
  })
  // The token layer first, so the palette can be eyeballed without scrolling.
  return list.sort((a, b) => Number(b.name === 'TokensSection') - Number(a.name === 'TokensSection'))
})
</script>

<template>
  <div class="bg-[var(--bg-page)] text-[var(--text)] min-h-screen">
    <!-- Sections -->
    <div v-for="section in sections" :key="section.name" class="border-b border-[var(--border)] p-4">
      <h2 class="text-xl font-bold mb-4">{{ section.name }}</h2>
      <component :is="section.component" />
    </div>
  </div>
</template>
