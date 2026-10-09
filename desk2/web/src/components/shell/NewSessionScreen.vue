<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { EyeOff, Folder, FolderPlus, ListFilter, MessagesSquare } from '@lucide/vue'
import type { ChatSummary, ProjectChoices, ProjectEntry, ProjectsResponse } from '@shared/protocol'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { focusFirstItem, MENU_CONTENT, MENU_ITEM } from '../sidebar/menuClasses'
import ProjectFoldersDialog from './ProjectFoldersDialog.vue'
import StatsCard from './StatsCard.vue'
import { useShellSource } from './source'
import { gridProjects } from './project-grid'
import { addProjectFolder, filterProjects, pickedFolder, type ProjectAction, type ProjectMenuApi, projectActions, runProjectAction, shownProjects, syncLabel } from './projects'
import { showHiddenProjects, showProjectDetails } from './projectDetails'

// The new-session screen above the composer: greeting, then either the user's projects (the default; clicking one
// starts a new chat in its folder) or the stats card behind a Stats tab (owner, 2026-10-08: "I click New Chat, and
// rather than seeing this overview and models, I see all my projects"). The composer below owns the env pills and
// the model chip.
defineProps<{ name: string; chats: ChatSummary[] }>()
const src = useShellSource()

const tab = ref<'projects' | 'stats'>('projects')
const query = ref('')
const answer = gridProjects
answer.value ??= src.cachedProjects?.() ?? null
const loading = ref(false)
const problem = ref<string | null>(null)
const actionProblem = ref<string | null>(null)
const managing = ref(false)
const NO_CHOICES: ProjectChoices = { folders: [], roots: [], hidden: [] }
const choices = computed(() => answer.value?.choices ?? NO_CHOICES)

function fail(err: unknown): void {
  actionProblem.value = err instanceof Error ? err.message : String(err)
}

// The server answers at once from what it knows; when part of that was stale (`pending`) it is shown, and a second
// call waits for the fresh git states. A later load (a folder added or hidden) wins over an earlier one still waiting.
let loads = 0
function load(): void {
  if (!src.projects) return
  const hidden = showHiddenProjects.value
  const n = ++loads
  const show = (res: ProjectsResponse) => {
    if (n !== loads) return
    answer.value = res
    problem.value = null
  }
  loading.value = true
  src
    .projects!({ hidden })
    .then((res) => {
      show(res)
      return res.pending ? src.projects!({ wait: true, hidden }).then(show) : undefined
    })
    .catch((err: unknown) => {
      if (n === loads) problem.value = err instanceof Error ? err.message : String(err)
    })
    .finally(() => {
      if (n === loads) loading.value = false
    })
}
onMounted(load)
watch(showHiddenProjects, load)

const hiddenCount = computed(() => choices.value.hidden.length)
const listed = computed(() => filterProjects(shownProjects(answer.value?.projects ?? [], showHiddenProjects.value), query.value))

// Six rows at most until the owner asks for all (owner, 2026-10-09). A row is as many tiles as the grid has columns,
// read from the browser so the cap follows the width. A filter shows every match, with no cap and no button.
const ROWS = 6
const grid = ref<ComponentPublicInstance | null>(null)
const cols = ref(3)
const expanded = ref(false)
function measureCols(): void {
  const el = grid.value?.$el as HTMLElement | undefined
  const tracks = el ? getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length : 0
  if (tracks) cols.value = tracks
}
let columns: ResizeObserver | null = null
watch(
  grid,
  (c) => {
    columns?.disconnect()
    columns = null
    measureCols()
    const el = c?.$el as HTMLElement | undefined
    if (el && typeof ResizeObserver !== 'undefined') {
      columns = new ResizeObserver(measureCols)
      columns.observe(el)
    }
  },
  { flush: 'post' },
)
onBeforeUnmount(() => columns?.disconnect())
const overflow = computed(() => !query.value.trim() && listed.value.length > cols.value * ROWS)
const shown = computed(() => (overflow.value && !expanded.value ? listed.value.slice(0, cols.value * ROWS) : listed.value))
const moreLabel = computed(() => (expanded.value ? 'Show fewer' : `Show all (${listed.value.length})`))
const iconSize = computed(() => (showProjectDetails.value ? 'size-7' : 'size-6'))
const folderSize = computed(() => (showProjectDetails.value ? 'size-4' : 'size-3.5'))

