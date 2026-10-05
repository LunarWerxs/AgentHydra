<script setup lang="ts">
import {
  BarChart3,
  Bot,
  Boxes,
  ChevronDown,
  Layers,
  ListChecks,
  Maximize2,
  MessagesSquare,
  Minimize2,
  Monitor,
  Moon,
  Power,
  RotateCw,
  Settings2,
  Sun,
  Terminal,
} from '@lucide/vue'
import { computed, onMounted, onUnmounted, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import AnalyticsView from '@/components/AnalyticsView.vue'
import AutomationSettings from '@/components/AutomationSettings.vue'
import CliMayteView from '@/components/CliMayteView.vue'
import CliView from '@/components/CliView.vue'
import HSwarmView from '@/components/HSwarmView.vue'
import InstancesHomeView from '@/components/InstancesHomeView.vue'
import InstancesView from '@/components/InstancesView.vue'
import PageSettingsDialog from '@/components/PageSettingsDialog.vue'
import QueueBuilder from '@/components/QueueBuilder.vue'
import QueueView from '@/components/QueueView.vue'
import SchedulerStatus from '@/components/SchedulerStatus.vue'
import SettingsView from '@/components/SettingsView.vue'
import ShortcutSheet from '@/components/ShortcutSheet.vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useData } from '@/composables/useData'
import { useNotifications } from '@/composables/useNotifications'
import { usePanels } from '@/composables/usePanels'
import { useRunningCode } from '@/composables/useRunningCode'
import { SHELL_BASE_MAX, useShellWidth } from '@/composables/useShellWidth'
import { openShortcutSheet, useShortcuts } from '@/composables/useShortcuts'
import { type AppView, useUiPrefs } from '@/composables/useUiPrefs'
import { useUpdates } from '@/composables/useUpdates'
import { shutdownApp } from '@/lib/api'
import { INSTANCES_VIEWS, OPEN_VIEW } from '@/lib/app-view'
import {
  deskInstanceAsk,
  deskWorkerAsk,
  EMBEDDED,
  findInstanceRow,
  flashRow,
  openInDesk,
  publishSidebar,
  showSessionsInDesk,
} from '@/lib/desk-embed'
import { pendingSessionJump, takeSessionJump } from '@/lib/session-jump'
import { REBRAND_NOTICE_KEY } from '@/lib/storage-rebrand'
import { type ThemeMode, useTheme } from '@/lib/theme'
import { applyWindowSizeHint } from '@/lib/window-size-hint'
import DiscordMark from '@/shell/DiscordMark.vue'
import Sidebar from '@/shell/Sidebar.vue'
import { usePushPanel } from '@/shell/usePushPanel'

// The studio's one invite link, never expiring (the same one every product carries).
const DISCORD_URL = 'https://lunarwerx.com/discord/agenthydra'

// A portable (--app) window forwarded into an already-running Chromium instance ignores
// --window-size and the saved placement; the daemon/tray tag its URL with the size it should
// be and we correct it here before first paint. No-op in a browser tab or on an un-hinted URL.
applyWindowSizeHint()

const { t } = useI18n()

const { queue, startPolling } = useData()
// Reset notifications. The NATIVE notification is raised by the daemon whether or not this window
// exists (that is the point of it); this mirror is so the news also lands in the app when you do
// happen to be looking at it, with the Acknowledge action that stops persistent mode repeating.
const { startPolling: startNotificationPolling } = useNotifications()

// Which tab you were on, remembered across reloads — and across the daemon landing on a different
// port, which is a different browser origin and therefore a different localStorage. Owned by
// composables/useUiPrefs.ts, which is where every mirrored layout preference lives.
const { view } = useUiPrefs()
// "Open this chat" asked from another view (the Instances move dialog lists chats; clicking one
// should land on its transcript). Hydra Desk 2's copy has no Sessions tab (Michael, 2026-10-04: the
// cloud list is the same thing): Desk opens the chat in its own view (lib/desk-embed.ts).
watch(pendingSessionJump, (j) => {
  if (j) openInDesk(takeSessionJump() ?? j)
})

// In Desk, CliMayte and HSwarm draw their sidebar in Desk's own (lib/desk-embed.ts useDeskSidebar); any
// other tab has none, so Desk shows its cloud list beside it.
const DESK_SIDEBAR_VIEWS: readonly AppView[] = ['climayte', 'hswarm']
if (EMBEDDED) {
  watch(
    view,
    (v) => {
      if (!DESK_SIDEBAR_VIEWS.includes(v)) publishSidebar(null)
    },
    { immediate: true },
  )
}
// Desk's sidebar asked for a CliMayte task: on its tab, which opens it (CliMayteView takes the ask).
watch(deskWorkerAsk, (id) => {
  if (id) view.value = 'climayte'
})
// Desk's session header asked for an account's row in Instances: its table (desktop or CLI), else the
// other one, scrolled to and marked.
watch(deskInstanceAsk, async (ask) => {
  if (!ask) return
  deskInstanceAsk.value = null
  const other = ask.kind === 'cli' ? 'desktop' : 'cli'
  for (const [tab, wait] of [
    [ask.kind, 4000],
    [other, 2500],
  ] as const) {
    view.value = tab
    const row = await findInstanceRow(ask.num, wait)
    if (row) return flashRow(row)
  }
  view.value = ask.kind
  toast(t('app.deskInstanceMissing', { num: ask.num }))
})

// The shell's own bindings — global, so they are on every view and lead the `?` sheet. Registered
// here rather than in each view because that is what makes them true everywhere.
useShortcuts([
  {
    keys: '?',
    labelKey: 'app.shortcutShowSheet',
    groupKey: 'app.shortcutGroupApp',
    run: openShortcutSheet,
  },
  {
    keys: 'mod+2',
    labelKey: 'app.shortcutClimayte',
    groupKey: 'app.shortcutGroupApp',
    run: () => {
      view.value = 'climayte'
    },
  },
  {
    keys: 'mod+3',
    labelKey: 'app.shortcutInstances',
    groupKey: 'app.shortcutGroupApp',
    run: () => {
      view.value = 'instances-home'
    },
  },
  {
    keys: 'mod+4',
    labelKey: 'app.shortcutAnalytics',
    groupKey: 'app.shortcutGroupApp',
    run: () => {
      view.value = 'analytics'
    },
  },
  {
    keys: 'mod+5',
    labelKey: 'app.shortcutCli',
    groupKey: 'app.shortcutGroupApp',
    run: () => {
      view.value = 'cli'
    },
  },
  {
    keys: 'mod+6',
    labelKey: 'app.shortcutDesktop',
    groupKey: 'app.shortcutGroupApp',
    run: () => {
      view.value = 'desktop'
    },
  },
  {
    keys: 'mod+7',
    labelKey: 'app.shortcutHswarm',
    groupKey: 'app.shortcutGroupApp',
    run: () => {
      view.value = 'hswarm'
    },
  },
])

// settings + queue share the right edge; usePanels keeps them mutually exclusive
const { settingsOpen, queueOpen, openSettingsTab, automationOpen } = usePanels()
// The passive "a newer version exists" signal — see the dot on the Settings button below.
const {
  updateAvailable,
  showUpdateDot,
  dismissUpdateDot,
  startAvailabilityPolling,
  stopAvailabilityPolling,
} = useUpdates()

/**
 * Opening Settings from the header button.
 *
 * With an update waiting this is a DEEP LINK rather than a plain toggle: the dot is the only
 * thing telling you a new version exists and it says nothing about what or why, so the click it
 * invites should land on the answer. openSettingsTab scrolls to the updates card and pulses it
 * (SettingsView's flashSection), and the dot goes quiet for the rest of this run — it has been
 * seen. Next launch it comes back, because the update is still there.
 *
 * With nothing waiting it stays an ordinary open/close toggle: deep-linking every click would
 * yank a user who just wanted the top of the page down to a card they did not ask for.
 */
function onSettingsButton() {
  // Already open: this click means CLOSE, whatever the dot says. Deep-linking here would make the
  // button stop closing the panel for as long as an update is pending, which is the button's
  // primary job.
  if (settingsOpen.value) {
    settingsOpen.value = false
    return
  }
  if (showUpdateDot.value) {
    dismissUpdateDot()
    openSettingsTab('updates')
    return
  }
  settingsOpen.value = true
}
const anyPanelOpen = computed(() => settingsOpen.value || queueOpen.value)
const { fullWidth } = useShellWidth()
// widthPx drives the content shift, the --content-inset-right var, and both panels'
// rendered width below — one value so they can never disagree. shellMaxWidth makes the
// shift the panel's actual overlap with the centered shell (0 on a wide monitor); in
// full-width mode there is no centered shell, so it is null and the shift is the whole panel.
// shiftPx reaches the template as the --push-shift custom property on the shell: the main
// column pads by exactly that, and the header by that plus its own 16px of breathing room
// (--header-pe), or its buttons would sit flush against the panel edge.
const { side, shiftPx, widthPx } = usePushPanel(anyPanelOpen, {
  widthPx: 480,
  shellMaxWidth: () => (fullWidth.value ? null : SHELL_BASE_MAX),
})

// --- settings-panel header controls: theme picker + shut down (moved out of the Appearance
// section into icons beside the panel's ✕, owner request) ---------------------------------------
const { mode: themeMode, isDark, setTheme } = useTheme()
// Reflect the ACTIVE theme in the trigger glyph: sun/moon for an explicit light/dark, a monitor
// for "follow the system".
const themeIcon = computed(() =>
  themeMode.value === 'system' ? Monitor : isDark.value ? Moon : Sun,
)

// Two-step so an errant click can't kill the app: first click arms (button turns red + tooltip
// changes), second confirms. Loses the armed state on blur, matching the cloud-sync disconnect.
const confirmShutdown = ref(false)
async function onShutdown() {
  if (!confirmShutdown.value) {
    confirmShutdown.value = true
    return
  }
  confirmShutdown.value = false
  toast(t('settings.shutdownToast'))
  try {
    await shutdownApp()
  } catch {
    // The daemon answers { ok } BEFORE it exits, so a rejection here is a genuine failure (not just
    // the socket dropping as it goes down).
    toast.error(t('settings.shutdownToastFailed'))
  }
}

// Top-level tabs. Instances is a group: clicking it opens the landing page, and its two sub-pages
// sit in a hover dropdown. The group reads as active on any of its three views.
const nav: { id: AppView; labelKey: string; icon: typeof MessagesSquare }[] = [
  { id: 'climayte', labelKey: 'app.tabClimayte', icon: Bot },
  { id: 'instances-home', labelKey: 'app.tabInstances', icon: Boxes },
  { id: 'analytics', labelKey: 'app.tabAnalytics', icon: BarChart3 },
  { id: 'hswarm', labelKey: 'app.tabHswarm', icon: Layers },
]
const instancesSub: { id: AppView; labelKey: string; icon: typeof Terminal }[] = [
  { id: 'cli', labelKey: 'app.tabCli', icon: Terminal },
  { id: 'desktop', labelKey: 'app.tabDesktop', icon: Monitor },
]
const inInstances = computed(() => INSTANCES_VIEWS.includes(view.value))
function tabActive(id: AppView) {
  return id === 'instances-home' ? inInstances.value : view.value === id
}

// Instances dropdown: opens on mouse hover (closing ~150 ms after the pointer leaves both the tab and
// the menu), on ArrowDown from the tab, on Enter/Space on the chevron, and on a tap of the chevron.
// Only keyboard opens move focus into the menu; a hover must not steal it.
const instancesMenuOpen = ref(false)
let instancesMenuViaKeyboard = false
let instancesCloseTimer: ReturnType<typeof setTimeout> | undefined
function cancelInstancesClose() {
  clearTimeout(instancesCloseTimer)
}
function hoverInstances(e: PointerEvent) {
  if (e.pointerType === 'touch') return
  cancelInstancesClose()
  instancesMenuOpen.value = true
}
function leaveInstances(e: PointerEvent) {
  if (e.pointerType === 'touch') return
  cancelInstancesClose()
  instancesCloseTimer = setTimeout(() => {
    instancesMenuOpen.value = false
  }, 150)
}
function setInstancesMenu(open: boolean) {
  cancelInstancesClose()
  instancesMenuOpen.value = open
}
function onInstancesTabKeydown(e: KeyboardEvent) {
  // Enter/Space keep their normal job on the tab (open the landing page): keep them from reaching the
  // trigger around it, which would open the menu instead.
  if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
  else if (e.key === 'ArrowDown') instancesMenuViaKeyboard = true
}
function onInstancesChevronPointerdown(e: PointerEvent) {
  // With a mouse the hover already opened the menu: a click must not toggle it shut again.
  if (e.pointerType === 'mouse') {
    e.stopPropagation()
    setInstancesMenu(true)
  }
}
function onInstancesChevronKeydown() {
  instancesMenuViaKeyboard = true
}
function onInstancesOpenAutoFocus(e: Event) {
  if (!instancesMenuViaKeyboard) e.preventDefault()
  instancesMenuViaKeyboard = false
}
function pickInstancesSub(id: AppView) {
  view.value = id
  setInstancesMenu(false)
}

// The landing page names the page a tile opens in its own words: its `instances` is the desktop page.
function onHomeNavigate(
  to: 'cli' | 'instances' | 'climayte' | 'sessions' | 'analytics' | 'hswarm',
) {
  if (to === 'sessions') showSessionsInDesk()
  else view.value = to === 'instances' ? 'desktop' : to
}

provide(OPEN_VIEW, (v: AppView) => {
  view.value = v
})

const runningCount = computed(() => queue.value.filter((q) => q.status === 'running').length)

// The "Sync my settings with Connections" sign-in (SettingsView.vue) opens /oauth/login in a
// NEW tab; that tab's SPA boots fresh here and lands back on ?connected=1 / ?connect=failed
// after the daemon's /oauth/callback redirect. Surface the outcome, open Settings so the
// result is visible, and strip the query param so a refresh doesn't re-trigger the toast.
function handleConnectRedirect() {
  const params = new URLSearchParams(window.location.search)
  const connected = params.get('connected')
  const failed = params.get('connect')
  if (!connected && !failed) return
  params.delete('connected')
  params.delete('connect')
  const query = params.toString()
  window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''))
  settingsOpen.value = true
  if (connected === '1') toast.success(t('settings.cloudSyncEnableToggle'))
  else if (failed === 'failed') toast.error(t('settings.cloudSyncConnectFailed'))
}

