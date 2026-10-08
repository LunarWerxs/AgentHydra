<script setup lang="ts">
import { computed, ref } from 'vue'
import { DIAGNOSTICS_SECTIONS } from './sections'

// The Diagnostics page: a row of section tabs and the open section under it. Sections live in sections.ts.
const open = ref(DIAGNOSTICS_SECTIONS[0]!.id)
const current = computed(() => DIAGNOSTICS_SECTIONS.find((s) => s.id === open.value) ?? DIAGNOSTICS_SECTIONS[0]!)
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="diagnostics">
    <div v-if="DIAGNOSTICS_SECTIONS.length > 1" role="tablist" aria-label="Diagnostics" class="flex gap-1">
      <button
        v-for="s in DIAGNOSTICS_SECTIONS"
        :key="s.id"
        type="button"
        role="tab"
        :aria-selected="open === s.id"
        class="flex h-7 cursor-default items-center rounded-(--radius-6) px-2.5 text-[13px] leading-4.75 focus-visible:shadow-(--focus-ring) focus-visible:outline-none"
        :class="open === s.id ? 'bg-fill-selected text-text' : 'text-text-2 hover:bg-fill-hover hover:text-text'"
        @click="open = s.id"
      >
        {{ s.label }}
      </button>
    </div>
    <component :is="current.component" />
  </div>
</template>
