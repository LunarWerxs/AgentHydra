<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { AlertTriangle, ChevronsDownUp, ChevronsUpDown, ExternalLink, File, Folder, FolderPlus, Loader2, Play, Plus, RotateCw, ScanSearch, Square, Star, X } from '@lucide/vue'
import type { DevWebCompany, DevWebFoundRow, DevWebProcess, DevWebProject, DevWebScanPreset, LocalServer, LocalServers } from '@shared/devwebui'
import { processAddress } from '@shared/devwebui'
import { shellGlyphs } from '@/lib/icons'
import { Tip } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { HEADER_BTN, LIST_HEADER, LIST_ROW } from '@/components/sidebar/rowClasses'
import { ignoreFolder, loadProject, localhostServers, scanProjects, startAllServers, stopAllServers } from './api'
import { actionDisabled, allKey, companyGroups, filterLocal, foundTree, groupActions, isUp, listView, matchesFilter, OUTSIDE_TIP, otherGroups, otherLabel, outsideNote, serverActions, serverPort, shownServers, sortServers, startBlock, statusDot, statusWord, type FoundCompany, type ServerAction } from './logic'
import { sameSelection, type DevSelection } from './info/selection'
import { useOpenGroups } from './open-groups'
import { useDevServers } from './store'
import CountBadge from './info/kit/CountBadge.vue'
import { DOT, INPUT } from './styles'

// The sidebar's Dev servers list (the title bar's Dev servers button), grouped as the owner asked on 2026-10-07 ("sorted
// by ... their main parent company", "collapsible", "default collapsed if they have none running. If they do have any
// running, it should show the one running unless I expand"): a toolbar (filter, Scan, Add project, Start all / Stop
// all, Expand all / Collapse all) over three parts. The projects, by company (company.ts on the server; a company with
// one project is just that project's header), each closed by default, a closed one still listing its servers that are
// up; inside, starred first, then the ones that are up, then by name. Then Other servers (dev servers no project lists,
// all running), open, by the company of the folder they run from. Last, Found on this PC (what scans found and nobody
// added), closed, by company, then the folder below it (each copy or app), then name. A filter opens every group that
// has a match. Which groups are open is remembered (open-groups.ts). A click SELECTS a row and the Dev servers page, in
// the chat's place, describes it (store.select); nothing starts by a click. Start / Stop / Restart are on hover, and
// Open in browser on rows with an address. It reads the window's one client (store.ts), the page's too, and keeps its
// polling on while it is on screen. Rows wear the cloud list's look (sidebar/rowClasses.ts).
const servers = useDevServers()
const release = servers.use()
onBeforeUnmount(release)

const filter = ref('')
const q = computed(() => filter.value.trim())
const selected = servers.selection
const selectedServer = computed(() => (selected.value?.kind === 'server' ? selected.value.id : null))
const selectedProject = computed(() => (selected.value?.kind === 'project' ? selected.value.id : null))
const selectedFound = computed(() => (selected.value?.kind === 'found' ? selected.value.path : null))
const selectedOther = computed(() => (selected.value?.kind === 'other' ? selected.value.port : null))

const groupsOpen = useOpenGroups()
// While a filter is typed every group with a match is open, and a chevron opens or closes one for that filter only
// (forgotten when the filter changes); otherwise a group is what was remembered, else its default.
const filterOpen = ref(new Map<string, boolean>())
watch(q, () => (filterOpen.value = new Map()))
const isOpen = (key: string, dflt = false): boolean => (q.value ? (filterOpen.value.get(key) ?? true) : groupsOpen.isOpen(key, dflt))
function setOpen(keys: readonly string[], open: boolean) {
  if (!q.value) return groupsOpen.setAll(keys, open)
  const next = new Map(filterOpen.value)
  for (const k of keys) next.set(k, open)
  filterOpen.value = next
}
const toggle = (key: string, dflt = false) => setOpen([key], !isOpen(key, dflt))
const companyKey = (prefix: string, c: DevWebCompany | null): string => `${prefix}:${c ? c.dir.toLowerCase() : ''}`

