<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check } from '@lucide/vue'
import type { DeskSettings, Effort, ModelChoice, PermissionMode } from '@shared/protocol'
import type { BabysitterStatus } from '@shared/babysitter'
import { isOrchestratorModel, ORCHESTRATOR_MODEL_ALIASES, type OrchestratorModelStatus } from '@shared/orchestrator'
import { useShellSource } from '@/components/shell/source'
import PaneSwitch from './PaneSwitch.vue'
import DiagnosticsView from '@/components/diagnostics/DiagnosticsView.vue'
import ConnectorsSettings from '@/components/connectors/ConnectorsSettings.vue'
import { EFFORTS, PERMISSION_MODES } from '@/components/composer/logic'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { settingsIcons } from '@/lib/icons'
import { usePaneApi } from './api'
import { BUTTON, SELECT_CONTENT as CONTENT, SELECT_ITEM, SELECT_TRIGGER as TRIGGER } from './settings-styles'
import { SETTINGS_SECTIONS, settingsGroups, stepSection, switchPatch, type SettingsCondition, type SettingsSection } from './settings'
import { requestedSection } from './settings-request'
import { rememberScreen } from '@/lib/view-memory'
import { ahUpdateDot, seeAhUpdateDot } from '@/components/hydra/api'
import { useAgentHydraSettings } from './agenthydra'
import AgentHydraControl from './AgentHydraControl.vue'
import { useInstanceSettings } from './instances'
import InstancesControl from './InstancesControl.vue'
import { useDevServerSettings } from './devservers'
import DevServersControl from './DevServersControl.vue'

// The body of the Settings dialog, laid out like the real Settings (docs/reference/real/user/
// real-settings-claude-code.webp) without its account, billing and connector pages: a darker nav with
// Search and captioned section rows on the left; on the right bold group headings over rows of a label,
// a wrapping muted description and the control, split by hairlines. Below 640px the nav is a pill row.
// The `ah` rows are AgentHydra's own settings (agenthydra.ts, AgentHydraControl.vue); the Instances pages'
// process columns and Claude native control are instances.ts (InstancesControl.vue).
const api = usePaneApi()
const src = useShellSource()
const ah = useAgentHydraSettings(api)
const inst = useInstanceSettings(api, ah)
const dw = useDevServerSettings()

const section = ref<SettingsSection>('general')
// A reload with Settings open comes back to this page (DeskFrame asks for it, lib/view-memory.ts).
watch(section, (id) => rememberScreen({ section: id }))
const query = ref('')
const searching = computed(() => query.value.trim() !== '')
const holds = (c: SettingsCondition) =>
  c === 'native' ? !!inst.nativeConfig.value : c === 'freeKeepalive' ? !!inst.free.value?.keepWindows : ah.holds(c)
const groups = computed(() => settingsGroups(section.value, query.value, holds))
const isAh = (id: string) => id.startsWith('ah')
const isDw = (id: string) => id.startsWith('dw')
// Every Desk row but About's needs the saved settings.
const needsSettings = computed(() => groups.value.some((g) => g.rows.some((r) => r.section !== 'about' && !isAh(r.id) && !isDw(r.id))))

// reka-ui's Select cannot hold null or '', so "no override" is this sentinel in the menus.
const NONE = '__default'

const SEGMENTS = 'flex h-7 shrink-0 items-center gap-px rounded-[var(--radius-7)] bg-fill-5 p-px'
const SEGMENT =
  'flex h-[26px] cursor-default items-center rounded-[var(--radius-5)] px-2.5 text-[13px] leading-[19px] text-text-2 transition-colors duration-[60ms] hover:text-text focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none aria-checked:bg-[var(--fill-secondary)] aria-checked:text-text'

const local = ref<DeskSettings | null>(null)
const models = ref<ModelChoice[]>([])
const version = ref<string | null>(null)
const home = ref<string | null>(null)
const bridge = ref<{ up: boolean; url: string } | null>(null)
const babysitter = ref<BabysitterStatus | null>(null)
const orchestratorModel = ref<OrchestratorModelStatus | null>(null)
/** The custom model id being typed (the Custom choice of the orchestrator model's select). */
const customModelOpen = ref(false)
const customModelDraft = ref('')
const loadError = ref<string | null>(null)
const saveError = ref<string | null>(null)
const showSaved = ref(false)
const notifyNote = ref<string | null>(null)
const idleDraft = ref('')

