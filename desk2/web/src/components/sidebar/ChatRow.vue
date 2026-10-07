<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { ChatSummary } from '@shared/protocol'
import { shellGlyphs } from '@/lib/icons'
import { useClock } from '@/lib/clock'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { chatRow, elapsedLabel, glyphDotClass, resetClock, rowMenu, rowTooltip, statusGlyph, type RowMenuItem } from './logic'
import { Tip } from '@/components/ui/tooltip'
import { createReusableTemplate } from '@vueuse/core'
import { useFirstInterest } from '@/lib/first-interest'
import RowMenuList from './RowMenuList.vue'
import AudioButton from './AudioButton.vue'
import { isAudible, isMuted, toggleMuted } from '@/lib/chat-audio'
import { cleanSidebar } from './clean'
import RowAge from '@/lib/RowAge.vue'
import { MENU_CONTENT, focusFirstItem, runShortcut } from './menuClasses'

// One session row: 26px, r6, status dot in a 24px leading slot, title with a right fade, and on hover
// the "More options" button. The three-dot menu and the right-click menu are the same list.
const props = withDefaults(defineProps<{ chat: ChatSummary; selected?: boolean; /** Move to group's names. */ groups?: string[] }>(), {
  selected: false,
  groups: () => []
})
const emit = defineEmits<{ select: []; action: [item: RowMenuItem]; rename: [title: string] }>()

const glyph = computed(() => statusGlyph(props.chat))
const speaker = computed(() => isMuted(props.chat.id) || isAudible(props.chat.id))
const menu = computed(() => rowMenu({ ...chatRow(props.chat), muted: isMuted(props.chat.id) }, props.groups))
// The clock is read only while the row shows a time that moves (a working chat's elapsed time, a limited
// one's reset), so an idle row never redraws on the tick.
const clock = useClock()
const timed = computed(() => props.chat.status === 'working' || props.chat.status === 'starting' || props.chat.status === 'limited')
const tooltip = computed(() => rowTooltip(props.chat, timed.value ? clock.value : Date.now()))
const menuOpen = ref(false)
// A row nobody touched draws its content and its trigger buttons only; its context menu and dropdown menu mount on the
// first hover or focus and stay (lib/first-interest.ts). Both menus share one row body, so it is written once.
const { seen, listeners } = useFirstInterest()
const [DefineBody, ReuseBody] = createReusableTemplate()

const dotClass = computed(() => glyphDotClass(glyph.value))

// Clean sidebar (clean.ts) leaves a working chat's elapsed time out; its pulsing dot still says it works.
const elapsed = computed(() =>
  !cleanSidebar.value && (props.chat.status === 'working' || props.chat.status === 'starting') ? elapsedLabel(props.chat.turnStartedAt, clock.value) : ''
)
const resets = computed(() => (props.chat.status === 'limited' ? resetClock(props.chat.limitResetsAt, clock.value) : ''))
// The account number and the age since its last activity, as the cloud list draws them (owner, 2026-10-08: they show
// without Cloud on, and Clean sidebar hides them). A working chat's elapsed time takes the age's place, and a limited
// one's reset time does.
const account = computed(() => (cleanSidebar.value ? null : (props.chat.account.number ?? null)))
const aged = computed(() => !cleanSidebar.value && !elapsed.value && !resets.value)

// Inline rename
const renaming = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement | null>(null)
function startRename() {
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
  const title = draft.value.trim()
  if (title && title !== props.chat.title) emit('rename', title)
}
function run(item: RowMenuItem) {
  if (item.action === 'mute' || item.action === 'unmute') return toggleMuted(props.chat.id)
  if (item.action === 'rename') {
    // After the menu has closed and given focus back, or the input loses it at once.
    setTimeout(startRename, 0)
    return
  }
  emit('action', item)
}
defineExpose({ startRename })
</script>

