<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, Star, X } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import { findServer } from '../logic'
import { useDevServers } from '../store'
import AddProject from './AddProject.vue'
import DevHome from './DevHome.vue'
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

// The Dev servers page (owner, 2026-10-07: "just be its own page ... cap the width ... have it slide in like Hydra
// slides in"): DeskFrame slides it in on AgentHydra's track, in the chat's place. A 41px strip with Back, where it is
// (Dev servers, a server's project, then the server), the server's star and Close, then the body, which scrolls, its
// content one centered column of at most 960px. `sel` is what it shows, null being the overview of every project
// (DevHome); DeskFrame keeps handing the last one while the page slides out, so it never empties on its way. `padLeft`
// is the room the chrome bar's buttons cover with the sidebar hidden. It reads the one client (store.ts) and keeps
// polling on while it is mounted.
//
// Back (nav.ts): a sub-view (edit, add a server, edit the project, take over) returns to its card view, scrolled where it
// was; a card view returns to the selection before it (a click in the list or a link in a card moves it), and with none
// before it to the overview. Escape goes back from a sub-view and closes the page from anywhere else, unless a field, a
// dialog or a menu has it.
const props = withDefaults(defineProps<{ sel: DevSelection | null; active?: boolean; padLeft?: number }>(), { active: true, padLeft: 8 })
const emit = defineEmits<{ close: [] }>()
const servers = useDevServers()
const release = servers.use()
onBeforeUnmount(release)

const sel = computed(() => props.sel)
const projects = servers.projects
const hit = computed(() => (sel.value?.kind === 'server' ? findServer(projects.value, sel.value.id) : null))
const project = computed(() => (sel.value?.kind === 'project' ? ((projects.value ?? []).find((p) => p.id === (sel.value as { id: string }).id) ?? null) : null))
const foundItem = computed(() => (sel.value?.kind === 'found' ? (servers.found.value?.items.find((i) => i.path === (sel.value as { path: string }).path) ?? null) : null))

// With the service down the list is empty, so the overview, a server or a project cannot be shown: say why rather than show nothing.
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
    if (!now) history.value = []
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
  if (!prev) return goHome()
  history.value = history.value.slice(0, -1)
  revisit(prev)
}
/** Moves as Back does, so the move is not added to the history; a move to what is shown already changes nothing. */
function revisit(next: DevSelection) {
  returning = !sameSelection(next, props.sel)
  servers.select(next)
}
/** A breadcrumb step: it leaves a sub-view even when the selection stays the same. */
function crumbTo(next: DevSelection) {
  sub.value = null
  servers.select(next)
}
/** The overview: the breadcrumb's root, and where Back ends. */
function goHome() {
  sub.value = null
  history.value = []
  servers.select(null)
}
provide(PANE_NAV, { open: (s) => void open(s), back: () => void back(), close: () => emit('close') })
const showBack = computed(() => !!sub.value || !!sel.value)

