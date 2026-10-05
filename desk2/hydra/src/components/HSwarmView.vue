<script setup lang="ts">
// The HSwarm tab: ZSwarm's console layout (owner, 2026-10-03: keep "its original Z Swarm layout with the
// left-handed sidebar"). A tree on the left (Overview, Providers > each provider > its models, All models,
// Routing & roles, Clients > each client, Jobs > recent jobs, Help) picks what the right pane shows; each
// page is its own component in ./hswarm/. Below 900px the tree is a drawer, as in the console.
//
// In Hydra Desk 2 the tree is drawn in Desk's own sidebar (lib/desk-embed.ts, Michael, 2026-10-04: one
// sidebar for everything): this view describes it row for row (the same rows, dots, stars and search)
// and hides its own, and Desk's clicks come back to select, toggle and star here.
import {
  AlertCircle,
  ChevronRight,
  Cpu,
  Info,
  Layers,
  LayoutGrid,
  Menu,
  PiggyBank,
  Plug,
  Plus,
  RefreshCw,
  Route,
  Search,
  Server,
  X,
} from '@lucide/vue'
import { type Component, computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
// biome-ignore lint/style/useImportType: used as a component in the template, which Biome cannot see; a type-only import left the search box an unstyled <input>
import { Input } from '@/components/ui/input'
import type { EmbedIcon, EmbedTone, SidebarRow } from '@desk/shared/hydra-embed'
import { API_BASE } from '@/lib/api'
import { EMBEDDED, useDeskSidebar } from '@/lib/desk-embed'
import { useHswarmApi } from '@/lib/hswarm-api'
import { hswarmJobAsk } from '@/lib/hswarm-pages'
import { reconcileList } from '@/lib/reconcile'
import HSwarmClients from './hswarm/HSwarmClients.vue'
import HSwarmJobs from './hswarm/HSwarmJobs.vue'
import HSwarmModels from './hswarm/HSwarmModels.vue'
import HSwarmOverview from './hswarm/HSwarmOverview.vue'
import HSwarmProviders from './hswarm/HSwarmProviders.vue'
import HSwarmRouting from './hswarm/HSwarmRouting.vue'
import HSwarmSavings from './hswarm/HSwarmSavings.vue'
import HSwarmTools from './hswarm/HSwarmTools.vue'

const { t } = useI18n()
const { status, error, loading, state, clients, jobs, loadClients, loadJobs, refreshHswarm, fetchState, refresh, apiCall } =
  useHswarmApi()

type Dot = 'ok' | 'warn' | 'nokey' | 'off' | 'run' | 'bad'
interface TreeNode {
  id: string
  label: string
  icon?: Component
  av?: string
  count?: number | null
  dot?: Dot
  dotTitle?: string
  meta?: string
  dim?: boolean
  // A model row: the model's name, its priority (★n) and whether AUTO may pick it (☆ when unstarred).
  model?: string
  star?: number | null
  auto?: boolean
  // The "N more: search to narrow" row under a provider whose models overflow the tree's budget.
  more?: boolean
  search?: string
  kids?: TreeNode[]
  hit?: boolean
  force?: boolean
}
interface TreeRow {
  id: string
  // What selecting the row selects: itself, or for a "more" row its provider.
  sel: string
  n: TreeNode
  depth: number
  parent: string | null
  hasKids: boolean
  open: boolean
  // The label split around the search's first match, and the provider logo's URL, built with the row.
  parts: [string, string, string]
  avSrc: string | null
}

const DOT_CLASS: Record<Dot, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  nokey: 'border border-muted-foreground',
  off: 'bg-muted-foreground/50',
  run: 'bg-primary animate-pulse',
  bad: 'bg-destructive',
}
const CLIENT_IDS = ['claude-code', 'claude-desktop', 'codex']
const JOBS_SHOWN = 25
// At most this many model rows in the open tree, as in the console; the rest wait behind a search.
const MODEL_BUDGET = 300
const TREE_MIN = 220
const TREE_DEFAULT = 300

// The tree's width, open branches and selection survive a reload, like the console's.
function load<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(`hswarm.tree.${k}`)
    return v == null ? d : (JSON.parse(v) as T)
  } catch {
    return d
  }
}
function save(k: string, v: unknown) {
  try {
    localStorage.setItem(`hswarm.tree.${k}`, JSON.stringify(v))
  } catch {
    // Storage blocked or full: the tree still works, it just forgets its layout.
  }
}