<template>
  <!-- The Tip wraps the whole context menu from outside: a Tip between the menu root and its trigger leaves the menu's popper unplaced (it opens off-screen). -->
  <Tip :label="renaming || menuOpen ? '' : tooltip" side="right" align="start">
    <span class="block" v-on="listeners">
      <DefineBody>
          <span class="flex size-6 shrink-0 items-center justify-center">
            <span class="flex size-[14px] items-center justify-center">
              <span role="img" :aria-label="glyph.label" class="size-1.5 rounded-full" :class="dotClass" />
            </span>
          </span>

          <input
            v-if="renaming"
            ref="input"
            v-model="draft"
            aria-label="Rename session"
            class="h-5 min-w-0 flex-1 rounded-[4px] bg-bg-deepest px-1 text-[13px] text-text outline-none ring-1 ring-accent"
            @click.stop
            @keydown.enter.stop="commitRename"
            @keydown.escape.stop="renaming = false"
            @blur="commitRename"
          />
          <span v-else class="row-title min-w-0 flex-1 overflow-hidden whitespace-nowrap" :class="{ 'row-title-open': menuOpen, 'row-title-audio': speaker }">{{ chat.title }}</span>

          <!-- Hydra Desk extras: account number, sub-items, elapsed time or age, limit reset, CliMayte count -->
          <!-- The elapsed counter and the age give their place to the three dots while the row is hovered or its menu open. -->
          <span v-if="!renaming && (account !== null || elapsed || aged || resets || chat.climayteActive > 0 || $slots.default)" class="ml-2 flex shrink-0 items-center gap-1 pr-1 text-[12px] leading-4 group-hover/row:pr-6" :class="speaker ? [menuOpen ? 'pr-11' : 'pr-6', 'group-hover/row:pr-11'] : { 'pr-6': menuOpen }">
            <span v-if="account !== null" class="shrink-0 rounded-[4px] bg-fill-5 px-1 text-[11px] leading-4 text-text-muted tnum">#{{ account }}</span>
            <!-- The sub-item badges (SubBadges.vue), when the sidebar shows them as counts. -->
            <slot />
            <span v-if="elapsed" class="tnum text-text-muted group-hover/row:hidden" :class="{ hidden: menuOpen }">{{ elapsed }}</span>
            <RowAge v-else-if="aged" class="group-hover/row:hidden" :class="{ hidden: menuOpen }" :at="chat.updatedAt" />
            <span v-if="resets" class="tnum text-[var(--status-limited-text)]">resets {{ resets }}</span>
            <span
              v-if="chat.climayteActive > 0"
              class="tnum flex h-4 min-w-4 items-center justify-center rounded-[4px] bg-[var(--fill-secondary)] px-1 text-[11px] text-text-2"
              :aria-label="`${chat.climayteActive} CliMayte ${chat.climayteActive === 1 ? 'worker' : 'workers'} active`"
            >{{ chat.climayteActive }}</span>
          </span>

      </DefineBody>
      <ContextMenu v-if="seen">
        <ContextMenuTrigger as-child>
        <div
          role="button"
          tabindex="0"
          :aria-current="selected ? 'page' : undefined"
          class="group/row relative flex h-[26px] w-full cursor-default items-center gap-1 rounded-[var(--radius-6)] px-0.5 text-[13px] leading-[19.5px] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-snap)] select-none"
          :class="[
            selected ? 'bg-fill-selected text-text' : 'text-text-2 hover:bg-fill-hover',
            menuOpen && !selected ? 'bg-fill-hover' : '',
            glyph.dim && !selected ? 'text-text-muted' : ''
          ]"
          @click="!renaming && emit('select')"
          @keydown.enter.self="emit('select')"
          @keydown.f2.self="startRename"
        >
          <ReuseBody />
          <AudioButton v-if="!renaming" :chat-id="chat.id" :open="menuOpen" />
          <DropdownMenu v-if="!renaming" v-model:open="menuOpen">
            <DropdownMenuTrigger as-child>
              <button
                type="button"
                :aria-label="`More options for ${chat.title}`"
                class="absolute right-[3px] top-[3px] flex size-5 items-center justify-center rounded-[var(--radius-5)] text-text-2 opacity-0 hover:bg-fill-hover hover:text-text focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
                @click.stop
              >
                <component :is="shellGlyphs.rowMore" class="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" :side-offset="4" :class="MENU_CONTENT" @open-auto-focus="focusFirstItem" @keydown.capture="(e: KeyboardEvent) => runShortcut(e, menu)">
              <RowMenuList :entries="menu" kind="dropdown" @run="run" />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
    <ContextMenuContent :class="MENU_CONTENT" @open-auto-focus="focusFirstItem" @keydown.capture="(e: KeyboardEvent) => runShortcut(e, menu)">
      <RowMenuList :entries="menu" kind="context" @run="run" />
    </ContextMenuContent>
      </ContextMenu>
        <div
          v-else
          data-slot="context-menu-trigger"
          data-state="closed"
          role="button"
          tabindex="0"
          :aria-current="selected ? 'page' : undefined"
          class="group/row relative flex h-[26px] w-full cursor-default items-center gap-1 rounded-[var(--radius-6)] px-0.5 text-[13px] leading-[19.5px] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-snap)] select-none"
          :class="[
            selected ? 'bg-fill-selected text-text' : 'text-text-2 hover:bg-fill-hover',
            menuOpen && !selected ? 'bg-fill-hover' : '',
            glyph.dim && !selected ? 'text-text-muted' : ''
          ]"
          @click="!renaming && emit('select')"
          @keydown.enter.self="emit('select')"
          @keydown.f2.self="startRename"
        >
          <ReuseBody />
          <AudioButton v-if="!renaming" :chat-id="chat.id" :open="menuOpen" />
          <button
            v-if="!renaming"
            type="button"
            data-slot="dropdown-menu-trigger"
            aria-haspopup="menu"
            aria-expanded="false"
            data-state="closed"
            :aria-label="`More options for ${chat.title}`"
            class="absolute right-[3px] top-[3px] flex size-5 items-center justify-center rounded-[var(--radius-5)] text-text-2 opacity-0 hover:bg-fill-hover hover:text-text focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
            @click.stop
          >
            <component :is="shellGlyphs.rowMore" class="size-4" />
          </button>
        </div>
    </span>
  </Tip>
</template>

<style scoped>
/* Fade mask behind the row's control: 32px (the title ends a little before the counter), 44px while the control shows. */
.row-title {
  mask-image: linear-gradient(to right, #000 calc(100% - 32px), transparent);
}
.group\/row:hover .row-title,
.row-title-open {
  mask-image: linear-gradient(to right, #000 calc(100% - 44px), transparent calc(100% - 20px));
}
/* The speaker (AudioButton.vue) sits at the right end, and left of the three dots while those show: the title fades earlier. */
.row-title-audio {
  mask-image: linear-gradient(to right, #000 calc(100% - 44px), transparent calc(100% - 20px));
}
.group\/row:hover .row-title-audio,
.row-title-open.row-title-audio {
  mask-image: linear-gradient(to right, #000 calc(100% - 64px), transparent calc(100% - 40px));
}
</style>
