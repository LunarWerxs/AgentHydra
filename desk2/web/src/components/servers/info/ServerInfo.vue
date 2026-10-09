<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  Check,
  Copy,
  Cpu,
  ExternalLink,
  FolderOpen,
  MemoryStick,
  MoreHorizontal,
  Pencil,
  Play,
  RotateCw,
  Server,
  Square
} from '@lucide/vue'
import { processAddress, type DevWebAlertRule, type DevWebFreePort, type DevWebProcess, type DevWebProject } from '@shared/devwebui'
import { Tip } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useClock } from '@/lib/clock'
import { alertList, devSettings, freePort, removeProcess, revealFolder, saveDevSettings, setProcessEnabled } from '../api'
import { actionDisabled, isUp, OUTSIDE_TIP, startBlock, statusDot, type Dot } from '../logic'
import { useDevServers } from '../store'
import AlertRules from './AlertRules.vue'
import ErrorList from './ErrorList.vue'
import { bytes, clockTime, cpu, uptime } from './format'
import { BTN, BTN_PRIMARY, CHIP, EYEBROW, ICON_BTN, ICON_BTN_SM, MONO, tabClass, TONE_BG, TONE_COLOR, type ChartPoint, type Tone } from './kit/kit'
import Card from './kit/Card.vue'
import CountBadge from './kit/CountBadge.vue'
import Notice from './kit/Notice.vue'
import StatTile from './kit/StatTile.vue'
import SwitchRow from './kit/SwitchRow.vue'
import LogView from './LogView.vue'
import MetricCard from './MetricCard.vue'
import { useMetrics } from './metrics'
import { memo, serverTab, usePaneNav, type ServerTab } from './nav'

// One server (owner, 2026-10-07: "a nice, like, card display", "charts or stats", never "this ugly table"). A hero with
// its name, status and address and the main actions (Start or Stop, Restart, Open in browser, Edit, a More menu); the
// notices that need a decision (a port taken, changed settings, waiting, a crash); then four tabs. Overview is tiles
// (status, uptime, restarts, port, who started it, its project), its CPU and memory over the last ten minutes, and a
// details card; Logs, Errors and Alerts are the server's own. It reads the shared client's list, so every figure follows
// each poll, and the tab picked stays as another server is picked.
const props = defineProps<{ project: DevWebProject; proc: DevWebProcess }>()
const servers = useDevServers()
const nav = usePaneNav()
const clock = useClock()
const p = computed(() => props.proc)
const up = computed(() => isUp(p.value.status))
const busy = computed(() => servers.busy.value.has(p.value.id))
const linkHost = ref('')
const monitoring = ref(true)
const savingMonitor = ref(false)
onMounted(async () => {
  const s = await devSettings({ start: false }).catch(() => null)
  linkHost.value = s?.linkHost ?? ''
  monitoring.value = s?.monitorResources ?? true
})
const address = computed(() => processAddress(p.value, linkHost.value))
const block = computed(() => startBlock(p.value))

const error = ref<string | null>(null)
const copied = ref<string | null>(null)
const fail = (err: unknown) => (error.value = err instanceof Error ? err.message : String(err))
async function attempt(fn: () => Promise<unknown>) {
  error.value = null
  try {
    await fn()
    await servers.refresh()
  } catch (err) {
    fail(err)
  }
}
async function copy(what: string, text: string | null) {
  if (!text) return
  await navigator.clipboard.writeText(text).catch(() => {}) // floor-ok: a blocked clipboard copies nothing
  copied.value = what
  setTimeout(() => (copied.value = null), 1500)
}
const toggle = () => servers.act(p.value, up.value ? 'stop' : 'start')

const freeing = ref<DevWebFreePort | null>(null)
async function free(pids?: number[]) {
  error.value = null
  try {
    freeing.value = await freePort(p.value.id, pids)
    await servers.refresh()
  } catch (err) {
    fail(err)
  }
}