const modes = PERMISSION_MODES.filter((m): m is (typeof m & { value: PermissionMode }) => m.value !== null)
const efforts: { value: Effort | null; label: string }[] = [{ value: null, label: 'Default' }, ...EFFORTS]
const activeWorkers = computed(() => src.workers.value.filter((w) => w.active).length)

// Settings changed elsewhere (another window, the account popup, the server) arrive through the source.
watch(
  () => src.settings.value,
  (s) => {
    if (s) setLocal(s)
  },
  { immediate: true }
)

watch(
  () => groups.value.some((g) => g.rows.some((r) => isDw(r.id))),
  (on) => {
    if (on && !dw.settings.value) void dw.load()
  },
  { immediate: true }
)
watch(dw.savedAt, flashSaved)

function setLocal(s: DeskSettings) {
  local.value = { ...s }
  idleDraft.value = String(s.idleCloseMinutes)
}

let savedTimer: ReturnType<typeof setTimeout> | null = null
function flashSaved() {
  showSaved.value = true
  if (savedTimer) clearTimeout(savedTimer)
  savedTimer = setTimeout(() => (showSaved.value = false), 1600)
}
watch(ah.savedAt, flashSaved)
async function save(patch: Partial<DeskSettings>) {
  if (!local.value) return
  const before = local.value as Record<string, unknown>
  const keys = Object.keys(patch) as (keyof DeskSettings)[]
  const prev: Record<string, unknown> = {}
  for (const k of keys) prev[k] = before[k]
  local.value = { ...local.value, ...patch }
  saveError.value = null
  try {
    setLocal(await api.putSettings(patch))
    flashSaved()
  } catch (e) {
    // Only this save's keys, and only where they still hold its value: a later save or another window's change stays.
    if (local.value) {
      const cur = local.value as Record<string, unknown>
      const next: Record<string, unknown> = { ...cur }
      for (const k of keys) if (cur[k] === patch[k]) next[k] = prev[k]
      local.value = next as unknown as DeskSettings
      if (keys.includes('idleCloseMinutes')) idleDraft.value = String(local.value.idleCloseMinutes)
    }
    saveError.value = e instanceof Error ? e.message : String(e)
  }
}

let idleTimer: ReturnType<typeof setTimeout> | null = null
function onIdleInput() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(commitIdle, 600)
}
function commitIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  const n = Math.round(Number(idleDraft.value))
  if (!Number.isFinite(n) || n < 1) {
    idleDraft.value = String(local.value?.idleCloseMinutes ?? 30)
    return
  }
  const v = Math.min(n, 1440)
  idleDraft.value = String(v)
  if (v !== local.value?.idleCloseMinutes) save({ idleCloseMinutes: v })
}

const modelValue = computed(() => local.value?.defaultModel ?? NONE)

async function testNotification() {
  notifyNote.value = null
  if (!('Notification' in window)) {
    notifyNote.value = 'This window has no notifications.'
    return
  }
  let perm = Notification.permission
  if (perm === 'default') perm = await Notification.requestPermission()
  if (perm !== 'granted') {
    notifyNote.value = 'Notifications are blocked for this window.'
    return
  }
  new Notification('AgentHydra', { body: 'Notifications work. You will see one when a chat finishes or needs you.' })
  notifyNote.value = 'Sent.'
}

async function loadBabysitter() {
  try {
    babysitter.value = await api.babysitter()
  } catch {
    babysitter.value = null
  }
}

async function loadOrchestratorModel() {
  try {
    orchestratorModel.value = await api.orchestratorModel()
  } catch {
    orchestratorModel.value = null
  }
}

