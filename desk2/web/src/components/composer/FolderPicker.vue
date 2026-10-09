<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { icons, newSessionGlyphs } from '@/lib/icons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { ComposerApi } from './api'
import { folderRows } from './folders'
import { folderName } from './logic'
import { HEADER, ITEM, MENU, MENU_GLYPH, SEPARATOR } from './menu'
import { Tip } from '@/components/ui/tooltip'
import { ENV_PILL_BUTTON, PILL_TEXT } from './pill'

// The new session's folder, as the real app's folder menu: Recent by name, a check on the current folder and,
// on hover, an X that takes a folder off the list (Delete does it from the keyboard); then "Add new folder...",
// which opens Windows' own folder dialog. The server shows that dialog: a page cannot learn a folder's path.
const Check = icons.check
const Plus = icons.add
const Remove = icons.dismiss
const props = defineProps<{ modelValue: string | null; api: ComposerApi }>()
const emit = defineEmits<{ 'update:modelValue': [cwd: string] }>()

/** Rows the menu shows; the server keeps a few more. */
const SHOWN = 10

const open = ref(false)
const recent = ref<string[]>([])
const error = ref<string | null>(null)
const rows = computed(() => folderRows(recent.value.slice(0, SHOWN), props.modelValue))

async function loadRecent() {
  try {
    recent.value = await props.api.recentFolders()
  } catch {
    recent.value = []
  }
}

watch(open, (o) => {
  if (o) loadRecent()
  else error.value = null
})

function choose(path: string) {
  emit('update:modelValue', path)
  props.api.rememberFolder(path).then((list) => (recent.value = list), () => {})
}

/** Takes the row off the list and keeps the keyboard on the row that takes its place. */
async function remove(path: string) {
  const at = recent.value.indexOf(path)
  recent.value = recent.value.filter((p) => p !== path)
  props.api.forgetFolder(path).then((list) => (recent.value = list), loadRecent)
  await nextTick()
  const items = document.querySelectorAll<HTMLElement>('[data-composer-menu="folder"] [role^="menuitem"]')
  items[Math.min(Math.max(at, 0), items.length - 1)]?.focus()
}

// Asking again while the dialog is open replaces it (the server closes the first one), so only the latest answer counts.
let asked = 0
async function addFolder() {
  const mine = ++asked
  error.value = null
  try {
    const path = await props.api.pickFolder(props.modelValue)
    if (mine === asked && path) emit('update:modelValue', path)
  } catch (e) {
    if (mine !== asked) return
    error.value = e instanceof Error ? e.message : String(e)
    open.value = true
  }
}
</script>

<template>
  <DropdownMenu v-model:open="open">
    <Tip :label="modelValue ?? 'Choose a folder'">
      <DropdownMenuTrigger as-child>
        <button type="button" :class="ENV_PILL_BUTTON" class="min-w-0 shrink">
          <newSessionGlyphs.folder class="size-4 shrink-0" />
          <span class="truncate" :class="PILL_TEXT">{{ modelValue ? folderName(modelValue) : 'Choose folder' }}</span>
        </button>
      </DropdownMenuTrigger>
    </Tip>
    <DropdownMenuContent side="top" align="start" :side-offset="6" :class="[MENU, 'min-w-48 max-w-72']" data-composer-menu="folder">
      <template v-if="rows.length">
        <div role="presentation" :class="HEADER">Recent</div>
        <DropdownMenuItem
          v-for="r in rows"
          :key="r.path"
          role="menuitemradio"
          :aria-checked="r.current"
          :class="[ITEM, 'group/folder pe-1']"
          @select="choose(r.path)"
          @keydown.delete.prevent="remove(r.path)"
        >
          <span class="min-w-0 flex-1 truncate">
            {{ r.name }}<span v-if="r.hint" class="ms-1.5 text-(--text-muted)">{{ r.hint }}</span>
          </span>
          <span class="flex size-5 shrink-0 items-center justify-center">
            <Check
              v-if="r.current"
              class="size-3.5 text-(--accent) group-hover/folder:hidden group-data-[highlighted]/folder:hidden"
              :stroke-width="3"
            />
            <!-- Its own click: stopped before the row sees it, so the row is not chosen. -->
            <button
              type="button"
              tabindex="-1"
              class="hidden size-5 items-center justify-center rounded-(--radius-5) text-(--text-muted) transition-colors duration-60 hover:bg-(--fill-secondary-hover) hover:text-(--text) group-hover/folder:flex group-data-[highlighted]/folder:flex"
              :aria-label="`Remove ${r.name} from Recent`"
              @pointerdown.stop
              @pointerup.stop
              @click.stop.prevent="remove(r.path)"
            >
              <Remove class="size-3.5" :stroke-width="2.5" />
            </button>
          </span>
        </DropdownMenuItem>
        <div role="separator" :class="SEPARATOR" />
      </template>
      <DropdownMenuItem :class="ITEM" @select="addFolder">
        <Plus :class="MENU_GLYPH" />
        Add new folder…
      </DropdownMenuItem>
      <p v-if="error" role="alert" class="px-2 py-1 text-[12px] leading-4 text-(--danger-text)">{{ error }}</p>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