const deleting = ref(false)
async function remove() {
  deleting.value = false
  await attempt(async () => {
    await removeProcess(p.value.id)
    servers.select({ kind: 'project', id: props.project.id })
  })
}
async function reveal() {
  error.value = null
  try {
    await revealFolder(p.value.cwd)
  } catch (err) {
    fail(err)
  }
}
async function monitorOn() {
  savingMonitor.value = true
  try {
    monitoring.value = (await saveDevSettings({ monitorResources: true })).monitorResources
    await servers.refresh()
  } catch (err) {
    fail(err)
  } finally {
    savingMonitor.value = false
  }
}

// ---- what the hero and the tiles say ----
const TONE: Record<Dot, Tone> = { run: 'success', wait: 'warning', bad: 'danger', off: 'neutral' }
const tone = computed(() => TONE[statusDot(p.value.status)])
const STATUS: Record<DevWebProcess['status'], string> = {
  running: 'Running',
  starting: 'Starting',
  waiting: 'Waiting',
  stopping: 'Stopping',
  stopped: 'Stopped',
  crashed: 'Crashed'
}
const statusText = computed(() => STATUS[p.value.status] ?? p.value.status)
const statusSub = computed(() => {
  const x = p.value
  if (x.status === 'crashed') return x.exitCode !== null ? `Exit code ${x.exitCode}` : 'It stopped by itself'
  if (x.status === 'waiting') return x.waitingOnPort ? `For port ${x.waitingOnPort}` : 'For what it starts after'
  if (x.status === 'starting') return x.pid !== null ? `Process ${x.pid}, not answering yet` : 'Not answering yet'
  if (x.status === 'stopping') return 'Ending its processes'
  if (up.value) return x.pid !== null ? `Process ${x.pid}` : 'Up'
  return x.exitCode !== null ? `Last exit code ${x.exitCode}` : 'Not running'
})
const outside = computed(() => p.value.owner === 'outside')
const waitFor = computed(() => {
  const w = p.value.waitForPort
  if (w === undefined) return null
  const sib = typeof w === 'string' ? props.project.processes.find((x) => x.localId === w) : null
  return sib ? `${sib.name} (port ${sib.port ?? '?'})` : `Port ${w}`
})
const linked = computed(() => (p.value.links ?? []).map((l) => props.project.processes.find((x) => x.localId === l)).filter((x): x is DevWebProcess => !!x))
const hostOf = (url: string | null) => {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// ---- charts: the service's last ten minutes, its alert limits as dashed lines ----
const history = useMetrics(p.value.id)
const windowMs = computed(() => history.value?.windowMs ?? 600_000)
// The charts span what there is, in whole minutes up to the service's ten: a server up for twenty seconds fills a third
// of a one-minute chart, not a sliver at the right edge of a ten-minute one.
const span = computed(() => {
  const oldest = history.value?.points[0]?.t ?? clock.value
  return Math.min(windowMs.value, Math.max(60_000, Math.ceil((clock.value - oldest) / 60_000) * 60_000))
})
const spanWords = computed(() => (span.value <= 60_000 ? 'the last minute' : `the last ${Math.round(span.value / 60_000)} minutes`))
const from = computed(() => clock.value - span.value)
const cpuPoints = computed<ChartPoint[]>(() => (history.value?.points ?? []).map((x) => ({ t: x.t, v: x.cpu })))
const memPoints = computed<ChartPoint[]>(() => (history.value?.points ?? []).map((x) => ({ t: x.t, v: x.memory })))
const seenRules = memo<DevWebAlertRule[]>()
const rules = ref<DevWebAlertRule[]>(seenRules.get(p.value.id) ?? [])
let rulesAt = 0
async function loadRules() {
  if (Date.now() - rulesAt < 5000) return
  rulesAt = Date.now()
  const all = await alertList({ start: false }).catch(() => null)
  if (!all) return
  rules.value = all.rules.filter((r) => r.processId === p.value.id)
  seenRules.set(p.value.id, rules.value)
}
watch([servers.answered, serverTab], () => void loadRules(), { immediate: true })
const limits = (metric: 'cpu' | 'memory') => rules.value.filter((r) => r.enabled && r.metric === metric).map((r) => r.threshold)
const peakOf = (pts: ChartPoint[]) => Math.max(0, ...pts.flatMap((x) => (x.v === null ? [] : [x.v])))
const cpuMax = computed(() => Math.max(25, peakOf(cpuPoints.value) * 1.2, ...limits('cpu').map((n) => n * 1.15)))
const memMax = computed(() => Math.max(64 * 1024 * 1024, peakOf(memPoints.value) * 1.25, ...limits('memory').map((n) => n * 1.15)))
const chartState = computed<'live' | 'down' | 'off'>(() => (!monitoring.value ? 'off' : up.value ? 'live' : 'down'))

// ---- tabs ----
const TABS: { id: ServerTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'logs', label: 'Logs' },
  { id: 'errors', label: 'Errors' },
  { id: 'alerts', label: 'Alerts' }
]
function tabKey(e: KeyboardEvent) {
  const i = TABS.findIndex((t) => t.id === serverTab.value)
  const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
  if (!step) return
  e.preventDefault()
  serverTab.value = TABS[(i + step + TABS.length) % TABS.length].id
  const bar = (e.currentTarget as HTMLElement).parentElement
  requestAnimationFrame(() => (bar?.querySelector('[aria-selected="true"]') as HTMLElement | null)?.focus())
}
const setTab = (t: ServerTab) => (serverTab.value = t)
const MENU_ITEM = 'text-[13px]'
</script>

