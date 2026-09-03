<script setup lang="ts">
// Port of dashboard.html's renderTiles(): one clickable tile per decision kind, in a fixed
// order, plus a final "visible chats scanned" tile that clears the filter (kind: null).
import { type DecisionKind, KINDS, type Plan } from '@/lib/api'

const props = defineProps<{ plan: Plan; filter: DecisionKind | null }>()
const emit = defineEmits<{ select: [kind: DecisionKind | null] }>()

const ORDER: DecisionKind[] = [
  'wait-on-person',
  'judgment',
  'archive',
  'held-back',
  'resume',
  'cannot',
]

const DOT: Record<string, string> = {
  warning: 'bg-warning',
  success: 'bg-success',
  destructive: 'bg-destructive',
  info: 'bg-info',
  secondary: 'bg-secondary-foreground',
  primary: 'bg-primary',
}
</script>

<template>
  <div class="my-3.5 flex flex-wrap gap-2.5">
    <button
      v-for="kind in ORDER"
      :key="kind"
      type="button"
      class="min-w-[130px] rounded-lg border bg-card px-3.5 py-2.5 text-left transition-colors hover:border-muted-foreground/40"
      :class="filter === kind ? 'border-primary ring-1 ring-primary' : 'border-border'"
      :aria-pressed="filter === kind"
      @click="emit('select', kind)"
    >
      <div class="text-2xl font-semibold leading-tight">{{ props.plan.counts[kind] || 0 }}</div>
      <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span class="size-2 shrink-0 rounded-full" :class="DOT[KINDS[kind].badge]" />
        {{ KINDS[kind].icon }} {{ KINDS[kind].label }}
      </div>
    </button>

    <button
      type="button"
      class="min-w-[130px] rounded-lg border bg-card px-3.5 py-2.5 text-left transition-colors hover:border-muted-foreground/40"
      :class="filter === null ? 'border-primary ring-1 ring-primary' : 'border-border'"
      :aria-pressed="filter === null"
      @click="emit('select', null)"
    >
      <div class="text-2xl font-semibold leading-tight">{{ props.plan.scanned }}</div>
      <div class="text-xs text-muted-foreground">🗂 visible chats scanned</div>
    </button>
  </div>
</template>
