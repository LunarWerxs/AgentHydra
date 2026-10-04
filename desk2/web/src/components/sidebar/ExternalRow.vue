<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { ExternalSession } from '@shared/protocol'
import { shellGlyphs } from '@/lib/icons'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { externalGlyph, externalRename, externalRow, glyphDotClass, rowMenu, sourceLabel, type RowMenuItem } from './logic'
import RowMenuList from './RowMenuList.vue'
import { MENU_CONTENT, focusFirstItem, runShortcut } from './menuClasses'

// A session running outside Hydra Desk, in the same list as our chats: the same 26px row, dot, title
// and menu as the real app (without Delete: its files are not ours). Opening it shows its transcript,
// with the composer that carries it on when it is an idle Claude Code session.
const props = withDefaults(defineProps<{ session: ExternalSession; selected?: boolean; /** Move to group's names. */ groups?: string[] }>(), {
  selected: false,
  groups: () => []
})
const emit = defineEmits<{ select: []; action: [item: RowMenuItem]; /** null: back to the session's own title. */ rename: [title: string | null] }>()

const glyph = computed(() => externalGlyph(props.session))
const source = computed(() => sourceLabel(props.session.source))
const menu = computed(() => rowMenu(externalRow(props.session), props.groups))
const menuOpen = ref(false)
const tooltip = computed(() =>
  [props.session.title, `${glyph.value.label} · ${source.value}${props.session.instance ? ` ${props.session.instance}` : ''}`, props.session.activity]
    .filter(Boolean)
    .join('\n')
)
const dotClass = computed(() => glyphDotClass(glyph.value))

// Inline rename: the new title is Hydra Desk's own, the session keeps its name where it runs; an
// emptied field goes back to that name.
const renaming = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement | null>(null)
function startRename() {
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
    <span class="block">
      <ContextMenu>
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
            glyph.dim && !selected ? 'text-text-muted' : ''
          ]"
          @click="!renaming && emit('select')"
          @keydown.enter.self="emit('select')"
          @keydown.f2.self="startRename"
        >
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
          <span v-else class="ext-title min-w-0 flex-1 overflow-hidden whitespace-nowrap" :class="{ 'ext-title-open': menuOpen }">{{ session.title }}</span>

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
</style>