const enc = encodeURIComponent
const dec = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const sel = ref<string>(load('sel', 'overview'))
const cur = ref<string>(sel.value)
const expanded = ref(new Set<string>(load<string[]>('exp', ['providers'])))
const query = ref('')
const adding = ref(false)
// Bumped by every Add provider / Add model click, so a second click reopens the form.
const addNonce = ref(0)
const starBusy = ref<string | null>(null)
const navOpen = ref(false)
const treeWidth = ref<number>(load('w', TREE_DEFAULT))
const isRefreshing = ref(false)
const treeEl = ref<HTMLElement | null>(null)
const searchEl = ref<InstanceType<typeof Input> | null>(null)

function provDot(p: any): [Dot, string] {
  if (!p.enabled) return ['off', t('hswarm.nav.switchedOff')]
  if (!p.keys) return ['nokey', t('hswarm.nav.noKeys')]
  if (p.ready > 0) return ['ok', t('hswarm.nav.ready')]
  if (p.resting > 0) return ['warn', t('hswarm.nav.restingOnly')]
  return ['bad', t('hswarm.nav.allKeysDisabled')]
}
function jobDot(s: string): Dot {
  if (s === 'running' || s === 'queued') return 'run'
  if (s === 'done' || s === 'finished') return 'ok'
  return /fail|error/i.test(s || '') ? 'bad' : 'off'
}

const hasKeys = computed(() => !!state.value?.providers?.some((p: any) => p.keys > 0))

// The console's tree: a model is part of its provider, so each provider opens onto its models.
const nodes = computed<TreeNode[]>(() => {
  const s = state.value
  if (!s) return []
  const provs = [...(s.providers ?? [])].sort(
    (a, b) => Number(b.keys > 0) - Number(a.keys > 0) || a.name.localeCompare(b.name),
  )
  const cl = clients.value ?? CLIENT_IDS.map((c) => ({ client: c, registered: null }))
  const js = (jobs.value ?? []).slice(0, JOBS_SHOWN)
  return [
    { id: 'overview', label: t('hswarm.overview'), icon: LayoutGrid },
    { id: 'savings', label: t('hswarm.savings'), icon: PiggyBank },
    {
      id: 'providers',
      label: t('hswarm.providers'),
      icon: Server,
      count: provs.length,
      kids: provs.map((p) => {
        const [dot, dotTitle] = provDot(p)
        return {
          id: `providers/${enc(p.name)}`,
          label: p.name,
          av: p.name,
          dot,
          dotTitle,
          meta: p.keys ? `${p.ready ?? 0}/${p.keys}` : t('hswarm.nav.noKey'),
          dim: !p.enabled,
          kids: (s.models ?? [])
            .filter((m: any) => m.provider === p.name)
            .map((m: any) => ({
              id: `providers/${enc(p.name)}/${enc(m.name)}`,
              label: m.label || m.name,
              icon: Cpu,
              model: m.name,
              star: m.priority,
              auto: !!m.auto,
              meta: m.switched_off ? t('hswarm.nav.off') : '',
              dim: !m.enabled || m.switched_off,
              search: m.api_id,
            })),
        }
      }),
    },
    { id: 'models', label: t('hswarm.nav.allModels'), icon: Cpu, count: s.models?.length ?? 0 },
    { id: 'routing', label: t('hswarm.routing'), icon: Route },
    {
      id: 'clients',
      label: t('hswarm.clients'),
      icon: Plug,
      kids: cl.map((c) => ({
        id: `clients/${c.client}`,
        label: t(`hswarm.nav.clientNames.${c.client}`, c.client),
        icon: Plug,
        dot: (c.registered ? 'ok' : 'off') as Dot,
        dotTitle: c.registered
          ? t('hswarm.v.clients.registered')
          : c.registered === false
            ? t('hswarm.v.clients.notRegistered')
            : t('hswarm.v.clients.checking'),
      })),
    },
    {
      id: 'jobs',
      label: t('hswarm.jobs'),
      icon: Layers,
      count: jobs.value ? js.length : null,
      kids: js.map((j) => ({
        id: `jobs/${enc(j.job_id)}`,
        label: j.label || j.job_id,
        icon: Layers,
        dot: jobDot(j.state),
        dotTitle: j.state,
        meta: (j.created ?? '').slice(5, 16).replace('T', ' '),
        search: j.job_id,
      })),
    },
    { id: 'help', label: t('hswarm.help'), icon: Info, search: t('hswarm.nav.helpSearch') },
  ]
})