const view = computed(() => listView({ status: servers.status.value, statusMissing: servers.statusMissing.value, projects: servers.projects.value, projectsError: servers.projectsError.value }))

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
      const named = !f || matchesFilter(`${g.project.company.name} ${g.project.name}`, f)
      const shown = named ? all : all.filter((p) => matchesFilter(`${g.project.name} ${p.name} ${p.port ?? ''} :${p.port ?? ''}`, f))
      return { ...g, servers: shown, total: all.length, hit: named || shown.length > 0 }
    })
    .filter((g) => g.hit)
})
type Group = (typeof groups.value)[number]
const companies = computed(() => companyGroups(groups.value))

type ProjectLine =
  | { kind: 'company'; key: string; company: DevWebCompany; up: number; total: number }
  | { kind: 'project'; key: string; g: Group; depth: 0 | 1 }
  | { kind: 'server'; key: string; project: DevWebProject; p: DevWebProcess; depth: 0 | 1 }
  | { kind: 'none'; key: string; depth: 0 | 1 }

const projectLines = computed<ProjectLine[]>(() => {
  const out: ProjectLine[] = []
  for (const c of companies.value) {
    const several = c.groups.length > 1
    const ck = companyKey('c', c.company)
    if (several) out.push({ kind: 'company', key: ck, company: c.company, up: c.up, total: c.total })
    const depth = several ? 1 : 0
    for (const g of c.groups) {
      const pk = `p:${g.project.id}`
      const peek = shownServers(g.servers, false, selectedServer.value)
      // A closed company still shows the projects with a server up (closed, so only those servers), as a project does,
      // and the one selected.
      if (several && !isOpen(ck) && !peek.length && g.project.id !== selectedProject.value) continue
      out.push({ kind: 'project', key: pk, g, depth })
      const open = isOpen(pk) && (!several || isOpen(ck))
      if (!g.total) {
        if (open) out.push({ kind: 'none', key: `${pk}:none`, depth })
        continue
      }
      for (const p of open ? g.servers : peek) out.push({ kind: 'server', key: p.id, project: g.project, p, depth })
    }
  }
  return out
})

const items = computed<DevWebFoundRow[]>(() =>
  (servers.found.value?.items ?? []).filter((i) => !q.value || matchesFilter(`${i.name} ${i.path} ${i.framework ?? ''} ${i.company.name}`, q.value))
)
const scanning = computed(() => !!servers.found.value?.scanning || scanBusy.value)
const tree = computed(() => foundTree(items.value))

type FoundLine =
  | { kind: 'company'; key: string; company: DevWebCompany; count: number }
  | { kind: 'project'; key: string; dir: string; name: string; count: number }
  | { kind: 'item'; key: string; item: DevWebFoundRow; where: string | null; depth: 1 | 2 }

// A closed group here lists nothing but the way down to the selected folder, so a selection never leaves the list.
/** One found company's project and item lines, once the company itself is open or holds the selection. */
function foundProjectLines(out: FoundLine[], c: FoundCompany<DevWebFoundRow>, cOpen: boolean, sel: string | null) {
  const several = c.projects.length > 1
  for (const pr of c.projects) {
    const pk = `fp:${pr.dir.toLowerCase()}`
    const pOpen = cOpen && (!several || isOpen(pk))
    if (!pOpen && !(!!sel && pr.items.some((i) => i.path === sel))) continue
    if (several) out.push({ kind: 'project', key: pk, dir: pr.dir, name: pr.name, count: pr.items.length })
    for (const i of pr.items) {
      if (pOpen || i.path === sel) out.push({ kind: 'item', key: i.path, item: i, where: pr.where.get(i.path) ?? null, depth: several ? 2 : 1 })
    }
  }
}

