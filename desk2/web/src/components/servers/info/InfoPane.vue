<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, provide, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, Star, X } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import { findServer } from '../logic'
import { useDevServers } from '../store'
import AddProject from './AddProject.vue'
import FoundInfo from './FoundInfo.vue'
import { ICON_BTN } from './kit/kit'
import { PANE_NAV, type SubView } from './nav'
import OtherInfo from './OtherInfo.vue'
import ProcessForm from './ProcessForm.vue'
import ProjectForm from './ProjectForm.vue'
import ProjectInfo from './ProjectInfo.vue'
import { sameSelection, type DevSelection } from './selection'
import ServerInfo from './ServerInfo.vue'
import TakeoverCard from './TakeoverCard.vue'

// The right-hand pane for what the Dev servers list selected (DeskFrame's dev-servers aside, over any view): a 41px strip
// with Back, where it is (a server's project, then the server), the server's star and Close, then the body, which
// scrolls. `sel` is the selection to describe: DeskFrame keeps handing the last one while the pane slides out, so it
// never empties on its way. It reads the one client (store.ts) and keeps polling on while it shows.
//
// Back (nav.ts): a sub-view (edit, add a server, edit the project, take over) returns to its card view, scrolled where it
// was; a card view returns to the selection before it (a click in the list or a link in a card moves it), and with none
// before it the pane closes.
const props = defineProps<{ sel: DevSelection | null }>()
const emit = defineEmits<{ close: [] }>()
const servers = useDevServers()
const release = servers.use()
onBeforeUnmount(release)

const sel = computed(() => props.sel)
const projects = servers.projects
const hit = computed(() => (sel.value?.kind === 'server' ? findServer(projects.value, sel.value.id) : null))
const project = computed(() => (sel.value?.kind === 'project' ? ((projects.value ?? []).find((p) => p.id === (sel.value as { id: string }).id) ?? null) : null))
const foundItem = computed(() => (sel.value?.kind === 'found' ? (servers.found.value?.items.find((i) => i.path === (sel.value as { path: string }).path) ?? null) : null))

// With the service down the list is empty, so a server or project cannot be shown: say why rather than show nothing.
const state = computed(() => servers.status.value?.state ?? null)
const down = computed(() => !projects.value && state.value !== null && state.value !== 'running')

// ---- where Back goes ----
const sub = ref<SubView | null>(null)
const history = ref<DevSelection[]>([])
let returning = false
const body = ref<HTMLElement | null>(null)
let cardScroll = 0
watch(
  () => props.sel,
  (now, was) => {
    if (sameSelection(now, was)) return
    sub.value = null
    if (was && now && !returning) history.value = [...history.value, was].slice(-30)
    returning = false
    if (body.value) body.value.scrollTop = 0
  }
)
async function open(next: SubView) {
  cardScroll = body.value?.scrollTop ?? 0
  sub.value = next
  await nextTick()
  if (body.value) body.value.scrollTop = 0
}
async function back() {
  if (sub.value) {
    sub.value = null
    await nextTick()
    if (body.value) body.value.scrollTop = cardScroll
    return
  }
  const prev = history.value[history.value.length - 1]
  if (!prev) return emit('close')
  history.value = history.value.slice(0, -1)
  returning = true
  servers.select(prev)
}
provide(PANE_NAV, { open: (s) => void open(s), back: () => void back(), close: () => emit('close') })
const showBack = computed(() => !!sub.value || history.value.length > 0 || sel.value?.kind === 'found' || sel.value?.kind === 'add')

// A sub-view's project and server, read live so a rename shows at once.
const subProject = computed(() => {
  const s = sub.value
  if (!s) return null
  const id = s.kind === 'edit-server' ? findServer(projects.value, s.id)?.project.id : s.kind === 'edit-project' ? s.id : s.projectId
  return (projects.value ?? []).find((p) => p.id === id) ?? null
})
const subServer = computed(() => (sub.value?.kind === 'edit-server' ? (findServer(projects.value, sub.value.id)?.proc ?? null) : null))

/** The strip: a breadcrumb (the server's project, then what is shown) and the title. */
const crumb = computed(() => {
  const s = sub.value
  if (s?.kind === 'edit-server') return { parent: subProject.value?.name ?? null, title: `Edit ${subServer.value?.name ?? 'server'}` }
  if (s?.kind === 'add-server') return { parent: subProject.value?.name ?? null, title: 'New server' }
  if (s?.kind === 'edit-project') return { parent: subProject.value?.name ?? null, title: 'Edit project' }
  if (s?.kind === 'takeover') return { parent: subProject.value?.name ?? null, title: 'Take over' }
  const v = sel.value
  if (!v) return { parent: null, title: 'Details' }
  if (v.kind === 'server') return { parent: hit.value?.project.name ?? null, title: hit.value?.proc.name ?? 'Server' }
  if (v.kind === 'project') return { parent: null, title: project.value?.name ?? 'Project' }
  if (v.kind === 'found') return { parent: 'Found on this PC', title: foundItem.value?.name ?? 'Found project' }
  if (v.kind === 'other') return { parent: 'Other servers', title: `Port ${v.port}` }
  return { parent: null, title: 'Add a project' }
})
function toParent() {
  if (sub.value) return void back()
  if (sel.value?.kind === 'server' && hit.value) servers.select({ kind: 'project', id: hit.value.project.id })
}
const parentClickable = computed(() => !!sub.value || (sel.value?.kind === 'server' && !!hit.value))