function filt(list: TreeNode[], q: string): TreeNode[] {
  const out: TreeNode[] = []
  for (const n of list) {
    if (`${n.label} ${n.search ?? ''}`.toLowerCase().includes(q)) {
      out.push({ ...n, hit: true })
      continue
    }
    const k = n.kids ? filt(n.kids, q) : []
    if (k.length) out.push({ ...n, kids: k, force: true })
  }
  return out
}

// Provider logos come from hswarm itself; a provider without one gets its initials.
const brokenAv = ref(new Set<string>())
const avatarUrls = computed(() => {
  const urls = new Map<string, string>()
  for (const p of state.value?.providers ?? []) {
    if (p.icon !== 'ok' || brokenAv.value.has(p.name)) continue
    urls.set(p.name, `${API_BASE}/api/hswarm/ui/favicon/${enc(p.name)}?v=${enc(String(p.icon_v ?? ''))}`)
  }
  return urls
})

const rows = computed<TreeRow[]>(() => {
  const q = query.value.trim().toLowerCase()
  const list = q ? filt(nodes.value, q) : nodes.value
  const urls = avatarUrls.value
  const out: TreeRow[] = []
  let budget = MODEL_BUDGET
  const walk = (ns: TreeNode[], depth: number, parent: string | null) => {
    for (const n of ns) {
      const hasKids = !!n.kids?.length
      const open = hasKids && (!!n.force || expanded.value.has(n.id))
      out.push({
        id: n.id,
        sel: n.id,
        n,
        depth,
        parent,
        hasKids,
        open,
        parts: hl(n.label, q),
        avSrc: (n.av && urls.get(n.av)) || null,
      })
      if (!open) continue
      const kids = n.kids ?? []
      if (kids[0]?.model && kids.length > budget) {
        const room = Math.max(0, budget)
        budget = 0
        walk(kids.slice(0, room), depth + 1, n.id)
        out.push({
          id: `more:${n.id}`,
          sel: n.id,
          n: {
            id: `more:${n.id}`,
            label: t('hswarm.nav.more', { n: kids.length - room }),
            more: true,
          },
          depth: depth + 1,
          parent: n.id,
          hasKids: false,
          open: false,
          parts: ['', '', ''],
          avSrc: null,
        })
        continue
      }
      if (kids[0]?.model) budget -= kids.length
      walk(kids, depth + 1, n.id)
    }
  }
  walk(list, 0, null)
  return out
})

// A row's label split around the search's first match, which the tree marks.
function hl(label: string, q: string): [string, string, string] {
  const i = q ? label.toLowerCase().indexOf(q) : -1
  return i < 0
    ? [label, '', '']
    : [label.slice(0, i), label.slice(i, i + q.length), label.slice(i + q.length)]
}

// What the right pane shows for the selected row.
const page = computed(() => {
  const segs = sel.value.split('/')
  const a = segs[1] != null ? dec(segs[1]) : undefined
  const b = segs[2] != null ? dec(segs[2]) : undefined
  switch (segs[0]) {
    case 'providers':
      if (b) return { component: HSwarmModels, props: { provider: a, model: b } }
      return { component: HSwarmProviders, props: { provider: a, adding: adding.value } }
    case 'models':
      return { component: HSwarmModels, props: { adding: adding.value } }
    case 'savings':
      return { component: HSwarmSavings, props: {} }
    case 'routing':
      return { component: HSwarmRouting, props: {} }
    case 'clients':
      return { component: HSwarmClients, props: { client: a } }
    case 'jobs':
      return { component: HSwarmJobs, props: { jobId: a } }
    case 'help':
      return { component: HSwarmTools, props: {} }
    default:
      return { component: HSwarmOverview, props: {} }
  }
})

function saveExp() {
  save('exp', [...expanded.value])
}

function select(id: string, o: { adding?: boolean } = {}) {
  sel.value = id
  cur.value = id
  adding.value = !!o.adding
  if (o.adding) addNonce.value++
  const segs = id.split('/')
  for (let i = 1; i < segs.length; i++) expanded.value.add(segs.slice(0, i).join('/'))
  saveExp()
  save('sel', id)
  if (segs[0] === 'jobs') loadJobs()
  if (segs[0] === 'clients' || segs[0] === 'overview') loadClients()
  navOpen.value = false
}

