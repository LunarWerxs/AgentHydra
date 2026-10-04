<script setup lang="ts">
import { computed } from 'vue'
import { shellGlyphs } from '@/lib/icons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import FilterMenuItems from '@/components/cloud/FilterMenuItems.vue'
import { scopesNarrowed } from '@/components/cloud/logic'
import { useCloud } from '@/components/cloud/store'
import type { SidebarFilter } from './logic'
import { MENU_CONTENT, focusFirstItem } from './menuClasses'

// The Search and Filter buttons at the right end of the sidebar list's first header, the desk list's or
// the cloud list's. The Filter menu holds both lists' filters (cloud/FilterMenuItems.vue).
const props = defineProps<{ searchOpen: boolean; filter: SidebarFilter }>()
const emit = defineEmits<{ search: []; 'update:filter': [filter: SidebarFilter] }>()

const cloud = useCloud()
const narrowed = computed(() => (cloud.on.value ? scopesNarrowed(cloud.scopes.value) : props.filter !== 'active'))
const HEADER_BTN = 'flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-6)] text-text-2 hover:bg-fill-hover hover:text-text'
</script>

<template>
  <Tip label="Search (Ctrl + K)">
    <button type="button" :class="HEADER_BTN" aria-label="Search" :aria-pressed="searchOpen" @click="emit('search')">
      <component :is="shellGlyphs.search" class="size-4" />
    </button>
  </Tip>
  <Tip label="Filter">
    <span class="inline-flex">
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button type="button" :class="[HEADER_BTN, narrowed ? 'text-accent-text' : '']" aria-label="Filter">
            <component :is="shellGlyphs.viewOptions" class="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" :class="`${MENU_CONTENT} w-64`" @open-auto-focus="focusFirstItem">
          <FilterMenuItems :filter="filter" @update:filter="(f: SidebarFilter) => emit('update:filter', f)" />
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  </Tip>
</template>
