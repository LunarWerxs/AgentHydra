<script setup lang="ts">
import {
  AppWindow,
  BellRing,
  CalendarClock,
  Cloud,
  CloudCheck,
  CloudCog,
  CloudDownload,
  CloudOff,
  ExternalLink,
  EyeOff,
  Gauge,
  LogOut,
  Mail,
  MessageCircleQuestion,
  Monitor,
  MonitorDown,
  Plug,
  RefreshCw,
  Repeat,
  Timer,
  User,
  VenetianMask,
} from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppSettings } from '@/composables/useAppSettings'
import { usePanels } from '@/composables/usePanels'
import { piiName } from '@/composables/usePrivacy'
import { useUiPrefs } from '@/composables/useUiPrefs'
import { useUpdates } from '@/composables/useUpdates'
import type { MonitorStateName, SearchIndexStatus, SyncStatus } from '@/lib/api'
import * as api from '@/lib/api'
import { bindSignInNudgeStatus, nudgeOnSettingsChange } from '@/lib/sign-in-nudge'
import { useTheme } from '@/lib/theme'
import { useTooltipConfig } from '@/lib/tooltip-config'
import ExpandTransition from '@/shell/ExpandTransition.vue'
import InfoHint from '@/shell/InfoHint.vue'
import SettingsGroup from '@/shell/SettingsGroup.vue'
import SettingsRow from '@/shell/SettingsRow.vue'

const { t } = useI18n()

// Settings holds what belongs to the whole app: appearance, the MCP server, notifications, updates
// and cloud sync. A setting that belongs to one page lives on that page (owner, 2026-10-01: "move
// all the settings that make sense to their pages"): the Instances tab's gear, the Sessions list's
// ⋯ menu, the CLI table's gear, and the queue drawer's scheduler button. A deep link (the header's
// update dot) scrolls to a section and pulses it.
const { enabled: showTooltips } = useTooltipConfig()
const { privacyMode } = useUiPrefs()

const sectionEls = ref<Record<string, HTMLElement | null>>({})
function setSectionEl(id: string, el: unknown) {
  sectionEls.value[id] = el as { $el?: HTMLElement } | HTMLElement | null as HTMLElement | null
}

// Which section is currently flashing after a deep link. A scroll alone lands you somewhere without
// saying WHERE — on a page of near-identical cards the arrival is ambiguous, so the target pulses
// briefly (see .settings-flash in style.css). Cleared on a timer, and re-armed if a second deep link
// arrives while the first is still running.
const flashSection = ref<string | null>(null)
let flashTimer: ReturnType<typeof setTimeout> | undefined

const { settingsRequestedTab } = usePanels()
function consumeRequestedTab() {
  const req = settingsRequestedTab.value
  if (req) {
    // Wait a tick so the section is laid out (view may be mounting fresh), then scroll to it.
    nextTick(() => {
      const el = sectionEls.value[req]
      const node = (el as { $el?: HTMLElement })?.$el ?? (el as HTMLElement | null)
      node?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      // Re-armed from null so clicking the same deep link twice replays the animation; without the
      // reset the class never changes and the browser has no reason to run it again.
      flashSection.value = null
      clearTimeout(flashTimer)
      nextTick(() => {
        flashSection.value = req
        flashTimer = setTimeout(() => {
          flashSection.value = null
        }, 1900)
      })
    })
  }
  if (req !== null) settingsRequestedTab.value = null
}
onBeforeUnmount(() => clearTimeout(flashTimer))
watch(settingsRequestedTab, consumeRequestedTab)
onMounted(consumeRequestedTab)

// --- updates ---
const { updateStatus, updateChecking, updateApplying, checkForUpdate, applyUpdate, progressLabel } =
  useUpdates()
// No git remote (and no AGENTHYDRA_UPDATE_REPO) means there is nowhere to pull updates
// from: the no-source row explains it and the auto-update rows gray out.
const noUpdateSource = computed(() => !!updateStatus.value && !updateStatus.value.remote)
// The engine's `reason` is a terse internal string (e.g. "local changes must be committed or
// stashed before updating"). Shown directly as the row's description (not tucked behind an
// InfoHint icon) so "Update blocked" is never a dead end - the single most common cause (a
// dirty working tree, since the updater refuses to overwrite uncommitted local edits) is
// visible at a glance instead of requiring a hover.
const updateBlockedReason = computed(() => updateStatus.value?.reason ?? undefined)
const applyMessage = ref<string | null>(null)
const applyError = ref<string | null>(null)
const restartRequired = ref(false)