// A page asked to show one object (a provider in the providers table, a model just added): select its row.
function openPath(path: string[]) {
  select(path.map(enc).join('/'))
}

// The tree's star, as in the console: ☆ gives the model the next priority number, ★n clears it.
async function toggleStar(n: TreeNode) {
  const name = n.model
  if (!name || starBusy.value) return
  const taken = (state.value?.models ?? []).map((m: any) => m.priority ?? 0)
  const priority = n.star ? null : Math.min(999, Math.max(0, ...taken) + 1)
  starBusy.value = name
  try {
    await apiCall('models/priority', { method: 'POST', body: JSON.stringify({ name, priority }) })
    await fetchState()
    toast.success(t('hswarm.v.models.prioritySet'))
  } catch (err) {
    toast.error(
      t('hswarm.v.models.priorityError', {
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  } finally {
    starBusy.value = null
  }
}

function toggle(id: string) {
  if (expanded.value.has(id)) expanded.value.delete(id)
  else expanded.value.add(id)
  saveExp()
}

// The chevron opens or closes a branch without selecting it; a row without one selects as usual.
function onChevron(e: MouseEvent, r: TreeRow) {
  if (!r.hasKids) return
  e.stopPropagation()
  cur.value = r.id
  toggle(r.id)
}

function focusRow(id: string) {
  cur.value = id
  treeEl.value
    ?.querySelector(`[data-row="${CSS.escape(id)}"]`)
    ?.scrollIntoView({ block: 'nearest' })
}

const TREE_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft', 'Enter', ' ']
function onTreeKey(e: KeyboardEvent) {
  const list = rows.value
  const i = list.findIndex((r) => r.id === cur.value)
  const r = list[i]
  // The focused row was filtered out or no longer exists: a navigation key lands on the first hit (or row).
  if (!r) {
    if (!list.length || !TREE_KEYS.includes(e.key)) return
    e.preventDefault()
    focusRow((list.find((x) => x.n.hit) ?? list[0]).id)
    return
  }
  const mv = (j: number) => focusRow(list[Math.max(0, Math.min(list.length - 1, j))].id)
  switch (e.key) {
    case 'ArrowDown':
      mv(i + 1)
      break
    case 'ArrowUp':
      if (i === 0) searchEl.value?.$el?.focus()
      else mv(i - 1)
      break
    case 'Home':
      mv(0)
      break
    case 'End':
      mv(list.length - 1)
      break
    case 'ArrowRight':
      if (r.hasKids && !r.open) toggle(r.id)
      else if (r.hasKids) mv(i + 1)
      break
    case 'ArrowLeft':
      if (r.hasKids && r.open && !r.n.force) toggle(r.id)
      else if (r.parent) focusRow(r.parent)
      break
    case 'Enter':
    case ' ':
      select(r.sel)
      break
    default:
      return
  }
  e.preventDefault()
}

function onSearchKey(e: KeyboardEvent) {
  const list = rows.value
  if (e.key === 'ArrowDown' && list.length) {
    e.preventDefault()
    cur.value = (list.find((r) => r.n.hit) ?? list[0]).id
    treeEl.value?.focus()
  } else if (e.key === 'Enter') {
    const h = list.find((r) => r.n.hit && !r.hasKids) ?? list.find((r) => r.n.hit)
    if (h) select(h.sel)
  } else if (e.key === 'Escape' && query.value) {
    query.value = ''
    e.stopPropagation()
  } else if (e.key === 'Escape') {
    treeEl.value?.focus()
  }
}

// "/" jumps to the tree's search, as in the console.
function onGlobalKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
  e.preventDefault()
  if (window.matchMedia('(max-width: 899px)').matches) navOpen.value = true
  searchEl.value?.$el?.focus()
}

// The tree pane is resizable on a desktop: drag, arrows, double-click or Enter to reset.
const maxWidth = () => Math.max(TREE_MIN, Math.min(620, window.innerWidth - 360))
// A drag writes the width once, when it ends; every other change writes it as it is made.
function setWidth(w: number, persist = true) {
  treeWidth.value = Math.round(Math.max(TREE_MIN, Math.min(maxWidth(), w)))
  if (persist) save('w', treeWidth.value)
}
let dragX: number | null = null
let dragW = 0
function onSplitDown(e: PointerEvent) {
  if (e.pointerType === 'touch') return
  dragX = e.clientX
  dragW = treeWidth.value
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  e.preventDefault()
}
function onSplitMove(e: PointerEvent) {
  if (dragX != null) setWidth(dragW + e.clientX - dragX, false)
}
function onSplitUp() {
  if (dragX != null) save('w', treeWidth.value)
  dragX = null
}
function onSplitKey(e: KeyboardEvent) {
  const keys: Record<string, number> = {
    ArrowLeft: treeWidth.value - 16,
    ArrowRight: treeWidth.value + 16,
    Home: TREE_MIN,
    End: maxWidth(),
    Enter: TREE_DEFAULT,
  }
  const to = keys[e.key]
  if (to == null) return
  e.preventDefault()
  setWidth(to)
}

const initials = (name: string) => name.slice(0, 2).toUpperCase()
function onAvError(n: TreeNode) {
  if (n.av) brokenAv.value.add(n.av)
}
// As the console does (console.html, ICONS_ASKED): once per page, when a provider's icon was never
// fetched, ask hswarm to fetch every missing one from the providers' websites, then reload so the
// logos replace the initials.
let iconsAsked = false
async function askIcons() {
  if (iconsAsked || !state.value?.providers?.some((p: any) => p.icon === 'unknown')) return
  iconsAsked = true
  try {
    await apiCall('favicons/fetch', { method: 'POST', body: '{}' })
    await fetchState()
  } catch (err) {
    console.warn('[hswarm] fetching provider icons failed; initials stay', err)
  }
}

// Hydra Desk 2: the tree as Desk's sidebar draws it (shared/hydra-embed.ts).
const DOT_TONE: Record<Dot, EmbedTone | 'hollow'> = {
  ok: 'success',
  warn: 'warning',
  nokey: 'hollow',
  off: 'muted',
  run: 'info',
  bad: 'danger',
}
const ICON_NAME = new Map<Component, EmbedIcon>([
  [LayoutGrid, 'grid'],
  [PiggyBank, 'piggy-bank'],
  [Server, 'server'],
  [Cpu, 'cpu'],
  [Route, 'route'],
  [Plug, 'plug'],
  [Layers, 'layers'],
  [Info, 'info'],
])
function deskRow(r: TreeRow): SidebarRow {
  const n = r.n
  const [before, hit] = r.parts
  return {
    key: r.id,
    label: n.label,
    depth: r.depth,
    hit: hit ? [before.length, before.length + hit.length] : undefined,
    branch: r.hasKids ? (r.open ? 'open' : 'closed') : undefined,
    status: n.dot ? { dot: DOT_TONE[n.dot], pulse: n.dot === 'run', label: n.dotTitle } : undefined,
    avatar: n.av ? { src: r.avSrc ?? undefined, text: initials(n.av) } : undefined,
    icon: !n.av && n.icon ? ICON_NAME.get(n.icon) : undefined,
    count: n.count ?? undefined,
    meta: n.meta || undefined,
    star:
      n.model && (n.star || n.auto)
        ? {
            text: n.star ? `★${n.star}` : '☆',
            on: !!n.star,
            label: n.star ? t('hswarm.nav.priority', { n: n.star }) : t('hswarm.nav.starIt'),
            busy: starBusy.value === n.model,
          }
        : undefined,
    dim: n.dim,
    italic: n.more,
    hint: n.dotTitle,
  }
}
const running = computed(() => !!status.value?.running && !!state.value)
// Each row Desk gets keeps its identity while it says the same, so a keystroke or a refresh hands over
// the rows that changed and no more new objects than that.
let sentRows: SidebarRow[] = []
const deskRows = computed<SidebarRow[]>(() => {
  if (!running.value) return []
  sentRows = reconcileList(sentRows, rows.value.map(deskRow), (r) => r.key)
  return sentRows
})
useDeskSidebar(
  'hswarm',
  () => ({
    view: 'hswarm',
    title: t('app.tabHswarm'),
    icon: 'network',
    buttons: [
      { id: 'help', icon: 'info', label: t('hswarm.help'), on: sel.value === 'help', disabled: !running.value },
      {
        id: 'refresh',
        icon: 'refresh',
        label: t('hswarm.refresh'),
        spin: isRefreshing.value,
        disabled: !status.value?.running || isRefreshing.value,
      },
    ],
    search: running.value
      ? { value: query.value, placeholder: t('hswarm.nav.search'), label: t('hswarm.nav.searchAria') }
      : undefined,
    legend: running.value
      ? [
          { dot: 'success', label: t('hswarm.nav.ready') },
          { dot: 'warning', label: t('hswarm.nav.resting') },
          { dot: 'hollow', label: t('hswarm.nav.noKey') },
          { dot: 'muted', label: t('hswarm.nav.off') },
        ]
      : undefined,
    legendNote: status.value?.running ? t('hswarm.nav.port', { port: status.value.port }) : undefined,
    sections: running.value ? [{ key: 'tree', rows: deskRows.value }] : [],
    selected: sel.value,
    empty: !running.value
      ? loading.value
        ? undefined
        : t('hswarm.notRunning')
      : t('hswarm.nav.nothingMatches', { q: query.value }),
    loading: loading.value && !state.value,
    footer: hasKeys.value
      ? [
          { id: 'add-provider', icon: 'plus', label: t('hswarm.addProvider') },
          { id: 'add-model', icon: 'plus', label: t('hswarm.addModel') },
        ]
      : undefined,
  }),
  (e) => {
    const row = 'key' in e ? rows.value.find((r) => r.id === e.key) : undefined
    if (e.action === 'select' && row) select(row.sel)
    else if (e.action === 'toggle' && row?.hasKids) toggle(row.id)
    else if (e.action === 'star' && row) void toggleStar(row.n)
    else if (e.action === 'search') query.value = e.value
    else if (e.action === 'button') {
      if (e.id === 'help') select('help')
      else if (e.id === 'refresh') void handleRefresh()
      else if (e.id === 'add-provider') select('providers', { adding: true })
      else if (e.id === 'add-model') select('models', { adding: true })
    }
  },
)

// Desk asked for one job (its sidebar's job rows): selected once the jobs list is in, which shows its detail
// (HSwarmJobs opens the job it is given). The job is selected even when the list shows only the newest few.
watch(
  [hswarmJobAsk, jobs],
  () => {
    const id = hswarmJobAsk.value
    if (!id || !jobs.value) return
    hswarmJobAsk.value = null
    select(`jobs/${enc(id)}`)
  },
  { immediate: true },
)

onMounted(async () => {
  // In Desk the tree's search is Desk's, so "/" is left to the page.
  if (!EMBEDDED) window.addEventListener('keydown', onGlobalKey)
  // What the shared copy has (lib/warm-data.ts) is on screen already; read it again now.
  await refreshHswarm()
  if (status.value?.running) void askIcons()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKey)
})

async function handleRefresh() {
  isRefreshing.value = true
  try {
    await refresh()
    loadClients()
    loadJobs()
    toast.success(t('hswarm.refreshed'))
  } catch (err) {
    toast.error(t('hswarm.refreshFailed'))
  } finally {
    isRefreshing.value = false
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Below 900px the tree is a drawer: a thin strip holds its button and the status -->
    <div
      v-if="!EMBEDDED && status?.running && state"
      class="flex items-center gap-2 border-b border-border px-2 py-1 min-[900px]:hidden"
    >
      <Button
        size="icon"
        variant="ghost"
        class="size-7"
        :aria-label="t('hswarm.nav.open')"
        :aria-expanded="navOpen"
        @click="navOpen = true"
      >
        <Menu class="size-4" />
      </Button>
      <span class="truncate text-xs text-muted-foreground">
        {{ t('hswarm.statusRunning', { port: status.port }) }}
      </span>
    </div>

    <!-- Error state -->
    <Alert v-if="error || !status?.running" variant="destructive" class="m-2 w-auto">
      <AlertCircle class="h-4 w-4" />
      <AlertTitle>{{ t('hswarm.notRunning') }}</AlertTitle>
      <AlertDescription>
        {{ error ? t('hswarm.errorLoading') : (status?.lastError ? t('hswarm.statusError', { error: status.lastError }) : t('hswarm.notRunning')) }}
      </AlertDescription>
    </Alert>

    <!-- Loading state (first load only: a reload keeps the tree and the page in place) -->
    <div v-if="loading && !state" class="flex items-center justify-center py-4">
      <div class="text-muted-foreground">{{ t('hswarm.loading') }}</div>
    </div>

    <!-- Main content: the tree on the left, the selected page on the right -->
    <div v-else-if="status?.running && state" class="relative flex min-h-0 flex-1">
      <div
        v-if="navOpen && !EMBEDDED"
        class="fixed inset-0 z-20 bg-black/40 min-[900px]:hidden"
        aria-hidden="true"
        @click="navOpen = false"
      />
      <nav
        v-if="!EMBEDDED"
        :aria-label="t('hswarm.nav.label')"
        class="flex min-h-0 shrink-0 flex-col border-e border-border bg-sidebar max-[899px]:fixed max-[899px]:inset-y-0 max-[899px]:start-0 max-[899px]:z-30 max-[899px]:w-[min(86vw,340px)] max-[899px]:transition-transform min-[900px]:w-(--tree-w)"
        :class="navOpen ? '' : 'max-[899px]:-translate-x-full max-[899px]:invisible'"
        :style="{ '--tree-w': `${treeWidth}px` }"
        @keydown.esc="navOpen = false"
      >
        <div class="flex items-center gap-1 px-2 py-1.5">
          <div class="relative flex-1">
            <Search class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref="searchEl"
              v-model="query"
              type="search"
              leading="icon"
              autocomplete="off"
              :placeholder="t('hswarm.nav.search')"
              :aria-label="t('hswarm.nav.searchAria')"
              aria-keyshortcuts="/"
              @keydown="onSearchKey"
            />
          </div>
          <Button
            size="icon"
            variant="ghost"
            class="size-7 shrink-0"
            :disabled="!status?.running || !state"
            :title="t('hswarm.help')"
            :aria-label="t('hswarm.help')"
            @click="select('help')"
          >
            <Info class="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            class="size-7 shrink-0"
            :disabled="!status?.running || isRefreshing"
            :title="t('hswarm.refresh')"
            :aria-label="t('hswarm.refresh')"
            @click="handleRefresh"
          >
            <RefreshCw :class="{ 'animate-spin': isRefreshing }" class="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            class="size-7 shrink-0 min-[900px]:hidden"
            :aria-label="t('hswarm.nav.close')"
            @click="navOpen = false"
          >
            <X class="size-4" />
          </Button>
        </div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 pb-1 text-xs text-muted-foreground">
          <span class="flex items-center gap-1"><span class="size-2 rounded-full" :class="DOT_CLASS.ok" />{{ t('hswarm.nav.ready') }}</span>
          <span class="flex items-center gap-1"><span class="size-2 rounded-full" :class="DOT_CLASS.warn" />{{ t('hswarm.nav.resting') }}</span>
          <span class="flex items-center gap-1"><span class="size-2 rounded-full" :class="DOT_CLASS.nokey" />{{ t('hswarm.nav.noKey') }}</span>
          <span class="flex items-center gap-1"><span class="size-2 rounded-full" :class="DOT_CLASS.off" />{{ t('hswarm.nav.off') }}</span>
          <span v-if="status?.running" class="ms-auto font-mono">{{ t('hswarm.nav.port', { port: status.port }) }}</span>
        </div>

        <div
          ref="treeEl"
          role="tree"
          tabindex="0"
          :aria-label="t('hswarm.nav.label')"
          :aria-activedescendant="rows.length ? `hs-tn-${cur}` : undefined"
          class="min-h-0 flex-1 overflow-y-auto py-0.5 text-sm focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-1"
          @keydown="onTreeKey"
        >
          <div
            v-for="r in rows"
            :id="`hs-tn-${r.id}`"
            :key="r.id"
            :data-row="r.id"
            role="treeitem"
            :aria-level="r.depth + 1"
            :aria-expanded="r.hasKids ? r.open : undefined"
            :aria-selected="r.id === sel"
            class="flex h-[26px] cursor-pointer items-center gap-1.5 border-s-2 pe-3 transition-colors"
            :class="[
              r.id === sel ? 'border-primary bg-accent font-medium' : 'border-transparent hover:bg-accent/50',
              r.id === cur && r.id !== sel ? 'bg-accent/30' : '',
              r.n.dim ? 'opacity-60' : '',
              r.n.more ? 'italic text-muted-foreground' : '',
            ]"
            :style="{ paddingInlineStart: `calc(4px + ${r.depth} * 14px)` }"
            :title="r.n.dotTitle"
            @click="select(r.sel)"
          >
            <span
              class="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
              aria-hidden="true"
              @click="onChevron($event, r)"
            >
              <ChevronRight
                v-if="r.hasKids"
                class="size-3.5 transition-transform"
                :class="r.open ? 'rotate-90' : ''"
              />
            </span>
            <span v-if="r.n.dot" class="size-2 shrink-0 rounded-full" :class="DOT_CLASS[r.n.dot]" aria-hidden="true" />
            <template v-if="r.n.av">
              <img
                v-if="r.avSrc"
                :src="r.avSrc"
                alt=""
                aria-hidden="true"
                decoding="async"
                class="size-5 shrink-0 rounded"
                @error="onAvError(r.n)"
              >
              <span
                v-else
                class="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold text-muted-foreground"
                aria-hidden="true"
              >{{ initials(r.n.av) }}</span>
            </template>
            <component :is="r.n.icon" v-else-if="r.n.icon" class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span v-if="r.n.more" class="min-w-0 truncate">{{ r.n.label }}</span>
            <span v-else class="min-w-0 truncate">{{ r.parts[0] }}<mark v-if="r.parts[1]" class="find-hit">{{ r.parts[1] }}</mark>{{ r.parts[2] }}</span>
            <span v-if="r.n.dotTitle" class="sr-only">, {{ r.n.dotTitle }}</span>
            <span v-if="r.n.star" class="sr-only">, {{ t('hswarm.nav.prioritySr', { n: r.n.star }) }}</span>
            <span v-if="r.n.count != null" class="shrink-0 text-xs text-muted-foreground">({{ r.n.count }})</span>
            <span class="ms-auto shrink-0 font-mono text-xs text-muted-foreground">{{ r.n.meta }}</span>
            <span
              v-if="r.n.model && (r.n.star || r.n.auto)"
              class="shrink-0 cursor-pointer rounded px-0.5 text-xs hover:bg-accent"
              :class="[r.n.star ? 'text-primary' : 'text-muted-foreground', starBusy === r.n.model ? 'opacity-50' : '']"
              aria-hidden="true"
              :title="r.n.star ? t('hswarm.nav.priority', { n: r.n.star }) : t('hswarm.nav.starIt')"
              @click.stop="toggleStar(r.n)"
            >{{ r.n.star ? `★${r.n.star}` : '☆' }}</span>
          </div>
        </div>
        <p v-if="!rows.length" class="px-3 py-2 text-sm text-muted-foreground" role="status">
          {{ t('hswarm.nav.nothingMatches', { q: query }) }}
        </p>

        <!-- Adding your own provider or model is for later: before the first key, the provider list is the way in. -->
        <div v-if="hasKeys" class="grid grid-cols-2 gap-1.5 border-t border-border p-1.5">
          <Button size="sm" variant="outline" @click="select('providers', { adding: true })">
            <Plus class="size-4" />
            <span class="ms-1 truncate">{{ t('hswarm.addProvider') }}</span>
          </Button>
          <Button size="sm" variant="outline" @click="select('models', { adding: true })">
            <Plus class="size-4" />
            <span class="ms-1 truncate">{{ t('hswarm.addModel') }}</span>
          </Button>
        </div>
      </nav>
      <div
        v-if="!EMBEDDED"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('hswarm.nav.resize')"
        :aria-valuenow="treeWidth"
        :aria-valuemin="TREE_MIN"
        tabindex="0"
        :title="t('hswarm.nav.resize')"
        class="relative z-10 -ms-1 w-1.5 shrink-0 cursor-col-resize touch-none transition-colors hover:bg-accent/60 focus-visible:bg-accent max-[899px]:hidden"
        @pointerdown="onSplitDown"
        @pointermove="onSplitMove"
        @pointerup="onSplitUp"
        @pointercancel="onSplitUp"
        @dblclick="setWidth(TREE_DEFAULT)"
        @keydown="onSplitKey"
      />

      <!-- The selected page; each is its own component in ./hswarm/ -->
      <div class="min-h-0 min-w-0 flex-1 overflow-auto" :class="page.component === HSwarmTools ? 'p-3' : ''">
        <component
          :is="page.component"
          :key="`${sel}|${adding}|${addNonce}`"
          :state="state"
          v-bind="page.props"
          @changed="handleRefresh"
          @open="openPath"
        />
      </div>
    </div>
  </div>
</template>
