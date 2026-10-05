<script setup lang="ts">
// On a folded group's heading, in the desk list and the cloud list: a blue dot with how many CliMayte tasks
// run under its rows and a green one with how many of its chats run (owner, 2026-10-05: "A blue dot with a
// count for CLI Mate tasks and a green dot for tasks in general that are running"), so nothing running is
// out of sight while its group is folded.
defineProps<{ tasks: number; chats: number }>()
</script>

<template>
  <span class="flex shrink-0 items-center gap-1.5 text-[11px] text-text-2 tnum">
    <span v-if="tasks" class="flex items-center gap-1" :title="`${tasks} CliMayte ${tasks === 1 ? 'task runs' : 'tasks run'} in this folded group`">
      <span class="size-1.5 rounded-full bg-accent" aria-hidden="true" />
      <span class="sr-only">CliMayte tasks running:</span>
      {{ tasks }}
    </span>
    <span v-if="chats" class="flex items-center gap-1" :title="`${chats} ${chats === 1 ? 'chat runs' : 'chats run'} in this folded group`">
      <span class="size-1.5 rounded-full bg-[var(--success-text)]" aria-hidden="true" />
      <span class="sr-only">Chats running:</span>
      {{ chats }}
    </span>
  </span>
</template>
