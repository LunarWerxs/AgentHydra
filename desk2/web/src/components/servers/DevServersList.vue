<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { AlertTriangle, ExternalLink, File, Folder, FolderPlus, Loader2, Play, Plus, RotateCw, ScanSearch, Square, Star, X } from '@lucide/vue'
import type { DevWebFoundItem, DevWebProcess, DevWebProject, DevWebScanPreset, LocalServers } from '@shared/devwebui'
import { processAddress } from '@shared/devwebui'
import { shellGlyphs } from '@/lib/icons'
import { Tip } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { HEADER_BTN, LIST_HEADER, LIST_ROW } from '@/components/sidebar/rowClasses'
import { ignoreFolder, loadProject, localhostServers, scanProjects, startAllServers, stopAllServers } from './api'
import { actionDisabled, allKey, filterLocal, groupActions, isUp, listView, matchesFilter, OUTSIDE_TIP, outsideNote, serverActions, serverPort, sortServers, startBlock, statusDot, statusWord, type ServerAction } from './logic'
import { sameSelection, type DevSelection } from './info/selection'
import { useDevServers } from './store'
import CountBadge from './info/kit/CountBadge.vue'
import { DOT, INPUT } from './styles'

// The sidebar's Dev servers list (the title bar's Dev servers button). A toolbar (filter, Scan, Add project, Start all /
// Stop all) over the projects (a header each and its servers: starred first, then the ones that are up, then by name),
// then "Found on this PC" (what scans found and nobody added) and "Other servers" (dev servers no project lists). A click
// SELECTS a row and the Dev servers page, in the chat's place, describes it (store.select); nothing starts by a click.
// Start / Stop / Restart are on hover, and Open in browser (the old click) on rows with an address. It reads the
// window's one client (store.ts), the page's too, and keeps its polling on while it is on screen. Rows wear the cloud list's look (sidebar/rowClasses.ts).
const servers = useDevServers()
const release = servers.use()
onBeforeUnmount(release)

const filter = ref('')
const q = computed(() => filter.value.trim())
const selected = servers.selection

const view = computed(() => listView({ status: servers.status.value, statusMissing: servers.statusMissing.value, projects: servers.projects.value, projectsError: servers.projectsError.value }))
const collapsed = ref(new Set<string>())
function toggleGroup(id: string) {
  const next = new Set(collapsed.value)
  if (!next.delete(id)) next.add(id)
  collapsed.value = next
}

const up = (p: DevWebProcess): number => (isUp(p.status) ? 0 : 1)
const arrange = (procs: DevWebProcess[]): DevWebProcess[] =>
  sortServers(procs).sort((a, b) => Number(!!b.starred) - Number(!!a.starred) || up(a) - up(b) || a.name.localeCompare(b.name))

// The groups the filter leaves: a project whose name matches keeps all its servers, otherwise only the servers that match.
const groups = computed(() => {
  if (view.value.kind !== 'list') return []
  const f = q.value
  return view.value.groups
    .map((g) => {
      const all = arrange(g.servers)
      const shown = !f || matchesFilter(g.project.name, f) ? all : all.filter((p) => matchesFilter(`${g.project.name} ${p.name} ${p.port ?? ''} :${p.port ?? ''}`, f))
      return { ...g, servers: shown, total: all.length, hit: !f || shown.length > 0 || matchesFilter(g.project.name, f) }
    })
    .filter((g) => g.hit)
})

const items = computed<DevWebFoundItem[]>(() => (servers.found.value?.items ?? []).filter((i) => !q.value || matchesFilter(`${i.name} ${i.path} ${i.framework ?? ''}`, q.value)))
const scanning = computed(() => !!servers.found.value?.scanning || scanBusy.value)