// One-time rename notice, shown only to installs that carried CC Manager UI state across (the
// carry-over in lib/storage-rebrand sets the flag). Cleared before the toast is raised, not after
// it is dismissed: an unread toast that survives a reload would follow the user around forever,
// and the same explanation lives permanently in the README and changelog.
function showRebrandNoticeOnce() {
  try {
    if (localStorage.getItem(REBRAND_NOTICE_KEY) !== '1') return
    localStorage.removeItem(REBRAND_NOTICE_KEY)
  } catch {
    return // storage blocked; the notice is not worth a broken mount
  }
  toast(t('app.rebrandTitle'), {
    description: t('app.rebrandBody'),
    duration: 30_000,
    action: {
      label: t('app.rebrandAction'),
      onClick: () =>
        window.open('https://github.com/LunarWerxs/AgentHydra/blob/main/CHANGELOG.md', '_blank'),
    },
  })
}

onMounted(startPolling)
onMounted(() => startNotificationPolling(t))
onMounted(handleConnectRedirect)
onMounted(showRebrandNoticeOnce)
// Reads the daemon's LAST background check — a memory read, no network from the daemon's side and
// nothing that delays boot. See composables/useUpdates.ts.
onMounted(startAvailabilityPolling)
// "The daemon is older than its folder": see composables/useRunningCode.ts.
const {
  restartNeeded,
  bootCommit,
  diskCommit,
  restarting,
  restartError,
  restart: restartDaemonNow,
  start: startRunningCodePolling,
  stop: stopRunningCodePolling,
} = useRunningCode()
onMounted(startRunningCodePolling)
onUnmounted(stopRunningCodePolling)
const restartTitle = computed(() =>
  restartError.value
    ? t('app.restartFailed', { reason: restartError.value })
    : t('app.restartNeededHint', {
        boot: bootCommit.value?.slice(0, 7) ?? '?',
        disk: diskCommit.value?.slice(0, 7) ?? '?',
      }),
)
onUnmounted(stopAvailabilityPolling)
</script>

