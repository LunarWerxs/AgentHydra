<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { AccountInfo, ChatSummary, ExternalSession } from '@shared/protocol'
import { icons, shellGlyphs, shellIcons } from '@/lib/icons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { chatRow, elapsedLabel, folderLabel, glyphDotClass, resetClock, rowMenu, statusGlyph, type RowMenuItem } from '@/components/sidebar/logic'
import { MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR, focusFirstItem, runShortcut } from '@/components/sidebar/menuClasses'
import RowMenuList from '@/components/sidebar/RowMenuList.vue'
import { resumable } from '@/components/external/logic'
import AccountSubmenu from './AccountSubmenu.vue'
import { PanelTopClose, PanelTopOpen } from '@lucide/vue'
import { headerOpen } from '@/components/session-header/state'
import { useClock } from '@/lib/clock'

// The title bar inside the pane (h32): session title (click to rename), its menu, the folder pill,
// Hydra Desk's status cue, and on the right the 26px pane buttons. Hydra Desk 2: an outside session's
// title bar has one, the session header's fold (components/session-header).
export type RightPane = 'diff' | 'climayte'

const props = withDefaults(
  defineProps<{
    chat: ChatSummary | null
    /** Title of a view that is not a chat (CliMayte, Elsewhere, Settings); empty on the new-session screen. */
    title?: string
    pane?: RightPane | null
    /** Accounts for the chat menu's "Account" submenu. */
    accounts?: AccountInfo[]
    /** A session running elsewhere: read-only unless it is a Claude Code session. */
    external?: ExternalSession | null
    /** Its stand-in chat while the composer can carry it on: the "…" menu picks the account it continues on. */
    standIn?: ChatSummary | null
    /** View options: thinking blocks open in the transcript. */
    showThinking?: boolean
    /** The chat menu's Move to group names. */
    groups?: string[]
  }>(),
  { title: '', pane: null, accounts: () => [], external: null, standIn: null, showThinking: false, groups: () => [] }
)
const emit = defineEmits<{
  action: [item: RowMenuItem]
  rename: [title: string]
  'toggle-pane': [pane: RightPane]
  account: [id: string]
  'update:showThinking': [show: boolean]
}>()

const menu = computed(() => (props.chat ? rowMenu(chatRow(props.chat), props.groups) : []))

// Hydra Desk status cue: only states the real app hides (idle and stopped show nothing). Only a working or
// limited chat's cue reads the clock, so the bar redraws on the tick only while its time moves.
const clock = useClock()
const cue = computed(() => {
  const c = props.chat
  if (!c) return null
  const g = statusGlyph(c)
  switch (c.status) {
    case 'starting':
      return { text: 'Starting', tone: 'text-text-muted', dot: 'bg-[var(--status-working)] animate-dot-blink' }
    case 'working': {
      const t = elapsedLabel(c.turnStartedAt, clock.value)
      return { text: t ? `Working · ${t}` : 'Working', tone: 'text-text-muted', dot: 'bg-[var(--status-working)] animate-dot-blink' }
    }
    case 'needs_you':
      return { text: 'Needs you', tone: 'text-warning-text', dot: 'bg-[var(--status-needs-you)] animate-dot-pulse' }
    case 'error':
      return { text: 'Error', tone: 'text-danger-text', dot: 'bg-[var(--status-error)]' }
    case 'limited': {
      const t = resetClock(c.limitResetsAt, clock.value)
      return { text: t ? `Limited · resets ${t}` : 'Limited', tone: 'text-[var(--status-limited-text)]', dot: glyphDotClass(g) }
    }
    case 'closed':
      return { text: g.label, tone: 'text-text-muted opacity-70', dot: '' }
    default:
      return null
  }
})

// Rename in place
const renaming = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement | null>(null)
function startRename() {
  if (!props.chat) return
  draft.value = props.chat.title
  renaming.value = true
  nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
}
function commitRename() {
  if (!renaming.value) return
  renaming.value = false
  const t = draft.value.trim()
  if (t && props.chat && t !== props.chat.title) emit('rename', t)
}
function run(item: RowMenuItem) {
  if (item.action === 'rename') setTimeout(startRename, 0)
  else emit('action', item)
}

const toggleSessionHeader = () => (headerOpen.value = !headerOpen.value)

const PANE_BTN =
  'flex size-[26px] items-center justify-center rounded-[var(--radius-6)] text-text-2 transition-colors duration-[60ms] hover:bg-fill-hover hover:text-text aria-pressed:bg-fill-selected aria-pressed:text-text aria-disabled:cursor-default aria-disabled:hover:bg-transparent aria-expanded:bg-fill-hover aria-expanded:text-text'
</script>

