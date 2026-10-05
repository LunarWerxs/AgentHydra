<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check } from '@lucide/vue'
import type { DeskSettings, Effort, ModelChoice, PermissionMode } from '@shared/protocol'
import { useShellSource } from '@/components/shell/source'
import AccountsList from '@/components/accounts/AccountsList.vue'
import PaneSwitch from './PaneSwitch.vue'
import DiagnosticsView from '@/components/diagnostics/DiagnosticsView.vue'
import { ITEM, MENU } from '@/components/composer/menu'
import { EFFORTS, PERMISSION_MODES } from '@/components/composer/logic'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { settingsIcons } from '@/lib/icons'
import { usePaneApi } from './api'
import { SETTINGS_SECTIONS, settingsGroups, stepSection, switchPatch, type SettingsSection } from './settings'

// The body of the Settings dialog, laid out like the real Settings (docs/reference/real/user/
// real-settings-claude-code.webp) without its account, billing and connector pages: a darker nav with
// Search and captioned section rows on the left; on the right bold group headings over rows of a label,
// a wrapping muted description and the control, split by hairlines. Below 640px the nav is a pill row.
const api = usePaneApi()
const src = useShellSource()

const section = ref<SettingsSection>('general')
const query = ref('')
const searching = computed(() => query.value.trim() !== '')
const groups = computed(() => settingsGroups(section.value, query.value))
// Every row but About's needs the saved settings.
const needsSettings = computed(() => groups.value.some((g) => g.rows.some((r) => r.section !== 'about')))

// reka-ui's Select cannot hold null or '', so "no override" is this sentinel in the menus.
const NONE = '__default'

const TRIGGER =
  'h-7 w-48 gap-1 rounded-[var(--radius-6)] border-0 bg-fill-5 px-2 text-[13px] leading-[19px] text-text shadow-[inset_0_0_0_1px_var(--border)] hover:bg-fill-hover data-[state=open]:bg-fill-hover focus-visible:ring-0 focus-visible:shadow-[var(--focus-ring)]'
const CONTENT = MENU + ' border-0'
const SELECT_ITEM = ITEM + ' pr-8 text-text focus:text-text'
const SEGMENTS = 'flex h-7 shrink-0 items-center gap-px rounded-[var(--radius-7)] bg-fill-5 p-px'
const SEGMENT =
  'flex h-[26px] cursor-default items-center rounded-[var(--radius-5)] px-2.5 text-[13px] leading-[19px] text-text-2 transition-colors duration-[60ms] hover:text-text focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none aria-checked:bg-[var(--fill-secondary)] aria-checked:text-text'
const BUTTON =
  'flex h-7 shrink-0 cursor-default items-center rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-2.5 text-[13px] text-text transition-colors duration-[60ms] hover:bg-[var(--fill-secondary-hover)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none'

const local = ref<DeskSettings | null>(null)
const models = ref<ModelChoice[]>([])
const version = ref<string | null>(null)
const home = ref<string | null>(null)
const bridge = ref<{ up: boolean; url: string } | null>(null)
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

function setLocal(s: DeskSettings) {
  local.value = { ...s }
  idleDraft.value = String(s.idleCloseMinutes)
}

let savedTimer: ReturnType<typeof setTimeout> | null = null
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
    showSaved.value = true
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => (showSaved.value = false), 1600)
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
  new Notification('Hydra Desk', { body: 'Notifications work. You will see one when a chat finishes or needs you.' })
  notifyNote.value = 'Sent.'
}

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
onMounted(async () => {
  syncBridgePoll()
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
  stopBridgePoll()
  if (savedTimer) clearTimeout(savedTimer)
  if (idleTimer) clearTimeout(idleTimer)
})
</script>