<template>
  <div class="flex flex-col gap-4 p-4">
    <!-- The hero: who it is, how it is, and what to do with it. -->
    <header class="flex flex-col gap-3.5">
      <div class="flex min-w-0 items-start gap-3">
        <span
          class="flex size-10 shrink-0 items-center justify-center rounded-(--radius-10) shadow-[inset_0_0_0_1px_var(--border)]"
          :class="p.color ? '' : TONE_BG[tone]"
          :style="p.color ? { background: `color-mix(in srgb, ${p.color} 22%, transparent)`, color: p.color } : undefined"
          aria-hidden="true"
        >
          <Server class="size-5" />
        </span>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h2 class="min-w-0 truncate text-[17px] font-semibold leading-6 text-text">{{ p.name }}</h2>
            <span class="inline-flex h-5.5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[12px] font-medium leading-4" :class="TONE_BG[tone]" role="status">
              <span class="size-1.5 rounded-full bg-current" :class="tone === 'warning' && 'animate-pulse motion-reduce:animate-none'" aria-hidden="true" />
              {{ statusText }}
            </span>
            <Tip v-if="outside" :label="OUTSIDE_TIP">
              <span :class="CHIP">Started outside</span>
            </Tip>
          </div>
          <div class="flex min-w-0 items-center gap-1 text-[12px] leading-5">
            <template v-if="address">
              <Tip :label="address"><a :href="address" target="_blank" rel="noopener" class="min-w-0 truncate font-mono text-accent-text hover:underline">{{ address }}</a></Tip>
              <Tip :label="copied === 'address' ? 'Copied' : 'Copy the address'">
                <button type="button" :class="ICON_BTN_SM" aria-label="Copy the address" @click="copy('address', address)">
                  <component :is="copied === 'address' ? Check : Copy" class="size-3.5" />
                </button>
              </Tip>
            </template>
            <span v-else class="text-text-muted">No address: it has no port or URL.</span>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        <Tip v-if="!up && block" :label="block">
          <span tabindex="0" class="inline-flex rounded-(--radius-6) focus-visible:shadow-(--focus-ring) focus-visible:outline-none">
            <button type="button" :class="BTN_PRIMARY" disabled :aria-label="`Start ${p.name}`"><Play class="size-3.5" />Start</button>
          </span>
        </Tip>
        <button v-else type="button" :class="up ? BTN : BTN_PRIMARY" :disabled="busy || p.status === 'stopping'" :aria-label="up ? `Stop ${p.name}` : `Start ${p.name}`" @click="toggle">
          <component :is="up ? Square : Play" class="size-3.5" :class="!up && 'fill-current'" />{{ up ? 'Stop' : 'Start' }}
        </button>
        <button type="button" :class="BTN" :disabled="actionDisabled(p, 'restart', busy) || p.status === 'stopping'" :aria-label="`Restart ${p.name}`" @click="servers.act(p, 'restart')">
          <RotateCw class="size-3.5" />Restart
        </button>
        <button v-if="address" type="button" :class="up ? BTN_PRIMARY : BTN" aria-label="Open in browser" @click="servers.show(project, p)">
          <ExternalLink class="size-3.5" />Open in browser
        </button>
        <button type="button" :class="BTN" :aria-label="`Edit ${p.name}`" @click="nav.open({ kind: 'edit-server', id: p.id })"><Pencil class="size-3.5" />Edit</button>
        <DropdownMenu>
          <Tip label="More">
            <DropdownMenuTrigger as-child>
              <button type="button" :class="ICON_BTN" aria-label="More actions"><MoreHorizontal class="size-4" /></button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent align="start">
            <DropdownMenuItem :class="MENU_ITEM" @select="servers.star(p.id, !p.starred)">{{ p.starred ? 'Unstar' : 'Star' }}</DropdownMenuItem>
            <DropdownMenuItem :class="MENU_ITEM" @select="attempt(() => setProcessEnabled(p.id, !p.enabled))">{{ p.enabled ? 'Turn autostart off' : 'Turn autostart on' }}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem :class="MENU_ITEM" @select="copy('command', p.command)">Copy command</DropdownMenuItem>
            <DropdownMenuItem v-if="address" :class="MENU_ITEM" @select="copy('address', address)">Copy address</DropdownMenuItem>
            <DropdownMenuItem :class="MENU_ITEM" @select="reveal">Show folder</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem :class="[MENU_ITEM, 'text-danger-text']" @select="deleting = true">Delete server…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span v-if="copied === 'command'" role="status" class="text-[12px] text-text-muted">Copied the command.</span>
      </div>
    </header>

    <!-- What needs a look or a decision. -->
    <Notice v-if="error" tone="danger" title="That did not work">{{ error }}</Notice>
    <Notice v-if="p.conflict && !up" tone="warning" :title="p.port ? `Port ${p.port} is taken` : 'Its port is taken'">
      {{ p.conflict }}
      <template v-if="freeing">
        <p v-if="freeing.refused" class="mt-2 text-danger-text">{{ freeing.refused }}</p>
        <div v-else-if="freeing.needsConfirm" class="mt-2 flex flex-col gap-1.5">
          <p>Programs AgentHydra did not start hold this port. Ending them may lose their work:</p>
          <ul class="flex flex-col gap-1">
            <li v-for="o in freeing.owners ?? []" :key="o.pid" :class="[CHIP, 'w-fit']">{{ o.name }} · process {{ o.pid }}</li>
          </ul>
        </div>
        <p v-else-if="freeing.ok" class="mt-2 text-success-text">The port is free.</p>
      </template>
      <template #actions>
        <button v-if="freeing?.needsConfirm" type="button" :class="BTN" @click="free((freeing?.owners ?? []).map((o) => o.pid))">End them and free the port</button>
        <button v-else type="button" :class="BTN" @click="free()">Free the port</button>
      </template>
    </Notice>
    <Notice v-if="p.configChanged && up" tone="accent" title="Its settings changed while it runs">
      The change applies at its next start.
      <template #actions><button type="button" :class="BTN" @click="servers.act(p, 'restart')">Restart to apply</button></template>
    </Notice>
    <Notice v-if="p.status === 'waiting' && p.waitingOnPort" tone="warning" :title="`Waiting for port ${p.waitingOnPort}`">It starts once that port answers.</Notice>
    <Notice v-if="p.status === 'crashed'" tone="danger" :title="p.exitCode !== null ? `It stopped with exit code ${p.exitCode}` : 'It stopped by itself'">
      The logs show what it printed last.
      <template #actions><button type="button" :class="BTN" @click="setTab('logs')">Show the logs</button></template>
    </Notice>

    <!-- The tabs. -->
    <div role="tablist" aria-label="Server views" class="-mx-4 flex items-center gap-1 border-b border-border px-4 pb-2.5">
      <button
        v-for="t in TABS"
        :key="t.id"
        type="button"
        role="tab"
        :aria-selected="serverTab === t.id"
        :tabindex="serverTab === t.id ? 0 : -1"
        :class="tabClass(serverTab === t.id)"
        @click="setTab(t.id)"
        @keydown="tabKey"
      >
        {{ t.label }}
        <CountBadge v-if="t.id === 'errors' && p.errorCount" :count="p.errorCount" />
        <CountBadge v-else-if="t.id === 'alerts' && p.alertsFiring" :count="p.alertsFiring" tone="warning" />
        <CountBadge v-else-if="t.id === 'alerts' && rules.length" :count="rules.length" tone="neutral" />
      </button>
    </div>

    <div v-if="serverTab === 'overview'" role="tabpanel" aria-label="Overview" class="flex flex-col gap-4">
      <div class="grid grid-cols-2 gap-2.5 @lg:grid-cols-3 @3xl:grid-cols-6">
        <StatTile label="Status" :value="statusText" :tone="tone === 'neutral' ? undefined : tone" :sub="statusSub" />
        <StatTile label="Uptime" :value="up ? uptime(p.startedAt, clock) : '–'" :sub="p.startedAt ? `Since ${clockTime(p.startedAt, clock)}` : 'Not started'" />
        <StatTile label="Restarts" :value="String(p.restarts)" :sub="p.restarts === 1 ? 'time restarted' : 'times restarted'" />
        <StatTile label="Port" :value="p.port ? String(p.port) : 'None'" :sub="hostOf(address) ?? 'No address'" />
        <StatTile label="Started by" :value="outside ? 'Outside' : p.owner === 'desk' ? 'AgentHydra' : '–'" :sub="outside ? 'Adopted, not doubled' : p.owner === 'desk' ? 'Managed here' : 'Not running'" :title="outside ? OUTSIDE_TIP : undefined" />
        <StatTile label="Project" interactive :sub="`${project.processes.length} ${project.processes.length === 1 ? 'server' : 'servers'}`" :title="`Show ${project.name}`" @click="servers.select({ kind: 'project', id: project.id })">
          <span class="size-2.5 shrink-0 rounded-full" :style="{ background: project.color || 'var(--text-muted)' }" aria-hidden="true" />
          <span class="truncate text-[15px]">{{ project.name }}</span>
        </StatTile>
      </div>

      <section class="flex flex-col gap-2.5" aria-label="Resources">
        <div class="flex items-baseline gap-2 px-0.5">
          <h3 class="text-[13px] font-medium leading-5 text-text">Resources</h3>
          <span class="text-[12px] leading-4 text-text-muted">Its whole process tree, {{ spanWords }}</span>
        </div>
        <div class="grid gap-2.5 @[540px]:grid-cols-2">
          <MetricCard
            label="CPU"
            :icon="Cpu"
            :now="up && p.cpu != null ? cpu(p.cpu) : null"
            :points="cpuPoints"
            :from="from"
            :to="clock"
            :color="TONE_COLOR.accent"
            :max="cpuMax"
            :thresholds="limits('cpu')"
            :format="cpu"
            :state="chartState"
            :busy="savingMonitor"
            @monitor="monitorOn"
          />
          <MetricCard
            label="Memory"
            :icon="MemoryStick"
            :now="up && p.memory != null ? bytes(p.memory) : null"
            :points="memPoints"
            :from="from"
            :to="clock"
            color="#a78bfa"
            :max="memMax"
            :thresholds="limits('memory')"
            :format="bytes"
            :state="chartState"
            :busy="savingMonitor"
            @monitor="monitorOn"
          />
        </div>
      </section>

      <Notice v-if="p.errorCount" tone="danger" :title="`${p.errorCount} ${p.errorCount === 1 ? 'error' : 'errors'} recorded`">
        Grouped by message, with the files and lines they name.
        <template #actions><button type="button" :class="BTN" @click="setTab('errors')">Show the errors</button></template>
      </Notice>

      <Card title="Details">
        <div class="flex flex-col gap-4">
          <div class="flex min-w-0 flex-col gap-1.5">
            <span :class="EYEBROW">Command</span>
            <div class="flex min-w-0 items-start gap-2 rounded-(--radius-8) bg-bg-deepest px-3 py-2 shadow-[inset_0_0_0_1px_var(--border)]">
              <code :class="[MONO, 'min-w-0 flex-1 break-all leading-5 text-text']">{{ p.command }}</code>
              <Tip :label="copied === 'command' ? 'Copied' : 'Copy the command'">
                <button type="button" :class="[ICON_BTN_SM, '-my-0.5 -me-1']" aria-label="Copy the command" @click="copy('command', p.command)">
                  <component :is="copied === 'command' ? Check : Copy" class="size-3.5" />
                </button>
              </Tip>
            </div>
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <span :class="EYEBROW">Folder</span>
            <div class="flex min-w-0 items-start gap-2">
              <span :class="[MONO, 'min-w-0 flex-1 break-all leading-5 text-text-2']">{{ p.cwd }}</span>
              <Tip label="Show the folder">
                <button type="button" :class="[ICON_BTN_SM, '-my-0.5']" aria-label="Show the folder" @click="reveal"><FolderOpen class="size-3.5" /></button>
              </Tip>
            </div>
          </div>
          <div class="grid gap-4 @md:grid-cols-2">
            <div class="flex min-w-0 flex-col gap-1">
              <span :class="EYEBROW">Runtime</span>
              <span class="text-text">{{ p.runtime === 'node' ? 'Node' : p.runtime === 'bun' ? 'Bun' : 'Settings default' }}</span>
            </div>
            <div class="flex min-w-0 flex-col gap-1">
              <span :class="EYEBROW">Starts after</span>
              <span class="text-text">{{ waitFor ?? 'Right away' }}</span>
            </div>
            <div class="flex min-w-0 flex-col gap-1">
              <span :class="EYEBROW">Runs with</span>
              <div v-if="linked.length" class="flex flex-wrap gap-1">
                <button v-for="l in linked" :key="l.id" type="button" :class="[CHIP, 'cursor-default hover:bg-fill-hover hover:text-text']" @click="servers.select({ kind: 'server', id: l.id })">{{ l.name }}</button>
              </div>
              <span v-else class="text-text">On its own</span>
            </div>
            <div class="flex min-w-0 flex-col gap-1">
              <span :class="EYEBROW">Companion</span>
              <span class="text-text">{{ p.companion ? 'Starts with any server of its project' : 'No' }}</span>
            </div>
          </div>
          <div class="border-t border-border pt-3.5">
            <SwitchRow
              label="Start automatically"
              description="With AgentHydra, while its project's autostart is on."
              :model-value="p.enabled"
              @update:model-value="(v: boolean) => attempt(() => setProcessEnabled(p.id, v))"
            />
          </div>
        </div>
      </Card>
    </div>
    <div v-else-if="serverTab === 'logs'" role="tabpanel" aria-label="Logs"><LogView :process-id="p.id" /></div>
    <div v-else-if="serverTab === 'errors'" role="tabpanel" aria-label="Errors"><ErrorList :process-id="p.id" /></div>
    <div v-else role="tabpanel" aria-label="Alerts"><AlertRules :process-id="p.id" /></div>

    <Dialog :open="deleting" @update:open="(o: boolean) => !o && (deleting = false)">
      <DialogContent :aria-describedby="undefined">
        <DialogTitle>Delete {{ p.name }}?</DialogTitle>
        <DialogDescription>It is stopped if AgentHydra runs it, and removed from the project's .devwebui file.</DialogDescription>
        <DialogFooter>
          <Button variant="ghost" @click="deleting = false">Cancel</Button>
          <Button variant="destructive" @click="remove">Delete server</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
