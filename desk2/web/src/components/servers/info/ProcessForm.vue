<script setup lang="ts">
import type { DevWebProcess, DevWebProcessSpec, DevWebProject } from '@shared/devwebui'
import { projectDir } from '@shared/devwebui'
import { FolderOpen, Plus, X } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { Tip } from '@/components/ui/tooltip'
import { addProcess, pickFolder, processConfig, removeProcess, updateProcess } from '../api'
import { useDevServers } from '../store'
import { ICON_BTN, INPUT, TEXT_BTN } from '../styles'

const props = defineProps<{ projectId: string; processId: string | null; siblings: DevWebProcess[] }>()
const emit = defineEmits<{ saved: [project: DevWebProject]; cancel: []; deleted: [] }>()
const servers = useDevServers()

const SWATCHES = ['#3b82f6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#a855f7', '#ec4899', '#14b8a6']
const LABEL = 'w-24 shrink-0 pt-1 text-[var(--text-2)]'

const loading = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const confirmDelete = ref(false)
// The entry as read, so keys this form does not edit (compose, starred, unknown ones) are written back unchanged.
let original: DevWebProcessSpec | null = null

const name = ref('')
const id = ref('')
const idTyped = ref(false)
const command = ref('')
const cwd = ref('')
const port = ref('')
const url = ref('')
const waitMode = ref<'none' | 'port' | 'sibling'>('none')
const waitPort = ref('')
const waitSibling = ref('')
const links = ref<string[]>([])
const companion = ref(false)
const autostart = ref(false)
const runtime = ref<'' | 'node' | 'bun'>('')
const color = ref('')
const env = ref<{ k: string; v: string }[]>([])
const answers = ref<{ expect: string; send: string; once: boolean }[]>([])
const hasCompose = ref(false)

const others = computed(() => props.siblings.filter((s) => s.id !== props.processId))
const project = computed(() => servers.projects.value?.find((p) => p.id === props.projectId) ?? null)

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
watch(name, (n) => {
  if (props.processId === null && !idTyped.value) id.value = slug(n)
})

function fill(s: DevWebProcessSpec | null): void {
  original = s
  name.value = s?.name ?? ''
  id.value = s?.id ?? ''
  idTyped.value = !!s
  command.value = s?.command ?? ''
  cwd.value = s?.cwd ?? ''
  port.value = s?.port ? String(s.port) : ''
  url.value = s?.url ?? ''
  const w = s?.waitForPort
  waitMode.value = w === undefined ? 'none' : typeof w === 'number' ? 'port' : 'sibling'
  waitPort.value = typeof w === 'number' ? String(w) : ''
  waitSibling.value = typeof w === 'string' ? w : ''
  links.value = [...(s?.links ?? [])]
  companion.value = !!s?.companion
  autostart.value = !!s?.autostart
  runtime.value = s?.runtime ?? ''
  color.value = s?.color ?? ''
  env.value = Object.entries(s?.env ?? {}).map(([k, v]) => ({ k, v }))
  answers.value = (s?.answers ?? []).map((a) => ({ expect: a.expect, send: a.send, once: !!a.once }))
  hasCompose.value = s?.compose !== undefined
}

