<script setup lang="ts">
import { Tip } from '@/components/ui/tooltip'
// On a folded group's heading, in the desk list and the cloud list: a dot with a count for the CliMayte tasks that
// run under its rows and a green one for its chats that run (owner, 2026-10-05: "A blue dot with a count for CLI
// Mate tasks and a green dot for tasks in general that are running"), so nothing running is out of sight while
// its group is folded. Blue then became HSwarm's alone (owner, 2026-10-05: "Only the HSwarm items should have
// blue"): the CliMayte dot is gray, as their lines' marks are, and the HSwarm jobs that run have the blue one.
defineProps<{ tasks: number; jobs: number; chats: number }>()
</script>

<template>
  <span class="flex shrink-0 items-center gap-1.5 text-[11px] text-text-2 tnum">
    <Tip v-if="tasks" :label="`${tasks} CliMayte ${tasks === 1 ? 'task runs' : 'tasks run'} in this folded group`">
      <span class="flex items-center gap-1">
        <span class="size-1.5 rounded-full bg-(--status-working)" aria-hidden="true" />
        <span class="sr-only">CliMayte tasks running:</span>
        {{ tasks }}
      </span>
    </Tip>
    <Tip v-if="jobs" :label="`${jobs} HSwarm ${jobs === 1 ? 'job runs' : 'jobs run'} in this folded group`">
      <span class="flex items-center gap-1">
        <span class="size-1.5 rounded-full bg-accent-text" aria-hidden="true" />
        <span class="sr-only">HSwarm jobs running:</span>
        {{ jobs }}
      </span>
    </Tip>
    <Tip v-if="chats" :label="`${chats} ${chats === 1 ? 'chat runs' : 'chats run'} in this folded group`">
      <span class="flex items-center gap-1">
        <span class="size-1.5 rounded-full bg-(--success-text)" aria-hidden="true" />
        <span class="sr-only">Chats running:</span>
        {{ chats }}
      </span>
    </Tip>
  </span>
</template>
