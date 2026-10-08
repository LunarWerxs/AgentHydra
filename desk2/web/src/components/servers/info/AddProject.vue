<script setup lang="ts">
import type { DevWebAddResult, DevWebProposal, DevWebScanPreset, DevWebScanResult, DevWebTrigger } from '@shared/devwebui'
import { FileCode, Folder, FolderOpen, FolderPlus, FolderSearch, GitBranch, HardDrive, LoaderCircle, ScanSearch, Search } from '@lucide/vue'
import { ref } from 'vue'
import { cloneDest, cloneProject, ignoreFolder, ignoredFolders, loadProject, pickFolder, scaffoldProject, scanProjects, unignoreFolder } from '../api'
import { useDevServers } from '../store'
import Card from './kit/Card.vue'
import Field from './kit/Field.vue'
import { BTN, BTN_GHOST, BTN_PRIMARY, CARD, CHIP, chip, INPUT_MONO, MONO } from './kit/kit'
import Notice from './kit/Notice.vue'
import ProposalEditor from './ProposalEditor.vue'
import TakeoverCard from './TakeoverCard.vue'

// "Add a project" (selection kind `add`): three ways in, each its own card (a folder or .devwebui file, a git clone,
// a scan of this PC), so the page reads as choices rather than a form dump. A folder with no .devwebui file opens the
// scaffold editor inside the first card. InfoPane draws the title strip and Back.

const servers = useDevServers()
const ICON_TILE = 'flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-fill-5 text-text-2'

const busy = ref(false)
const error = ref<string | null>(null)
const path = ref('')
const scaffold = ref<{ dir: string; proposal: DevWebProposal } | null>(null)
// A project whose folder also starts its server by itself stays on this page so the take-over can be offered.
const done = ref<{ id: string; name: string; firstLoad: boolean; triggers: DevWebTrigger[] } | null>(null)

const url = ref('')
const dest = ref('')
const destTyped = ref(false)

const scan = ref<DevWebScanResult | null>(null)
const scanning = ref<DevWebScanPreset | null>(null)
const gone = ref(new Set<string>())
const ignored = ref<string[] | null>(null)

const PRESETS: { id: DevWebScanPreset; title: string; line: string; icon: typeof Search }[] = [
  { id: 'quick', title: 'Quick scan', line: 'Your usual project folders', icon: Search },
  { id: 'deep', title: 'Deep scan', line: 'Every drive, slower', icon: HardDrive },
  { id: 'scoped', title: 'This folder', line: 'Only the folder typed above', icon: FolderSearch }
]

