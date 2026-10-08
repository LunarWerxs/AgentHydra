<script lang="ts">
import { ref } from 'vue'

// One open Filter menu for every Filter button. The button sits in the list's first header, and a filter
// that takes that group away (or a cloud filter that switches lists) mounts it again in the next one: the
// menu stays open there (owner, 2026-10-05). The newest button holds it, so a header still fading out
// shows no second menu.
const filterOpen = ref(false)
const mountedTools = ref<number[]>([])
let lastTools = 0
</script>

<script setup lang="ts">
import { computed, onUnmounted } from 'vue'
import { Activity } from '@lucide/vue'
import { icons, shellGlyphs } from '@/lib/icons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import FilterMenuItems from '@/components/cloud/FilterMenuItems.vue'
import { scopesNarrowed } from '@/components/cloud/logic'
import { useCloud } from '@/components/cloud/store'
import type { SidebarFilter } from './logic'
import { useHiddenGroups } from './hidden'
import { activeOnly } from './active'
import { MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR, focusFirstItem } from './menuClasses'

// The Search and Filter buttons at the right end of the sidebar list's first header, the desk list's or
// the cloud list's. The Filter menu holds both lists' filters (cloud/FilterMenuItems.vue).
const props = defineProps<{ searchOpen: boolean; filter: SidebarFilter }>()
const emit = defineEmits<{ search: []; 'update:filter': [filter: SidebarFilter] }>()

const cloud = useCloud()
const { showHidden } = useHiddenGroups()
// Show hidden counts too: the list holds groups it otherwise leaves out.
const narrowed = computed(() => (cloud.on.value ? scopesNarrowed(cloud.scopes.value) : props.filter !== 'active') || showHidden.value || activeOnly.value)
// The colour is apart so the Filter's blue (a filter is narrowing the list) replaces it rather than racing it.
const toggleActive = () => (activeOnly.value = !activeOnly.value)
const ACTIVE_TIP = 'Show only the sessions running or starting, those with background work still running, and those waiting on you (a question, a reply you have not read, an error), in both lists'
const BTN_SHAPE = 'flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-6)] hover:bg-fill-hover'
const HEADER_BTN = `${BTN_SHAPE} text-text-2 hover:text-text`

const toolsId = ++lastTools
mountedTools.value.push(toolsId)
onUnmounted(() => (mountedTools.value = mountedTools.value.filter((id) => id !== toolsId)))
const menuOpen = computed({
  get: () => filterOpen.value && mountedTools.value.at(-1) === toolsId,
  set: (open: boolean) => (filterOpen.value = open),
})
// A menu handed to a newer button keeps the focus where that one put it, not on this button.
function keepFocus(e: Event): void {
  if (filterOpen.value) e.preventDefault()
}
</script>

<template>
  <Tip label="Search (Ctrl + K)">
    <button type="button" :class="HEADER_BTN" aria-label="Search" :aria-pressed="searchOpen" @click="emit('search')">
      <component :is="shellGlyphs.search" class="size-4" />
    </button>
  </Tip>
  <Tip label="Filter">
    <span class="inline-flex">
      <DropdownMenu v-model:open="menuOpen">
        <DropdownMenuTrigger as-child>
          <button type="button" :class="narrowed ? `${BTN_SHAPE} text-accent-text` : HEADER_BTN" aria-label="Filter">
            <component :is="shellGlyphs.viewOptions" class="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" :class="`${MENU_CONTENT} w-64`" @open-auto-focus="focusFirstItem" @close-auto-focus="keepFocus">
          <FilterMenuItems :filter="filter" @update:filter="(f: SidebarFilter) => emit('update:filter', f)" />
          <DropdownMenuSeparator :class="MENU_SEPARATOR" />
          <DropdownMenuItem
            role="menuitemcheckbox"
            :aria-checked="activeOnly"
            :title="ACTIVE_TIP"
            :class="`${MENU_ITEM} pe-2`"
            @select.prevent="toggleActive"
          >
            <Activity />
            <span class="flex-1">Active only</span>
            <component :is="icons.check" v-if="activeOnly" class="ms-3" />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  </Tip>
</template>
