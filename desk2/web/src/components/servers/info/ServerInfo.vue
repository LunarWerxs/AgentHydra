<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { AlertTriangle, Copy, ExternalLink, MoreHorizontal, Pencil, Play, RotateCw, Square } from '@lucide/vue'
import { processAddress, type DevWebFreePort, type DevWebProcess, type DevWebProject } from '@shared/devwebui'
import { Tip } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useClock } from '@/lib/clock'
import { devSettings, freePort, removeProcess, revealFolder, setProcessEnabled, setStarred } from '../api'
import { actionDisabled, isUp, outsideNote, startBlock, statusDot, statusWord } from '../logic'
import { useDevServers } from '../store'
import { DOT, ICON_BTN, TEXT_BTN } from '../styles'
import AlertRules from './AlertRules.vue'
import ErrorList from './ErrorList.vue'
import { bytes, cpu, uptime } from './format'
import LogView from './LogView.vue'
import ProcessForm from './ProcessForm.vue'

// One server: what it is doing, the actions on it (Start / Stop, Restart, Open in browser, Edit and a More menu), the
// notices that need a decision (port conflict, changed config, waiting, crashed), a grid of its details, then its
// errors, its logs and its alert rules. It reads the shared client's list, so the numbers follow each poll.
const props = defineProps<{ project: DevWebProject; proc: DevWebProcess }>()
const servers = useDevServers()
const clock = useClock()
const p = computed(() => props.proc)
const up = computed(() => isUp(p.value.status))
const busy = computed(() => servers.busy.value.has(p.value.id))
const linkHost = ref('')
const monitoring = ref(true)
onMounted(async () => {
  const s = await devSettings({ start: false }).catch(() => null)
  linkHost.value = s?.linkHost ?? ''
  monitoring.value = s?.monitorResources ?? true
})
const address = computed(() => processAddress(p.value, linkHost.value))
const block = computed(() => startBlock(p.value))

const editing = ref(false)
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

const waitFor = computed(() => {
  const w = p.value.waitForPort
  if (w === undefined) return null
  const sib = typeof w === 'string' ? props.project.processes.find((x) => x.localId === w) : null
  return sib ? `${sib.name} (port ${sib.port ?? '?'})` : `port ${w}`
})
const linked = computed(() => (p.value.links ?? []).map((l) => props.project.processes.find((x) => x.localId === l)).filter((x): x is DevWebProcess => !!x))
const rows = computed<[string, string][]>(() => [
  ['Status', statusWord(p.value)],
  ['Port', p.value.port ? String(p.value.port) : '–'],
  ['Process id', p.value.pid === null ? '–' : String(p.value.pid)],
  ['Uptime', uptime(p.value.startedAt, clock.value)],
  ['CPU', cpu(p.value.cpu)],
  ['Memory', bytes(p.value.memory)],
  ['Restarts', String(p.value.restarts)],
  ['Exit code', p.value.exitCode === null ? '–' : String(p.value.exitCode)],
  ['Runtime', p.value.runtime ?? 'Settings default'],
  ['Starts after', waitFor.value ?? '–'],
  ['Companion', p.value.companion ? 'Starts when another server of the project is started' : 'No']
])
const MENU_ITEM = 'text-[13px]'
</script>

