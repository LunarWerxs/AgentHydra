<script setup lang="ts">
import type { DevWebProcess, DevWebProcessSpec, DevWebProject } from '@shared/devwebui'
import { projectDir } from '@shared/devwebui'
import { Check, FolderOpen, LoaderCircle, Plus, X } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { Tip } from '@/components/ui/tooltip'
import { addProcess, pickFolder, processConfig, removeProcess, updateProcess } from '../api'
import { useDevServers } from '../store'
import { BTN, BTN_DANGER, BTN_GHOST, BTN_PRIMARY, CARD, ICON_BTN_SM, INPUT, INPUT_MONO, SELECT } from './kit/kit'
import ColorPicker from './kit/ColorPicker.vue'
import Field from './kit/Field.vue'
import FormSection from './kit/FormSection.vue'
import Notice from './kit/Notice.vue'
import Segmented from './kit/Segmented.vue'
import SwitchRow from './kit/SwitchRow.vue'

// The edit / new server form, a sub-view of the Dev servers page (InfoPane draws its title and Back). Owner, 2026-10-07: "the
// edit menu ... Holy fuck ... That is so horrible." So: sections of cards, labels above the fields, a line of help
// under each, and Save / Cancel in a footer that stays in view while the form scrolls.
const props = defineProps<{ projectId: string; processId: string | null; siblings: DevWebProcess[] }>()
const emit = defineEmits<{ saved: [project: DevWebProject]; cancel: []; deleted: [] }>()
const servers = useDevServers()

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

const waitOptions = computed(() => [
  { value: 'none' as const, label: 'Right away' },
  { value: 'port' as const, label: 'A port answers' },
  ...(others.value.length ? [{ value: 'sibling' as const, label: 'Another server is up' }] : [])
])
const RUNTIMES = [
  { value: '' as const, label: 'Settings default' },
  { value: 'node' as const, label: 'Node' },
  { value: 'bun' as const, label: 'Bun' }
]

function toggleLink(localId: string): void {
  links.value = links.value.includes(localId) ? links.value.filter((l) => l !== localId) : [...links.value, localId]
}

// A new server's id follows its name until the id is typed in by hand.
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

const saving = ref(false)
async function run(fn: () => Promise<void>): Promise<void> {
  busy.value = true
  error.value = null
  try {
    await fn()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
    saving.value = false
  }
}

const save = () => {
  saving.value = true
  return run(async () => {
    const spec = build()
    const p = props.processId === null ? await addProcess(props.projectId, spec) : await updateProcess(props.processId, spec)
    void servers.refresh()
    emit('saved', p)
  })
}
const remove = () =>
  run(async () => {
    if (props.processId === null) return
    await removeProcess(props.processId)
    void servers.refresh()
    emit('deleted')
  })

const browsing = ref(false)
async function browse(): Promise<void> {
  const base = project.value ? projectDir(project.value) : null
  browsing.value = true
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
  } finally {
    browsing.value = false
  }
}

const CHIP_TOGGLE =
  'inline-flex h-7 cursor-default items-center gap-1.5 rounded-[var(--radius-6)] px-2.5 text-[13px] leading-[19px] transition-colors duration-[60ms] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none'
const chipClass = (on: boolean): string[] => [
  CHIP_TOGGLE,
  on ? 'bg-fill-selected text-text shadow-[inset_0_0_0_1px_var(--border-strong)]' : 'bg-fill-5 text-text-2 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-fill-hover hover:text-text'
]
</script>