function onKey(e: KeyboardEvent) {
  if (!props.active || e.key !== 'Escape' || e.defaultPrevented) return
  if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
  const t = e.target as HTMLElement | null
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
  e.preventDefault()
  if (sub.value) void back()
  else emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

// A sub-view's project and server, read live so a rename shows at once.
const subProject = computed(() => {
  const s = sub.value
  if (!s) return null
  const id = s.kind === 'edit-server' ? findServer(projects.value, s.id)?.project.id : s.kind === 'edit-project' ? s.id : s.projectId
  return (projects.value ?? []).find((p) => p.id === id) ?? null
})
const subServer = computed(() => (sub.value?.kind === 'edit-server' ? (findServer(projects.value, sub.value.id)?.proc ?? null) : null))

/** The strip: a breadcrumb from Dev servers (the overview) down to what is shown, each step a link where it leads somewhere. */
type Crumb = { label: string; go?: () => void }
const crumbs = computed<{ path: Crumb[]; title: string }>(() => {
  const home: Crumb = { label: 'Dev servers', go: goHome }
  const s = sub.value
  const pr = subProject.value
  if (s?.kind === 'edit-server') {
    const path: Crumb[] = [home]
    if (pr) path.push({ label: pr.name, go: () => crumbTo({ kind: 'project', id: pr.id }) })
    path.push({ label: subServer.value?.name ?? 'Server', go: () => void back() })
    return { path, title: 'Edit' }
  }
  if (s) return { path: [home, { label: pr?.name ?? 'Project', go: () => void back() }], title: s.kind === 'add-server' ? 'New server' : s.kind === 'edit-project' ? 'Edit project' : 'Take over' }
  const v = sel.value
  if (!v) return { path: [], title: 'Dev servers' }
  if (v.kind === 'server') {
    const p = hit.value?.project
    return { path: p ? [home, { label: p.name, go: () => crumbTo({ kind: 'project', id: p.id }) }] : [home], title: hit.value?.proc.name ?? 'Server' }
  }
  if (v.kind === 'project') return { path: [home], title: project.value?.name ?? 'Project' }
  if (v.kind === 'found') return { path: [home, { label: 'Found on this PC' }], title: foundItem.value?.name ?? 'Found project' }
  if (v.kind === 'other') return { path: [home, { label: 'Other servers' }], title: `Port ${v.port}` }
  return { path: [home], title: 'Add a project' }
})
const CRUMB = 'min-w-0 max-w-[14rem] shrink truncate rounded-[var(--radius-5)] px-1 text-text-muted'
const CRUMB_LINK = `${CRUMB} cursor-default transition-colors duration-[60ms] hover:bg-fill-hover hover:text-text-2 focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none`

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
  if (pid) revisit({ kind: 'project', id: pid })
}
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg-page" :aria-label="sel ? 'Server details' : 'Dev servers overview'">
    <!-- The window's title row when it draws its own (lib/host-window.ts): it drags the window, and keeps clear of its buttons. -->
    <header class="title-drag flex h-10.25 shrink-0 items-center gap-1 border-b border-border pe-[calc(0.5rem_+_var(--caption-w))] text-[13px]" :style="{ paddingInlineStart: `${padLeft}px` }">
      <Tip v-if="showBack" label="Back">
        <button type="button" :class="ICON_BTN" aria-label="Back" @click="back"><ChevronLeft class="size-4" /></button>
      </Tip>
      <span v-else class="w-1" aria-hidden="true" />
      <nav aria-label="Where this is" class="flex min-w-0 flex-1 items-center gap-1 leading-5">
        <template v-for="(c, i) in crumbs.path" :key="i">
          <button v-if="c.go" type="button" :class="CRUMB_LINK" @click="c.go">{{ c.label }}</button>
          <span v-else :class="CRUMB">{{ c.label }}</span>
          <ChevronRight class="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
        </template>
        <h2 class="min-w-0 truncate px-1 font-medium text-text">{{ crumbs.title }}</h2>
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
      <Tip label="Close Dev servers (Esc)">
        <button type="button" :class="ICON_BTN" aria-label="Close Dev servers" @click="emit('close')"><X class="size-4" /></button>
      </Tip>
    </header>

    <!-- One centered column, capped so a wide window does not stretch the cards; each view fills its height (a form's Save bar sticks to the bottom). -->
    <div ref="body" class="relative min-h-0 flex-1 overflow-y-auto text-[13px] leading-5 text-text">
      <div class="@container mx-auto flex min-h-full w-full max-w-240 flex-col *:flex-1">
        <p v-if="down && (!sel || sel.kind === 'server' || sel.kind === 'project')" role="status" class="p-4 text-text-muted">
          <template v-if="state === 'starting'">Starting the dev-servers service…</template>
          <template v-else>
            The dev-servers service is not running.
            <button type="button" class="ms-1 rounded-(--radius-5) px-1 text-text-2 hover:bg-fill-hover" @click="servers.tryAgain()">Start it now</button>
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
          <ProjectForm v-else-if="sub.kind === 'edit-project' && subProject" :key="subProject.id" :project="subProject" @saved="back" @cancel="back" @removed="goHome" />
          <TakeoverCard v-else-if="sub.kind === 'takeover' && subProject" :key="subProject.id" :project-id="subProject.id" />
          <p v-else class="p-4 text-text-muted">This is not in the list any more.</p>
        </template>

        <DevHome v-else-if="!sel" />
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
    </div>
  </section>
</template>
