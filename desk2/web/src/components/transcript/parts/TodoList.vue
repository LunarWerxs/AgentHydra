<script setup lang="ts">
import { Check, Circle, CircleDot } from '@lucide/vue'
import type { TodoEntry } from '@shared/protocol'

defineProps<{ todos: TodoEntry[] }>()
</script>

<template>
  <ul class="text-sm/5">
    <li v-for="(t, i) in todos" :key="i" class="flex items-start gap-2 py-0.5">
      <Check v-if="t.status === 'completed'" class="mt-0.5 size-4 shrink-0 text-success-text" />
      <CircleDot v-else-if="t.status === 'in_progress'" class="mt-0.5 size-4 shrink-0 text-accent-text" />
      <Circle v-else class="mt-0.5 size-4 shrink-0 text-text-muted" />
      <span
        :class="
          t.status === 'completed'
            ? 'text-text-muted line-through'
            : t.status === 'in_progress'
              ? 'text-text'
              : 'text-text-muted'
        "
      >{{ t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content }}</span>
    </li>
  </ul>
</template>