const foundLines = computed<FoundLine[]>(() => {
  const out: FoundLine[] = []
  const sel = selectedFound.value
  const holds = (pr: { items: readonly DevWebFoundRow[] }) => !!sel && pr.items.some((i) => i.path === sel)
  const open = isOpen('f')
  for (const c of tree.value) {
    const ck = companyKey('fc', c.company)
    const cSel = c.projects.some(holds)
    if (!open && !cSel) continue
    out.push({ kind: 'company', key: ck, company: c.company, count: c.count })
    const cOpen = open && isOpen(ck)
    if (cOpen || cSel) foundProjectLines(out, c, cOpen, sel)
  }
  return out
})

const local = shallowRef<LocalServers | null>(null)
let localAt = 0
async function loadLocal() {
  if (Date.now() - localAt < 8000) return
  localAt = Date.now()
  local.value = await localhostServers().catch(() => local.value)
}
watch(servers.answered, () => view.value.kind === 'list' && void loadLocal(), { immediate: true })
const others = computed(() => filterLocal(local.value?.servers ?? [], q.value))

type OtherLine =
  | { kind: 'company'; key: string; company: DevWebCompany | null; count: number }
  | { kind: 'server'; key: string; o: LocalServer; label: ReturnType<typeof otherLabel> }

const otherLines = computed<OtherLine[]>(() => {
  const out: OtherLine[] = []
  const sel = selectedOther.value
  const open = isOpen('o', true)
  for (const g of otherGroups(others.value)) {
    const ck = companyKey('oc', g.company)
    const gSel = g.servers.some((o) => o.port === sel)
    if (!open && !gSel) continue
    out.push({ kind: 'company', key: ck, company: g.company, count: g.servers.length })
    const gOpen = open && isOpen(ck, true)
    for (const o of g.servers) if (gOpen || o.port === sel) out.push({ kind: 'server', key: `o:${o.port}`, o, label: otherLabel(o) })
  }
  return out
})

// Expand all opens every project and company and Other servers (never the found list: hundreds of rows); Collapse all
// closes every group, found ones too.
const projectKeys = computed(() => companies.value.flatMap((c) => [...(c.groups.length > 1 ? [companyKey('c', c.company)] : []), ...c.groups.map((g) => `p:${g.project.id}`)]))
const otherKeys = computed(() => ['o', ...otherGroups(others.value).map((g) => companyKey('oc', g.company))])
const foundKeys = computed(() => ['f', ...tree.value.flatMap((c) => [companyKey('fc', c.company), ...c.projects.map((pr) => `fp:${pr.dir.toLowerCase()}`)])])
const allOpen = computed(() => projectKeys.value.length > 0 && projectKeys.value.every((k) => isOpen(k)))
function expandAll() {
  if (allOpen.value) setOpen([...projectKeys.value, ...otherKeys.value, ...foundKeys.value], false)
  else setOpen([...projectKeys.value, ...otherKeys.value], true)
}

const ACTION = {
  start: { label: 'Start', icon: Play },
  stop: { label: 'Stop', icon: Square },
  restart: { label: 'Restart', icon: RotateCw }
} as const
const ROW_BTN =
  'flex size-5 shrink-0 items-center justify-center rounded-[var(--radius-5)] text-text-muted hover:bg-fill-hover hover:text-text focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40'
const NOTE = 'px-1.5 pt-3 text-[12px] leading-4 text-text-muted'
const LINK = 'ms-1 rounded-[4px] px-1 text-text-2 hover:bg-fill-hover'
// A group inside a part: a row-high header, and its rows, each step in by 12px.
const SUB_HEADER = 'group/head flex h-[26px] items-center gap-1 pe-1 text-[12px] leading-4 text-text-muted'
const HEAD_INDENT = ['ps-1.5', 'ps-[18px]', 'ps-[30px]'] as const
const ROW_INDENT = ['', 'ps-3', 'ps-6'] as const
const CHEVRON = 'flex size-4 shrink-0 items-center justify-center rounded-[4px] hover:text-text-2'
const LABEL = 'min-w-0 truncate rounded-[4px] text-start hover:text-text-2'