const local = shallowRef<LocalServers | null>(null)
let localAt = 0
async function loadLocal() {
  if (Date.now() - localAt < 8000) return
  localAt = Date.now()
  local.value = await localhostServers().catch(() => local.value)
}
watch(servers.answered, () => view.value.kind === 'list' && void loadLocal(), { immediate: true })
const others = computed(() => filterLocal(local.value?.servers ?? [], q.value))

const ACTION = {
  start: { label: 'Start', icon: Play },
  stop: { label: 'Stop', icon: Square },
  restart: { label: 'Restart', icon: RotateCw }
} as const
const ROW_BTN =
  'flex size-5 shrink-0 items-center justify-center rounded-[var(--radius-5)] text-text-muted hover:bg-fill-hover hover:text-text focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40'
const NOTE = 'px-1.5 pt-3 text-[12px] leading-4 text-text-muted'
const LINK = 'ml-1 rounded-[4px] px-1 text-text-2 hover:bg-fill-hover'

const pick = (sel: DevSelection) => servers.select(sel)
const on = (sel: DevSelection): boolean => sameSelection(selected.value, sel)
const rowOn = (sel: DevSelection): string => (on(sel) ? 'bg-fill-selected text-text' : 'text-text-2 hover:bg-fill-hover')
const act = (p: DevWebProcess, a: ServerAction) => servers.act(p, a)
function tip(project: DevWebProject, p: DevWebProcess): string {
  return [p.name, [statusWord(p), serverPort(p) || null].filter(Boolean).join(' · '), outsideNote(p), startBlock(p), processAddress(p), project.name].filter(Boolean).join('\n')
}

const error = ref<string | null>(null)
const fail = (err: unknown) => (error.value = err instanceof Error ? err.message : String(err))

const scanBusy = ref(false)
async function scan(preset: DevWebScanPreset) {
  if (scanning.value) return
  scanBusy.value = true
  error.value = null
  try {
    await scanProjects(preset)
    await servers.refresh()
  } catch (err) {
    fail(err)
  } finally {
    scanBusy.value = false
  }
}

const busyFound = ref(new Set<string>())
async function guard(path: string, fn: () => Promise<void>) {
  if (busyFound.value.has(path)) return
  busyFound.value = new Set(busyFound.value).add(path)
  error.value = null
  try {
    await fn()
  } catch (err) {
    fail(err)
  } finally {
    const next = new Set(busyFound.value)
    next.delete(path)
    busyFound.value = next
  }
}
// A folder with no .devwebui comes back as a proposal to review: its found row opens for that instead of adding blind.
const add = (i: DevWebFoundItem) =>
  guard(i.path, async () => {
    const r = await loadProject(i.path)
    if (r.error) throw new Error(r.error)
    if (r.project) {
      await servers.refresh()
      pick({ kind: 'project', id: r.project.id })
    } else if (r.needsScaffold) pick({ kind: 'found', path: i.path })
  })
const ignore = (i: DevWebFoundItem) =>
  guard(i.path, async () => {
    await ignoreFolder(i.path)
    if (on({ kind: 'found', path: i.path })) servers.select(null)
    await servers.refresh()
  })
const addable = computed(() => items.value.filter((i) => (i.kind === 'file' ? i.valid !== false : true)))
// Asked from the confirm dialog; a second click while it runs is the same click. A project that also starts itself
// from outside AgentHydra is selected afterwards, so its take-over card shows.
const addingAll = ref(false)
async function addAll() {
  if (addingAll.value) return
  addingAll.value = true
  const todo = addable.value
  error.value = null
  let skipped = 0
  let takeover: string | null = null
  try {
    for (const i of todo) {
      try {
        const r = await loadProject(i.path)
        if (!r.project) skipped++
        else if (!takeover && r.autostartTriggers?.length) takeover = r.project.id
      } catch {
        skipped++
      }
    }
    await servers.refresh()
  } finally {
    addingAll.value = false
  }
  if (takeover) pick({ kind: 'project', id: takeover })
  if (skipped) error.value = `${skipped} could not be added without a look; open them to review.`
}