<template>
  <!-- Three columns: the title in the middle one, centred on the pane (Michael, 2026-10-04), with each side
       column at least as wide as the buttons on the right so a long title stops short of them. -->
  <header
    class="grid h-8 min-w-0 grid-cols-[minmax(var(--side),1fr)_minmax(0,auto)_minmax(var(--side),1fr)] items-center pl-1 pr-3 text-[13px] leading-[19.5px]"
    :style="{ '--side': chat ? '116px' : external ? '26px' : '0px' }"
  >
    <span aria-hidden="true" />
    <div class="col-start-2 flex min-w-0 items-center">
    <template v-if="chat">
      <span class="flex size-6 shrink-0 items-center justify-center text-text" aria-hidden="true">
        <component :is="shellGlyphs.local" class="size-4" />
      </span>
      <input
        v-if="renaming"
        ref="input"
        v-model="draft"
        aria-label="Rename session"
        class="h-6 w-[320px] max-w-[40vw] rounded-[var(--radius-6)] bg-bg-deepest px-1 text-[13px] font-medium text-text outline-none ring-1 ring-accent"
        @keydown.enter="commitRename"
        @keydown.escape="renaming = false"
        @blur="commitRename"
      />
      <Tip v-else label="Rename session">
        <button
          type="button"
          :aria-label="`${chat.title}, rename session`"
          class="flex h-6 min-w-0 cursor-default items-center rounded-[var(--radius-6)] px-1 font-medium text-text hover:bg-fill-hover"
          @click="startRename"
        >
          <span class="truncate">{{ chat.title }}</span>
        </button>
      </Tip>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            :aria-label="`More options for ${chat.title}`"
            class="-ml-1 flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-6)] text-text-2 hover:bg-fill-hover hover:text-text data-[state=open]:bg-fill-hover"
          >
            <component :is="shellGlyphs.more" class="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" :class="MENU_CONTENT" @open-auto-focus="focusFirstItem" @keydown.capture="(e: KeyboardEvent) => runShortcut(e, menu)">
          <RowMenuList :entries="menu" kind="dropdown" @run="run" />
          <template v-if="accounts.length">
            <DropdownMenuSeparator :class="MENU_SEPARATOR" />
            <AccountSubmenu :accounts="accounts" :current="chat.account.id" note="Applies at the chat's next start" @pick="(id: string) => emit('account', id)" />
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tip :label="chat.cwd">
        <span class="ml-1 flex h-5 shrink-0 items-center rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-[5px] text-[12px] leading-4 text-text-2">
          {{ folderLabel(chat.cwd) }}
        </span>
      </Tip>

      <!-- Hydra Desk extras -->
      <span v-if="cue" class="ml-2 flex h-5 shrink-0 items-center gap-1.5 text-[12px] leading-4" :class="cue.tone" role="status">
        <span v-if="cue.dot" class="size-1.5 rounded-full" :class="cue.dot" />
        <span class="tnum">{{ cue.text }}</span>
      </span>
      <Tip v-if="chat.climayteActive > 0" label="CliMayte workers">
        <button
          type="button"
          class="ml-2 flex h-5 shrink-0 cursor-default items-center gap-1 rounded-[var(--radius-6)] px-[5px] text-[12px] leading-4 text-text-2 hover:bg-fill-hover"
          :aria-label="`${chat.climayteActive} CliMayte ${chat.climayteActive === 1 ? 'worker' : 'workers'} active`"
          :aria-pressed="pane === 'climayte'"
          @click="emit('toggle-pane', 'climayte')"
        >
          <component :is="shellIcons.climayte" class="size-3.5" />
          <span class="tnum">{{ chat.climayteActive }}</span>
        </button>
      </Tip>
    </template>
    <template v-else-if="external">
      <span class="truncate px-1 font-medium text-text">{{ external.title }}</span>
      <span v-if="!resumable(external)" class="ml-1 shrink-0 text-[12px] leading-4 text-text-muted">read-only</span>
      <DropdownMenu v-else-if="standIn && accounts.length">
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            :aria-label="`More options for ${external.title}`"
            class="-ml-1 flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-6)] text-text-2 hover:bg-fill-hover hover:text-text data-[state=open]:bg-fill-hover"
          >
            <component :is="shellGlyphs.more" class="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" :class="MENU_CONTENT" @open-auto-focus="focusFirstItem">
          <AccountSubmenu :accounts="accounts" :current="standIn.account.id" note="Where its next message continues it" @pick="(id: string) => emit('account', id)" />
        </DropdownMenuContent>
      </DropdownMenu>
    </template>
    <span v-else-if="title" class="truncate px-1 font-medium text-text">{{ title }}</span>
    </div>

    <div v-if="chat" class="col-start-3 flex shrink-0 items-center gap-1 justify-self-end">
      <Tip label="Terminal (not in Hydra Desk)">
        <button type="button" :class="PANE_BTN" aria-label="Terminal" aria-disabled="true">
          <component :is="shellGlyphs.terminal" class="size-4" />
        </button>
      </Tip>
      <Tip label="Changes">
        <button type="button" :class="PANE_BTN" aria-label="Changes" :aria-pressed="pane === 'diff'" @click="emit('toggle-pane', 'diff')">
          <component :is="shellGlyphs.changes" class="size-4" />
        </button>
      </Tip>
      <Tip label="Browser (not in Hydra Desk)">
        <button type="button" :class="PANE_BTN" aria-label="Browser" aria-disabled="true">
          <component :is="shellGlyphs.browser" class="size-4" />
        </button>
      </Tip>
      <Tip label="View options">
        <span class="inline-flex">
      <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button type="button" :class="PANE_BTN" aria-label="View options">
              <component :is="shellGlyphs.viewOptionsDots" class="size-4" />
            </button>
          </DropdownMenuTrigger>
        <DropdownMenuContent align="end" :class="MENU_CONTENT" @open-auto-focus="focusFirstItem">
          <DropdownMenuItem role="menuitemcheckbox" :aria-checked="showThinking" :class="MENU_ITEM" @select="emit('update:showThinking', !showThinking)">
            <span class="flex-1">Show thinking</span>
            <span class="flex size-4 items-center justify-center"><component :is="icons.check" v-if="showThinking" /></span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
        </span>
      </Tip>
    </div>
    <Tip v-else-if="external" :label="headerOpen ? 'Hide session details' : 'Show session details'">
      <button type="button" :class="PANE_BTN" class="col-start-3 justify-self-end" :aria-label="headerOpen ? 'Hide session details' : 'Show session details'" @click="toggleSessionHeader">
        <component :is="headerOpen ? PanelTopClose : PanelTopOpen" class="size-4" />
      </button>
    </Tip>
  </header>
</template>