function open(p: ProjectEntry): void {
  src.select({ kind: 'new', cwd: p.path })
}
const picked = (p: ProjectEntry) => pickedFolder(src.selected.value, p.path)

const menuApi: ProjectMenuApi = {
  reveal: (path) => src.revealFolder(path),
  newChat: (path) => src.select({ kind: 'new', cwd: path }),
  copy: (path) => navigator.clipboard.writeText(path),
  hide: async (path) => {
    await src.changeProjectChoice?.('hidden', path, true)
    load()
  },
  unhide: async (path) => {
    await src.changeProjectChoice?.('hidden', path, false)
    load()
  },
}

function runAction(action: ProjectAction, path: string): void {
  actionProblem.value = null
  runProjectAction(action, path, menuApi).catch(fail)
}

const pick = () => src.pickFolder?.() ?? Promise.resolve(null)
const change = (kind: 'folders' | 'roots' | 'hidden', path: string, on: boolean) => src.changeProjectChoice?.(kind, path, on) ?? Promise.resolve()
function addFolder(kind: 'folders' | 'roots'): void {
  actionProblem.value = null
  addProjectFolder(kind, { pickFolder: pick, changeProjectChoice: change }).then((added) => added && load(), fail)
}

const CHIP = 'flex h-5 cursor-default items-center rounded-[var(--radius-5)] px-1.5 text-[12px] leading-4'
const chip = (on: boolean) => [CHIP, on ? 'bg-fill-hover font-semibold text-text' : 'text-text-muted hover:text-text-2']

// A tile that stops matching the filter (owner, 2026-10-08: "those kinda like nicely animated filtering ... instead of
// everything just kinda disappears") fades and shrinks out where it stands. It goes absolute at its spot so it does not
// hold its grid cell while it leaves, which the remaining tiles need to glide into. Reduced motion turns all of it off.
function pinLeaving(el: Element): void {
  const tile = el as HTMLElement
  tile.style.left = `${tile.offsetLeft}px`
  tile.style.top = `${tile.offsetTop}px`
  tile.style.width = `${tile.offsetWidth}px`
}

// The details of a tile: in its flow when the toggle is on (the tile is its old, taller self), otherwise a layer under
// the tile that shows on hover or keyboard focus and takes no room, so the grid never moves (owner, 2026-10-08: "only
// display that on hover. So it fits more vertically").
// w-full: a button is only as wide as its content, so a long name ran into the next tile (owner, 2026-10-08: "they run
// into each other"). The padding follows the toggle: roomy with the details in flow, tighter and one line without
// (owner, 2026-10-09: "shorter vertically ... so that more fits vertically").
const TILE = 'group/tile relative flex w-full min-w-0 gap-2 rounded-(--radius-12) text-start'
const TILE_BG = 'bg-fill-5 hover:bg-fill-hover'
// The folder the next chat starts in: the hover fill stays, and an inset accent ring marks it without moving the tile.
const TILE_PICKED = 'bg-fill-hover ring-1 ring-inset ring-(--accent)'
const DETAILS_HOVER = 'pointer-events-none absolute inset-x-0 top-full z-20 mt-1 hidden min-w-0 flex-col gap-2 rounded-(--radius-8) bg-(--bg-popover) p-2 group-hover/tile:flex group-focus-visible/tile:flex'
const TOGGLE = 'flex size-8 shrink-0 items-center justify-center rounded-(--radius-8) text-text-2'
// The project's open chats, at the end of its name (owner, 2026-10-08: "a little badge on them, with how many active
// chats or, I guess, unarchived chats exist for each"); those projects come first.
const OPEN_CHATS = 'ms-auto flex shrink-0 items-center gap-1 rounded-(--radius-5) bg-(--fill-secondary) px-1.5 text-[11px] font-semibold leading-4 tabular-nums text-text-2'
const openChatsLabel = (n: number) => `${n} open chat${n === 1 ? '' : 's'}`
</script>

