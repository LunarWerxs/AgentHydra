<script setup lang="ts">
import type { AccountInfo } from '@shared/protocol'
import { newSessionGlyphs } from '@/lib/icons'
import type { ComposerApi } from './api'
import AccountPicker from './AccountPicker.vue'
import FolderPicker from './FolderPicker.vue'
import { ENV_PILL, PILL_TEXT } from './pill'

// The env pills above the new-session box, loose on the page like the real ones: the folder, the branch
// with its worktree checkbox, Add another folder; the chosen account sits quietly at the end. Every chat
// runs on this computer, so the real Local/Cloud pill is left out. Hydra Desk has no worktrees or extra
// folders yet, so those pills are shown as the real app draws them but do nothing.
defineProps<{ cwd: string | null; api: ComposerApi; branch: string | null; account: string; accounts: AccountInfo[] }>()
const emit = defineEmits<{ 'update:cwd': [cwd: string] }>()

const SOON = 'Not available in Hydra Desk yet'
</script>

<template>
  <div role="group" aria-label="Environment" class="mb-1 flex h-6 min-w-0 items-center gap-1.5">
    <FolderPicker :model-value="cwd" :api="api" @update:model-value="(v) => emit('update:cwd', v)" />

    <span v-if="branch" :class="ENV_PILL" class="min-w-0 shrink" :title="`On branch ${branch}`">
      <newSessionGlyphs.branch class="size-4 shrink-0" />
      <span class="truncate" :class="PILL_TEXT">{{ branch }}</span>
      <span class="ml-2 flex shrink-0 items-center" :title="`Worktree: ${SOON}`">
        <span class="h-2.5 w-px bg-[var(--fill-secondary)]" aria-hidden="true" />
        <span
          role="checkbox"
          aria-checked="false"
          aria-disabled="true"
          aria-label="worktree"
          class="ml-[5px] size-3 rounded-[3px] border border-[#ffffff33]"
        />
        <span class="ml-[3px]" :class="PILL_TEXT" aria-hidden="true">worktree</span>
      </span>
    </span>

    <button type="button" :class="ENV_PILL" class="cursor-default" aria-label="Add another folder" aria-disabled="true" :title="`Add another folder: ${SOON}`">
      <newSessionGlyphs.addFolder class="size-4 shrink-0" />
    </button>

    <span class="flex-1" />
    <AccountPicker :model-value="account" :api="api" :accounts="accounts" />
  </div>
</template>
