<script setup lang="ts">
import { Ban, Check, LoaderCircle, X } from '@lucide/vue'

defineProps<{ status: 'running' | 'done' | 'error' | 'denied' }>()
</script>

<template>
  <LoaderCircle v-if="status === 'running'" class="size-3.5 shrink-0 animate-spin text-text-muted" aria-label="Running" />
  <Check v-else-if="status === 'done'" class="size-3.5 shrink-0 text-success-text" aria-label="Done" />
  <X v-else-if="status === 'error'" class="size-3.5 shrink-0 text-danger-text" aria-label="Failed" />
  <Ban v-else class="size-3.5 shrink-0 text-text-muted" aria-label="Denied" />
</template>