<template>
  <div class="flex flex-col gap-4">
    <ProcessForm v-if="editing" :project-id="project.id" :process-id="p.id" :siblings="project.processes" @saved="editing = false; servers.refresh()" @cancel="editing = false" @deleted="editing = false; servers.select({ kind: 'project', id: project.id })" />
    <template v-else>
      <div>
        <div class="flex items-center gap-2">
          <span class="size-2 shrink-0 rounded-full" :class="DOT[statusDot(p.status)]" aria-hidden="true" />
          <span class="font-medium">{{ statusWord(p) }}</span>
          <span v-if="outsideNote(p)" class="text-[12px] text-text-muted">{{ outsideNote(p) }}</span>
        </div>
        <p class="mt-1 text-text-muted">
          In
          <button type="button" class="rounded-[4px] text-text-2 underline-offset-2 hover:text-text hover:underline" @click="servers.select({ kind: 'project', id: project.id })">{{ project.name }}</button>
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        <button type="button" :class="TEXT_BTN" :disabled="busy || (!up && !!block)" :aria-label="up ? `Stop ${p.name}` : `Start ${p.name}`" @click="toggle">
          <component :is="up ? Square : Play" class="size-3.5" />{{ up ? 'Stop' : 'Start' }}
        </button>
        <button type="button" :class="TEXT_BTN" :disabled="actionDisabled(p, 'restart', busy) || p.status === 'stopping'" :aria-label="`Restart ${p.name}`" @click="servers.act(p, 'restart')"><RotateCw class="size-3.5" />Restart</button>
        <button v-if="address" type="button" :class="TEXT_BTN" aria-label="Open in browser" @click="servers.show(project, p)"><ExternalLink class="size-3.5" />Open in browser</button>
        <button type="button" :class="TEXT_BTN" :aria-label="`Edit ${p.name}`" @click="editing = true"><Pencil class="size-3.5" />Edit</button>
        <DropdownMenu>
          <Tip label="More">
            <DropdownMenuTrigger as-child>
              <button type="button" :class="ICON_BTN" aria-label="More actions"><MoreHorizontal class="size-4" /></button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent align="start">
            <DropdownMenuItem :class="MENU_ITEM" @select="attempt(() => setStarred(p.id, !p.starred))">{{ p.starred ? 'Unstar' : 'Star' }}</DropdownMenuItem>
            <DropdownMenuItem :class="MENU_ITEM" @select="attempt(() => setProcessEnabled(p.id, !p.enabled))">{{ p.enabled ? 'Turn autostart off' : 'Turn autostart on' }}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem :class="MENU_ITEM" @select="copy('command', p.command)">Copy command</DropdownMenuItem>
            <DropdownMenuItem v-if="address" :class="MENU_ITEM" @select="copy('address', address)">Copy address</DropdownMenuItem>
            <DropdownMenuItem :class="MENU_ITEM" @select="reveal">Show folder</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem :class="[MENU_ITEM, 'text-danger-text']" @select="deleting = true">Delete server…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span v-if="copied" role="status" class="text-[12px] text-text-muted">Copied the {{ copied }}.</span>
      </div>

      <p v-if="error" role="alert" class="text-danger-text">{{ error }}</p>

      <div v-if="p.conflict && !up" role="alert" class="rounded-[var(--radius-6)] bg-[var(--fill-secondary)] p-2.5">
        <p class="flex items-start gap-1.5 text-warning-text"><AlertTriangle class="mt-0.5 size-3.5 shrink-0" />{{ p.conflict }}</p>
        <div class="mt-2 flex flex-wrap items-center gap-1.5">
          <button type="button" :class="TEXT_BTN" @click="free()">Free the port</button>
        </div>
        <template v-if="freeing">
          <p v-if="freeing.refused" class="mt-2 text-danger-text">{{ freeing.refused }}</p>
          <div v-else-if="freeing.needsConfirm" class="mt-2">
            <p class="text-text-2">Programs AgentHydra did not start hold this port. Ending them may lose their work:</p>
            <ul class="mt-1 list-disc pl-5 text-text-2">
              <li v-for="o in freeing.owners ?? []" :key="o.pid">{{ o.name }} (process {{ o.pid }})</li>
            </ul>
            <button type="button" :class="[TEXT_BTN, 'mt-2']" @click="free((freeing.owners ?? []).map(o => o.pid))">End them and free the port</button>
          </div>
          <p v-else-if="freeing.ok" class="mt-2 text-success-text">The port is free.</p>
        </template>
      </div>
      <p v-if="p.configChanged && up" class="flex items-center gap-2 text-text-2">
        Its settings changed while it runs.
        <button type="button" :class="TEXT_BTN" @click="servers.act(p, 'restart')">Restart to apply</button>
      </p>
      <p v-if="p.status === 'waiting' && p.waitingOnPort" class="text-text-2">Waiting for port {{ p.waitingOnPort }} to answer before it starts.</p>
      <p v-if="p.status === 'crashed'" role="alert" class="text-danger-text">It stopped{{ p.exitCode !== null ? ` with exit code ${p.exitCode}` : '' }}. The logs below show what it last printed.</p>

      <dl class="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <template v-for="[k, v] in rows" :key="k">
          <dt class="text-text-muted">{{ k }}</dt>
          <dd class="min-w-0 break-words">
            {{ v }}
            <template v-if="k === 'Memory' && !monitoring && up"> <span class="text-text-muted">(Resource monitoring is off. Turn it on in Settings, Dev servers.)</span></template>
          </dd>
        </template>
        <dt class="text-text-muted">Address</dt>
        <dd class="min-w-0 break-all">
          <a v-if="address" :href="address" target="_blank" rel="noopener" class="text-accent-text hover:underline">{{ address }}</a>
          <span v-else>–</span>
        </dd>
        <dt class="text-text-muted">Command</dt>
        <dd class="flex min-w-0 items-start gap-1">
          <code class="min-w-0 flex-1 break-all font-mono text-[12px]">{{ p.command }}</code>
          <Tip label="Copy the command">
            <button type="button" :class="ICON_BTN" aria-label="Copy the command" @click="copy('command', p.command)"><Copy class="size-3.5" /></button>
          </Tip>
        </dd>
        <dt class="text-text-muted">Folder</dt>
        <dd class="min-w-0 break-all font-mono text-[12px]">{{ p.cwd }}</dd>
        <template v-if="linked.length">
          <dt class="text-text-muted">Runs with</dt>
          <dd class="flex min-w-0 flex-wrap gap-x-2">
            <button v-for="l in linked" :key="l.id" type="button" class="text-accent-text hover:underline" @click="servers.select({ kind: 'server', id: l.id })">{{ l.name }}</button>
          </dd>
        </template>
        <dt class="text-text-muted">Autostart</dt>
        <dd>
          <label class="flex items-center gap-1.5">
            <input type="checkbox" :checked="p.enabled" @change="attempt(() => setProcessEnabled(p.id, ($event.target as HTMLInputElement).checked))" />
            Start with AgentHydra when its project is on
          </label>
        </dd>
      </dl>

      <ErrorList :process-id="p.id" />
      <LogView :process-id="p.id" />
      <AlertRules :process-id="p.id" />
    </template>

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