const confirm = ref<'start' | 'stop' | 'add' | null>(null)
const CONFIRM = {
  start: { title: 'Start all servers?', text: () => 'This starts every server that is switched on, in every project.', button: 'Start all' },
  stop: { title: 'Stop all servers?', text: () => 'This stops every server that is running, including ones AgentHydra did not start.', button: 'Stop all' },
  add: {
    title: 'Add every found project?',
    text: () => `This adds ${addable.value.length === 1 ? '1 found project' : `${addable.value.length} found projects`} to the list. Nothing is started.`,
    button: 'Add all'
  }
} as const
// The last one asked keeps its words while the dialog fades out.
const shown = ref<keyof typeof CONFIRM>('start')
watch(confirm, (c) => c && (shown.value = c))
async function runAll() {
  const what = confirm.value
  confirm.value = null
  if (what === 'add') return void addAll()
  error.value = null
  try {
    if (what === 'start') await startAllServers()
    else if (what === 'stop') await stopAllServers()
    await servers.refresh()
  } catch (err) {
    fail(err)
  }
}
const openBrowser = (project: DevWebProject, p: DevWebProcess) => servers.show(project, p)
const anyUp = computed(() => (servers.projects.value ?? []).some((p) => p.processes.some((x) => isUp(x.status))))
</script>

