<script setup lang="ts">
// The real "Repository and pull request controls" strip: a separate 40px card above the box
// (docs/reference/real/composer-strip-above-box.png). Left: project and branch (or, for a new
// session, the slot: folder and account pickers). Right: +N -N (opens the diff), Create PR split
// button, Dismiss.
import { computed } from 'vue'
import { icons } from '@/lib/icons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { ConnectorView } from '@shared/connectors'
import { formatCount } from './logic'
import RepoYetiActions from './RepoYetiActions.vue'
import { installItem, yetiRuns, type BarGit } from './repoyeti-bar'
import { ITEM, MENU, SEPARATOR, STRIP_BUTTON } from './menu'
import { Tip } from '@/components/ui/tooltip'

const props = defineProps<{
  project: string | null
  projectPath?: string | null
  branch: string | null
  added: number
  removed: number
  /** Create PR is offered when there is a chat to ask and a branch to open it from. */
  canCreatePr: boolean
  /** RepoYeti's connector entry: while it runs, its git actions replace Create PR. */
  yeti?: ConnectorView | null
  cwd?: string | null
  chatId?: string | null
  git?: BarGit
}>()
const emit = defineEmits<{
  'open-diff': []
  'create-pr': [draft: boolean]
  dismiss: []
  'yeti-install': [action: 'install' | 'start']
  'open-yeti': []
  notice: [text: string]
  changed: []
}>()

const install = computed(() => installItem(props.yeti ?? null))

const X = icons.dismiss
const Chevron = icons.morePrOptions
</script>

<template>
  <nav
    aria-label="Repository and pull request controls"
    class="flex h-10 items-center gap-[5px] rounded-[var(--radius-10)] bg-[var(--fill-5)] p-2 text-[13px] leading-[19px]"
  >
    <div class="flex min-w-0 flex-1 items-center gap-[5px]">
      <slot>
        <!-- One mono run, "project branch" with a single space, like the real strip. -->
        <Tip v-if="project || branch" :label="projectPath ?? project ?? ''" side="top">
          <span
            class="flex h-6 min-w-0 items-center gap-[1ch] truncate rounded-[var(--radius-6)] px-[5px] font-mono text-[var(--text-muted)]"
          >
            <span v-if="project" class="truncate">{{ project }}</span>
            <span v-if="branch" class="truncate">{{ branch }}</span>
          </span>
        </Tip>
      </slot>
    </div>

    <Tip v-if="added || removed" label="Show the changes" side="top">
      <button
        type="button"
        :class="STRIP_BUTTON"
        class="gap-0.5 bg-[var(--fill-secondary)] font-medium hover:bg-[var(--fill-secondary-hover)]"
        :aria-label="`${formatCount(added)} additions, ${formatCount(removed)} deletions`"
        @click="emit('open-diff')"
      >
        <span class="tnum text-[var(--git-add)]">+{{ formatCount(added) }}</span>
        <span class="tnum text-[var(--git-del)]">−{{ formatCount(removed) }}</span>
      </button>
    </Tip>

    <RepoYetiActions
      v-if="yetiRuns(yeti ?? null) && cwd && git"
      :cwd="cwd"
      :chat-id="chatId ?? null"
      :git="git"
      @notice="emit('notice', $event)"
      @open-yeti="emit('open-yeti')"
      @changed="emit('changed')"
    />

    <div v-else-if="canCreatePr" role="group" aria-label="Create PR" class="flex h-6 shrink-0 items-stretch overflow-hidden rounded-[var(--radius-6)] bg-[var(--fill-secondary)]">
      <Tip label="Ask Claude to commit and open a pull request" side="top">
        <button
          type="button"
          class="px-2 text-[13px] font-medium text-[var(--text)] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)]"
          @click="emit('create-pr', false)"
        >
          Create PR
        </button>
      </Tip>
      <span class="my-1 w-px bg-[var(--border)]" />
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            class="flex w-6 items-center justify-center text-[var(--text-muted)] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] hover:text-[var(--text)]"
            aria-label="More PR options"
          >
            <Chevron class="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" :side-offset="6" :class="MENU">
          <DropdownMenuItem :class="ITEM" @select="emit('create-pr', false)">Create PR</DropdownMenuItem>
          <DropdownMenuItem :class="ITEM" @select="emit('create-pr', true)">Create draft PR</DropdownMenuItem>
          <DropdownMenuItem :class="ITEM" @select="emit('open-diff')">Review changes</DropdownMenuItem>
          <template v-if="install">
            <DropdownMenuSeparator :class="SEPARATOR" />
            <DropdownMenuItem :class="ITEM" :disabled="!install.enabled" @select="install.action && emit('yeti-install', install.action)">{{ install.label }}</DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <Tip label="Hide this bar until the folder changes" side="top">
      <button
        type="button"
        class="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-6)] text-[var(--text-muted)] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] hover:text-[var(--text)]"
        aria-label="Dismiss"
        @click="emit('dismiss')"
      >
        <X class="size-4" />
      </button>
    </Tip>
  </nav>
</template>
