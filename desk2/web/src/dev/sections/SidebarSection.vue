<script setup lang="ts">
import { provide } from 'vue'
import Sidebar from '@/components/sidebar/Sidebar.vue'
import { SHELL_SOURCE } from '@/components/shell/source'
import { demoSource } from '@/components/shell/demo'

// The sidebar at its real size (288 wide) on the same rows as docs/reference/real/sidebar.png, plus
// one row per Hydra Desk status cue and the sessions running elsewhere; beside it the account popup
// open. The whole window is at #/gallery/shell (and /new, /accounts, /external, /settings).
provide(SHELL_SOURCE, demoSource())
</script>

<template>
  <div class="flex flex-wrap items-start gap-6">
    <div>
      <h3 class="mb-2 text-sm text-[var(--text-muted)]">Sidebar (account popup closed)</h3>
      <div class="flex h-[720px] w-[288px] overflow-hidden rounded-[var(--radius-8)] border border-[var(--border)]">
        <Sidebar :width="288" />
      </div>
    </div>
    <div>
      <h3 class="mb-2 text-sm text-[var(--text-muted)]">Account popup open (choosing a row saves the default account for new chats)</h3>
      <div class="flex h-[720px] w-[288px] overflow-hidden rounded-[var(--radius-8)] border border-[var(--border)]">
        <Sidebar :width="288" accounts-open />
      </div>
    </div>
  </div>
</template>