<template>
  <div class="flex h-full min-h-0 w-full flex-col bg-bg-popover text-text sm:flex-row">
    <nav
      aria-label="Settings sections"
      class="flex shrink-0 flex-col gap-2 border-b border-border bg-bg-panel p-3 pr-12 sm:w-[160px] sm:pr-3 sm:border-b-0 sm:border-r lg:w-[185px]"
    >
      <label
        class="flex h-8 shrink-0 items-center gap-2 rounded-[var(--radius-6)] bg-fill-5 px-2 shadow-[inset_0_0_0_1px_var(--border)] focus-within:shadow-[var(--focus-ring)]"
      >
        <component :is="settingsIcons.search" class="size-4 shrink-0 text-text-muted" />
        <input
          v-model="query"
          type="search"
          placeholder="Search"
          aria-label="Search settings"
          class="min-w-0 flex-1 bg-transparent text-[13px] leading-[19px] text-text outline-none placeholder:text-text-muted [&::-webkit-search-cancel-button]:appearance-none"
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
            class="flex h-8 shrink-0 cursor-default items-center gap-2 rounded-full px-3 text-left text-[13px] leading-[19px] transition-colors duration-[var(--dur-fast)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none sm:rounded-[var(--radius-6)] sm:px-2"
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
        <span v-if="saveError" class="text-danger-text">Not saved: {{ saveError }}</span>
      </div>

      <div v-if="!local && needsSettings" class="text-[13px] leading-[19px]" :class="loadError ? 'text-danger-text' : 'text-text-muted'">
        {{ loadError ? `Could not load settings: ${loadError}` : 'Loading…' }}
      </div>

      <p v-else-if="searching && !groups.length" class="text-[13px] leading-[19px] text-text-muted">No settings match</p>

      <DiagnosticsView v-else-if="section === 'diagnostics' && !searching" />

      <template v-else>
        <div v-for="(g, gi) in groups" :key="g.heading" role="group" :aria-label="g.heading" :class="gi ? 'mt-8' : ''">
          <h3 class="text-[13px] font-semibold leading-5 text-text">{{ g.heading }}</h3>
          <div>
            <div
              v-for="r in g.rows"
              :key="r.id"
              class="flex flex-wrap gap-x-6 gap-y-2 border-b border-border py-3.5 last:border-b-0"
              :class="r.id === 'account' ? 'flex-col' : 'items-center'"
            >
              <div class="min-w-[200px] flex-1">
                <div class="text-[13px] leading-5 text-text">{{ r.label }}</div>
                <div class="mt-0.5 text-[13px] leading-[19px] text-text-muted">
                  {{ r.id === 'notifications' && notifyNote ? notifyNote : r.description }}
                </div>
                <div v-if="r.id === 'bridge'" class="truncate font-mono text-[12px] leading-[19px] text-text-muted">{{ bridge?.url || 'No address yet' }}</div>
              </div>

              <span v-if="r.id === 'version'" class="font-mono text-[13px] leading-[19px] text-text-2">{{ version ? `v${version}` : '…' }}</span>
              <span v-else-if="r.id === 'home'" class="max-w-[60%] truncate font-mono text-[12px] leading-[19px] text-text-2">
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

                <div v-else-if="r.id === 'idle'" class="flex shrink-0 items-center gap-2 text-[13px] leading-[19px] text-text-muted">
                  <input
                    v-model="idleDraft"
                    type="number"
                    min="1"
                    max="1440"
                    class="tnum h-7 w-16 rounded-[var(--radius-6)] bg-fill-5 px-2 text-right text-[13px] text-text shadow-[inset_0_0_0_1px_var(--border)] outline-none [appearance:textfield] focus:shadow-[var(--focus-ring)] [&::-webkit-inner-spin-button]:appearance-none"
                    aria-label="Idle-close minutes"
                    @input="onIdleInput"
                    @blur="commitIdle"
                    @keydown.enter="commitIdle"
                  />
                  minutes
                </div>

                <div v-else-if="r.id === 'account'" class="rounded-[var(--radius-8)] bg-fill-5 p-1 shadow-[inset_0_0_0_1px_var(--border)]">
                  <AccountsList embedded />
                </div>

                <PaneSwitch
                  v-else-if="r.id === 'delegate'"
                  label="Delegate to CliMayte"
                  :model-value="local.delegateToCliMayte"
                  @update:model-value="(v: boolean) => save(switchPatch('delegate', v))"
                />

                <span v-else-if="r.id === 'workers'" class="tnum text-[13px] leading-[19px] text-text-2">{{ activeWorkers }}</span>

                <span v-else-if="r.id === 'bridge'" class="flex items-center gap-2 text-[13px] leading-[19px] text-text-2">
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
