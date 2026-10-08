<script setup lang="ts">
import { Cloud, Server } from '@lucide/vue'
import { agentHydraIcon, shellGlyphs, shellIcons } from '@/lib/icons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR, MENU_SHORTCUT, focusFirstItem } from '@/components/sidebar/menuClasses'
import { markUpdateSeen, updateSeen, type UpdateOffer } from '@/lib/server-update'

// The custom chrome bar (h36, z21) that lies over the top of the sidebar: Menu and Hide sidebar (28px, r7).
// The real app's Chat / Code mode switch is left out: Hydra Desk is Code only. Its Back and Forward arrows
// are gone too (owner, 2026-10-06); Alt + Left / Right still go back and forward (DeskFrame).
// AgentHydra 2.0 adds five: AgentHydra (slides AgentHydra in beside the sidebar), Cloud (the sidebar lists
// every session of both PCs), CliMayte (each session's running CliMayte tasks listed under it,
// sidebar/tasks.ts), Dev servers (the sidebar lists the projects and servers AgentHydra runs, servers/DevServersList.vue)
// and Clean sidebar (rows without their account number and times, sidebar/clean.ts).
// Each shows when it is on: AgentHydra pressed, the other four blue. A thin divider sets Cloud and the toggles after
// it apart from Menu and Hide sidebar. AgentHydra and Dev servers sit at the right end, after another: with the sidebar open, at its right edge; hidden, right after Clean sidebar. The bar's
// width follows the sidebar's slide (`sliding`, DeskFrame's 300 ms snap), so the two glide left and right with it.
// data-peek-zone: pointing at the toggle opens the collapsed sidebar's flyout (DeskFrame).
// `update`: the server's code changed after it started (lib/server-update.ts): a blue dot on Menu, and Menu has
// Restart to update (or, for a server the launcher did not start, how to restart it).
defineProps<{ sidebarOpen: boolean; width: number; sliding?: boolean; hydraOpen?: boolean; cloudOn?: boolean; tasksOn?: boolean; devOn?: boolean; cleanOn?: boolean; update?: UpdateOffer | null }>()
const emit = defineEmits<{ new: []; search: []; 'toggle-sidebar': []; settings: []; hydra: []; 'hydra-intent': []; cloud: []; tasks: []; dev: []; clean: []; restart: [] }>()

// The colour is apart so the cloud's blue replaces it: two colour utilities on one button resolve by
// stylesheet order, not by which came last.
const BTN_SHAPE =
  'flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-7)] transition-colors duration-[60ms] hover:bg-fill-hover disabled:opacity-50 disabled:hover:bg-transparent aria-expanded:bg-fill-hover'
const BTN = `${BTN_SHAPE} text-text`
/** Hidden, the bar is just its buttons: 12 + 7 buttons of 28 + 8 gaps of 4 + two 1px dividers + 4 = 246. */
const COLLAPSED_WIDTH = 246
</script>