watch(
  () => props.processId,
  async (pid) => {
    error.value = null
    confirmDelete.value = false
    if (pid === null) return fill(null)
    loading.value = true
    try {
      const s = await processConfig(pid)
      if (pid === props.processId) fill(s)
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  },
  { immediate: true }
)

function portNumber(v: string, what: string): number | undefined {
  if (!v.trim()) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${what} must be a whole number from 1 to 65535.`)
  return n
}

function build(): DevWebProcessSpec {
  if (!name.value.trim()) throw new Error('Give the server a name.')
  if (!id.value.trim()) throw new Error('Give the server an id.')
  if (!command.value.trim()) throw new Error('Type the command that starts it.')
  const spec: DevWebProcessSpec = { ...(original ?? {}), id: id.value.trim(), name: name.value.trim(), command: command.value.trim() }
  const set = <K extends keyof DevWebProcessSpec>(k: K, v: DevWebProcessSpec[K] | undefined): void => {
    if (v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length)) delete spec[k]
    else spec[k] = v
  }
  set('cwd', cwd.value.trim())
  set('port', portNumber(port.value, 'The port'))
  set('url', url.value.trim())
  if (waitMode.value === 'sibling' && !waitSibling.value) throw new Error('Pick the server to wait for.')
  set('waitForPort', waitMode.value === 'port' ? portNumber(waitPort.value, 'The port to wait for') : waitMode.value === 'sibling' ? waitSibling.value : undefined)
  // Unticking removes a link from `links`; saved links to servers missing from a stale `siblings` list are kept.
  set('links', links.value)
  set('companion', companion.value)
  set('autostart', autostart.value)
  set('runtime', runtime.value || undefined)
  set('color', color.value)
  const e = env.value.filter((r) => r.k.trim())
  set('env', e.length ? Object.fromEntries(e.map((r) => [r.k.trim(), r.v])) : undefined)
  set('answers', answers.value.filter((a) => a.expect).map((a) => (a.once ? { expect: a.expect, send: a.send, once: true } : { expect: a.expect, send: a.send })))
  return spec
}

async function run(fn: () => Promise<void>): Promise<void> {
  busy.value = true
  error.value = null
  try {
    await fn()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

const save = () =>
  run(async () => {
    const spec = build()
    const p = props.processId === null ? await addProcess(props.projectId, spec) : await updateProcess(props.processId, spec)
    void servers.refresh()
    emit('saved', p)
  })
const remove = () =>
  run(async () => {
    if (props.processId === null) return
    await removeProcess(props.processId)
    void servers.refresh()
    emit('deleted')
  })

async function browse(): Promise<void> {
  const base = project.value ? projectDir(project.value) : null
  try {
    const picked = await pickFolder(base && cwd.value ? `${base}/${cwd.value}` : base)
    if (!picked) return
    // The file keeps the folder relative to itself, as DevWebUI wrote it.
    const b = base?.replace(/\\/g, '/').replace(/\/$/, '') ?? ''
    const p = picked.replace(/\\/g, '/')
    if (b && p.toLowerCase() === b.toLowerCase()) cwd.value = ''
    else if (b && p.toLowerCase().startsWith(`${b.toLowerCase()}/`)) cwd.value = p.slice(b.length + 1)
    else cwd.value = p
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <form class="flex flex-col gap-2 text-[12px]" @submit.prevent="save">
    <p v-if="loading" class="text-[var(--text-muted)]">Reading its entry...</p>
    <template v-else>
      <label class="flex items-start gap-2"><span :class="LABEL">Name</span><input v-model="name" :class="INPUT" placeholder="Web" /></label>
      <label class="flex items-start gap-2">
        <span :class="LABEL">Id</span>
        <input v-model="id" :class="[INPUT, 'font-mono']" placeholder="web" @input="idTyped = true" />
      </label>
      <label class="flex items-start gap-2"><span :class="LABEL">Command</span><input v-model="command" :class="[INPUT, 'font-mono']" placeholder="bun run dev" /></label>
      <div class="flex items-start gap-2">
        <span :class="LABEL">Folder</span>
        <input v-model="cwd" :class="[INPUT, 'font-mono']" aria-label="Folder, relative to the project" placeholder="The project folder" />
        <Tip label="Browse">
          <button type="button" :class="ICON_BTN" aria-label="Browse for its folder" @click="browse"><FolderOpen class="size-3.5" /></button>
        </Tip>
      </div>
      <label class="flex items-start gap-2"><span :class="LABEL">Port</span><input v-model="port" :class="INPUT" inputmode="numeric" placeholder="None" /></label>
      <label class="flex items-start gap-2"><span :class="LABEL">Address</span><input v-model="url" :class="[INPUT, 'font-mono']" placeholder="A path like /app, or a full URL" /></label>
      <div class="flex items-start gap-2">
        <span :class="LABEL">Start after</span>
        <select v-model="waitMode" :class="[INPUT, 'flex-none']" aria-label="Start after">
          <option value="none">Right away</option>
          <option value="port">A port answers</option>
          <option v-if="others.length" value="sibling">Another server is up</option>
        </select>
        <input v-if="waitMode === 'port'" v-model="waitPort" :class="INPUT" inputmode="numeric" aria-label="Port to wait for" placeholder="5432" />
        <select v-if="waitMode === 'sibling'" v-model="waitSibling" :class="INPUT" aria-label="Server to wait for">
          <option v-for="o in others" :key="o.id" :value="o.localId">{{ o.name }}</option>
        </select>
      </div>
      <div v-if="others.length" class="flex items-start gap-2">
        <span :class="LABEL">Runs with</span>
        <div class="flex flex-col gap-1 pt-1">
          <label v-for="o in others" :key="o.id" class="flex items-center gap-2 text-[var(--text)]">
            <input v-model="links" type="checkbox" :value="o.localId" />{{ o.name }}
          </label>
          <span class="text-[var(--text-muted)]">Starting or stopping one starts or stops them all.</span>
        </div>
      </div>
      <label class="flex items-center gap-2 pl-26 text-[var(--text)]"><input v-model="companion" type="checkbox" />Start it whenever another server of this project is started</label>
      <label class="flex items-center gap-2 pl-26 text-[var(--text)]"><input v-model="autostart" type="checkbox" />Start it automatically</label>
      <label class="flex items-start gap-2">
        <span :class="LABEL">Runtime</span>
        <select v-model="runtime" :class="[INPUT, 'flex-none']">
          <option value="">Settings default</option>
          <option value="node">Node</option>
          <option value="bun">Bun</option>
        </select>
      </label>
      <div class="flex items-start gap-2">
        <span :class="LABEL">Color</span>
        <div class="flex flex-wrap items-center gap-1 pt-0.5">
          <Tip label="No color">
            <button type="button" :class="[ICON_BTN, !color ? 'bg-[var(--fill-selected)]' : '']" aria-label="No color" @click="color = ''"><X class="size-3.5" /></button>
          </Tip>
          <button
            v-for="c in SWATCHES"
            :key="c"
            type="button"
            class="size-5 rounded-full focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
            :class="color.toLowerCase() === c ? 'ring-2 ring-[var(--text)] ring-offset-1 ring-offset-[var(--bg-page)]' : ''"
            :style="{ background: c }"
            :aria-label="`Color ${c}`"
            @click="color = c"
          />
          <input v-model="color" type="color" class="size-5 cursor-default rounded-full bg-transparent" aria-label="Custom color" />
        </div>
      </div>
      <div class="flex items-start gap-2">
        <span :class="LABEL">Environment</span>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <div v-for="(r, i) in env" :key="i" class="flex items-center gap-1">
            <input v-model="r.k" :class="[INPUT, 'font-mono']" aria-label="Variable name" placeholder="NAME" />
            <input v-model="r.v" :class="[INPUT, 'font-mono']" aria-label="Value" placeholder="value" />
            <Tip label="Remove">
              <button type="button" :class="ICON_BTN" aria-label="Remove variable" @click="env.splice(i, 1)"><X class="size-3.5" /></button>
            </Tip>
          </div>
          <div><button type="button" :class="TEXT_BTN" @click="env.push({ k: '', v: '' })"><Plus class="size-3" />Variable</button></div>
        </div>
      </div>
      <div class="flex items-start gap-2">
        <span :class="LABEL">Answers</span>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <span class="text-[var(--text-muted)]">When it prints the text on the left, AgentHydra types the reply on the right.</span>
          <div v-for="(a, i) in answers" :key="i" class="flex items-center gap-1">
            <input v-model="a.expect" :class="INPUT" aria-label="When it prints" placeholder="Continue? (y/n)" />
            <input v-model="a.send" :class="INPUT" aria-label="Reply" placeholder="y" />
            <Tip label="Only answer the first time">
              <label class="flex items-center gap-1 text-[var(--text-2)]"><input v-model="a.once" type="checkbox" aria-label="Only once" />Once</label>
            </Tip>
            <Tip label="Remove">
              <button type="button" :class="ICON_BTN" aria-label="Remove answer" @click="answers.splice(i, 1)"><X class="size-3.5" /></button>
            </Tip>
          </div>
          <div><button type="button" :class="TEXT_BTN" @click="answers.push({ expect: '', send: '', once: false })"><Plus class="size-3" />Answer</button></div>
        </div>
      </div>
      <p v-if="hasCompose" class="pl-26 text-[var(--text-muted)]">Its docker compose setup is kept as written.</p>

      <p v-if="error" class="text-[var(--danger-text)]">{{ error }}</p>
      <div class="flex flex-wrap items-center gap-2 pt-1">
        <button type="submit" :class="TEXT_BTN" :disabled="busy">{{ processId === null ? 'Add server' : 'Save' }}</button>
        <button type="button" :class="TEXT_BTN" :disabled="busy" @click="emit('cancel')">Cancel</button>
        <template v-if="processId !== null">
          <span class="flex-1" />
          <template v-if="confirmDelete">
            <span class="text-[var(--text-2)]">Delete it from the .devwebui file?</span>
            <button type="button" :class="[TEXT_BTN, 'text-[var(--danger-text)]']" :disabled="busy" @click="remove">Delete</button>
            <button type="button" :class="TEXT_BTN" :disabled="busy" @click="confirmDelete = false">Keep</button>
          </template>
          <button v-else type="button" :class="[TEXT_BTN, 'text-[var(--danger-text)]']" :disabled="busy" @click="confirmDelete = true">Delete server</button>
        </template>
      </div>
    </template>
  </form>
</template>
