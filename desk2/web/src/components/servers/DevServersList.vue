<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { Play, RotateCw, Square } from '@lucide/vue'
import type { DevWebProcess, DevWebProject } from '@shared/devwebui'
import { processAddress } from '@shared/devwebui'
import { shellGlyphs } from '@/lib/icons'
import { Tip } from '@/components/ui/tooltip'
import { HEADER_BTN, LIST_HEADER, LIST_ROW } from '@/components/sidebar/rowClasses'
import { actionDisabled, allKey, groupActions, listView, OUTSIDE_TIP, outsideNote, serverActions, serverPort, startBlock, statusDot, statusWord, type ServerAction } from './logic'
import { useDevServers } from './store'
import { DOT } from './styles'

// The sidebar's Dev servers list (the title bar's Dev servers button): the projects, a header each (its name,
// Start all / Stop all for a project with more than one server, how many run) and its servers under it, running ones
// first, each a status dot, its name and port, and Start / Stop / Restart on hover. A click shows the server in the right
// servers pane (DeskFrame answers the store's `focus`). A server someone else started wears a quiet note, and one whose
// port a program holds has its Start off with the reason. It reads the window's one client (store.ts), the pane's
// too, and keeps its polling on while it is on screen. Rows and headers wear the cloud list's look (sidebar/rowClasses.ts).
const servers = useDevServers()
const release = servers.use()
onBeforeUnmount(release)

const view = computed(() => listView({ status: servers.status.value, statusMissing: servers.statusMissing.value, projects: servers.projects.value, projectsError: servers.projectsError.value }))
const collapsed = ref(new Set<string>())
function toggleGroup(id: string) {
  const next = new Set(collapsed.value)
  if (!next.delete(id)) next.add(id)
  collapsed.value = next
}

const ACTION = {
  start: { label: 'Start', icon: Play },
  stop: { label: 'Stop', icon: Square },
  restart: { label: 'Restart', icon: RotateCw }
} as const
const ROW_BTN =
  'flex size-5 shrink-0 items-center justify-center rounded-[var(--radius-5)] text-text-muted hover:bg-fill-hover hover:text-text focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40'
const NOTE = 'px-1.5 pt-3 text-[12px] leading-4 text-text-muted'
const LINK = 'ml-1 rounded-[4px] px-1 text-text-2 hover:bg-fill-hover'

const act = (p: DevWebProcess, a: ServerAction) => servers.act(p, a)
function tip(project: DevWebProject, p: DevWebProcess): string {
  return [p.name, [statusWord(p), serverPort(p) || null].filter(Boolean).join(' · '), outsideNote(p), startBlock(p), processAddress(p), project.name].filter(Boolean).join('\n')
}
</script>

