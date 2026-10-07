<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { Cloud } from '@lucide/vue'
import { isAddedRow, isTaskRow } from './tasks'
import type { ExternalSession } from '@shared/protocol'
import { shellGlyphs, shellIcons } from '@/lib/icons'
import { ahSource, appLead, fromPcLabel } from '@/components/cloud/logic'
import { appMark } from '@/components/cloud/appMarks'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { createReusableTemplate } from '@vueuse/core'
import { useFirstInterest } from '@/lib/first-interest'
import { externalGlyph, externalRename, externalRow, glyphDotClass, rowMenu, sourceLabel, type RowMenuEntry, type RowMenuItem, type StatusGlyph } from './logic'
import RowMenuList from './RowMenuList.vue'
import AudioButton from './AudioButton.vue'
import { isAudible, isMuted, toggleMuted } from '@/lib/chat-audio'
import { MENU_CONTENT, focusFirstItem, runShortcut } from './menuClasses'
import { cleanSidebar } from './clean'
import { dimText } from './rowClasses'
import RowAge from '@/lib/RowAge.vue'

// A session running outside Hydra Desk, in the same list as our chats: the same 26px row, dot, title
// and menu as the real app (without Delete: its files are not ours). Opening it shows its transcript,
// with the composer that carries it on when it is an idle Claude Code session. A row the sidebar adds for
// running work no row lists (tasks.ts addedEntry) is drawn the same, with its own short menu (`entries`)
// and no Rename: Hydra Desk keeps no marks on it.
const props = withDefaults(
  defineProps<{
    session: ExternalSession
    selected?: boolean
    /** Move to group's names. */
    groups?: string[]
    /** The menu in place of an outside session's; without Rename, the row cannot be renamed. */
    entries?: RowMenuEntry[]
    /** The dot in place of the session's: an added row that is a running HSwarm job pulses blue (Sidebar.vue addedGlyph). */
    dot?: StatusGlyph
  }>(),
  {
    selected: false,
    groups: () => []
  }
)
const emit = defineEmits<{ select: []; action: [item: RowMenuItem]; /** null: back to the session's own title. */ rename: [title: string | null] }>()