// The version number IS the update control now (owner request): it reads green when up to date,
// amber when an update is waiting, red when blocked / there is no update source. Its tooltip
// spells out the state, and clicking it re-checks (or applies a waiting update) — folding away the
// old always-visible "Up to date." / "Update available" / "Update blocked" status rows.
type UpdateState = 'checking' | 'up-to-date' | 'available' | 'blocked' | 'no-source' | 'unknown'
const updateState = computed<UpdateState>(() => {
  if (updateChecking.value || updateApplying.value) return 'checking'
  const s = updateStatus.value
  if (!s) return 'unknown'
  if (!s.remote) return 'no-source'
  if (s.updateAvailable) return s.canApply ? 'available' : 'blocked'
  return 'up-to-date'
})
const versionColorClass = computed(() => {
  switch (updateState.value) {
    case 'up-to-date':
      return 'text-success'
    case 'available':
      return 'text-warning'
    case 'blocked':
    case 'no-source':
      return 'text-destructive'
    default:
      return 'text-muted-foreground'
  }
})
const versionTip = computed(() => {
  switch (updateState.value) {
    case 'checking':
      return t('settings.versionCheckingTip')
    case 'available':
      return t('settings.versionUpdateAvailableTip')
    case 'blocked':
      return updateBlockedReason.value
        ? `${t('settings.versionUpdateBlockedTip')} ${updateBlockedReason.value}`
        : t('settings.versionUpdateBlockedTip')
    case 'no-source':
      return `${t('settings.versionNoSourceTip')} ${t('settings.noUpdateSourceHint')}`
    default:
      return t('settings.versionUpToDateTip')
  }
})

onMounted(() => {
  checkForUpdate()
})

async function onCheckForUpdate() {
  applyMessage.value = null
  applyError.value = null
  await checkForUpdate()
}
async function onApplyUpdate() {
  applyMessage.value = null
  applyError.value = null
  try {
    const result = await applyUpdate()
    applyMessage.value = result.message
    restartRequired.value = result.restartRequired
  } catch (e) {
    applyError.value = e instanceof Error ? e.message : String(e)
  }
}
// One click, state-dependent: apply a waiting update, otherwise (re-)check for one.
async function onVersionClick() {
  if (updateChecking.value || updateApplying.value) return
  if (updateState.value === 'available') {
    await onApplyUpdate()
    return
  }
  await onCheckForUpdate()
}

// --- portable mode ---
const portableMode = ref(false)
const creatingInstanceShortcut = ref(false)
// --- hide tray icon ---
const hideTrayIcon = ref(false)

async function refreshSettings() {
  try {
    const s = await api.getSettings()
    portableMode.value = s.portableMode
    hideTrayIcon.value = s.hideTrayIcon
    readMcpSettings(s)
  } catch {
    /* keep last-known value on a failed refresh */
  }
}
onMounted(refreshSettings)

async function togglePortableMode(enabled: boolean) {
  try {
    const s = await api.updateSettings({ portableMode: enabled })
    portableMode.value = s.portableMode
  } catch {
    toast.error(t('settings.portableModeToastFailed'))
    return
  }
  if (!enabled) return
  try {
    const result = await api.openPortableWindow()
    if (result.ok) {
      toast.success(t('settings.portableModeToastOpened'))
    } else {
      toast.error(t('settings.portableModeToastNoBrowser'))
    }
  } catch {
    toast.error(t('settings.portableModeToastNoBrowser'))
  }
}

async function createQuickInstancesShortcut() {
  if (creatingInstanceShortcut.value) return
  creatingInstanceShortcut.value = true
  try {
    const result = await api.createInstanceModeShortcut()
    if (result.ok) {
      toast.success(t('settings.instanceModeShortcutCreated'))
    } else {
      toast.error(result.message ?? t('settings.instanceModeShortcutFailed'))
    }
  } catch {
    toast.error(t('settings.instanceModeShortcutFailed'))
  } finally {
    creatingInstanceShortcut.value = false
  }
}

async function toggleHideTrayIcon(enabled: boolean) {
  try {
    const s = await api.updateSettings({ hideTrayIcon: enabled })
    hideTrayIcon.value = s.hideTrayIcon
  } catch {
    toast.error(t('settings.hideTrayIconToastFailed'))
  }
}

// --- MCP registration (server/src/mcp-register.ts) ---
// Two values, not one: the SWITCH and what the config file actually says. The daemon reports both
// because they can disagree - a read-only ~/.claude.json, or an entry someone wrote by hand - and
// showing only the switch would report success over a registration that never landed.
const mcpRegister = ref(true)
const mcpRegistered = ref(false)
const mcpUrl = ref('')
const mcpConfigPath = ref('')
const mcpError = ref<string | null>(null)
// The toolbox half. Separate from the registration because they fail independently and a user
// with one and not the other sees a completely different symptom.
const mcpToolboxPresent = ref(true)
const mcpMissingComponents = ref<string[]>([])

function readMcpSettings(s: Awaited<ReturnType<typeof api.getSettings>>) {
  mcpRegister.value = s.mcpRegisterClaudeCode
  mcpRegistered.value = s.mcpRegistered
  mcpUrl.value = s.mcpUrl
  mcpConfigPath.value = s.mcpConfigPath
  mcpError.value = s.mcpRegisterError
  mcpToolboxPresent.value = s.mcpToolboxPresent
  mcpMissingComponents.value = s.mcpMissingComponents
}