<template>
  <div class="flex flex-col" role="region" aria-label="Dev servers">
    <header v-if="view.kind === 'loading' || view.kind === 'starting'" :class="LIST_HEADER">
      <span role="status">{{ view.kind === 'starting' ? 'Starting the server manager…' : 'Loading servers…' }}</span>
    </header>

    <p v-else-if="view.kind === 'restart-desk'" :class="NOTE">Restart AgentHydra to turn on servers.</p>
    <p v-else-if="view.kind === 'failed'" role="alert" :class="[NOTE, 'text-danger-text']">
      The server manager did not start: {{ view.reason }}
      <button type="button" :class="LINK" @click="servers.tryAgain()">Try again</button>
    </p>
    <p v-else-if="view.kind === 'stopped'" :class="NOTE">
      The server manager is not running; it starts when a chat or a server needs it.
      <button type="button" :class="LINK" @click="servers.tryAgain()">Start it now</button>
    </p>
    <p v-else-if="view.kind === 'unreachable'" role="alert" :class="[NOTE, 'text-danger-text']">The server manager did not answer: {{ view.reason }}</p>
    <p v-else-if="view.kind === 'empty'" role="status" :class="NOTE">No projects yet. Open a chat's Browser button to set up its folder's servers.</p>

    <template v-else-if="view.kind === 'list'">
      <p v-if="servers.actionError.value" role="alert" class="px-1.5 pt-2 text-[12px] leading-4 text-danger-text">{{ servers.actionError.value }}</p>
      <section v-for="g in view.groups" :key="g.project.id" :aria-label="g.project.name">
        <header :class="LIST_HEADER">
          <Tip :label="g.project.path" align="start">
            <button type="button" class="flex min-w-0 items-center gap-0.5 rounded-[4px] hover:text-text-2" :aria-expanded="!collapsed.has(g.project.id)" @click="toggleGroup(g.project.id)">
              <span class="truncate">{{ g.project.name }}</span>
              <component
                :is="shellGlyphs.groupChevron"
                class="size-3 shrink-0 transition-transform duration-[var(--dur-fast)] group-hover/head:opacity-100"
                :class="collapsed.has(g.project.id) ? 'opacity-100' : 'rotate-90 opacity-0'"
              />
            </button>
          </Tip>
          <span class="flex-1" />
          <template v-if="groupActions(g.servers).start">
            <Tip label="Start all">
              <button type="button" :class="HEADER_BTN" :disabled="servers.busy.value.has(allKey(g.project))" :aria-label="`Start all in ${g.project.name}`" @click="servers.actAll(g.project, 'start')"><Play class="size-3.5" /></button>
            </Tip>
          </template>
          <template v-if="groupActions(g.servers).stop">
            <Tip label="Stop all">
              <button type="button" :class="HEADER_BTN" :disabled="servers.busy.value.has(allKey(g.project))" :aria-label="`Stop all in ${g.project.name}`" @click="servers.actAll(g.project, 'stop')"><Square class="size-3.5" /></button>
            </Tip>
          </template>
          <span class="tnum" :title="`${g.running} of ${g.servers.length} running`">{{ g.running }}/{{ g.servers.length }}</span>
        </header>
        <p v-if="!g.servers.length" class="px-1.5 pb-1 text-[12px] leading-4 text-text-muted">No servers in this project.</p>
        <div v-else-if="!collapsed.has(g.project.id)" class="flex flex-col gap-[1.5px] pt-[1.5px]">
          <Tip v-for="p in g.servers" :key="p.id" :label="tip(g.project, p)" side="right" align="start">
            <div
              role="button"
              tabindex="0"
              :aria-label="`Open ${p.name}`"
              :aria-description="statusWord(p)"
              :class="[LIST_ROW, 'text-text-2 hover:bg-fill-hover']"
              @click="servers.show(g.project, p)"
              @keydown.enter.self="servers.show(g.project, p)"
            >
              <span class="flex size-6 shrink-0 items-center justify-center"><span class="size-1.5 rounded-full" :class="DOT[statusDot(p.status)]" aria-hidden="true" /></span>
              <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
              <span v-if="outsideNote(p)" class="shrink-0 text-[11px] leading-4 text-text-muted" :title="OUTSIDE_TIP">{{ outsideNote(p) }}</span>
              <span v-if="p.port" class="shrink-0 rounded-[4px] bg-fill-5 px-1 text-[11px] leading-4 text-text-muted tnum">{{ serverPort(p) }}</span>
              <span class="hidden shrink-0 items-center gap-0.5 group-hover/row:flex group-focus-within/row:flex" @click.stop>
                <Tip v-for="a in serverActions(p.status)" :key="a" :label="a !== 'stop' && startBlock(p) ? startBlock(p)! : ACTION[a].label">
                  <button type="button" :class="ROW_BTN" :disabled="actionDisabled(p, a, servers.busy.value.has(p.id))" :aria-label="`${ACTION[a].label} ${p.name}`" @click="act(p, a)">
                    <component :is="ACTION[a].icon" class="size-3.5" />
                  </button>
                </Tip>
              </span>
            </div>
          </Tip>
        </div>
      </section>
    </template>
  </div>
</template>
