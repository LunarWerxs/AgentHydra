<script setup lang="ts">
import type { AccountInfo } from '@shared/protocol'
import { newSessionGlyphs } from '@/lib/icons'
import { Tip } from '@/components/ui/tooltip'
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

    <Tip v-if="branch" :label="`On branch ${branch}`">
      <span :class="ENV_PILL" class="min-w-0 shrink">
        <newSessionGlyphs.branch class="size-4 shrink-0" />
        <span class="truncate" :class="PILL_TEXT">{{ branch }}</span>
        <Tip :label="`Worktree: ${SOON}`">
          <span class="ms-2 flex shrink-0 items-center">
            <span class="h-2.5 w-px bg-(--fill-secondary)" aria-hidden="true" />
            <span
              role="checkbox"
              aria-checked="false"
              aria-disabled="true"
              aria-label="worktree"
              class="ms-1.25 size-3 rounded-[3px] border border-[#ffffff33]"
            />
            <span class="ms-0.75" :class="PILL_TEXT" aria-hidden="true">worktree</span>
          </span>
        </Tip>
      </span>
    </Tip>

    <Tip :label="`Add another folder: ${SOON}`">
      <button type="button" :class="ENV_PILL" class="cursor-default" aria-label="Add another folder" aria-disabled="true">
        <newSessionGlyphs.addFolder class="size-4 shrink-0" />
      </button>
    </Tip>

    <span class="flex-1" />
    <AccountPicker :model-value="account" :api="api" :accounts="accounts" />
  </div>
</template>