<template>
  <div
    class="absolute left-0 top-0 z-21 flex h-9 items-center gap-1 ps-3"
    :class="[sidebarOpen ? 'pe-2' : 'pe-1', sliding ? 'transition-[width,padding] duration-(--dur-slow) ease-(--ease-snap) motion-reduce:transition-none' : '']"
    :style="{ width: `${sidebarOpen ? width : COLLAPSED_WIDTH}px` }"
    data-peek-zone="keep"
  >
    <Tip label="Menu">
      <span class="inline-flex">
    <DropdownMenu @update:open="(open: boolean) => open && update && markUpdateSeen(true)">
        <DropdownMenuTrigger as-child>
          <button type="button" :class="[BTN, 'relative']" :aria-label="update && !updateSeen ? 'Menu (update ready)' : 'Menu'">
            <component :is="shellGlyphs.menu" class="size-4" />
            <span v-if="update && !updateSeen" class="absolute right-1 top-1 size-1.5 rounded-full bg-accent" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
      <DropdownMenuContent align="start" :class="MENU_CONTENT" @open-auto-focus="focusFirstItem">
        <DropdownMenuItem :class="MENU_ITEM" @select="emit('new')">New session<DropdownMenuShortcut :class="MENU_SHORTCUT">Ctrl + N</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem :class="MENU_ITEM" @select="emit('search')">Search<DropdownMenuShortcut :class="MENU_SHORTCUT">Ctrl + K</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem :class="MENU_ITEM" @select="emit('toggle-sidebar')">
          {{ sidebarOpen ? 'Hide sidebar' : 'Show sidebar' }}<DropdownMenuShortcut :class="MENU_SHORTCUT">Ctrl + B</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator :class="MENU_SEPARATOR" />
        <DropdownMenuItem :class="MENU_ITEM" @select="emit('settings')">Settings</DropdownMenuItem>
        <template v-if="update">
          <DropdownMenuSeparator :class="MENU_SEPARATOR" />
          <DropdownMenuItem v-if="update.restartable" :class="MENU_ITEM" :disabled="update.restarting" @select="emit('restart')">
            {{ update.restarting ? 'Restarting...' : 'Restart to update' }}
          </DropdownMenuItem>
          <DropdownMenuItem v-else :class="MENU_ITEM" disabled>Server out of date: run launcher/restart.ps1</DropdownMenuItem>
          <DropdownMenuItem v-if="update.error" :class="[MENU_ITEM, 'whitespace-normal']" disabled>{{ update.error }}</DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenu>
      </span>
    </Tip>
    <Tip :label="`${sidebarOpen ? 'Hide' : 'Show'} sidebar (Ctrl + B)`">
      <button type="button" :class="BTN" :aria-label="sidebarOpen ? 'Hide sidebar' : 'Show sidebar'" data-peek-zone="open" @click="emit('toggle-sidebar')">
        <component :is="shellGlyphs.sidebarToggle" class="size-4" />
      </button>
    </Tip>
    <!-- A divider before Cloud with the bar's own 4px each side (owner, 2026-10-07: "a little normal amount", not pushed
         off to the right as AgentHydra and Dev servers are). -->
    <span class="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
    <Tip :label="cloudOn ? 'Back to the desk list' : 'Cloud: every session, both PCs'">
      <!-- On shows as a blue icon alone, no pressed background (Michael, 2026-10-04). -->
      <button type="button" :class="[BTN_SHAPE, cloudOn ? 'text-accent-text' : 'text-text']" aria-label="Cloud sessions" :aria-pressed="!!cloudOn" @click="emit('cloud')">
        <Cloud class="size-4" />
      </button>
    </Tip>
    <Tip :label="tasksOn ? 'Hide the CliMayte tasks under each session' : 'CliMayte: the running tasks under each session'">
      <button type="button" :class="[BTN_SHAPE, tasksOn ? 'text-accent-text' : 'text-text']" aria-label="CliMayte tasks in the sidebar" :aria-pressed="!!tasksOn" @click="emit('tasks')">
        <component :is="shellIcons.climayte" class="size-4" />
      </button>
    </Tip>
    <Tip :label="cleanOn ? 'Show account numbers and times in the sidebar' : 'Clean sidebar: titles only, no account numbers or times'">
      <button type="button" :class="[BTN_SHAPE, cleanOn ? 'text-accent-text' : 'text-text']" aria-label="Clean sidebar" :aria-pressed="!!cleanOn" @click="emit('clean')">
        <component :is="shellGlyphs.cleanSidebar" class="size-4" />
      </button>
    </Tip>
    <!-- AgentHydra and Dev servers sit at the bar's right end, after a thin divider (owner, 2026-10-07). -->
    <span class="ms-auto h-4 w-px shrink-0 bg-border" aria-hidden="true" />
    <Tip :label="hydraOpen ? 'Back to chats' : 'AgentHydra: accounts, instances and HSwarm'">
      <button type="button" :class="[BTN, hydraOpen ? 'bg-fill-selected' : '']" aria-label="AgentHydra" :aria-pressed="!!hydraOpen" @click="emit('hydra')" @pointerenter="emit('hydra-intent')" @focus="emit('hydra-intent')">
        <component :is="agentHydraIcon" class="size-4" />
      </button>
    </Tip>
    <Tip :label="devOn ? 'Back to the desk list' : 'Dev servers: the projects and servers AgentHydra runs'">
      <button type="button" :class="[BTN_SHAPE, devOn ? 'text-accent-text' : 'text-text']" aria-label="Dev servers" :aria-pressed="!!devOn" @click="emit('dev')">
        <Server class="size-4" />
      </button>
    </Tip>
  </div>
</template>
