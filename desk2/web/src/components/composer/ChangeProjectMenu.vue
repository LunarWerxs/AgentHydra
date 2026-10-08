<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import { icons } from '@/lib/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { COMPOSER_API, httpComposerApi } from './api'
import { projectRows } from './change-project'
import { HEADER, ITEM, MENU, MENU_GLYPH, SEPARATOR, SUB_TRIGGER } from './menu'

// The "..." menu on a message of yours and on the box's unsent draft: Change project, then one of the recent
// folders (all but this one) or another from Windows' folder dialog. What the message becomes there is the
// caller's (`choose`); `header` says it at the top of the folder list.
const Plus = icons.add
const props = defineProps<{ current: string | null; header: string }>()
const emit = defineEmits<{ choose: [cwd: string] }>()
const open = defineModel<boolean>('open', { default: false })
const api = inject(COMPOSER_API, httpComposerApi)

/** Rows the menu shows, as the folder menu. */
const SHOWN = 10

const recent = ref<string[]>([])
const error = ref<string | null>(null)
const rows = computed(() => projectRows(recent.value, props.current).slice(0, SHOWN))

watch(open, (o) => {
  if (o) api.recentFolders().then((list) => (recent.value = list), () => (recent.value = []))
  else error.value = null
})

// Closed here, before `choose`: the library closes the menu a tick after the select, and by then the caller may
// have gone on to another view and taken this menu away, which would leave its `open` true for next time.
function choose(path: string) {
  open.value = false
  emit('choose', path)
}

async function other() {
  error.value = null
  try {
    const path = await api.pickFolder(props.current)
    if (path) choose(path)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    open.value = true
  }
}
</script>

<template>
  <DropdownMenu v-model:open="open">
    <DropdownMenuTrigger as-child>
      <slot />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" :side-offset="4" :class="MENU">
      <DropdownMenuSub>
        <DropdownMenuSubTrigger :class="[ITEM, SUB_TRIGGER]">Change project</DropdownMenuSubTrigger>
        <DropdownMenuSubContent :side-offset="4" :class="[MENU, 'min-w-48 max-w-72']">
          <div role="presentation" :class="HEADER">{{ header }}</div>
          <DropdownMenuItem v-for="r in rows" :key="r.path" :class="ITEM" :title="r.path" @select="choose(r.path)">
            <span class="min-w-0 flex-1 truncate">
              {{ r.name }}<span v-if="r.hint" class="ms-1.5 text-(--text-muted)">{{ r.hint }}</span>
            </span>
          </DropdownMenuItem>
          <div v-if="rows.length" role="separator" :class="SEPARATOR" />
          <DropdownMenuItem :class="ITEM" @select="other">
            <Plus :class="MENU_GLYPH" />
            Other folder…
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <p v-if="error" role="alert" class="px-2 py-1 text-[12px] leading-4 text-(--danger-text)">{{ error }}</p>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