const isAliasModel = (m: string | undefined) => (ORCHESTRATOR_MODEL_ALIASES as readonly string[]).includes(m ?? '')
/** The select's choice: an alias, or Custom when the setting is a full id or the owner picked Custom. */
const orchestratorModelChoice = computed(() => {
  const m = local.value?.orchestratorModel
  return customModelOpen.value || !isAliasModel(m) ? 'custom' : m!
})
/** Under the model's row: what the setting runs now (the model the SDK reported, once a judgment ran), or the alias. */
const orchestratorModelNote = computed(() => {
  const m = local.value?.orchestratorModel
  if (customModelOpen.value && !isOrchestratorModel(customModelDraft.value.trim())) return 'Type a full model id, such as claude-opus-5-5.'
  if (!m) return null
  const s = orchestratorModel.value
  if (s?.resolved && s.setting === m) return `Runs ${s.resolved}`
  return isAliasModel(m) ? `Alias ${m}: the model it resolves to shows after the first judgment.` : `Runs ${m}`
})
function pickOrchestratorModel(v: string) {
  if (v !== 'custom') {
    customModelOpen.value = false
    void save({ orchestratorModel: v })
    return
  }
  const current = local.value?.orchestratorModel ?? ''
  customModelOpen.value = true
  customModelDraft.value = isAliasModel(current) ? '' : current
}
function commitOrchestratorModel() {
  const id = customModelDraft.value.trim()
  if (!isOrchestratorModel(id) || id === local.value?.orchestratorModel) return
  void save({ orchestratorModel: id }).then(loadOrchestratorModel)
}

// A full model id in the setting shows in the custom box, ready to edit.
watch(() => local.value?.orchestratorModel, (m) => {
  if (m && !isAliasModel(m)) customModelDraft.value = m
}, { immediate: true })

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
/** Under the Babysitter row: what a usage limit has stopped now, by account, and what it last continued. */
const babysitterNote = computed(() => {
  const s = babysitter.value
  if (!s) return null
  const stopped = s.accounts.length
    ? `Stopped by a limit: ${s.accounts.map((a) => `${a.account} ${a.stopped} (${a.resetsAt === null ? 'reset unknown' : `resets ${clock(a.resetsAt)}`})`).join(', ')}.`
    : 'Nothing is stopped by a limit.'
  const last = s.acts.find((a) => a.did === 'resumed')
  return [stopped, last ? `Last continued ${last.title} at ${clock(last.at)}.` : null, s.error].filter(Boolean).join(' ')
})

async function loadBridge() {
  try {
    bridge.value = await api.bridgeStatus()
  } catch {
    bridge.value = { up: false, url: bridge.value?.url ?? '' }
  }
}

// Segmented control: arrows move the choice, as in a radio group.
function onSegmentKey(e: KeyboardEvent, current: number, count: number, pick: (i: number) => void) {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
  if (!step) return
  e.preventDefault()
  const next = (current + step + count) % count
  pick(next)
  const group = (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]')
  group[next]?.focus()
}
const effortIndex = computed(() => Math.max(0, efforts.findIndex((x) => x.value === (local.value?.defaultEffort ?? null))))

// Nav: one tab stop on the current row, arrows move between rows (and choose them).
const navEl = ref<HTMLElement | null>(null)
const contentEl = ref<HTMLElement | null>(null)
function pick(id: SettingsSection) {
  section.value = id
  query.value = ''
}
// A newer AgentHydra is waiting (the footer gear's dot, hydra/api.ts): Settings opens on Updates, and
// seeing Updates clears the dot. A section another part of Desk asked for comes first.
if (ahUpdateDot.value) pick('updates')
watch(section, (id) => id === 'updates' && seeAhUpdateDot(), { immediate: true })
// Another part of Desk asked for a section (settings-request.ts); a page kept from before a reload may be one
// Settings no longer has.
watch(
  requestedSection,
  (id) => {
    if (!id) return
    if (SETTINGS_SECTIONS.some((s) => s.id === id)) pick(id)
    requestedSection.value = null
  },
  { immediate: true }
)
function focusSection(id: SettingsSection) {
  void nextTick(() => navEl.value?.querySelector<HTMLElement>(`[data-section="${id}"]`)?.focus())
}
function onNavKey(e: KeyboardEvent) {
  const next = stepSection(section.value, e.key)
  if (!next) return
  e.preventDefault()
  pick(next)
  focusSection(next)
}
watch([section, searching], () => contentEl.value?.scrollTo?.({ top: 0 }))