const starred = computed(() => !sub.value && hit.value?.proc.starred)
function toggleStar() {
  const p = hit.value?.proc
  if (p) void servers.star(p.id, !p.starred)
}

// A deleted server leaves the history too, so Back never lands on it; its project is shown in its place.
function afterDelete() {
  const pid = subProject.value?.id
  const gone = sub.value?.kind === 'edit-server' ? sub.value.id : null
  sub.value = null
  if (gone) history.value = history.value.filter((h) => !(h.kind === 'server' && h.id === gone))
  if (!pid) return
  returning = true
  servers.select({ kind: 'project', id: pid })
}
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg-page">
    <header class="flex h-[41px] shrink-0 items-center gap-1 border-b border-border pl-2 pr-2 text-[13px]">
      <Tip v-if="showBack" label="Back">
        <button type="button" :class="ICON_BTN" aria-label="Back" @click="back"><ChevronLeft class="size-4" /></button>
      </Tip>
      <span v-else class="w-1" aria-hidden="true" />
      <nav aria-label="Where this is" class="flex min-w-0 flex-1 items-center gap-1 leading-5">
        <template v-if="crumb.parent">
          <button
            v-if="parentClickable"
            type="button"
            class="min-w-0 max-w-[45%] shrink cursor-default truncate rounded-[var(--radius-5)] px-1 text-text-muted transition-colors duration-[60ms] hover:bg-fill-hover hover:text-text-2 focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
            @click="toParent"
          >{{ crumb.parent }}</button>
          <span v-else class="min-w-0 max-w-[45%] shrink truncate px-1 text-text-muted">{{ crumb.parent }}</span>
          <ChevronRight class="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
        </template>
        <h2 class="min-w-0 truncate px-1 font-medium text-text">{{ crumb.title }}</h2>
      </nav>
      <Tip v-if="hit && !sub" :label="starred ? 'Unstar: no longer listed first' : 'Star: listed first in its project'">
        <button
          type="button"
          :class="[ICON_BTN, starred && 'text-warning hover:text-warning']"
          :aria-label="starred ? `Unstar ${hit.proc.name}` : `Star ${hit.proc.name}`"
          :aria-pressed="!!starred"
          @click="toggleStar"
        >
          <Star class="size-4" :class="starred && 'fill-current'" />
        </button>
      </Tip>
      <Tip label="Close details">
        <button type="button" :class="ICON_BTN" aria-label="Close details" @click="emit('close')"><X class="size-4" /></button>
      </Tip>
    </header>

    <div ref="body" class="@container relative min-h-0 flex-1 overflow-y-auto text-[13px] leading-5 text-text">
      <p v-if="!sel" class="p-4 text-text-muted">Pick a server, project or folder in the list to see its details.</p>
      <p v-else-if="down && (sel.kind === 'server' || sel.kind === 'project')" role="status" class="p-4 text-text-muted">
        <template v-if="state === 'starting'">Starting the dev-servers service…</template>
        <template v-else>
          The dev-servers service is not running.
          <button type="button" class="ml-1 rounded-[var(--radius-5)] px-1 text-text-2 hover:bg-fill-hover" @click="servers.tryAgain()">Start it now</button>
        </template>
      </p>

      <template v-else-if="sub">
        <ProcessForm
          v-if="(sub.kind === 'edit-server' || sub.kind === 'add-server') && subProject"
          :key="sub.kind === 'edit-server' ? sub.id : `new:${sub.projectId}`"
          :project-id="subProject.id"
          :process-id="sub.kind === 'edit-server' ? sub.id : null"
          :siblings="subProject.processes"
          @saved="back"
          @cancel="back"
          @deleted="afterDelete"
        />
        <ProjectForm v-else-if="sub.kind === 'edit-project' && subProject" :key="subProject.id" :project="subProject" @saved="back" @cancel="back" @removed="emit('close')" />
        <TakeoverCard v-else-if="sub.kind === 'takeover' && subProject" :key="subProject.id" :project-id="subProject.id" />
        <p v-else class="p-4 text-text-muted">This is not in the list any more.</p>
      </template>

      <template v-else-if="sel.kind === 'server'">
        <ServerInfo v-if="hit" :key="hit.proc.id" :project="hit.project" :proc="hit.proc" />
        <p v-else-if="projects" class="p-4 text-text-muted">This server is not in the list any more.</p>
      </template>
      <template v-else-if="sel.kind === 'project'">
        <ProjectInfo v-if="project" :key="project.id" :project="project" />
        <p v-else-if="projects" class="p-4 text-text-muted">This project is not in the list any more.</p>
      </template>
      <template v-else-if="sel.kind === 'found'">
        <FoundInfo v-if="foundItem" :key="foundItem.path" :item="foundItem" />
        <p v-else-if="servers.found.value" class="p-4 text-text-muted">This folder is not on the found list any more. It may have been added or ignored.</p>
      </template>
      <OtherInfo v-else-if="sel.kind === 'other'" :key="sel.port" :port="sel.port" />
      <AddProject v-else />
    </div>
  </section>
</template>