<template>
  <form class="flex min-h-full flex-col text-[13px]" @submit.prevent="save">
    <div class="mx-auto flex w-full max-w-160 flex-col gap-6 p-4 pb-6">
      <div v-if="loading" :class="[CARD, 'flex h-85 items-center justify-center']" aria-busy="true">
        <p class="text-[13px] text-text-muted">Reading its entry…</p>
      </div>
      <template v-else>
        <FormSection title="Basics" description="What it is and how it starts.">
          <Field label="Name">
            <template #default="{ id: fid, describedBy, invalid }">
              <input :id="fid" v-model="name" :class="[INPUT, 'max-w-90']" :aria-describedby="describedBy" :aria-invalid="invalid" placeholder="Web" />
            </template>
          </Field>
          <Field label="Id" help="Its name in the .devwebui file and in links. Changing it renames the server.">
            <template #default="{ id: fid, describedBy, invalid }">
              <input :id="fid" v-model="id" :class="[INPUT_MONO, 'max-w-90']" :aria-describedby="describedBy" :aria-invalid="invalid" placeholder="web" @input="idTyped = true" />
            </template>
          </Field>
          <Field label="Command" help="Run in its folder to start it.">
            <template #default="{ id: fid, describedBy, invalid }">
              <input :id="fid" v-model="command" :class="INPUT_MONO" :aria-describedby="describedBy" :aria-invalid="invalid" placeholder="bun run dev" />
            </template>
          </Field>
          <Field label="Folder" help="Relative to the project's folder. Empty is the project's folder.">
            <template #default="{ id: fid, describedBy, invalid }">
              <div class="flex min-w-0 items-center gap-2">
                <input :id="fid" v-model="cwd" :class="INPUT_MONO" :aria-describedby="describedBy" :aria-invalid="invalid" placeholder="The project folder" />
                <button type="button" :class="BTN" aria-label="Browse for its folder" :disabled="browsing" :aria-busy="browsing" @click="browse"><FolderOpen class="size-3.5" />Browse</button>
              </div>
            </template>
          </Field>
        </FormSection>

        <FormSection title="Network" description="Where it answers.">
          <Field label="Port" help="The port it listens on: AgentHydra checks it is free before starting and shows the server as up when it answers.">
            <template #default="{ id: fid, describedBy, invalid }">
              <input :id="fid" v-model="port" :class="[INPUT, 'tnum max-w-40']" inputmode="numeric" :aria-describedby="describedBy" :aria-invalid="invalid" placeholder="None" />
            </template>
          </Field>
          <Field label="Address" help="A path like /app, or a full URL. Open in browser goes here.">
            <template #default="{ id: fid, describedBy, invalid }">
              <input :id="fid" v-model="url" :class="INPUT_MONO" :aria-describedby="describedBy" :aria-invalid="invalid" placeholder="/app or https://example.com" />
            </template>
          </Field>
        </FormSection>

        <FormSection title="Startup" description="When it starts and with what.">
          <div class="flex min-w-0 flex-col gap-1.5">
            <span class="text-[12px] font-medium leading-4 text-text-2">Start after</span>
            <Segmented v-model="waitMode" :options="waitOptions" label="Start after" />
          </div>
          <Field v-if="waitMode === 'port'" label="Port to wait for">
            <template #default="{ id: fid }">
              <input :id="fid" v-model="waitPort" :class="[INPUT, 'tnum max-w-40']" inputmode="numeric" placeholder="5432" />
            </template>
          </Field>
          <Field v-if="waitMode === 'sibling'" label="Server to wait for">
            <template #default="{ id: fid }">
              <select :id="fid" v-model="waitSibling" :class="[SELECT, 'max-w-90']">
                <option v-for="o in others" :key="o.id" :value="o.localId">{{ o.name }}</option>
              </select>
            </template>
          </Field>
          <div v-if="others.length" class="flex min-w-0 flex-col gap-1.5">
            <span class="text-[12px] font-medium leading-4 text-text-2">Runs with</span>
            <div role="group" aria-label="Runs with" class="flex flex-wrap gap-1.5">
              <button v-for="o in others" :key="o.id" type="button" :class="chipClass(links.includes(o.localId))" :aria-pressed="links.includes(o.localId)" @click="toggleLink(o.localId)">
                <Check v-if="links.includes(o.localId)" class="size-3.5" />{{ o.name }}
              </button>
            </div>
            <p class="text-[12px] leading-4 text-text-muted">Starting or stopping one starts or stops them all.</p>
          </div>
          <SwitchRow v-model="companion" label="Start with any server of this project" description="Starts whenever another server of this project is started. For a shared database or queue." />
          <SwitchRow v-model="autostart" label="Start automatically" description="Starts when AgentHydra starts, if its project's autostart is on." />
          <div class="flex min-w-0 flex-col gap-1.5">
            <span class="text-[12px] font-medium leading-4 text-text-2">Runtime</span>
            <Segmented v-model="runtime" :options="RUNTIMES" label="Runtime" />
            <p class="text-[12px] leading-4 text-text-muted">How a bun, node or package-script command is run.</p>
          </div>
        </FormSection>

        <FormSection title="Appearance">
          <div class="flex min-w-0 flex-col gap-1.5">
            <span class="text-[12px] font-medium leading-4 text-text-2">Color</span>
            <ColorPicker v-model="color" label="Color" />
            <p class="text-[12px] leading-4 text-text-muted">Its dot in the list.</p>
          </div>
        </FormSection>

        <FormSection title="Environment variables" description="Set for this server only.">
          <p v-if="!env.length" class="text-[13px] text-text-muted">No variables.</p>
          <div v-else class="flex flex-col gap-2">
            <div v-for="(r, i) in env" :key="i" class="flex min-w-0 items-center gap-2">
              <input v-model="r.k" :class="[INPUT_MONO, 'max-w-50']" aria-label="Variable name" placeholder="NAME" />
              <span class="text-text-muted" aria-hidden="true">=</span>
              <input v-model="r.v" :class="INPUT_MONO" aria-label="Value" placeholder="value" />
              <Tip label="Remove">
                <button type="button" :class="ICON_BTN_SM" aria-label="Remove variable" @click="env.splice(i, 1)"><X class="size-3.5" /></button>
              </Tip>
            </div>
          </div>
          <div><button type="button" :class="BTN_GHOST" @click="env.push({ k: '', v: '' })"><Plus class="size-3.5" />Add variable</button></div>
        </FormSection>

        <FormSection title="Automatic answers" description="When it prints the text on the left, AgentHydra types the reply.">
          <div v-if="answers.length" class="flex flex-col gap-2">
            <div v-for="(a, i) in answers" :key="i" class="flex min-w-0 flex-wrap items-center gap-2">
              <input v-model="a.expect" :class="[INPUT, 'min-w-40 flex-1']" aria-label="When it prints" placeholder="Continue? (y/n)" />
              <input v-model="a.send" :class="[INPUT, 'max-w-35']" aria-label="Reply" placeholder="y" />
              <Tip label="Only answer the first time">
                <label :class="[chipClass(a.once), 'focus-within:shadow-(--focus-ring)']">
                  <input v-model="a.once" type="checkbox" class="sr-only" aria-label="Only once" />
                  <Check v-if="a.once" class="size-3.5" />Only once
                </label>
              </Tip>
              <Tip label="Remove">
                <button type="button" :class="ICON_BTN_SM" aria-label="Remove answer" @click="answers.splice(i, 1)"><X class="size-3.5" /></button>
              </Tip>
            </div>
          </div>
          <div><button type="button" :class="BTN_GHOST" @click="answers.push({ expect: '', send: '', once: false })"><Plus class="size-3.5" />Add answer</button></div>
          <Notice v-if="hasCompose" tone="neutral" title="Its docker compose setup is kept as written." />
        </FormSection>

        <FormSection v-if="processId !== null" title="Danger zone" tone="danger">
          <div class="flex min-w-0 flex-wrap items-center gap-3">
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="text-[13px] leading-5 text-text">Delete this server</span>
              <span class="text-[12px] leading-4 text-text-muted">It is stopped if AgentHydra runs it, and removed from the project's .devwebui file.</span>
            </div>
            <div v-if="confirmDelete" class="flex items-center gap-1.5">
              <span class="text-[12px] text-text-2">Delete it from the .devwebui file?</span>
              <button type="button" :class="BTN_DANGER" :disabled="busy" @click="remove">Delete</button>
              <button type="button" :class="BTN_GHOST" :disabled="busy" @click="confirmDelete = false">Keep</button>
            </div>
            <button v-else type="button" :class="BTN_DANGER" :disabled="busy" @click="confirmDelete = true">Delete server</button>
          </div>
        </FormSection>
      </template>
    </div>

    <div class="sticky bottom-0 mt-auto border-t border-border bg-bg-page/95 px-4 py-3 backdrop-blur">
      <div class="mx-auto flex w-full max-w-160 flex-wrap items-center gap-2">
        <p v-if="error" role="alert" class="min-w-0 flex-1 wrap-break-word text-[12px] leading-4 text-danger-text">{{ error }}</p>
        <span v-else class="flex-1" />
        <button type="button" :class="BTN_GHOST" :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button type="submit" :class="BTN_PRIMARY" :disabled="busy || loading">
          <LoaderCircle v-if="saving && busy" class="size-3.5 animate-spin motion-reduce:animate-none" />
          {{ processId === null ? 'Add server' : 'Save changes' }}
        </button>
      </div>
    </div>
  </form>
</template>
