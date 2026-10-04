<script setup lang="ts">
import { shellGlyphs } from '@/lib/icons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR, MENU_SHORTCUT, focusFirstItem } from '@/components/sidebar/menuClasses'

// The custom chrome bar (h36, z21) that lies over the top of the sidebar: Menu, Hide sidebar, Back,
// Forward (28px, r7). The real app's Chat / Code mode switch is left out: Hydra Desk is Code only.
// data-peek-zone: pointing at the toggle opens the collapsed sidebar's flyout (DeskFrame).
defineProps<{ sidebarOpen: boolean; width: number; canBack: boolean; canForward: boolean }>()
const emit = defineEmits<{ new: []; search: []; 'toggle-sidebar': []; back: []; forward: []; settings: [] }>()

const BTN =
  'flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-7)] text-text transition-colors duration-[60ms] hover:bg-fill-hover disabled:opacity-50 disabled:hover:bg-transparent aria-expanded:bg-fill-hover'
</script>

<template>
  <div
    class="absolute left-0 top-0 z-[21] flex h-9 items-center gap-1 pl-3"
    :class="sidebarOpen ? 'pr-2' : 'pr-1'"
    :style="sidebarOpen ? { width: `${width}px` } : undefined"
    data-peek-zone="keep"
  >
    <Tip label="Menu">
      <span class="inline-flex">
    <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button type="button" :class="BTN" aria-label="Menu"><component :is="shellGlyphs.menu" class="size-4" /></button>
        </DropdownMenuTrigger>
      <DropdownMenuContent align="start" :class="MENU_CONTENT" @open-auto-focus="focusFirstItem">
        <DropdownMenuItem :class="MENU_ITEM" @select="emit('new')">New session<DropdownMenuShortcut :class="MENU_SHORTCUT">Ctrl + N</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem :class="MENU_ITEM" @select="emit('search')">Search<DropdownMenuShortcut :class="MENU_SHORTCUT">Ctrl + K</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem :class="MENU_ITEM" @select="emit('toggle-sidebar')">
          {{ sidebarOpen ? 'Hide sidebar' : 'Show sidebar' }}<DropdownMenuShortcut :class="MENU_SHORTCUT">Ctrl + B</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator :class="MENU_SEPARATOR" />
        <DropdownMenuItem :class="MENU_ITEM" @select="emit('settings')">Settings</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
      </span>
    </Tip>
    <Tip :label="`${sidebarOpen ? 'Hide' : 'Show'} sidebar (Ctrl + B)`">
      <button type="button" :class="BTN" :aria-label="sidebarOpen ? 'Hide sidebar' : 'Show sidebar'" data-peek-zone="open" @click="emit('toggle-sidebar')">
        <component :is="shellGlyphs.sidebarToggle" class="size-4" />
      </button>
    </Tip>
    <Tip label="Back (Alt + Left)">
      <button type="button" :class="BTN" aria-label="Back" :disabled="!canBack" @click="emit('back')">
        <component :is="shellGlyphs.back" class="size-4" />
      </button>
    </Tip>
    <Tip label="Forward (Alt + Right)">
      <button type="button" :class="[BTN, '-ml-0.5']" aria-label="Forward" :disabled="!canForward" @click="emit('forward')">
        <component :is="shellGlyphs.forward" class="size-4" />
      </button>
    </Tip>
  </div>
</template>