// The bridge status is polled only while its row is on screen (its section, or a search that lists it) and the window is visible.
const showsBridge = computed(() => groups.value.some((g) => g.rows.some((r) => r.id === 'bridge')))
let bridgeTimer: ReturnType<typeof setInterval> | null = null
function stopBridgePoll() {
  if (bridgeTimer) clearInterval(bridgeTimer)
  bridgeTimer = null
}
function syncBridgePoll() {
  stopBridgePoll()
  if (showsBridge.value && !document.hidden) bridgeTimer = setInterval(loadBridge, 10_000)
}
watch(showsBridge, (on) => {
  syncBridgePoll()
  if (on) void loadBridge()
})
function onVisibility() {
  syncBridgePoll()
  if (showsBridge.value && !document.hidden) void loadBridge()
}
document.addEventListener('visibilitychange', onVisibility)

// The babysitter's status is read when its row comes on screen and when the window is shown again.
const showsBabysitter = computed(() => groups.value.some((g) => g.rows.some((r) => r.id === 'babysitter')))
watch(showsBabysitter, (on) => {
  if (on) void loadBabysitter()
}, { immediate: true })
document.addEventListener('visibilitychange', onBabysitterVisibility)
function onBabysitterVisibility() {
  if (showsBabysitter.value && !document.hidden) void loadBabysitter()
}

// The orchestrator model's resolved id is read when its row comes on screen.
const showsOrchestratorModel = computed(() => groups.value.some((g) => g.rows.some((r) => r.id === 'orchestratorModel')))
watch(showsOrchestratorModel, (on) => {
  if (on) void loadOrchestratorModel()
}, { immediate: true })

// AgentHydra's update check asks its Git remote, so it runs when its row is first on screen.
const showsUpdate = computed(() => groups.value.some((g) => g.rows.some((r) => r.id === 'ahVersion')))
watch(
  showsUpdate,
  (on) => {
    if (on && !ah.update.value && !ah.checking.value) void ah.checkUpdate()
  },
  { immediate: true }
)
// Claude native control reads its accounts and settings when its rows are first on screen.
const showsNative = computed(() => groups.value.some((g) => g.rows.some((r) => r.id === 'ahNativeAuto')))
watch(
  showsNative,
  (on) => {
    if (on) void inst.loadNative()
  },
  { immediate: true }
)
// The CLI login setting reads its state when its row is first on screen.
const showsPairing = computed(() => groups.value.some((g) => g.rows.some((r) => r.id === 'ahDesktopCliPair')))
watch(
  showsPairing,
  (on) => {
    if (on) void inst.loadPairing()
  },
  { immediate: true }
)
// The Free keepalive reads Desk's own settings when its rows are first on screen.
const showsFree = computed(() => groups.value.some((g) => g.rows.some((r) => r.id === 'ahFreeKeepalive')))
watch(
  showsFree,
  (on) => {
    if (on) void inst.loadFree()
  },
  { immediate: true }
)
// The Connections sign-in is a window of its own: coming back here reads the sync state again.
function onFocus() {
  if (!ah.sync.value?.connected) void ah.loadSync()
}
window.addEventListener('focus', onFocus)
onMounted(async () => {
  syncBridgePoll()
  void ah.load()
  void ah.loadSync()
  void ah.loadAutoUpdate()
  const tasks: Promise<unknown>[] = [
    api.models().then((m) => (models.value = m)).catch(() => {}),
    api
      .health()
      .then((h) => {
        version.value = h.version
        const reported = (h as Record<string, unknown>).home
        home.value = typeof reported === 'string' ? reported : null
      })
      .catch(() => {}),
    loadBridge()
  ]
  if (!local.value) {
    tasks.push(
      api
        .getSettings()
        .then((s) => {
          if (!local.value) setLocal(s)
        })
        .catch((e) => (loadError.value = e instanceof Error ? e.message : String(e)))
    )
  }
  await Promise.all(tasks)
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  document.removeEventListener('visibilitychange', onBabysitterVisibility)
  window.removeEventListener('focus', onFocus)
  stopBridgePoll()
  if (savedTimer) clearTimeout(savedTimer)
  if (idleTimer) clearTimeout(idleTimer)
})
</script>