/** Re-apply the CURRENT release to restore a missing component. applyUpdate() already treats an
 *  install with a missing release folder as installable at its own version (see
 *  missingComponents / resolveUpdateToApply), so this is the same path the update row uses.
 *
 *  The OUTCOME is toasted rather than left to applyMessage/applyError, which render inside the
 *  Updates group ~300 lines further down the page: a failed repair would otherwise look like a
 *  button that did nothing at all. */
async function onRepairInstall() {
  await onApplyUpdate()
  await refreshSettings()
  if (applyError.value) toast.error(applyError.value)
  else if (mcpMissingComponents.value.length)
    toast.warning(applyMessage.value ?? t('settings.mcpRepairFailed'))
  else toast.success(applyMessage.value ?? t('settings.mcpRepairDone'))
}

async function toggleMcpRegister(enabled: boolean) {
  try {
    readMcpSettings(await api.updateSettings({ mcpRegisterClaudeCode: enabled }))
  } catch {
    toast.error(t('settings.mcpRegisterToastFailed'))
  }
}

// --- app settings this panel still owns ---------------------------------------------------------
// The notification settings: the rest of the composable belongs to the pages that use it.
const {
  notifyEnabled,
  notifySessionReset,
  notifyWeeklyReset,
  notifyMinPct,
  notifySessionMaxWeeklyPct,
  notifyDesktop,
  notifyPersistent,
  notifyPersistentIntervalMin,
  notifyPersistentMaxRepeats,
  notifyEmail,
  notifyEmailTo,
  notifyEmailFrom,
  notifySmtpHost,
  notifySmtpPort,
  notifySmtpSecure,
  notifySmtpUser,
  notifySmtpPassSet,
  load: loadUsageSettings,
  update: updateAppSettings,
} = useAppSettings()
onMounted(loadUsageSettings)

// --- reset notifications (server/src/reset-watch.ts) --------------------------------------------
// Every control here auto-saves through the same round-trip as the rest of the panel. The SMTP
// password is the one exception to "the field shows what is stored": the server never returns it,
// so this field is always blank and an empty value on save means "keep the stored one".
async function patchNotifications(patch: api.AppSettingsPatch) {
  if (!(await updateAppSettings(patch))) toast.error(t('settings.usageToastFailed'))
}

const smtpPassDraft = ref('')
async function saveSmtpPass() {
  const value = smtpPassDraft.value
  if (!value) return
  smtpPassDraft.value = ''
  await patchNotifications({ notifySmtpPass: value })
}