// A file:// URL (pasted from Explorer or a browser) becomes the path it names.
function cleanPath(s: string): string {
  const t = s.trim().replace(/^"|"$/g, '')
  if (!/^file:\/\//i.test(t)) return t
  try {
    const u = new URL(t)
    const p = decodeURIComponent(u.pathname)
    // file://server/share/app names a network share; file:///C:/x has no host.
    if (u.hostname) return `//${u.hostname}${p}`
    return /^\/[a-z]:/i.test(p) ? p.slice(1) : p
  } catch {
    return t
  }
}

async function act(fn: () => Promise<void>): Promise<void> {
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

// True when the project was added, false when the scaffold editor opened instead.
async function handle(res: DevWebAddResult): Promise<boolean> {
  if (res.error) throw new Error(res.error)
  if (res.needsScaffold && res.dir && res.proposal) {
    scaffold.value = { dir: res.dir, proposal: res.proposal }
    return false
  }
  if (!res.project) throw new Error('It could not be added.')
  scaffold.value = null
  await servers.refresh()
  const triggers = res.autostartTriggers ?? []
  if (triggers.length) done.value = { id: res.project.id, name: res.project.name, firstLoad: !!res.firstLoad, triggers }
  else servers.select({ kind: 'project', id: res.project.id })
  return true
}

const browsing = ref(false)
async function browse(): Promise<void> {
  browsing.value = true
  try {
    const p = await pickFolder(cleanPath(path.value) || null)
    if (p) path.value = p
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    browsing.value = false
  }
}
const add = () => act(async () => { await handle(await loadProject(cleanPath(path.value))) })
const writeScaffold = () => act(async () => { if (scaffold.value) await handle(await scaffoldProject(scaffold.value.dir, scaffold.value.proposal)) })

async function suggestDest(): Promise<void> {
  if (destTyped.value || !url.value.trim()) return
  try {
    dest.value = (await cloneDest(url.value.trim())).dest
  } catch {
    // A URL that is not valid yet gets no suggestion; Clone reports the reason.
  }
}
const clone = () => act(async () => { await handle(await cloneProject(url.value.trim(), dest.value.trim())) })

const runScan = (preset: DevWebScanPreset) =>
  act(async () => {
    scanning.value = preset
    try {
      const roots = preset === 'scoped' ? [cleanPath(path.value)] : undefined
      scan.value = await scanProjects(preset, roots)
      gone.value = new Set()
      void servers.refresh()
    } finally {
      scanning.value = null
    }
  })
const addFound = (p: string) => act(async () => { if (await handle(await loadProject(p))) gone.value = new Set(gone.value).add(p) })
const ignore = (p: string) =>
  act(async () => {
    ignored.value = (await ignoreFolder(p)).paths
    gone.value = new Set(gone.value).add(p)
  })
const toggleIgnored = () => act(async () => { ignored.value = ignored.value ? null : (await ignoredFolders()).paths })
const unignore = (p: string) => act(async () => { ignored.value = (await unignoreFolder(p)).paths })
const plural = (n: number) => `${n} ${n === 1 ? 'server' : 'servers'}`
</script>

<template>
  <div class="flex flex-col gap-4 p-4">
    <template v-if="done">
      <Notice tone="success" :title="`Added ${done.name}.`">
        <template v-if="done.firstLoad">Nothing was started.</template>
      </Notice>
      <TakeoverCard :project-id="done.id" :triggers="done.triggers" :embedded="true" />
      <div class="flex flex-wrap justify-end gap-2">
        <button type="button" :class="BTN_GHOST" @click="done = null">Add another</button>
        <button type="button" :class="BTN_PRIMARY" @click="servers.select({ kind: 'project', id: done.id })">Show the project</button>
      </div>
    </template>

    <template v-else>
      <!-- 1. A folder or a .devwebui file -->
      <section :class="[CARD, 'flex flex-col gap-3 p-4']">
        <div class="flex items-start gap-3">
          <span :class="ICON_TILE"><FolderPlus class="size-4" aria-hidden="true" /></span>
          <div class="min-w-0">
            <h3 class="text-[13px] font-medium leading-5 text-text">Add a folder</h3>
            <p class="text-[12px] leading-4.5 text-text-muted">A folder with a package.json, or a .devwebui file. A file:// link works too.</p>
          </div>
        </div>
        <Field label="Folder or .devwebui file" v-slot="{ id, describedBy }">
          <div class="flex flex-wrap items-center gap-2">
            <div class="min-w-50 flex-1">
              <input :id="id" v-model="path" :class="INPUT_MONO" :aria-describedby="describedBy" placeholder="C:/Users/me/projects/app" @keydown.enter="path.trim() && add()" />
            </div>
            <button type="button" :class="BTN" aria-label="Browse for a folder" :disabled="browsing" :aria-busy="browsing" @click="browse"><FolderOpen class="size-3.5" aria-hidden="true" />Browse</button>
            <button type="button" :class="BTN_PRIMARY" :disabled="busy || !path.trim()" @click="add">Add</button>
          </div>
        </Field>
        <template v-if="scaffold">
          <div class="flex flex-col gap-3 border-t border-border pt-3">
            <p class="text-[13px] leading-5 text-text-2">This folder has no .devwebui file yet. Review what goes into it.</p>
            <ProposalEditor v-model="scaffold.proposal" />
            <div class="sticky bottom-0 z-10 -mx-4 -mb-4 flex flex-wrap items-center justify-end gap-2 rounded-b-(--radius-10) border-t border-border bg-bg-panel/95 px-4 py-3 backdrop-blur">
              <p v-if="error" role="alert" class="me-auto min-w-0 text-[12px] leading-4 text-danger-text">{{ error }}</p>
              <button type="button" :class="BTN_GHOST" @click="scaffold = null">Cancel</button>
              <button type="button" :class="BTN_PRIMARY" :disabled="busy || !scaffold.proposal.processes.length" @click="writeScaffold">Create .devwebui and add</button>
            </div>
          </div>
        </template>
      </section>

      <!-- 2. A git clone: the destination is suggested from the URL until typed by hand -->
      <section :class="[CARD, 'flex flex-col gap-3 p-4']">
        <div class="flex items-start gap-3">
          <span :class="ICON_TILE"><GitBranch class="size-4" aria-hidden="true" /></span>
          <div class="min-w-0">
            <h3 class="text-[13px] font-medium leading-5 text-text">Clone a repository</h3>
            <p class="text-[12px] leading-4.5 text-text-muted">Clones it into a folder, then adds it.</p>
          </div>
        </div>
        <Field label="Repository URL" v-slot="{ id }">
          <input :id="id" v-model="url" :class="INPUT_MONO" placeholder="https://example.com/team/app.git" @blur="suggestDest" />
        </Field>
        <Field label="Destination folder" help="Suggested from the URL until you type your own." v-slot="{ id, describedBy }">
          <div class="flex flex-wrap items-center gap-2">
            <div class="min-w-50 flex-1">
              <input :id="id" v-model="dest" :class="INPUT_MONO" :aria-describedby="describedBy" placeholder="C:/Users/me/projects/app" @input="destTyped = true" />
            </div>
            <button type="button" :class="BTN_PRIMARY" :disabled="busy || !url.trim() || !dest.trim()" @click="clone">Clone</button>
          </div>
        </Field>
      </section>

      <!-- 3. A scan -->
      <section :class="[CARD, 'flex flex-col gap-3 p-4']">
        <div class="flex items-start gap-3">
          <span :class="ICON_TILE"><ScanSearch class="size-4" aria-hidden="true" /></span>
          <div class="min-w-0 flex-1">
            <h3 class="text-[13px] font-medium leading-5 text-text">Find projects on this PC</h3>
            <p class="text-[12px] leading-4.5 text-text-muted">Looks for .devwebui files and project folders not added yet.</p>
          </div>
          <button type="button" :class="BTN_GHOST" :disabled="busy" @click="toggleIgnored">{{ ignored ? 'Hide ignored' : 'Show ignored' }}</button>
        </div>
        <div class="grid grid-cols-1 gap-2 @md:grid-cols-3">
          <button
            v-for="p in PRESETS"
            :key="p.id"
            type="button"
            :disabled="busy || (p.id === 'scoped' && !path.trim())"
            class="flex min-h-14 cursor-default items-start gap-2.5 rounded-(--radius-6) bg-fill-5 p-3 text-start shadow-[inset_0_0_0_1px_var(--border)] transition-colors duration-60 hover:bg-fill-hover focus-visible:shadow-(--focus-ring) focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45"
            @click="runScan(p.id)"
          >
            <LoaderCircle v-if="scanning === p.id" class="mt-0.5 size-3.5 shrink-0 animate-spin text-accent-text motion-reduce:animate-none" aria-hidden="true" />
            <component :is="p.icon" v-else class="mt-0.5 size-3.5 shrink-0 text-text-2" aria-hidden="true" />
            <span class="flex min-w-0 flex-col">
              <span class="text-[13px] font-medium leading-5 text-text">{{ scanning === p.id ? 'Scanning…' : p.title }}</span>
              <span class="text-[12px] leading-4 text-text-muted">{{ p.line }}</span>
            </span>
          </button>
        </div>

        <template v-if="scan">
          <p class="text-[12px] leading-4 text-text-muted">
            Looked in {{ scan.scannedDirs }} folders in {{ (scan.ms / 1000).toFixed(1) }} s.
            <template v-if="scan.truncated"> Stopped at the result limit.</template>
            <template v-if="scan.timedOut"> Stopped at the time limit.</template>
          </p>
          <p v-if="!scan.files.length && !scan.detected.length" class="text-[13px] leading-5 text-text-2">Nothing new was found.</p>
          <Card v-else flush>
            <ul class="divide-y divide-border">
              <li v-for="f in scan.files.filter((x) => !gone.has(x.path))" :key="f.path" class="flex min-h-12 items-center gap-3 px-4 py-2.5">
                <FileCode class="size-4 shrink-0 text-text-2" aria-hidden="true" />
                <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span class="truncate text-[13px] text-text">{{ f.name }}</span>
                    <span class="text-[12px] text-text-muted">{{ plural(f.processes) }}</span>
                    <span v-if="!f.valid" :class="chip('danger')">Does not parse</span>
                  </div>
                  <div :class="[MONO, 'truncate text-text-muted']" :title="f.path">{{ f.path }}</div>
                </div>
                <button type="button" :class="BTN" :disabled="busy || !f.valid" @click="addFound(f.path)">Add</button>
                <button type="button" :class="BTN_GHOST" :disabled="busy" @click="ignore(f.path)">Ignore</button>
              </li>
              <li v-for="d in scan.detected.filter((x) => !gone.has(x.path))" :key="d.path" class="flex min-h-12 items-center gap-3 px-4 py-2.5">
                <Folder class="size-4 shrink-0 text-text-2" aria-hidden="true" />
                <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span class="truncate text-[13px] text-text">{{ d.name }}</span>
                    <span class="text-[12px] text-text-muted">{{ plural(d.processes) }}</span>
                    <span :class="CHIP">No .devwebui</span>
                    <span v-if="d.framework" :class="CHIP">{{ d.framework }}</span>
                  </div>
                  <div :class="[MONO, 'truncate text-text-muted']" :title="d.path">{{ d.path }}</div>
                </div>
                <!-- The path is copied into the folder field so its scaffold step reads as that folder's. -->
                <button type="button" :class="BTN" :disabled="busy" @click="path = d.path; addFound(d.path)">Add</button>
                <button type="button" :class="BTN_GHOST" :disabled="busy" @click="ignore(d.path)">Ignore</button>
              </li>
            </ul>
          </Card>
        </template>

        <Card v-if="ignored" title="Ignored folders" flush>
          <p v-if="!ignored.length" class="px-4 pb-4 text-[12px] text-text-muted">No folders are ignored.</p>
          <ul v-else class="divide-y divide-border border-t border-border">
            <li v-for="p in ignored" :key="p" class="flex min-h-10 items-center gap-3 px-4 py-1.5">
              <span :class="[MONO, 'min-w-0 flex-1 truncate text-text-2']" :title="p">{{ p }}</span>
              <button type="button" :class="BTN_GHOST" :disabled="busy" @click="unignore(p)">Unignore</button>
            </li>
          </ul>
        </Card>
      </section>

      <Notice v-if="error && !scaffold" tone="danger" title="That did not work">{{ error }}</Notice>
    </template>
  </div>
</template>