<template>
  <div class="flex size-full min-h-0 flex-col bg-bg-popover text-text sm:flex-row">
    <nav
      aria-label="Settings sections"
      class="flex shrink-0 flex-col gap-2 border-b border-border bg-bg-panel p-3 pe-12 sm:w-40 sm:pe-3 sm:border-b-0 sm:border-e lg:w-46.25"
    >
      <label
        class="flex h-8 shrink-0 items-center gap-2 rounded-(--radius-6) bg-fill-5 px-2 shadow-[inset_0_0_0_1px_var(--border)] focus-within:shadow-(--focus-ring)"
      >
        <component :is="settingsIcons.search" class="size-4 shrink-0 text-text-muted" />
        <input
          v-model="query"
          type="search"
          placeholder="Search"
          aria-label="Search settings"
          class="min-w-0 flex-1 bg-transparent text-[13px] leading-4.75 text-text outline-none placeholder:text-text-muted [&::-webkit-search-cancel-button]:appearance-none"
          @keydown.down.prevent="focusSection(section)"
        />
      </label>

      <div ref="navEl" class="flex gap-1 overflow-x-auto sm:flex-col sm:gap-px sm:overflow-visible" @keydown="onNavKey">
        <template v-for="(s, i) in SETTINGS_SECTIONS" :key="s.id">
          <div
            v-if="s.caption !== SETTINGS_SECTIONS[i - 1]?.caption"
            class="hidden px-2 pb-1.5 text-[12px] leading-4 text-text-muted sm:block"
            :class="i ? 'pt-4' : 'pt-2'"
          >
            {{ s.caption }}
          </div>
          <button
            type="button"
            :data-section="s.id"
            :aria-current="!searching && section === s.id ? 'page' : undefined"
            :tabindex="section === s.id ? 0 : -1"
            class="flex h-8 shrink-0 cursor-default items-center gap-2 rounded-full px-3 text-start text-[13px] leading-4.75 transition-colors duration-(--dur-fast) focus-visible:shadow-(--focus-ring) focus-visible:outline-none sm:rounded-(--radius-6) sm:px-2"
            :class="!searching && section === s.id ? 'bg-fill-selected text-text' : 'text-text-2 hover:bg-fill-hover hover:text-text'"
            @click="pick(s.id)"
          >
            <component :is="settingsIcons[s.id]" class="size-4 shrink-0" />
            {{ s.label }}
          </button>
        </template>
      </div>
    </nav>

    <section ref="contentEl" class="relative min-h-0 min-w-0 flex-1 overflow-y-auto px-6 pb-6 pt-12" aria-label="Settings">
      <div class="absolute left-6 top-4 flex h-5 items-center gap-3 text-[12px] leading-4" aria-live="polite">
        <span class="flex items-center gap-1 text-text-muted transition-opacity duration-300" :class="showSaved ? 'opacity-100' : 'opacity-0'">
          <Check class="size-3.5 text-success-text" /> Saved
        </span>
        <span v-if="saveError || ah.error.value || dw.error.value" class="text-danger-text">Not saved: {{ saveError || ah.error.value || dw.error.value }}</span>
      </div>

      <div v-if="!local && needsSettings" class="text-[13px] leading-4.75" :class="loadError ? 'text-danger-text' : 'text-text-muted'">
        {{ loadError ? `Could not load settings: ${loadError}` : 'Loading…' }}
      </div>

      <p v-else-if="searching && !groups.length" class="text-[13px] leading-4.75 text-text-muted">No settings match</p>

      <DiagnosticsView v-else-if="section === 'diagnostics' && !searching" />

      <ConnectorsSettings v-else-if="section === 'connectors' && !searching" />

      <template v-else>
        <div v-for="(g, gi) in groups" :key="g.heading" role="group" :aria-label="g.heading" :class="gi ? 'mt-8' : ''">
          <h3 class="text-[13px] font-semibold leading-5 text-text">{{ g.heading }}</h3>
          <div>
            <div v-for="r in g.rows" :key="r.id" class="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border py-3.5 last:border-b-0">
              <div class="min-w-50 flex-1">
                <div class="text-[13px] leading-5 text-text">{{ r.label }}</div>
                <div class="mt-0.5 text-[13px] leading-4.75 text-text-muted">
                  {{ r.id === 'notifications' && notifyNote ? notifyNote : r.description }}
                </div>
                <div v-if="r.id === 'bridge'" class="truncate font-mono text-[12px] leading-4.75 text-text-muted">{{ bridge?.url || 'No address yet' }}</div>
                <div v-if="r.id === 'babysitter' && babysitterNote" class="mt-0.5 wrap-break-word text-[12px] leading-4.5 text-text-muted">{{ babysitterNote }}</div>
                <div v-if="r.id === 'orchestratorModel' && orchestratorModelNote" class="mt-0.5 wrap-break-word text-[12px] leading-4.5 text-text-muted">{{ orchestratorModelNote }}</div>
                <div v-for="n in ah.rowNotes(r.id)" :key="n" class="mt-0.5 break-all text-[12px] leading-4.5 text-text-muted">{{ n }}</div>
                <div v-for="n in inst.rowNotes(r.id)" :key="n" class="mt-0.5 wrap-break-word text-[12px] leading-4.5 text-text-muted">{{ n }}</div>
                <div v-if="r.id === 'ahDesktopCliPair' && inst.pairingConfirm.value" class="mt-1.5">
                  <div class="text-[13px] leading-4.75 text-text">{{ inst.pairingQuestion.value }}</div>
                  <div v-for="c in inst.pairing.value?.candidates ?? []" :key="c.desktopDir" class="text-[12px] leading-4.5 text-text-muted">{{ inst.candidateLine(c) }}</div>
                  <div class="mt-1.5 flex gap-2">
                    <button type="button" :class="BUTTON" @click="inst.savePairing(true)">Yes, add them</button>
                    <button type="button" :class="BUTTON" @click="inst.cancelPairing()">Cancel</button>
                  </div>
                </div>
              </div>

              <InstancesControl v-if="inst.owns(r.id)" :id="r.id" :label="r.label" :inst="inst" />
              <AgentHydraControl v-else-if="isAh(r.id)" :id="r.id" :label="r.label" :ah="ah" />
              <DevServersControl v-else-if="isDw(r.id)" :id="r.id" :label="r.label" :ctx="dw" />
              <span v-else-if="r.id === 'version'" class="font-mono text-[13px] leading-4.75 text-text-2">{{ version ? `v${version}` : '…' }}</span>
              <span v-else-if="r.id === 'home'" class="max-w-[60%] truncate font-mono text-[12px] leading-4.75 text-text-2">
                {{ home ?? '~/.hydra-desk-2 (or HYDRA_DESK_HOME)' }}
              </span>

              <template v-else-if="local">
                <Select v-if="r.id === 'model'" :model-value="modelValue" @update:model-value="(v) => save({ defaultModel: v === NONE ? null : String(v) })">
                  <SelectTrigger :class="TRIGGER" aria-label="Default model"><SelectValue /></SelectTrigger>
                  <SelectContent :class="CONTENT" position="popper" align="end" :side-offset="4">
                    <SelectItem :class="SELECT_ITEM" :value="NONE">Account default</SelectItem>
                    <SelectItem v-for="m in models" :key="m.value" :class="SELECT_ITEM" :value="m.value">{{ m.label }}</SelectItem>
                    <SelectItem
                      v-if="local.defaultModel && !models.some((m) => m.value === local!.defaultModel)"
                      :class="SELECT_ITEM"
                      :value="local.defaultModel"
                    >{{ local.defaultModel }}</SelectItem>
                  </SelectContent>
                </Select>

                <div
                  v-else-if="r.id === 'effort'"
                  role="radiogroup"
                  aria-label="Default effort"
                  :class="SEGMENTS"
                  @keydown="(e: KeyboardEvent) => onSegmentKey(e, effortIndex, efforts.length, (i) => save({ defaultEffort: efforts[i]!.value }))"
                >
                  <button
                    v-for="(e, i) in efforts"
                    :key="e.label"
                    type="button"
                    role="radio"
                    :aria-checked="i === effortIndex"
                    :tabindex="i === effortIndex ? 0 : -1"
                    :class="SEGMENT"
                    @click="save({ defaultEffort: e.value })"
                  >
                    {{ e.label }}
                  </button>
                </div>

                <Select
                  v-else-if="r.id === 'permission'"
                  :model-value="local.defaultPermissionMode"
                  @update:model-value="(v) => save({ defaultPermissionMode: v as PermissionMode })"
                >
                  <SelectTrigger :class="TRIGGER" aria-label="Permission mode"><SelectValue /></SelectTrigger>
                  <SelectContent :class="CONTENT" position="popper" align="end" :side-offset="4">
                    <SelectItem v-for="m in modes" :key="m.value" :class="SELECT_ITEM" :value="m.value">{{ m.label }}</SelectItem>
                  </SelectContent>
                </Select>

                <div v-else-if="r.id === 'notifications'" class="flex shrink-0 items-center gap-3">
                  <button type="button" :class="BUTTON" @click="testNotification">Test</button>
                  <PaneSwitch label="Notifications" :model-value="local.notifications" @update:model-value="(v: boolean) => save(switchPatch('notifications', v))" />
                </div>

                <div v-else-if="r.id === 'idle'" class="flex shrink-0 items-center gap-2 text-[13px] leading-4.75 text-text-muted">
                  <input
                    v-model="idleDraft"
                    type="number"
                    min="1"
                    max="1440"
                    class="tnum h-7 w-16 rounded-(--radius-6) bg-fill-5 px-2 text-end text-[13px] text-text shadow-[inset_0_0_0_1px_var(--border)] outline-none [appearance:textfield] focus:shadow-(--focus-ring) [&::-webkit-inner-spin-button]:appearance-none"
                    aria-label="Idle-close minutes"
                    @input="onIdleInput"
                    @blur="commitIdle"
                    @keydown.enter="commitIdle"
                  />
                  minutes
                </div>

                <PaneSwitch
                  v-else-if="r.id === 'babysitter'"
                  label="Babysitter"
                  :model-value="local.babysitter"
                  @update:model-value="(v: boolean) => save({ babysitter: v })"
                />

                <PaneSwitch
                  v-else-if="r.id === 'orchestrator'"
                  label="Orchestrator"
                  :model-value="local.orchestrator"
                  @update:model-value="(v: boolean) => save({ orchestrator: v })"
                />

                <div v-else-if="r.id === 'orchestratorModel'" class="flex shrink-0 items-center gap-2">
                  <input
                    v-if="orchestratorModelChoice === 'custom'"
                    v-model="customModelDraft"
                    type="text"
                    class="h-7 w-52 rounded-(--radius-6) bg-fill-5 px-2 font-mono text-[13px] text-text shadow-[inset_0_0_0_1px_var(--border)] outline-none focus:shadow-(--focus-ring)"
                    aria-label="Custom model id"
                    placeholder="claude-opus-5-5"
                    @blur="commitOrchestratorModel"
                    @keydown.enter="commitOrchestratorModel"
                  />
                  <Select :model-value="orchestratorModelChoice" @update:model-value="(v) => pickOrchestratorModel(String(v))">
                    <SelectTrigger :class="TRIGGER" aria-label="Orchestrator model"><SelectValue /></SelectTrigger>
                    <SelectContent :class="CONTENT" position="popper" align="end" :side-offset="4">
                      <SelectItem :class="SELECT_ITEM" value="opus">Opus (newest)</SelectItem>
                      <SelectItem :class="SELECT_ITEM" value="sonnet">Sonnet (newest)</SelectItem>
                      <SelectItem :class="SELECT_ITEM" value="haiku">Haiku (newest)</SelectItem>
                      <SelectItem :class="SELECT_ITEM" value="custom">Custom id</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <PaneSwitch
                  v-else-if="r.id === 'delegate'"
                  label="Delegate to CliMayte"
                  :model-value="local.delegateToCliMayte"
                  @update:model-value="(v: boolean) => save(switchPatch('delegate', v))"
                />

                <span v-else-if="r.id === 'workers'" class="tnum text-[13px] leading-4.75 text-text-2">{{ activeWorkers }}</span>

                <span v-else-if="r.id === 'bridge'" class="flex items-center gap-2 text-[13px] leading-4.75 text-text-2">
                  <span
                    class="inline-block size-2 rounded-full"
                    :style="{ background: bridge === null ? 'var(--text-muted)' : bridge.up ? 'var(--success)' : 'var(--danger)' }"
                  />
                  {{ bridge === null ? 'Checking…' : bridge.up ? 'Connected' : 'Not running' }}
                </span>
              </template>
            </div>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>
