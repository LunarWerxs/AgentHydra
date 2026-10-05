<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue'

// On a folded group's heading, in the desk list and the cloud list: how many CliMayte tasks run under its
// rows, so a running task is never out of sight while its group is folded (owner, 2026-10-05: "Is one
// smaller than six?").
defineProps<{ count: number }>()
</script>

<template>
  <span class="flex shrink-0 items-center gap-0.5 text-[11px] text-accent-text tnum" :title="`${count} CliMayte ${count === 1 ? 'task runs' : 'tasks run'} in this folded group`">
    <LoaderCircle class="size-3 animate-spin" aria-hidden="true" />
    <span class="sr-only">CliMayte tasks running:</span>
    {{ count }}
  </span>
</template>
