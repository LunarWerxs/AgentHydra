<script setup lang="ts">
import type { DevWebAddResult, DevWebProposal, DevWebScanPreset, DevWebScanResult, DevWebTrigger } from '@shared/devwebui'
import { FileCode, Folder, FolderOpen } from '@lucide/vue'
import { ref } from 'vue'
import { Tip } from '@/components/ui/tooltip'
import { cloneDest, cloneProject, ignoreFolder, ignoredFolders, loadProject, pickFolder, scaffoldProject, scanProjects, unignoreFolder } from '../api'
import { useDevServers } from '../store'
import { ICON_BTN, INPUT, TEXT_BTN } from '../styles'
import ProposalEditor from './ProposalEditor.vue'
import TakeoverCard from './TakeoverCard.vue'

const servers = useDevServers()
const H3 = 'text-[12px] font-medium text-[var(--text)]'

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

/** A file:// URL (pasted from Explorer or a browser) becomes the path it names. */
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

/** True when the project was added, false when the scaffold editor opened instead. */
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

async function browse(): Promise<void> {
  try {
    const p = await pickFolder(cleanPath(path.value) || null)
    if (p) path.value = p
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
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
</script>

<template>
  <div class="flex flex-col gap-4 p-3 text-[12px]">
    <section v-if="done" class="flex flex-col gap-2">
      <p class="text-[var(--success-text)]">Added {{ done.name }}.{{ done.firstLoad ? ' Nothing was started.' : '' }}</p>
      <TakeoverCard :project-id="done.id" :triggers="done.triggers" />
      <div class="flex gap-2">
        <button type="button" :class="TEXT_BTN" @click="servers.select({ kind: 'project', id: done.id })">Show the project</button>
        <button type="button" :class="TEXT_BTN" @click="done = null">Add another</button>
      </div>
    </section>

    <template v-else>
      <section class="flex flex-col gap-2">
        <h3 :class="H3">Add a folder or .devwebui file</h3>
        <div class="flex items-center gap-1">
          <input v-model="path" :class="[INPUT, 'font-mono']" aria-label="Folder or .devwebui file" placeholder="C:/Users/me/projects/app" @keydown.enter="path.trim() && add()" />
          <Tip label="Browse">
            <button type="button" :class="ICON_BTN" aria-label="Browse for a folder" @click="browse"><FolderOpen class="size-3.5" /></button>
          </Tip>
          <button type="button" :class="TEXT_BTN" :disabled="busy || !path.trim()" @click="add">Add</button>
        </div>
        <template v-if="scaffold">
          <p class="text-[var(--text-2)]">This folder has no .devwebui file. Review what goes into it, then write it.</p>
          <ProposalEditor v-model="scaffold.proposal" />
          <div class="flex gap-2">
            <button type="button" :class="TEXT_BTN" :disabled="busy || !scaffold.proposal.processes.length" @click="writeScaffold">Create .devwebui and add</button>
            <button type="button" :class="TEXT_BTN" @click="scaffold = null">Cancel</button>
          </div>
        </template>
      </section>

      <section class="flex flex-col gap-2">
        <h3 :class="H3">Clone a git repository</h3>
        <input v-model="url" :class="[INPUT, 'flex-none font-mono']" aria-label="Repository URL" placeholder="https://example.com/team/app.git" @blur="suggestDest" />
        <div class="flex items-center gap-1">
          <input v-model="dest" :class="[INPUT, 'font-mono']" aria-label="Destination folder" placeholder="Destination folder" @input="destTyped = true" />
          <button type="button" :class="TEXT_BTN" :disabled="busy || !url.trim() || !dest.trim()" @click="clone">Clone</button>
        </div>
      </section>

      <section class="flex flex-col gap-2">
        <h3 :class="H3">Scan</h3>
        <div class="flex flex-wrap items-center gap-1">
          <button type="button" :class="TEXT_BTN" :disabled="busy" @click="runScan('quick')">{{ scanning === 'quick' ? 'Scanning...' : 'Quick scan' }}</button>
          <button type="button" :class="TEXT_BTN" :disabled="busy" @click="runScan('deep')">{{ scanning === 'deep' ? 'Scanning...' : 'Deep scan' }}</button>
          <Tip label="Scan only the folder typed above">
            <button type="button" :class="TEXT_BTN" :disabled="busy || !path.trim()" @click="runScan('scoped')">{{ scanning === 'scoped' ? 'Scanning...' : 'This folder' }}</button>
          </Tip>
          <button type="button" :class="TEXT_BTN" :disabled="busy" @click="toggleIgnored">{{ ignored ? 'Hide ignored' : 'Show ignored' }}</button>
        </div>
        <template v-if="scan">
          <p class="text-[var(--text-muted)]">
            Looked in {{ scan.scannedDirs }} folders in {{ (scan.ms / 1000).toFixed(1) }} s.
            <template v-if="scan.truncated"> Stopped at the result limit.</template>
            <template v-if="scan.timedOut"> Stopped at the time limit.</template>
          </p>
          <p v-if="!scan.files.length && !scan.detected.length" class="text-[var(--text-2)]">Nothing new was found.</p>
          <ul class="flex flex-col gap-1">
            <li v-for="f in scan.files.filter((x) => !gone.has(x.path))" :key="f.path" class="flex items-center gap-2">
              <FileCode class="size-3.5 shrink-0 text-[var(--text-2)]" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <div class="flex items-baseline gap-2">
                  <span class="truncate text-[var(--text)]">{{ f.name }}</span>
                  <span class="shrink-0 text-[var(--text-muted)]">{{ f.processes }} {{ f.processes === 1 ? 'server' : 'servers' }}</span>
                  <span v-if="!f.valid" class="shrink-0 text-[var(--danger-text)]">Does not parse</span>
                </div>
                <div class="truncate font-mono text-[11px] text-[var(--text-muted)]" :title="f.path">{{ f.path }}</div>
              </div>
              <button type="button" :class="TEXT_BTN" :disabled="busy || !f.valid" @click="addFound(f.path)">Add</button>
              <button type="button" :class="TEXT_BTN" :disabled="busy" @click="ignore(f.path)">Ignore</button>
            </li>
            <li v-for="d in scan.detected.filter((x) => !gone.has(x.path))" :key="d.path" class="flex items-center gap-2">
              <Folder class="size-3.5 shrink-0 text-[var(--text-2)]" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <div class="flex items-baseline gap-2">
                  <span class="truncate text-[var(--text)]">{{ d.name }}</span>
                  <span class="shrink-0 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-1 text-[11px] text-[var(--text-2)]">No .devwebui</span>
                  <span v-if="d.framework" class="shrink-0 text-[var(--text-muted)]">{{ d.framework }}</span>
                  <span class="shrink-0 text-[var(--text-muted)]">{{ d.processes }} {{ d.processes === 1 ? 'server' : 'servers' }}</span>
                </div>
                <div class="truncate font-mono text-[11px] text-[var(--text-muted)]" :title="d.path">{{ d.path }}</div>
              </div>
              <button type="button" :class="TEXT_BTN" :disabled="busy" @click="path = d.path; addFound(d.path)">Add</button>
              <button type="button" :class="TEXT_BTN" :disabled="busy" @click="ignore(d.path)">Ignore</button>
            </li>
          </ul>
        </template>
        <div v-if="ignored" class="flex flex-col gap-1">
          <p v-if="!ignored.length" class="text-[var(--text-muted)]">No folders are ignored.</p>
          <div v-for="p in ignored" :key="p" class="flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-2)]" :title="p">{{ p }}</span>
            <button type="button" :class="TEXT_BTN" :disabled="busy" @click="unignore(p)">Unignore</button>
          </div>
        </div>
      </section>

      <p v-if="error" class="text-[var(--danger-text)]">{{ error }}</p>
    </template>
  </div>
</template>