const glyph = computed(() => props.dot ?? externalGlyph(props.session))
const source = computed(() => sourceLabel(props.session.source))
const speaker = computed(() => isMuted(props.session.id) || isAudible(props.session.id))
const menu = computed(() => props.entries ?? rowMenu({ ...externalRow(props.session), muted: isMuted(props.session.id) }, props.groups))
const canRename = computed(() => menu.value.some((e) => typeof e === 'object' && 'action' in e && e.action === 'rename'))
const menuOpen = ref(false)
// A row nobody touched draws its content and its trigger buttons only; its context menu and dropdown menu mount on the
// first hover or focus and stay (lib/first-interest.ts). Both menus share one row body, so it is written once.
const { seen, listeners } = useFirstInterest()
const [DefineBody, ReuseBody] = createReusableTemplate()
// A Desktop chat AgentHydra's chat sync took from another PC: a cloud beside the status dot, as the cloud list draws it.
const fromPc = computed(() => (props.session.fromPc ? fromPcLabel(props.session.fromPc, ahSource(props.session.source)) : null))
const tooltip = computed(() =>
  [props.session.title, `${glyph.value.label} · ${source.value}${props.session.instance ? ` ${props.session.instance}` : ''}`, fromPc.value, props.session.activity]
    .filter(Boolean)
    .join('\n')
)
// A chat of another app on this PC the Apps scope shows has that app's muted mark beside its dot, as in the cloud list; an added row never does.
const app = computed(() => (props.session.fromPc || isAddedRow(props.session.id) ? null : appLead(ahSource(props.session.source))))
const dotClass = computed(() => glyphDotClass(glyph.value))
// The account number (an instance named "#38") and the age since its last activity, as the cloud list draws them;
// Clean sidebar (clean.ts) hides both (owner, 2026-10-07).
const account = computed(() => {
  const num = cleanSidebar.value ? null : props.session.instance?.match(/^#(\d+)$/)
  return num ? Number(num[1]) : null
})
const aged = computed(() => !cleanSidebar.value && props.session.lastActivityAt !== null)

// Inline rename: the new title is Hydra Desk's own, the session keeps its name where it runs; an
// emptied field goes back to that name.
const renaming = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement | null>(null)
function startRename() {
  if (!canRename.value) return
  draft.value = props.session.title
  renaming.value = true
  nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
}
function commitRename() {
  if (!renaming.value) return
  renaming.value = false
  const title = externalRename(draft.value, props.session.title)
  if (title !== undefined) emit('rename', title)
}
function run(item: RowMenuItem) {
  if (item.action === 'mute' || item.action === 'unmute') return toggleMuted(props.session.id)
  if (item.action === 'rename') {
    // After the menu has closed and given focus back, or the input loses it at once.
    setTimeout(startRename, 0)
    return
  }
  emit('action', item)
}
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
          <!-- Its own slot after the dot, so the working / needs-you dot keeps its column and its look (owner, 2026-10-04: "the cloud chats don't have a cloud icon"). -->
          <Cloud v-if="fromPc" role="img" :aria-label="fromPc" class="size-3.5 shrink-0 text-text-muted" />
          <!-- A chat of another app on this PC: its muted mark beside the dot, never in its place, so working and needs-you still show. -->
          <component :is="appMark(app.app)" v-else-if="app?.kind === 'app'" role="img" :aria-label="app.label" :title="app.label" class="size-3.5 shrink-0 text-text-muted" />
          <!-- A CliMayte task drawn as a row of its own (nothing says which chat started it): the CliMayte toggle's mark, so it never reads as a chat (owner, 2026-10-07). -->
          <component :is="shellIcons.climayte" v-if="isTaskRow(session.id)" role="img" aria-label="CliMayte task" title="CliMayte task" class="size-3.5 shrink-0 text-text-muted" />
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
          <span v-else class="ext-title min-w-0 flex-1 overflow-hidden whitespace-nowrap" :class="{ 'ext-title-open': menuOpen, 'ext-title-audio': speaker }">{{ session.title }}</span>

          <!-- The account number, the sub-item badges (SubBadges.vue, when the sidebar shows them as counts) and the age; they
               make room for the three dots on hover, the age giving its place. -->
          <span v-if="!renaming && (account !== null || aged || $slots.default)" class="ml-1 flex shrink-0 items-center gap-1 pr-1 text-[12px] leading-4 group-hover/row:pr-6" :class="speaker ? [menuOpen ? 'pr-11' : 'pr-6', 'group-hover/row:pr-11'] : { 'pr-6': menuOpen }">
            <span v-if="account !== null" class="shrink-0 rounded-[4px] bg-fill-5 px-1 text-[11px] leading-4 text-text-muted tnum">#{{ account }}</span>
            <slot />
            <RowAge v-if="aged" class="group-hover/row:hidden" :class="{ hidden: menuOpen }" :at="session.lastActivityAt" />
          </span>

      </DefineBody>
      <ContextMenu v-if="seen">
        <ContextMenuTrigger as-child>
        <div
          role="button"
          tabindex="0"
          :aria-current="selected ? 'page' : undefined"
          :aria-description="`Runs in ${source}`"
          class="group/row relative flex h-[26px] w-full cursor-default items-center gap-1 rounded-[var(--radius-6)] px-0.5 text-[13px] leading-[19.5px] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-snap)] select-none"
          :class="[
            selected ? 'bg-fill-selected text-text' : 'text-text-2 hover:bg-fill-hover',
            menuOpen && !selected ? 'bg-fill-hover' : '',
            dimText(glyph, selected)
          ]"
          @click="!renaming && emit('select')"
          @keydown.enter.self="emit('select')"
          @keydown.f2.self="startRename"
        >
          <ReuseBody />
          <AudioButton v-if="!renaming" :chat-id="session.id" :open="menuOpen" />
          <DropdownMenu v-if="!renaming" v-model:open="menuOpen">
            <DropdownMenuTrigger as-child>
              <button
                type="button"
                :aria-label="`More options for ${session.title}`"
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
          :aria-description="`Runs in ${source}`"
          class="group/row relative flex h-[26px] w-full cursor-default items-center gap-1 rounded-[var(--radius-6)] px-0.5 text-[13px] leading-[19.5px] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-snap)] select-none"
          :class="[
            selected ? 'bg-fill-selected text-text' : 'text-text-2 hover:bg-fill-hover',
            menuOpen && !selected ? 'bg-fill-hover' : '',
            dimText(glyph, selected)
          ]"
          @click="!renaming && emit('select')"
          @keydown.enter.self="emit('select')"
          @keydown.f2.self="startRename"
        >
          <ReuseBody />
          <AudioButton v-if="!renaming" :chat-id="session.id" :open="menuOpen" />
          <button
            v-if="!renaming"
            type="button"
            data-slot="dropdown-menu-trigger"
            aria-haspopup="menu"
            aria-expanded="false"
            data-state="closed"
            :aria-label="`More options for ${session.title}`"
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
/* Fade mask behind the row's control: 24px, 44px while the control shows. */
.ext-title {
  mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent);
}
.group\/row:hover .ext-title,
.ext-title-open {
  mask-image: linear-gradient(to right, #000 calc(100% - 44px), transparent calc(100% - 20px));
}
/* The speaker (AudioButton.vue) sits at the right end, and left of the three dots while those show: the title fades earlier. */
.ext-title-audio {
  mask-image: linear-gradient(to right, #000 calc(100% - 44px), transparent calc(100% - 20px));
}
.group\/row:hover .ext-title-audio,
.ext-title-open.ext-title-audio {
  mask-image: linear-gradient(to right, #000 calc(100% - 64px), transparent calc(100% - 40px));
}
</style>