const testingNotification = ref(false)
async function onTestNotification() {
  testingNotification.value = true
  try {
    const r = await api.sendTestNotification()
    if (!r.desktop.attempted && !r.email.attempted) {
      toast.info(t('notifications.testNothingEnabled'))
      return
    }
    if (r.desktop.attempted) {
      if (r.desktop.ok) toast.success(t('notifications.testDesktopOk'))
      else toast.error(t('notifications.testDesktopFailed', { error: r.desktop.error ?? '' }))
    }
    if (r.email.attempted) {
      if (r.email.ok) toast.success(t('notifications.testEmailOk'))
      else toast.error(t('notifications.testEmailFailed', { error: r.email.error ?? '' }))
    }
  } catch (err) {
    toast.error(
      t('notifications.testDesktopFailed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  } finally {
    testingNotification.value = false
  }
}

// --- theme + cloud sync -----------------------
// The theme PICKER now lives as an icon in the settings panel header (App.vue); this composable
// stays here only so cloud sync can read/apply the theme (applyAppearance / currentAppearance).
const { mode: themeMode, setTheme } = useTheme()
const syncStatus = ref<SyncStatus>({
  ok: true,
  enabled: false,
  connected: false,
  name: null,
  email: null,
  picture: null,
  lastSyncedAt: null,
  version: 0,
  appearance: null,
})
const syncBusy = ref(false)
const syncError = ref<string | null>(null)
const confirmDisconnect = ref(false)
// Set right before applying a pulled appearance, so the theme watcher below doesn't turn
// right around and push the value it just received.
let applyingRemoteAppearance = false
let syncPushTimer: ReturnType<typeof setTimeout> | undefined

function currentAppearance(): Record<string, unknown> {
  return { theme: themeMode.value }
}
function applyAppearance(appearance: Record<string, unknown> | null | undefined) {
  if (!appearance) return
  const theme = appearance.theme
  if (theme === 'light' || theme === 'dark' || theme === 'system') {
    applyingRemoteAppearance = true
    setTheme(theme)
    queueMicrotask(() => {
      applyingRemoteAppearance = false
    })
  }
}
function absorbSyncResult(res: api.SyncResult): api.SyncResult {
  if (res.ok) {
    syncStatus.value = res
    syncError.value = null
  } else {
    syncError.value = res.error
  }
  return res
}
async function refreshSyncStatus() {
  try {
    const s = await api.getSyncStatus()
    syncStatus.value = s
    syncError.value = null
  } catch {
    /* keep last-known value on a failed refresh */
  }
}
onMounted(refreshSyncStatus)

function goSignIn() {
  // New tab so the current app state isn't lost - the new tab lands on /?connected=1 after
  // auth; sync status here refreshes when the user returns to this tab.
  window.open('/oauth/login', '_blank', 'noopener')
}
function onWindowFocus() {
  if (!syncStatus.value.connected) void refreshSyncStatus()
}
onMounted(() => window.addEventListener('focus', onWindowFocus))
onBeforeUnmount(() => window.removeEventListener('focus', onWindowFocus))

async function onToggleSyncEnable(enabled: boolean) {
  confirmDisconnect.value = false
  syncBusy.value = true
  try {
    if (enabled) {
      const res = await api.setSync({ enabled: true, appearance: currentAppearance() })
      absorbSyncResult(res)
      if (res.ok) applyAppearance(res.appearance)
    } else {
      absorbSyncResult(await api.setSync({ enabled: false }))
    }
  } catch (e) {
    syncError.value = e instanceof Error ? e.message : String(e)
  } finally {
    syncBusy.value = false
  }
}
async function onSyncNow() {
  syncBusy.value = true
  try {
    const pulled = absorbSyncResult(await api.syncPull())
    if (pulled.ok) {
      applyAppearance(pulled.appearance)
      const pushed = absorbSyncResult(await api.syncPush())
      if (pushed.ok) toast.success(t('settings.cloudSyncSyncedToast'))
    }
  } catch (e) {
    syncError.value = e instanceof Error ? e.message : String(e)
  } finally {
    syncBusy.value = false
  }
}
async function onDisconnect() {
  if (!confirmDisconnect.value) {
    confirmDisconnect.value = true
    return
  }
  confirmDisconnect.value = false
  syncBusy.value = true
  try {
    absorbSyncResult(await api.setSync({ enabled: false, forget: true }))
  } catch (e) {
    syncError.value = e instanceof Error ? e.message : String(e)
  } finally {
    syncBusy.value = false
  }
}

const syncedLabel = computed(() => {
  const iso = syncStatus.value.lastSyncedAt
  if (!iso) return t('settings.cloudSyncNeverSynced')
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return t('settings.cloudSyncNeverSynced')
  const seconds = Math.round((Date.now() - ts) / 1000)
  if (seconds < 10) return t('settings.cloudSyncSyncedNow')
  const minutes = Math.round(seconds / 60)
  const hours = Math.round(minutes / 60)
  const when =
    seconds < 60
      ? t('settings.cloudSyncSecondsAgo', { n: seconds })
      : minutes < 60
        ? t('settings.cloudSyncMinutesAgo', { n: minutes })
        : t('settings.cloudSyncHoursAgo', { n: hours })
  return t('settings.cloudSyncSyncedAgo', { when })
})

// When the theme changes AND sync is enabled+connected, debounce and push - but never echo a
// value just applied from a pull/enable (applyingRemoteAppearance).
watch(themeMode, () => {
  if (applyingRemoteAppearance) return
  // NOT connected is the interesting case for the sign-in prompt, and it is exactly the branch the
  // push below discards. Someone who just changed an appearance setting is who "these follow you to
  // your other machines" is a true sentence for, and this is the same instant we WOULD have pushed
  // it. The engine says no to almost every one of these; see lib/sign-in-nudge.
  if (!syncStatus.value.connected) nudgeOnSettingsChange()
  if (!syncStatus.value.enabled || !syncStatus.value.connected) return
  clearTimeout(syncPushTimer)
  syncPushTimer = setTimeout(() => {
    void api.setSync({ appearance: currentAppearance() }).then(absorbSyncResult)
  }, 800)
})

// Point the prompt at the live connection state. Only the STATUS binds here - the session count
// starts at app boot (main.ts), because this view is lazy and an owner who never opens Settings
// would otherwise never accrue a session and never pass the prompt's gate.
bindSignInNudgeStatus(() => syncStatus.value.connected)

// --- auto-update ---
// Single toggle - no user-facing interval control (family-standard "Auto-update"). The check
// cadence is a fixed sensible default owned by the server (server/src/auto-update.ts); the old
// per-user interval setting is migrated/ignored gracefully server-side.
const autoUpdateEnabled = ref(false)

async function refreshAutoUpdateSettings() {
  try {
    const s = await api.getAutoUpdateSettings()
    autoUpdateEnabled.value = s.enabled
  } catch {
    /* keep last-known value on a failed refresh */
  }
}
onMounted(refreshAutoUpdateSettings)

async function toggleAutoUpdate(enabled: boolean) {
  try {
    const s = await api.updateAutoUpdateSettings({ enabled })
    autoUpdateEnabled.value = s.enabled
    toast.success(
      enabled ? t('settings.autoUpdateToastEnabled') : t('settings.autoUpdateToastDisabled'),
    )
  } catch {
    toast.error(t('settings.autoUpdateToastFailed'))
  }
}
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-6 overflow-y-auto p-6">
    <!-- appearance -->
    <SettingsGroup :label="$t('settings.appearance')">
      <!-- Theme + Shut down moved to icons in the settings panel header (App.vue). The transcript
           editor, the copy-path format and the search index moved to the Sessions list's settings. -->
      <SettingsRow :icon="AppWindow" :label="$t('settings.portableModeLabel')">
        <template #info>
          <InfoHint :text="$t('settings.portableModeHint')" />
        </template>
        <template #control>
          <Switch :model-value="portableMode" @update:model-value="togglePortableMode" />
        </template>
      </SettingsRow>
      <SettingsRow :icon="MonitorDown" :label="$t('settings.instanceModeShortcutLabel')">
        <template #info>
          <InfoHint :text="$t('settings.instanceModeShortcutHint')" />
        </template>
        <template #control>
          <Button
            variant="outline"
            size="sm"
            :disabled="creatingInstanceShortcut"
            @click="createQuickInstancesShortcut"
          >
            <MonitorDown :class="creatingInstanceShortcut ? 'animate-pulse' : ''" />
            {{
              $t(
                creatingInstanceShortcut
                  ? 'settings.instanceModeShortcutCreating'
                  : 'settings.instanceModeShortcutCreate',
              )
            }}
          </Button>
        </template>
      </SettingsRow>
      <SettingsRow :icon="EyeOff" :label="$t('settings.hideTrayIconLabel')">
        <template #info>
          <InfoHint :text="$t('settings.hideTrayIconHint')" />
        </template>
        <template #control>
          <Switch :model-value="hideTrayIcon" @update:model-value="toggleHideTrayIcon" />
        </template>
      </SettingsRow>
      <SettingsRow :icon="MessageCircleQuestion" :label="$t('settings.showTooltipsLabel')">
        <template #info>
          <InfoHint :text="$t('settings.showTooltipsHint')" />
        </template>
        <template #control>
          <Switch v-model="showTooltips" />
        </template>
      </SettingsRow>
      <SettingsRow :icon="VenetianMask" :label="$t('settings.privacyModeLabel')">
        <template #info>
          <InfoHint :text="$t('settings.privacyModeHint')" />
        </template>
        <template #control>
          <Switch v-model="privacyMode" />
        </template>
      </SettingsRow>
    </SettingsGroup>

    <!-- MCP: the agent-facing half of the app. On by default, because the alternative was a
         documented command that only worked from a source checkout. -->
    <SettingsGroup :label="$t('settings.mcpTitle')" :description="$t('settings.mcpHint')">
      <SettingsRow :icon="Plug" :label="$t('settings.mcpRegisterLabel')">
        <template #info>
          <InfoHint :text="$t('settings.mcpRegisterHint')" />
        </template>
        <template #control>
          <Switch :model-value="mcpRegister" @update:model-value="toggleMcpRegister" />
        </template>
      </SettingsRow>
      <div class="space-y-0.5 px-3.5 py-2.5 text-2xs text-muted-foreground">
        <p v-if="mcpError" class="text-destructive">{{ mcpError }}</p>
        <p v-else-if="mcpRegistered">{{ $t('settings.mcpRegisteredYes', { url: mcpUrl }) }}</p>
        <p v-else>
          {{ mcpRegister ? $t('settings.mcpRegisteredNo') : $t('settings.mcpRegisteredOff') }}
        </p>
        <p v-if="mcpConfigPath" class="break-all">
          {{ $t('settings.mcpConfigPath', { path: mcpConfigPath }) }}
        </p>
      </div>
      <!-- Any release-owned folder this install is missing, whichever it is. The message is
           SPECIFIC to the consequence: a missing orchestrator/ breaks moving chats, a missing
           misc/ costs the tray icon, and claiming the first when it is the second would be a
           false alarm. A repair is the ordinary update path applied to the CURRENT version, so
           the button is the same apply the update row uses. -->
      <div v-if="mcpMissingComponents.length" class="space-y-1.5 px-3.5 py-2.5 text-2xs">
        <p class="text-warning">
          {{
            mcpToolboxPresent
              ? $t('settings.mcpComponentsMissing', { names: mcpMissingComponents.join(', ') })
              : $t('settings.mcpToolboxMissing', { names: mcpMissingComponents.join(', ') })
          }}
        </p>
        <p class="text-muted-foreground">{{ $t('settings.mcpToolboxMissingWhy') }}</p>
        <Button size="sm" variant="outline" :disabled="updateApplying" @click="onRepairInstall">
          {{ $t(updateApplying ? 'settings.mcpRepairing' : 'settings.mcpRepair') }}
        </Button>
      </div>
    </SettingsGroup>

    <!-- notifications: the quota EDGE, not the number. See server/src/reset-watch.ts.
         Everything below the master switch is disclosed only when it is on - the whole group is
         several rows of nothing when notifications are off. -->
    <SettingsGroup :label="$t('notifications.title')">
      <SettingsRow :icon="BellRing" :label="$t('notifications.enabled')">
        <template #info>
          <InfoHint :text="$t('notifications.enabledHint')" />
        </template>
        <template #control>
          <Switch
            :model-value="notifyEnabled"
            @update:model-value="(v: boolean) => patchNotifications({ notifyEnabled: v })"
          />
        </template>
      </SettingsRow>
      <ExpandTransition :open="notifyEnabled">
        <div class="divide-y divide-border">
          <SettingsRow :icon="Timer" :label="$t('notifications.sessionReset')">
            <template #control>
              <Switch
                :model-value="notifySessionReset"
                @update:model-value="(v: boolean) => patchNotifications({ notifySessionReset: v })"
              />
            </template>
          </SettingsRow>
          <SettingsRow :icon="CalendarClock" :label="$t('notifications.weeklyReset')">
            <template #control>
              <Switch
                :model-value="notifyWeeklyReset"
                @update:model-value="(v: boolean) => patchNotifications({ notifyWeeklyReset: v })"
              />
            </template>
          </SettingsRow>
          <SettingsRow :icon="Gauge" :label="$t('notifications.minPct')">
            <template #info>
              <InfoHint :text="$t('notifications.minPctHint')" />
            </template>
            <template #control>
              <div class="flex items-center gap-1">
                <Input
                  class="h-7 w-16 text-end"
                  type="number"
                  min="0"
                  max="100"
                  :model-value="notifyMinPct"
                  @change="(e: Event) => patchNotifications({ notifyMinPct: Number((e.target as HTMLInputElement).value) })"
                />
                <span>%</span>
              </div>
            </template>
          </SettingsRow>
          <!-- Disabled when session resets are off entirely: there is nothing left for it to
               suppress, and a live-looking control that changes nothing is worse than a greyed one. -->
          <SettingsRow
            :icon="Gauge"
            :label="$t('notifications.sessionMaxWeeklyPct')"
            :disabled="!notifySessionReset"
          >
            <template #info>
              <InfoHint :text="$t('notifications.sessionMaxWeeklyPctHint')" />
            </template>
            <template #control>
              <div class="flex items-center gap-1">
                <Input
                  class="h-7 w-16 text-end"
                  type="number"
                  min="0"
                  max="100"
                  :disabled="!notifySessionReset"
                  :model-value="notifySessionMaxWeeklyPct"
                  @change="(e: Event) => patchNotifications({ notifySessionMaxWeeklyPct: Number((e.target as HTMLInputElement).value) })"
                />
                <span>%</span>
              </div>
            </template>
          </SettingsRow>
          <SettingsRow :icon="Monitor" :label="$t('notifications.desktop')">
            <template #info>
              <InfoHint :text="$t('notifications.desktopHint')" />
            </template>
            <template #control>
              <Switch
                :model-value="notifyDesktop"
                @update:model-value="(v: boolean) => patchNotifications({ notifyDesktop: v })"
              />
            </template>
          </SettingsRow>
          <SettingsRow :icon="Repeat" :label="$t('notifications.persistent')">
            <template #info>
              <InfoHint :text="$t('notifications.persistentHint')" />
            </template>
            <template #control>
              <Switch
                :model-value="notifyPersistent"
                @update:model-value="(v: boolean) => patchNotifications({ notifyPersistent: v })"
              />
            </template>
          </SettingsRow>
          <ExpandTransition :open="notifyPersistent">
            <div class="divide-y divide-border">
              <SettingsRow :icon="Timer" :label="$t('notifications.persistentInterval')">
                <template #control>
                  <div class="flex items-center gap-1">
                    <Input
                      class="h-7 w-16 text-end"
                      type="number"
                      min="1"
                      max="1440"
                      :model-value="notifyPersistentIntervalMin"
                      @change="(e: Event) => patchNotifications({ notifyPersistentIntervalMin: Number((e.target as HTMLInputElement).value) })"
                    />
                    <span>{{ $t('notifications.minutes') }}</span>
                  </div>
                </template>
              </SettingsRow>
              <SettingsRow :icon="Repeat" :label="$t('notifications.persistentMaxRepeats')">
                <template #info>
                  <InfoHint :text="$t('notifications.persistentMaxRepeatsHint')" />
                </template>
                <template #control>
                  <div class="flex items-center gap-1">
                    <Input
                      class="h-7 w-16 text-end"
                      type="number"
                      min="0"
                      max="200"
                      :model-value="notifyPersistentMaxRepeats"
                      @change="(e: Event) => patchNotifications({ notifyPersistentMaxRepeats: Number((e.target as HTMLInputElement).value) })"
                    />
                    <span>{{ $t('notifications.reminders') }}</span>
                  </div>
                </template>
              </SettingsRow>
            </div>
          </ExpandTransition>
          <SettingsRow :icon="Mail" :label="$t('notifications.email')">
            <template #info>
              <InfoHint :text="$t('notifications.emailHint')" />
            </template>
            <template #control>
              <Switch
                :model-value="notifyEmail"
                @update:model-value="(v: boolean) => patchNotifications({ notifyEmail: v })"
              />
            </template>
          </SettingsRow>
          <ExpandTransition :open="notifyEmail">
            <div class="divide-y divide-border">
              <SettingsRow :icon="Mail" :label="$t('notifications.emailTo')">
                <template #control>
                  <Input
                    class="h-7 w-56"
                    type="email"
                    :model-value="notifyEmailTo"
                    @change="(e: Event) => patchNotifications({ notifyEmailTo: (e.target as HTMLInputElement).value })"
                  />
                </template>
              </SettingsRow>
              <SettingsRow :icon="Mail" :label="$t('notifications.emailFrom')">
                <template #control>
                  <Input
                    class="h-7 w-56"
                    type="email"
                    :model-value="notifyEmailFrom"
                    @change="(e: Event) => patchNotifications({ notifyEmailFrom: (e.target as HTMLInputElement).value })"
                  />
                </template>
              </SettingsRow>
              <SettingsRow :icon="Cloud" :label="$t('notifications.smtpHost')">
                <template #control>
                  <Input
                    class="h-7 w-56"
                    :model-value="notifySmtpHost"
                    @change="(e: Event) => patchNotifications({ notifySmtpHost: (e.target as HTMLInputElement).value })"
                  />
                </template>
              </SettingsRow>
              <SettingsRow :icon="Cloud" :label="$t('notifications.smtpPort')">
                <template #control>
                  <Input
                    class="h-7 w-20 text-end"
                    type="number"
                    min="1"
                    max="65535"
                    :model-value="notifySmtpPort"
                    @change="(e: Event) => patchNotifications({ notifySmtpPort: Number((e.target as HTMLInputElement).value) })"
                  />
                </template>
              </SettingsRow>
              <SettingsRow :icon="CloudCheck" :label="$t('notifications.smtpSecure')">
                <template #info>
                  <InfoHint :text="$t('notifications.smtpSecureHint')" />
                </template>
                <template #control>
                  <Switch
                    :model-value="notifySmtpSecure"
                    @update:model-value="(v: boolean) => patchNotifications({ notifySmtpSecure: v })"
                  />
                </template>
              </SettingsRow>
              <SettingsRow :icon="User" :label="$t('notifications.smtpUser')">
                <template #control>
                  <Input
                    class="h-7 w-56"
                    :model-value="notifySmtpUser"
                    @change="(e: Event) => patchNotifications({ notifySmtpUser: (e.target as HTMLInputElement).value })"
                  />
                </template>
              </SettingsRow>
              <!-- Always blank: the server does not return the stored password, so there is
                   nothing to prefill. Saving an empty value keeps whatever is stored. -->
              <SettingsRow :icon="User" :label="$t('notifications.smtpPass')">
                <template #description>
                  <span v-if="notifySmtpPassSet">{{ $t('notifications.smtpPassStored') }}</span>
                </template>
                <template #control>
                  <Input
                    v-model="smtpPassDraft"
                    class="h-7 w-56"
                    type="password"
                    autocomplete="new-password"
                    @change="saveSmtpPass"
                  />
                </template>
              </SettingsRow>
            </div>
          </ExpandTransition>
          <SettingsRow :icon="BellRing" :label="$t('notifications.test')">
            <template #info>
              <InfoHint :text="$t('notifications.testHint')" />
            </template>
            <template #control>
              <Button
                size="xs"
                variant="outline"
                :disabled="testingNotification"
                @click="onTestNotification"
              >
                <RefreshCw v-if="testingNotification" class="animate-spin" />
                {{ testingNotification ? $t('notifications.testSending') : $t('notifications.test') }}
              </Button>
            </template>
          </SettingsRow>
        </div>
      </ExpandTransition>
    </SettingsGroup>

    <!-- updates.
         Deep-linkable, because the blue dot on the header's settings button is the only thing that
         says a new version exists and the dot itself explains nothing: clicking it now scrolls
         here and pulses this card, so the answer to "why is there a dot?" is the first thing you
         see instead of something you have to go hunting for down a long page. -->
    <SettingsGroup
      :ref="(el: unknown) => setSectionEl('updates', el)"
      :class="flashSection === 'updates' ? 'settings-flash' : ''"
      :label="$t('settings.updates')"
    >
      <!-- The version number IS the status indicator + control now (owner request): green = up to
           date, amber = update available (click to apply & restart), red = blocked / no update
           source. Hover spells out the exact state; clicking re-checks, or applies a waiting update.
           This folds away the old always-visible "Up to date." / "Update available" / "Update
           blocked" / "no source" status rows. -->
      <SettingsRow :icon="CloudDownload" :label="$t('settings.currentVersion')">
        <template #control>
          <Tooltip>
            <TooltipTrigger as-child>
              <!-- The colour lives on the version-number span, not the <button>: the kit's base
                   reset sets `button { color: inherit }` unlayered, which beats a `text-*` utility
                   on the button itself — and "the version number is green/red" is the literal ask. -->
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium tabular-nums transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-70"
                :disabled="updateApplying"
                @click="onVersionClick"
              >
                <RefreshCw
                  v-if="updateChecking || updateApplying"
                  class="size-3.5 animate-spin"
                  :class="versionColorClass"
                />
                <span :class="versionColorClass">{{ updateStatus?.currentVersion ?? '—' }}</span>
                <span v-if="updateStatus?.currentCommit" class="text-muted-foreground/80">
                  · {{ updateStatus.currentCommit.slice(0, 7) }}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{{ versionTip }}</TooltipContent>
          </Tooltip>
        </template>
      </SettingsRow>
      <!-- What the update is DOING, while it does it. The apply request covers minutes of real
           work (a ~100 MB download, or a pull + reinstall + rebuild), and until this existed the
           only feedback was a spinning icon — so a healthy slow update and a hung one looked
           identical. See composables/useUpdates.ts. -->
      <p
        v-if="updateApplying && progressLabel"
        class="px-3.5 pb-2.5 text-xs text-muted-foreground"
        aria-live="polite"
      >
        {{ progressLabel }}
      </p>
      <p v-if="applyMessage" class="px-3.5 pb-2.5 text-xs text-muted-foreground">
        {{ applyMessage }}
        <span v-if="restartRequired">{{ $t('settings.restartGuidance') }}</span>
      </p>
      <p v-if="applyError" class="px-3.5 pb-2.5 text-xs text-destructive">{{ applyError }}</p>

      <!-- the auto-update loop lives with the manual check: one Updates story, one group.
           Single toggle (family-standard "Auto-update" - no separate interval control; the
           daemon checks on a sensible fixed cadence internally). Grays out when there is no
           update source, since it could never fire. -->
      <SettingsRow :icon="CloudCog" :label="$t('settings.autoUpdate')">
        <template #info>
          <InfoHint :text="$t('settings.autoUpdateDescription')" />
        </template>
        <template #control>
          <Switch
            :model-value="autoUpdateEnabled"
            :disabled="noUpdateSource"
            @update:model-value="toggleAutoUpdate"
          />
        </template>
      </SettingsRow>
    </SettingsGroup>

    <!-- cloud sync -->
    <SettingsGroup :label="$t('settings.cloudSyncTitle')">
      <!-- not connected: sign-in CTA -->
      <div v-if="!syncStatus.connected" class="px-3.5 py-2.5">
        <Button variant="outline" class="w-full" @click="goSignIn">
          <Cloud class="text-info" />
          {{ $t('settings.cloudSyncConnectButton') }}
          <ExternalLink class="opacity-70" />
        </Button>
      </div>

      <!-- connected: master toggle + status -->
      <template v-else>
        <SettingsRow :icon="CloudCheck" :label="$t('settings.cloudSyncEnableToggle')">
          <template #info>
            <InfoHint :text="$t('settings.cloudSyncHint')" />
          </template>
          <template #control>
            <Switch :model-value="syncStatus.enabled" @update:model-value="onToggleSyncEnable" />
          </template>
        </SettingsRow>
        <SettingsRow v-if="syncStatus.enabled" :label="piiName(syncStatus.name || syncStatus.email || '')">
          <template #icon>
            <img
              v-if="syncStatus.picture"
              :src="syncStatus.picture"
              alt=""
              class="size-4.5 shrink-0 rounded-full object-cover"
            />
            <User v-else class="size-4.5 shrink-0 text-muted-foreground" />
          </template>
          <template #control>
            <span class="text-xs text-muted-foreground">{{ syncedLabel }}</span>
            <Button variant="ghost" size="sm" :disabled="syncBusy" @click="onSyncNow">
              <RefreshCw :class="syncBusy ? 'animate-spin' : ''" />
              {{ syncBusy ? $t('settings.cloudSyncSyncing') : $t('settings.cloudSyncSyncNow') }}
            </Button>
          </template>
        </SettingsRow>
        <SettingsRow>
          <template #icon><LogOut class="size-4.5 shrink-0 text-muted-foreground" /></template>
          <template #label>
            {{ confirmDisconnect ? $t('settings.cloudSyncConfirmDisconnect') : $t('settings.cloudSyncDisconnect') }}
          </template>
          <template #control>
            <Button
              :variant="confirmDisconnect ? 'destructive' : 'ghost'"
              size="sm"
              :disabled="syncBusy"
              @click="onDisconnect"
              @blur="confirmDisconnect = false"
            >
              <CloudOff />
              {{ $t('settings.cloudSyncDisconnect') }}
            </Button>
          </template>
        </SettingsRow>
      </template>
      <p v-if="syncError" class="px-3.5 pb-2.5 text-xs text-destructive">{{ syncError }}</p>
    </SettingsGroup>

    <!-- No Accounts group here anymore. It listed only LEGACY pasted credentials, which are
         nobody's normal path since accounts arrived by signing an instance in, so for almost
         everyone it rendered as a section whose entire content was "no accounts yet" above a
         note telling you to go to the Instances tab. A settings section that exists to redirect
         you elsewhere is a dead end, not a setting (owner request). The per-account monitor
         overrides list accounts where they actually mean something, and DELETE
         /api/accounts stays for the rare leftover credential. The monitor's per-account
         switches moved with it to the queue drawer's scheduler settings. -->
  </div>
</template>