<template>
  <!-- m-auto rather than justify-center: when the window is too short the column starts at the top and
       scrolls, instead of its top being cut off. -->
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
    <!-- The projects tab leaves 16px more under the tiles (owner, 2026-10-08: the folder row below ran into them); the composer's row is not changed. -->
    <div class="m-auto flex w-full max-w-3xl flex-col items-center" :class="tab === 'projects' ? 'pt-6 pb-10' : 'py-6'">
      <h1 class="flex items-center justify-center gap-1.75 text-center text-[22px] font-normal leading-7 text-text">
        <!-- The AgentHydra logo, the window's own favicon, where Claude draws its spark (Jacob, 2026-10-06). -->
        <img src="/favicon.svg" alt="" class="relative top-px size-5.5 shrink-0" />
        <span>What’s up next{{ name ? `, ${name}` : '' }}?</span>
      </h1>

      <div role="tablist" aria-label="New screen" class="mt-5 flex items-center gap-0.5">
        <button type="button" role="tab" :aria-selected="tab === 'projects'" :class="chip(tab === 'projects')" @click="tab = 'projects'">Projects</button>
        <button type="button" role="tab" :aria-selected="tab === 'stats'" :class="chip(tab === 'stats')" @click="tab = 'stats'">Stats</button>
      </div>

      <template v-if="tab === 'projects'">
        <div class="mt-3 flex w-full items-center gap-1.5">
          <input v-model="query" type="search" placeholder="Filter projects" aria-label="Filter projects" class="h-8 min-w-0 flex-1 rounded-(--radius-8) bg-fill-5 px-3 text-[13px] leading-4.75 text-text placeholder:text-text-muted outline-none focus-visible:ring-1 focus-visible:ring-(--accent)" />
          <Tip label="View options">
            <span class="inline-flex">
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <button type="button" aria-label="View options" :class="[TOGGLE, showProjectDetails || showHiddenProjects ? 'bg-fill-hover text-text' : 'bg-fill-5 hover:bg-fill-hover']">
                    <ListFilter class="size-4" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" :class="MENU_CONTENT" @open-auto-focus="focusFirstItem">
                  <DropdownMenuCheckboxItem :class="MENU_ITEM" :model-value="showProjectDetails" @update:model-value="(v: boolean) => (showProjectDetails = v)">Folders and git status</DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem :class="MENU_ITEM" :disabled="!hiddenCount" :model-value="showHiddenProjects" @update:model-value="(v: boolean) => (showHiddenProjects = v)">Show hidden projects ({{ hiddenCount || 'none' }})</DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </Tip>
          <Tip v-if="src.pickFolder && src.changeProjectChoice" label="Choose project folders">
            <span class="inline-flex">
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <button type="button" aria-label="Choose project folders" class="flex size-8 shrink-0 items-center justify-center rounded-(--radius-8) bg-fill-5 text-text-2 hover:bg-fill-hover">
                    <FolderPlus class="size-4" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" :class="MENU_CONTENT" @open-auto-focus="focusFirstItem">
                  <DropdownMenuItem :class="MENU_ITEM" @select="addFolder('folders')">Add a project folder…</DropdownMenuItem>
                  <DropdownMenuItem :class="MENU_ITEM" @select="addFolder('roots')">Add a folder of projects…</DropdownMenuItem>
                  <DropdownMenuItem :class="MENU_ITEM" @select="managing = true">Manage folders…</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </Tip>
        </div>
        <p v-if="actionProblem" role="alert" class="mt-3 text-[12px] leading-4 text-danger">{{ actionProblem }}</p>
        <p v-if="problem && !answer" class="mt-4 text-[12px] leading-4 text-text-muted">Could not load your projects: {{ problem }}</p>
        <p v-else-if="!answer && loading" class="mt-4 text-[12px] leading-4 text-text-muted">Loading your projects…</p>
        <p v-else-if="!listed.length" class="mt-4 text-[12px] leading-4 text-text-muted">{{ query ? 'No project matches that.' : 'No projects yet. Start a chat in a folder and it shows up here.' }}</p>
        <TransitionGroup
          v-else
          ref="grid"
          tag="div"
          class="relative mt-3 grid w-full grid-cols-3 gap-2"
          enter-active-class="transition-[opacity,scale] duration-[220ms] ease-(--ease-out) motion-reduce:transition-none"
          enter-from-class="opacity-0 scale-95"
          leave-active-class="pointer-events-none absolute transition-[opacity,scale] duration-[220ms] ease-(--ease-out) motion-reduce:transition-none"
          leave-to-class="opacity-0 scale-95"
          move-class="transition-transform duration-[220ms] ease-(--ease-snap) motion-reduce:transition-none"
          @before-leave="pinLeaving"
        >
          <div v-for="p in shown" :key="p.path" class="min-w-0">
            <ContextMenu>
              <ContextMenuTrigger as-child>
                <button type="button" :aria-pressed="picked(p)" :class="[TILE, picked(p) ? TILE_PICKED : TILE_BG, p.hidden ? 'opacity-60' : '', showProjectDetails ? 'flex-col p-3' : 'items-center px-2.5 py-1.5']" @click="open(p)">
                  <Tip :label="p.path">
                    <span class="flex w-full min-w-0 items-center gap-2">
                      <img v-if="p.icon" :src="p.icon" alt="" :class="[iconSize, 'shrink-0 rounded-(--radius-6)']" />
                      <span v-else :class="[iconSize, 'flex shrink-0 items-center justify-center rounded-(--radius-6) bg-(--fill-secondary) text-text-muted']">
                        <Folder :class="folderSize" aria-hidden="true" />
                      </span>
                      <span class="truncate text-[13px] font-semibold leading-4.75 text-text">{{ p.name }}</span>
                      <Tip v-if="p.hidden" label="Hidden from Projects">
                        <span class="inline-flex shrink-0 text-text-muted"><EyeOff class="size-3" aria-hidden="true" /></span>
                      </Tip>
                      <Tip v-if="p.openChats" :label="openChatsLabel(p.openChats)">
                        <span :class="OPEN_CHATS" :aria-label="openChatsLabel(p.openChats)">
                          <MessagesSquare class="size-3" aria-hidden="true" />{{ p.openChats }}
                        </span>
                      </Tip>
                    </span>
                  </Tip>
                  <span :class="showProjectDetails ? 'flex min-w-0 flex-col gap-2' : DETAILS_HOVER">
                    <span class="truncate text-[11px] leading-4 text-text-muted">{{ p.path }}</span>
                    <span v-if="syncLabel(p.git)" class="self-start rounded-(--radius-5) bg-(--fill-secondary) px-1.5 text-[11px] leading-4 text-text-2">{{ syncLabel(p.git) }}</span>
                  </span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent :class="MENU_CONTENT" @open-auto-focus="focusFirstItem">
                <ContextMenuItem v-for="item in projectActions(p.hidden)" :key="item.action" :class="MENU_ITEM" @select="runAction(item.action, p.path)">
                  {{ item.label }}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </div>
        </TransitionGroup>
        <button v-if="overflow" type="button" :aria-expanded="expanded" class="mt-3 h-7 rounded-(--radius-8) bg-fill-5 px-3 text-[12px] leading-4 text-text-2 hover:bg-fill-hover" @click="expanded = !expanded">{{ moreLabel }}</button>
        <p v-if="answer?.hydra.found && answer.hydra.problem" class="mt-3 text-[11px] leading-4 text-text-muted">Project Hydra: {{ answer.hydra.problem }}</p>
        <ProjectFoldersDialog :open="managing" :choices="choices" :projects="answer?.projects ?? []" @update:open="(o: boolean) => (managing = o)" @changed="load" @failed="fail" />
      </template>

      <StatsCard v-else class="mt-6" :chats="chats" />
    </div>
  </div>
</template>
