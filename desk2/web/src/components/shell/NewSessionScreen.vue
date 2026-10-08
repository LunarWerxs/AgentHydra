<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Folder, FolderPlus } from '@lucide/vue'
import type { ChatSummary, ProjectChoices, ProjectEntry } from '@shared/protocol'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { focusFirstItem, MENU_CONTENT, MENU_ITEM } from '../sidebar/menuClasses'
import ProjectFoldersDialog from './ProjectFoldersDialog.vue'
import StatsCard from './StatsCard.vue'
import { useShellSource } from './source'
import { addProjectFolder, filterProjects, PROJECT_ACTIONS, type ProjectAction, type ProjectMenuApi, runProjectAction, syncLabel } from './projects'

// The new-session screen above the composer: greeting, then either the user's projects (the default; clicking one
// starts a new chat in its folder) or the stats card behind a Stats tab (owner, 2026-10-08: "I click New Chat, and
// rather than seeing this overview and models, I see all my projects"). The composer below owns the env pills and
// the model chip.
defineProps<{ name: string; chats: ChatSummary[] }>()
const src = useShellSource()

const tab = ref<'projects' | 'stats'>('projects')
const query = ref('')
const answer = ref(src.cachedProjects?.() ?? null)
const loading = ref(false)
const problem = ref<string | null>(null)
const actionProblem = ref<string | null>(null)
const managing = ref(false)
const NO_CHOICES: ProjectChoices = { folders: [], roots: [], hidden: [] }
const choices = computed(() => answer.value?.choices ?? NO_CHOICES)

function fail(err: unknown): void {
  actionProblem.value = err instanceof Error ? err.message : String(err)
}

function load(): void {
  if (!src.projects) return
  loading.value = true
  src.projects().then(
    (res) => {
      answer.value = res
      problem.value = null
    },
    (err: unknown) => {
      problem.value = err instanceof Error ? err.message : String(err)
    }
  ).finally(() => (loading.value = false))
}
onMounted(load)

const listed = computed(() => filterProjects(answer.value?.projects ?? [], query.value))

function open(p: ProjectEntry): void {
  src.select({ kind: 'new', cwd: p.path })
}

const menuApi: ProjectMenuApi = {
  reveal: (path) => src.revealFolder(path),
  newChat: (path) => src.select({ kind: 'new', cwd: path }),
  copy: (path) => navigator.clipboard.writeText(path),
  hide: async (path) => {
    await src.changeProjectChoice?.('hidden', path, true)
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
</script>

<template>
  <!-- m-auto rather than justify-center: when the window is too short the column starts at the top and
       scrolls, instead of its top being cut off. -->
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
    <div class="m-auto flex w-full max-w-3xl flex-col items-center py-6">
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
          <DropdownMenu v-if="src.pickFolder && src.changeProjectChoice">
            <DropdownMenuTrigger as-child>
              <button type="button" aria-label="Choose project folders" title="Choose project folders" class="flex size-8 shrink-0 items-center justify-center rounded-(--radius-8) bg-fill-5 text-text-2 hover:bg-fill-hover">
                <FolderPlus class="size-4" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" :class="MENU_CONTENT" @open-auto-focus="focusFirstItem">
              <DropdownMenuItem :class="MENU_ITEM" @select="addFolder('folders')">Add a project folder…</DropdownMenuItem>
              <DropdownMenuItem :class="MENU_ITEM" @select="addFolder('roots')">Add a folder of projects…</DropdownMenuItem>
              <DropdownMenuItem :class="MENU_ITEM" @select="managing = true">Manage folders…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <p v-if="actionProblem" role="alert" class="mt-3 text-[12px] leading-4 text-danger">{{ actionProblem }}</p>
        <p v-if="problem && !answer" class="mt-4 text-[12px] leading-4 text-text-muted">Could not load your projects: {{ problem }}</p>
        <p v-else-if="!answer && loading" class="mt-4 text-[12px] leading-4 text-text-muted">Loading your projects…</p>
        <p v-else-if="!listed.length" class="mt-4 text-[12px] leading-4 text-text-muted">{{ query ? 'No project matches that.' : 'No projects yet. Start a chat in a folder and it shows up here.' }}</p>
        <div v-else class="mt-3 grid w-full grid-cols-3 gap-2">
          <ContextMenu v-for="p in listed" :key="p.path">
            <ContextMenuTrigger as-child>
              <button type="button" :title="p.path" class="flex min-w-0 flex-col gap-2 rounded-(--radius-12) bg-fill-5 p-3 text-start hover:bg-fill-hover" @click="open(p)">
                <span class="flex min-w-0 items-center gap-2">
                  <img v-if="p.icon" :src="p.icon" alt="" class="size-7 shrink-0 rounded-(--radius-6)" />
                  <span v-else class="flex size-7 shrink-0 items-center justify-center rounded-(--radius-6) bg-(--fill-secondary) text-text-muted">
                    <Folder class="size-4" aria-hidden="true" />
                  </span>
                  <span class="truncate text-[13px] font-semibold leading-4.75 text-text">{{ p.name }}</span>
                </span>
                <span class="truncate text-[11px] leading-4 text-text-muted">{{ p.path }}</span>
                <span v-if="syncLabel(p.git)" class="self-start rounded-(--radius-5) bg-(--fill-secondary) px-1.5 text-[11px] leading-4 text-text-2">{{ syncLabel(p.git) }}</span>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent :class="MENU_CONTENT" @open-auto-focus="focusFirstItem">
              <ContextMenuItem v-for="item in PROJECT_ACTIONS" :key="item.action" :class="MENU_ITEM" @select="runAction(item.action, p.path)">
                {{ item.label }}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>
        <p v-if="answer?.hydra.found && answer.hydra.problem" class="mt-3 text-[11px] leading-4 text-text-muted">Project Hydra: {{ answer.hydra.problem }}</p>
        <ProjectFoldersDialog :open="managing" :choices="choices" @update:open="(o: boolean) => (managing = o)" @changed="load" @failed="fail" />
      </template>

      <StatsCard v-else class="mt-6" :chats="chats" />
    </div>
  </div>
</template>