const pick = (sel: DevSelection) => servers.select(sel)
const on = (sel: DevSelection): boolean => sameSelection(selected.value, sel)
const rowOn = (sel: DevSelection): string => (on(sel) ? 'bg-fill-selected text-text' : 'text-text-2 hover:bg-fill-hover')
const act = (p: DevWebProcess, a: ServerAction) => servers.act(p, a)
function tip(project: DevWebProject, p: DevWebProcess): string {
  return [p.name, [statusWord(p), serverPort(p) || null].filter(Boolean).join(' · '), outsideNote(p), startBlock(p), processAddress(p), project.name].filter(Boolean).join('\n')
}
const upCount = (g: Group): number => g.project.processes.filter((p) => isUp(p.status)).length

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
const add = (i: DevWebFoundRow) =>
  guard(i.path, async () => {
    const r = await loadProject(i.path)
    if (r.error) throw new Error(r.error)
    if (r.project) {
      await servers.refresh()
      pick({ kind: 'project', id: r.project.id })
    } else if (r.needsScaffold) pick({ kind: 'found', path: i.path })
  })
const ignore = (i: DevWebFoundRow) =>
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
      <Tip :label="allOpen ? 'Collapse all' : 'Expand all projects'">
        <button type="button" :class="HEADER_BTN" :aria-label="allOpen ? 'Collapse all' : 'Expand all projects'" :disabled="!projectKeys.length" @click="expandAll">
          <component :is="allOpen ? ChevronsDownUp : ChevronsUpDown" class="size-3.5" />
        </button>
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

      <section v-if="projectLines.length" aria-label="Projects" class="flex flex-col gap-[1.5px]">
        <template v-for="l in projectLines" :key="l.key">
          <header v-if="l.kind === 'company'" :class="LIST_HEADER">
            <Tip :label="l.company.dir" align="start">
              <button type="button" :class="LABEL" :aria-expanded="isOpen(l.key)" @click="toggle(l.key)">{{ l.company.name }}</button>
            </Tip>
            <button type="button" :class="CHEVRON" :aria-expanded="isOpen(l.key)" :aria-label="`${isOpen(l.key) ? 'Collapse' : 'Expand'} ${l.company.name}`" @click="toggle(l.key)">
              <component :is="shellGlyphs.groupChevron" class="size-3 shrink-0 transition-transform duration-(--dur-fast)" :class="isOpen(l.key) ? 'rotate-90' : ''" />
            </button>
            <span class="flex-1" />
            <Tip :label="`${l.up} of ${l.total} running`"><span class="tnum">{{ l.up }}/{{ l.total }}</span></Tip>
          </header>

          <header v-else-if="l.kind === 'project'" :class="l.depth ? [SUB_HEADER, HEAD_INDENT[1]] : LIST_HEADER">
            <Tip :label="l.g.project.path" align="start">
              <button type="button" :class="[LABEL, on({ kind: 'project', id: l.g.project.id }) && 'text-text']" @click="pick({ kind: 'project', id: l.g.project.id })">{{ l.g.project.name }}</button>
            </Tip>
            <Tip :label="isOpen(l.key) ? 'Collapse' : 'Expand'">
              <button type="button" :class="CHEVRON" :aria-expanded="isOpen(l.key)" :aria-label="`${isOpen(l.key) ? 'Collapse' : 'Expand'} ${l.g.project.name}`" @click="toggle(l.key)">
                <component :is="shellGlyphs.groupChevron" class="size-3 shrink-0 transition-transform duration-(--dur-fast)" :class="isOpen(l.key) ? 'rotate-90' : ''" />
              </button>
            </Tip>
            <span class="flex-1" />
            <template v-if="groupActions(l.g.project.processes).start">
              <Tip label="Start all">
                <button type="button" :class="HEADER_BTN" :disabled="servers.busy.value.has(allKey(l.g.project))" :aria-label="`Start all in ${l.g.project.name}`" @click="servers.actAll(l.g.project, 'start')"><Play class="size-3.5" /></button>
              </Tip>
            </template>
            <template v-if="groupActions(l.g.project.processes).stop">
              <Tip label="Stop all">
                <button type="button" :class="HEADER_BTN" :disabled="servers.busy.value.has(allKey(l.g.project))" :aria-label="`Stop all in ${l.g.project.name}`" @click="servers.actAll(l.g.project, 'stop')"><Square class="size-3.5" /></button>
              </Tip>
            </template>
            <Tip :label="`${upCount(l.g)} of ${l.g.total} running`"><span class="tnum">{{ upCount(l.g) }}/{{ l.g.total }}</span></Tip>
          </header>

          <p v-else-if="l.kind === 'none'" class="pb-1 text-[12px] leading-4 text-text-muted" :class="HEAD_INDENT[l.depth]">No servers in this project.</p>

          <div v-else :class="ROW_INDENT[l.depth]">
            <Tip :label="tip(l.project, l.p)" side="right" align="start">
              <div
                role="button"
                tabindex="0"
                :aria-label="`${l.p.name} details`"
                :aria-description="statusWord(l.p)"
                :aria-pressed="on({ kind: 'server', id: l.p.id })"
                :class="[LIST_ROW, rowOn({ kind: 'server', id: l.p.id })]"
                @click="pick({ kind: 'server', id: l.p.id })"
                @keydown.enter.self="pick({ kind: 'server', id: l.p.id })"
                @keydown.space.self.prevent="pick({ kind: 'server', id: l.p.id })"
              >
                <span class="flex size-6 shrink-0 items-center justify-center"><span class="size-1.5 rounded-full" :class="DOT[statusDot(l.p.status)]" aria-hidden="true" /></span>
                <span class="min-w-0 flex-1 truncate">{{ l.p.name }}</span>
                <span class="shrink-0" :class="l.p.starred ? 'flex' : 'hidden group-hover/row:flex group-focus-within/row:flex'">
                  <Tip :label="l.p.starred ? 'Unstar' : 'Star'">
                    <button type="button" :class="ROW_BTN" :aria-label="`${l.p.starred ? 'Unstar' : 'Star'} ${l.p.name}`" @click.stop="servers.star(l.p.id, !l.p.starred)">
                      <Star class="size-3.5" :class="l.p.starred && 'fill-current text-warning'" />
                    </button>
                  </Tip>
                </span>
                <CountBadge v-if="l.p.errorCount" :count="l.p.errorCount" :title="`${l.p.errorCount} errors`" />
                <AlertTriangle v-if="l.p.alertsFiring" class="size-3 shrink-0 text-warning-text" aria-label="An alert is firing" />
                <Tip v-if="outsideNote(l.p)" :label="OUTSIDE_TIP"><span class="shrink-0 text-[11px] leading-4 text-text-muted">{{ outsideNote(l.p) }}</span></Tip>
                <!-- The port steps aside for the hover buttons: with a running server's three and the star, it pushed the star
                     to the middle of the row, where a click meant for the row starred the server. -->
                <span v-if="l.p.port" class="shrink-0 rounded-sm bg-fill-5 px-1 text-[11px] leading-4 text-text-muted tnum group-hover/row:hidden group-focus-within/row:hidden">{{ serverPort(l.p) }}</span>
                <span class="hidden shrink-0 items-center gap-0.5 group-hover/row:flex group-focus-within/row:flex" @click.stop>
                  <Tip v-if="processAddress(l.p)" label="Open in browser">
                    <button type="button" :class="ROW_BTN" :aria-label="`Open ${l.p.name} in browser`" @click="openBrowser(l.project, l.p)"><ExternalLink class="size-3.5" /></button>
                  </Tip>
                  <Tip v-for="a in serverActions(l.p.status)" :key="a" :label="a !== 'stop' && startBlock(l.p) ? startBlock(l.p)! : ACTION[a].label">
                    <button type="button" :class="ROW_BTN" :disabled="actionDisabled(l.p, a, servers.busy.value.has(l.p.id))" :aria-label="`${ACTION[a].label} ${l.p.name}`" @click="act(l.p, a)">
                      <component :is="ACTION[a].icon" class="size-3.5" />
                    </button>
                  </Tip>
                </span>
              </div>
            </Tip>
          </div>
        </template>
      </section>

      <section v-if="others.length" aria-label="Other servers" class="flex flex-col gap-[1.5px]">
        <header :class="LIST_HEADER">
          <Tip label="Dev servers running that no project lists" align="start">
            <button type="button" :class="LABEL" :aria-expanded="isOpen('o', true)" @click="toggle('o', true)">Other servers</button>
          </Tip>
          <button type="button" :class="CHEVRON" :aria-expanded="isOpen('o', true)" :aria-label="`${isOpen('o', true) ? 'Collapse' : 'Expand'} Other servers`" @click="toggle('o', true)">
            <component :is="shellGlyphs.groupChevron" class="size-3 shrink-0 transition-transform duration-(--dur-fast)" :class="isOpen('o', true) ? 'rotate-90' : ''" />
          </button>
          <span class="flex-1" />
          <Tip :label="`${others.length} running`"><span class="tnum">{{ others.length }}</span></Tip>
        </header>
        <template v-for="l in otherLines" :key="l.key">
          <header v-if="l.kind === 'company'" :class="[SUB_HEADER, HEAD_INDENT[1]]">
            <Tip :label="l.company?.dir ?? 'Its command line names no project folder'" align="start">
              <button type="button" :class="LABEL" :aria-expanded="isOpen(l.key, true)" @click="toggle(l.key, true)">{{ l.company?.name ?? 'No project folder' }}</button>
            </Tip>
            <button type="button" :class="CHEVRON" :aria-expanded="isOpen(l.key, true)" :aria-label="`${isOpen(l.key, true) ? 'Collapse' : 'Expand'} ${l.company?.name ?? 'No project folder'}`" @click="toggle(l.key, true)">
              <component :is="shellGlyphs.groupChevron" class="size-3 shrink-0 transition-transform duration-(--dur-fast)" :class="isOpen(l.key, true) ? 'rotate-90' : ''" />
            </button>
            <span class="flex-1" />
            <span class="tnum">{{ l.count }}</span>
          </header>
          <div v-else :class="ROW_INDENT[1]">
            <Tip :label="[l.o.title, l.o.process, l.o.dir, l.o.url].filter(Boolean).join('\n')" side="right" align="start">
              <div
                role="button"
                tabindex="0"
                :aria-label="`Port ${l.o.port}${l.o.process ? `, ${l.o.process}` : ''}, details`"
                :class="[LIST_ROW, rowOn({ kind: 'other', port: l.o.port })]"
                @click="pick({ kind: 'other', port: l.o.port })"
                @keydown.enter.self="pick({ kind: 'other', port: l.o.port })"
                @keydown.space.self.prevent="pick({ kind: 'other', port: l.o.port })"
              >
                <span class="flex size-6 shrink-0 items-center justify-center"><span class="size-1.5 rounded-full" :class="DOT.run" aria-hidden="true" /></span>
                <span class="min-w-0 flex-1 truncate">{{ l.label.name }}<span v-if="l.label.where" class="text-text-muted">&ensp;{{ l.label.where }}</span></span>
                <span class="shrink-0 rounded-sm bg-fill-5 px-1 text-[11px] leading-4 text-text-muted tnum">:{{ l.o.port }}</span>
              </div>
            </Tip>
          </div>
        </template>
      </section>

      <section v-if="servers.found.value && (items.length || scanning)" aria-label="Found on this PC" class="flex flex-col gap-[1.5px]">
        <header :class="LIST_HEADER">
          <Tip label="Projects a scan found that are not added" align="start">
            <button type="button" :class="LABEL" :aria-expanded="isOpen('f')" @click="toggle('f')">Found on this PC</button>
          </Tip>
          <button type="button" :class="CHEVRON" :aria-expanded="isOpen('f')" :aria-label="`${isOpen('f') ? 'Collapse' : 'Expand'} Found on this PC`" @click="toggle('f')">
            <component :is="shellGlyphs.groupChevron" class="size-3 shrink-0 transition-transform duration-(--dur-fast)" :class="isOpen('f') ? 'rotate-90' : ''" />
          </button>
          <span v-if="scanning" role="status" class="truncate">Scanning…</span>
          <span class="flex-1" />
          <Tip v-if="items.length > 1" label="Add every found project">
            <button type="button" class="rounded-sm px-1 text-text-2 hover:bg-fill-hover" :disabled="addingAll" @click="confirm = 'add'">Add all</button>
          </Tip>
          <span class="tnum">{{ items.length }}</span>
        </header>
        <template v-for="l in foundLines" :key="l.key">
          <header v-if="l.kind !== 'item'" :class="[SUB_HEADER, HEAD_INDENT[l.kind === 'company' ? 1 : 2]]">
            <Tip :label="l.kind === 'company' ? l.company.dir : l.dir" align="start">
              <button type="button" :class="LABEL" :aria-expanded="isOpen(l.key)" @click="toggle(l.key)">{{ l.kind === 'company' ? l.company.name : l.name }}</button>
            </Tip>
            <button type="button" :class="CHEVRON" :aria-expanded="isOpen(l.key)" :aria-label="`${isOpen(l.key) ? 'Collapse' : 'Expand'} ${l.kind === 'company' ? l.company.name : l.name}`" @click="toggle(l.key)">
              <component :is="shellGlyphs.groupChevron" class="size-3 shrink-0 transition-transform duration-(--dur-fast)" :class="isOpen(l.key) ? 'rotate-90' : ''" />
            </button>
            <span class="flex-1" />
            <span class="tnum">{{ l.count }}</span>
          </header>
          <div v-else :class="ROW_INDENT[l.depth]">
            <Tip :label="l.item.path" side="right" align="start">
              <div
                role="button"
                tabindex="0"
                :aria-label="`${l.item.name}, found, details`"
                :class="[LIST_ROW, rowOn({ kind: 'found', path: l.item.path })]"
                @click="pick({ kind: 'found', path: l.item.path })"
                @keydown.enter.self="pick({ kind: 'found', path: l.item.path })"
                @keydown.space.self.prevent="pick({ kind: 'found', path: l.item.path })"
              >
                <span class="flex size-6 shrink-0 items-center justify-center text-text-muted"><component :is="l.item.kind === 'file' ? File : Folder" class="size-3.5" aria-hidden="true" /></span>
                <span class="min-w-0 flex-1 truncate">{{ l.item.name }}<span v-if="l.where" class="text-text-muted">&ensp;{{ l.where }}</span></span>
                <span class="shrink-0 truncate text-[11px] leading-4 text-text-muted group-hover/row:hidden group-focus-within/row:hidden">{{ l.item.framework ?? (l.item.processes === 1 ? '1 server' : `${l.item.processes} servers`) }}</span>
                <span class="hidden shrink-0 items-center gap-0.5 group-hover/row:flex group-focus-within/row:flex" @click.stop>
                  <Tip label="Add this project">
                    <button type="button" :class="ROW_BTN" :disabled="busyFound.has(l.item.path)" :aria-label="`Add ${l.item.name}`" @click="add(l.item)"><FolderPlus class="size-3.5" /></button>
                  </Tip>
                  <Tip label="Do not offer this again">
                    <button type="button" :class="ROW_BTN" :disabled="busyFound.has(l.item.path)" :aria-label="`Ignore ${l.item.name}`" @click="ignore(l.item)"><X class="size-3.5" /></button>
                  </Tip>
                </span>
              </div>
            </Tip>
          </div>
        </template>
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