<template>
  <!-- TooltipProvider: required ancestor for every kit Tooltip/InfoHint (mounted once, like ReDesign) -->
  <TooltipProvider :delay-duration="120">
  <!-- fixed-viewport shell, centered at a comfortable reading width: each view scrolls
       its own columns internally; the page itself never scrolls. The header's full-width
       toggle lifts the cap altogether; 100vw rather than `none` so max-width still animates. -->
  <div
    class="mx-auto flex h-dvh w-full max-w-(--shell-max) flex-col overflow-hidden border-x border-border transition-max-width duration-300 ease-in-out"
    :style="{
      '--shell-max': fullWidth ? '100vw' : `${SHELL_BASE_MAX}px`,
      '--push-shift': `${shiftPx}px`,
      '--header-pe': `calc(${shiftPx}px + 1rem)`,
    }"
  >
    <!-- top bar (borderless: the content columns carry their own separators). Shares the
         push-panel padding shift with the main content, or an open drawer would cover the
         right-side buttons instead of nudging them over. -->
    <header
      class="flex shrink-0 items-center gap-3 bg-sidebar ps-4 pe-(--header-pe) py-2 transition-padding duration-300 ease-in-out"
    >
      <div class="flex items-center gap-2.5">
        <!-- the real brand mark (same asset as the favicon/tray icon), not a placeholder glyph -->
        <img src="/favicon.svg" alt="" class="size-8 rounded-lg" />
        <span class="hidden text-sm font-bold tracking-tight min-[480px]:inline">AgentHydra</span>
      </div>

      <!-- view tabs -->
      <nav class="ms-2 flex items-start gap-1" :aria-label="$t('app.navLabel')">
        <template v-for="n in nav" :key="n.id">
          <!-- Instances: the tab opens the landing page; hovering it (or its chevron) drops down CLI and Desktop -->
          <DropdownMenu
            v-if="n.id === 'instances-home'"
            :open="instancesMenuOpen"
            :modal="false"
            @update:open="setInstancesMenu"
          >
            <DropdownMenuTrigger as-child>
              <div
                class="flex items-center"
                @pointerenter="hoverInstances"
                @pointerleave="leaveInstances"
              >
                <Button
                  :variant="tabActive(n.id) ? 'secondary' : 'ghost'"
                  size="sm"
                  :title="$t(n.labelKey)"
                  :aria-current="view === n.id ? 'page' : tabActive(n.id) ? 'true' : undefined"
                  @pointerdown.stop
                  @keydown="onInstancesTabKeydown"
                  @click="view = n.id"
                >
                  <component :is="n.icon" />
                  <span class="hidden sm:inline">{{ $t(n.labelKey) }}</span>
                </Button>
                <Button
                  :variant="tabActive(n.id) ? 'secondary' : 'ghost'"
                  size="icon-sm"
                  class="-ms-1 w-5"
                  :aria-label="$t('app.instancesMenu')"
                  @pointerdown="onInstancesChevronPointerdown"
                  @keydown="onInstancesChevronKeydown"
                >
                  <ChevronDown class="size-3" />
                </Button>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              :aria-label="$t('app.instancesMenu')"
              @open-auto-focus="onInstancesOpenAutoFocus"
              @close-auto-focus.prevent
              @pointerenter="hoverInstances"
              @pointerleave="leaveInstances"
            >
              <DropdownMenuItem
                v-for="sub in instancesSub"
                :key="sub.id"
                :class="view === sub.id ? 'bg-secondary text-foreground' : ''"
                :aria-current="view === sub.id ? 'page' : undefined"
                @select="pickInstancesSub(sub.id)"
              >
                <component :is="sub.icon" />
                {{ $t(sub.labelKey) }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            v-else
            :variant="tabActive(n.id) ? 'secondary' : 'ghost'"
            size="sm"
            :title="$t(n.labelKey)"
            :aria-current="view === n.id ? 'page' : tabActive(n.id) ? 'true' : undefined"
            @click="view = n.id"
          >
            <component :is="n.icon" />
            <span class="hidden sm:inline">{{ $t(n.labelKey) }}</span>
          </Button>
        </template>
      </nav>

      <div class="ms-auto flex items-center gap-2">
        <!-- always-on "is it working?" indicator: scheduler state + live run / next-run -->
        <SchedulerStatus />
        <!-- New run lives inside the queue drawer's toolbar (QueueView) now, so the header
             carries just the queue toggle + settings. -->
        <!-- queue drawer toggle: stays available on every view. Brand-purple (primary)
             at rest; this is now the ONE queue button, so it carries the accent the
             old in-chat one had; secondary while the drawer is open (pressed state). -->
        <Button
          :variant="queueOpen ? 'secondary' : 'default'"
          size="sm"
          :title="$t('app.queue')"
          :aria-pressed="queueOpen"
          @click="queueOpen = !queueOpen"
        >
          <ListChecks />
          <span class="hidden sm:inline">{{ $t('app.queue') }}</span>
          <span
            v-if="runningCount > 0"
            class="ms-0.5 inline-flex size-4 items-center justify-center rounded-full text-3xs font-semibold"
            :class="queueOpen ? 'bg-info/15 text-info' : 'bg-primary-foreground/25 text-primary-foreground'"
          >
            {{ runningCount }}
          </span>
        </Button>
        <!-- Only when the daemon is serving older code than its folder (a commit or pull without a
             restart): new routes and tools are missing until it restarts, and nothing else on
             screen would say why. One click relaunches it in place and reloads the page. -->
        <Button
          v-if="restartNeeded"
          variant="outline"
          size="sm"
          :disabled="restarting"
          :title="restartTitle"
          @click="restartDaemonNow"
        >
          <RotateCw :class="restarting ? 'animate-spin' : ''" />
          <span class="hidden sm:inline">{{ $t(restarting ? 'app.restarting' : 'app.restartNeeded') }}</span>
        </Button>
        <!-- Full window width and back (owner, 2026-10-03). Remembered across reloads; off is the
             centered shell exactly as before. The tooltip names
             the click's effect; the label stays constant and aria-pressed carries the state. -->
        <Button
          variant="ghost"
          size="icon-sm"
          :title="fullWidth ? $t('app.shellFitWidth') : $t('app.shellFullWidth')"
          :aria-label="$t('app.shellFullWidth')"
          :aria-pressed="fullWidth"
          @click="fullWidth = !fullWidth"
        >
          <component :is="fullWidth ? Minimize2 : Maximize2" />
        </Button>
        <!-- The update hint lives HERE, on the button that leads to the update controls, rather
             than as a banner or a toast. A newer version is not urgent — it does not want the
             screen — but it does have to be visible without going looking for it, and that was the
             whole failure: the only code that ever checked was the Settings screen's own onMounted,
             so a user who never opened Settings was never told. A dot on the door to the thing is
             the smallest signal that still reaches someone who isn't already there. -->
        <!-- The studio's Discord, as a plain icon: this is the page people keep open and come
             back to, so it carries the invite quietly rather than the landing pages' floating
             badge (owner, 2026-09-27). -->
        <Button variant="ghost" size="icon-sm" as-child>
          <a :href="DISCORD_URL" target="_blank" rel="noopener noreferrer" :title="$t('app.discord')" :aria-label="$t('app.discord')">
            <DiscordMark />
          </a>
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          class="relative"
          :title="updateAvailable ? $t('app.settingsUpdateAvailable') : $t('app.settings')"
          :aria-pressed="settingsOpen"
          @click="onSettingsButton"
        >
          <Settings2 />
          <span
            v-if="showUpdateDot"
            class="absolute right-0.5 top-0.5 size-2 rounded-full bg-info ring-2 ring-background"
          />
        </Button>
      </div>
    </header>

    <!-- main (pushes left when a right-docked panel overlaps the shell) -->
    <div class="min-h-0 flex-1 pe-(--push-shift) transition-padding duration-300 ease-in-out">
      <main
        class="h-full min-h-0"
        :class="inInstances ? 'overflow-y-auto scroll-slim' : ''"
      >
        <Transition name="view-fade" mode="out-in">
          <AnalyticsView v-if="view === 'analytics'" />
          <CliMayteView v-else-if="view === 'climayte'" class="h-full" />
          <InstancesHomeView v-else-if="view === 'instances-home'" @navigate="onHomeNavigate" />
          <CliView v-else-if="view === 'cli'" />
          <HSwarmView v-else-if="view === 'hswarm'" />
          <InstancesView v-else />
        </Transition>
      </main>
    </div>

    <QueueBuilder />

    <!-- queue: a push-in drawer so the list rides alongside whatever you're doing -->
    <Sidebar
      v-model:open="queueOpen"
      :side="side"
      :title="$t('queue.title')"
      :width-px="widthPx"
      body-class="flex min-h-0 flex-1 flex-col"
    >
      <QueueView />
    </Sidebar>

    <!-- settings: the shared push-in panel. Custom header carries the theme picker + shut-down
         icons beside the panel's ✕ (owner request). -->
    <Sidebar v-model:open="settingsOpen" :side="side" :title="$t('app.settings')" :width-px="widthPx">
      <template #header>
        <span class="text-xs font-semibold">{{ $t('app.settings') }}</span>
        <div class="ms-auto flex items-center gap-0.5">
          <!-- theme picker (moved out of the Appearance section) -->
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon-sm" :title="$t('settings.themeLabel')">
                <component :is="themeIcon" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="max-w-44">
              <DropdownMenuRadioGroup
                :model-value="themeMode"
                @update:model-value="(v) => setTheme(v as ThemeMode)"
              >
                <DropdownMenuRadioItem value="light"><Sun /> {{ $t('settings.themeLight') }}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark"><Moon /> {{ $t('settings.themeDark') }}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system"><Monitor /> {{ $t('settings.themeSystem') }}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <!-- shut down: closes the whole app (window + daemon + tray). Two-step to prevent a
               mis-click; see onShutdown. -->
          <Button
            :variant="confirmShutdown ? 'destructive' : 'ghost'"
            size="icon-sm"
            :title="confirmShutdown ? $t('settings.shutdownConfirmTooltip') : $t('settings.shutdownTooltip')"
            @click="onShutdown"
            @blur="confirmShutdown = false"
          >
            <Power />
          </Button>
        </div>
      </template>
      <!-- No Save button: every setting saves as it changes. The footer's button only flushed the
           scheduler's numbers, which moved to the queue's automation settings and save on blur. -->
      <SettingsView />
    </Sidebar>

    <!-- The queue's scheduler and auto-resume settings, opened from the queue drawer and the
         header's scheduler chip (usePanels.openAutomation). -->
    <PageSettingsDialog v-model:open="automationOpen" :title="$t('queue.automationTitle')">
      <AutomationSettings />
    </PageSettingsDialog>

    <!-- close-button: vue-sonner defaults it OFF, which left every toast in the app dismissable
         only by waiting it out or clicking its body. The plain ones showed it worst — an
         "Auto-updates enabled" success toast carries no action button either, so it had no
         controls at all. The kit's wrapper (components/ui/sonner/Sonner.vue) already ships the
         close glyph and pins it top-right, so this is switching on a control that was built and
         never enabled, not adding one. -->
    <ShortcutSheet />
    <Toaster close-button />
  </div>
  </TooltipProvider>
</template>