<template>
  <div class="flex flex-col" role="region" aria-label="Dev servers">
    <div v-if="view.kind === 'list' || view.kind === 'empty'" class="flex items-center gap-1 px-1 pb-1 pt-1.5">
      <input v-model="filter" type="search" :class="INPUT" placeholder="Filter servers" aria-label="Filter servers" />
      <DropdownMenu>
        <Tip label="Scan this PC for projects">
          <DropdownMenuTrigger as-child>
            <button type="button" :class="HEADER_BTN" aria-label="Scan this PC for projects">
              <Loader2 v-if="scanning" class="size-3.5 animate-spin" />
              <ScanSearch v-else class="size-3.5" />
            </button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="start">
          <DropdownMenuItem :disabled="scanning" @select="scan('quick')">Quick scan</DropdownMenuItem>
          <DropdownMenuItem :disabled="scanning" @select="scan('deep')">Deep scan</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tip label="Add a project">
        <button type="button" :class="HEADER_BTN" aria-label="Add a project" @click="pick({ kind: 'add' })"><Plus class="size-3.5" /></button>
      </Tip>
      <Tip label="Start all servers">
        <button type="button" :class="HEADER_BTN" aria-label="Start all servers" @click="confirm = 'start'"><Play class="size-3.5" /></button>
      </Tip>
      <Tip label="Stop all servers">
        <button type="button" :class="HEADER_BTN" aria-label="Stop all servers" :disabled="!anyUp" @click="confirm = 'stop'"><Square class="size-3.5" /></button>
      </Tip>
    </div>

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

    <template v-if="view.kind === 'list' || view.kind === 'empty'">
      <p v-if="servers.actionError.value || error" role="alert" class="px-1.5 pt-2 text-[12px] leading-4 text-danger-text">{{ servers.actionError.value || error }}</p>
      <p v-if="view.kind === 'empty' && !items.length" role="status" :class="NOTE">No projects yet. Scan this PC, or add a folder with the + button.</p>

      <section v-for="g in groups" :key="g.project.id" :aria-label="g.project.name">
        <header :class="LIST_HEADER">
          <Tip :label="g.project.path" align="start">
            <button type="button" class="min-w-0 truncate rounded-[4px] hover:text-text-2" :class="on({ kind: 'project', id: g.project.id }) && 'text-text'" @click="pick({ kind: 'project', id: g.project.id })">{{ g.project.name }}</button>
          </Tip>
          <Tip :label="collapsed.has(g.project.id) ? 'Expand' : 'Collapse'">
            <button type="button" class="flex size-4 shrink-0 items-center justify-center rounded-[4px] hover:text-text-2" :aria-expanded="!collapsed.has(g.project.id)" :aria-label="`${collapsed.has(g.project.id) ? 'Expand' : 'Collapse'} ${g.project.name}`" @click="toggleGroup(g.project.id)">
              <component :is="shellGlyphs.groupChevron" class="size-3 shrink-0 transition-transform duration-[var(--dur-fast)]" :class="collapsed.has(g.project.id) ? '' : 'rotate-90'" />
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
          <span class="tnum" :title="`${g.running} of ${g.total} running`">{{ g.running }}/{{ g.total }}</span>
        </header>
        <p v-if="!g.total" class="px-1.5 pb-1 text-[12px] leading-4 text-text-muted">No servers in this project.</p>
        <div v-else-if="!collapsed.has(g.project.id)" class="flex flex-col gap-[1.5px] pt-[1.5px]">
          <Tip v-for="p in g.servers" :key="p.id" :label="tip(g.project, p)" side="right" align="start">
            <div
              role="button"
              tabindex="0"
              :aria-label="`${p.name} details`"
              :aria-description="statusWord(p)"
              :aria-pressed="on({ kind: 'server', id: p.id })"
              :class="[LIST_ROW, rowOn({ kind: 'server', id: p.id })]"
              @click="pick({ kind: 'server', id: p.id })"
              @keydown.enter.self="pick({ kind: 'server', id: p.id })"
              @keydown.space.self.prevent="pick({ kind: 'server', id: p.id })"
            >
              <span class="flex size-6 shrink-0 items-center justify-center"><span class="size-1.5 rounded-full" :class="DOT[statusDot(p.status)]" aria-hidden="true" /></span>
              <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
              <span class="shrink-0" :class="p.starred ? 'flex' : 'hidden group-hover/row:flex group-focus-within/row:flex'">
                <Tip :label="p.starred ? 'Unstar' : 'Star'">
                  <button type="button" :class="ROW_BTN" :aria-label="`${p.starred ? 'Unstar' : 'Star'} ${p.name}`" @click.stop="servers.star(p.id, !p.starred)">
                    <Star class="size-3.5" :class="p.starred && 'fill-current text-warning'" />
                  </button>
                </Tip>
              </span>
              <CountBadge v-if="p.errorCount" :count="p.errorCount" :title="`${p.errorCount} errors`" />
              <AlertTriangle v-if="p.alertsFiring" class="size-3 shrink-0 text-warning-text" aria-label="An alert is firing" />
              <span v-if="outsideNote(p)" class="shrink-0 text-[11px] leading-4 text-text-muted" :title="OUTSIDE_TIP">{{ outsideNote(p) }}</span>
              <!-- The port steps aside for the hover buttons: with a running server's three and the star, it pushed the star
                   to the middle of the row, where a click meant for the row starred the server. -->
              <span v-if="p.port" class="shrink-0 rounded-[4px] bg-fill-5 px-1 text-[11px] leading-4 text-text-muted tnum group-hover/row:hidden group-focus-within/row:hidden">{{ serverPort(p) }}</span>
              <span class="hidden shrink-0 items-center gap-0.5 group-hover/row:flex group-focus-within/row:flex" @click.stop>
                <Tip v-if="processAddress(p)" label="Open in browser">
                  <button type="button" :class="ROW_BTN" :aria-label="`Open ${p.name} in browser`" @click="openBrowser(g.project, p)"><ExternalLink class="size-3.5" /></button>
                </Tip>
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

      <section v-if="servers.found.value && (items.length || scanning)" aria-label="Found on this PC">
        <header :class="LIST_HEADER">
          <span class="truncate">Found on this PC</span>
          <span class="tnum">{{ items.length }}</span>
          <span v-if="scanning" role="status" class="truncate">Scanning…</span>
          <span class="flex-1" />
          <Tip v-if="items.length > 1" label="Add every found project">
            <button type="button" class="rounded-[4px] px-1 text-text-2 hover:bg-fill-hover" :disabled="addingAll" @click="confirm = 'add'">Add all</button>
          </Tip>
        </header>
        <div class="flex flex-col gap-[1.5px] pt-[1.5px]">
          <Tip v-for="i in items" :key="i.path" :label="i.path" side="right" align="start">
            <div
              role="button"
              tabindex="0"
              :aria-label="`${i.name}, found, details`"
              :class="[LIST_ROW, rowOn({ kind: 'found', path: i.path })]"
              @click="pick({ kind: 'found', path: i.path })"
              @keydown.enter.self="pick({ kind: 'found', path: i.path })"
              @keydown.space.self.prevent="pick({ kind: 'found', path: i.path })"
            >
              <span class="flex size-6 shrink-0 items-center justify-center text-text-muted"><component :is="i.kind === 'file' ? File : Folder" class="size-3.5" aria-hidden="true" /></span>
              <span class="min-w-0 flex-1 truncate">{{ i.name }}</span>
              <span class="shrink-0 truncate text-[11px] leading-4 text-text-muted">{{ i.framework ?? (i.processes === 1 ? '1 server' : `${i.processes} servers`) }}</span>
              <span class="hidden shrink-0 items-center gap-0.5 group-hover/row:flex group-focus-within/row:flex" @click.stop>
                <Tip label="Add this project">
                  <button type="button" :class="ROW_BTN" :disabled="busyFound.has(i.path)" :aria-label="`Add ${i.name}`" @click="add(i)"><FolderPlus class="size-3.5" /></button>
                </Tip>
                <Tip label="Do not offer this again">
                  <button type="button" :class="ROW_BTN" :disabled="busyFound.has(i.path)" :aria-label="`Ignore ${i.name}`" @click="ignore(i)"><X class="size-3.5" /></button>
                </Tip>
              </span>
            </div>
          </Tip>
        </div>
      </section>

      <section v-if="others.length" aria-label="Other servers">
        <header :class="LIST_HEADER">
          <span class="truncate">Other servers</span>
          <span class="tnum">{{ others.length }}</span>
        </header>
        <div class="flex flex-col gap-[1.5px] pt-[1.5px]">
          <Tip v-for="o in others" :key="o.port" :label="[o.title, o.process, o.url].filter(Boolean).join('\n')" side="right" align="start">
            <div
              role="button"
              tabindex="0"
              :aria-label="`Port ${o.port}${o.process ? `, ${o.process}` : ''}, details`"
              :class="[LIST_ROW, rowOn({ kind: 'other', port: o.port })]"
              @click="pick({ kind: 'other', port: o.port })"
              @keydown.enter.self="pick({ kind: 'other', port: o.port })"
              @keydown.space.self.prevent="pick({ kind: 'other', port: o.port })"
            >
              <span class="flex size-6 shrink-0 items-center justify-center"><span class="size-1.5 rounded-full" :class="DOT.run" aria-hidden="true" /></span>
              <span class="min-w-0 flex-1 truncate">{{ o.title || o.process || 'Server' }}</span>
              <span class="shrink-0 rounded-[4px] bg-fill-5 px-1 text-[11px] leading-4 text-text-muted tnum">:{{ o.port }}</span>
            </div>
          </Tip>
        </div>
      </section>
    </template>

    <Dialog :open="confirm !== null" @update:open="(o: boolean) => !o && (confirm = null)">
      <DialogContent :aria-describedby="undefined">
        <DialogTitle>{{ CONFIRM[shown].title }}</DialogTitle>
        <DialogDescription>{{ CONFIRM[shown].text() }}</DialogDescription>
        <DialogFooter>
          <Button variant="ghost" @click="confirm = null">Cancel</Button>
          <Button @click="runAll">{{ CONFIRM[shown].button }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
