<script setup lang="ts">
import { BarChart3, Boxes, Layers, Maximize2, Minimize2, RotateCw } from '@lucide/vue'
import {
  type Component,
  computed,
  KeepAlive,
  onMounted,
  onUnmounted,
  provide,
  ref,
  watch,
} from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import PageSettingsDialog from '@/components/PageSettingsDialog.vue'
import SchedulerStatus from '@/components/SchedulerStatus.vue'
import ShortcutSheet from '@/components/ShortcutSheet.vue'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useBuilder } from '@/composables/useBuilder'
import { useData } from '@/composables/useData'
import { INSTANCE_KINDS, useInstanceFilter } from '@/composables/useInstanceFilter'
import { useNotifications } from '@/composables/useNotifications'
import { usePanels } from '@/composables/usePanels'
import { useRunningCode } from '@/composables/useRunningCode'
import { SHELL_BASE_MAX, useShellWidth } from '@/composables/useShellWidth'
import { openShortcutSheet, useShortcuts } from '@/composables/useShortcuts'
import { type AppView, useUiPrefs } from '@/composables/useUiPrefs'
import { useUpdates } from '@/composables/useUpdates'
import { hswarmNodeAsk, OPEN_VIEW } from '@/lib/app-view'
import { freeThreadAsk } from '@/lib/free-instances'
import { lazyView, prefetchViews } from '@/lib/lazy-view'
import {
  deskInstanceAsk,
  deskWorkerAsk,
  deskSwarmAsk,
  EMBEDDED,
  findInstanceRow,
  flashRow,
  openInDesk,
  openSettingsInDesk,
  PANE_OPEN_EVENT,
  resendSidebar,
  setDeskView,
  showUpdateDotInDesk,
  TITLE_BAR_ATTR,
} from '@/lib/desk-embed'
import { refreshForView } from '@/lib/warm-data'
import { startWarmData } from '@/lib/warm-kinds'
import { pendingSessionJump, takeSessionJump } from '@/lib/session-jump'
import { REBRAND_NOTICE_KEY } from '@/lib/storage-rebrand'
import { useTheme } from '@/lib/theme'
import { applyWindowSizeHint } from '@/lib/window-size-hint'
import DiscordMark from '@/shell/DiscordMark.vue'
import Sidebar from '@/shell/Sidebar.vue'
import { usePushPanel } from '@/shell/usePushPanel'

// Each tab's view loads the first time its tab opens, so the pane starts with the shell and the one
// view in front of it, not the whole graph (charts included).
// The builder is loaded and mounted on the first request; useBuilder opens it once it is there.
const { requested: builderEverOpened, builderMounted } = useBuilder()
const AutomationSettings = lazyView(() => import('@/components/AutomationSettings.vue'))
const QueueBuilder = lazyView(() => import('@/components/QueueBuilder.vue'))
const QueueView = lazyView(() => import('@/components/QueueView.vue'))
const AnalyticsView = lazyView(() => import('@/components/AnalyticsView.vue'))
const HSwarmView = lazyView(() => import('@/components/HSwarmView.vue'))
const InstancesView = lazyView(() => import('@/components/InstancesView.vue'))

// The studio's one invite link, never expiring (the same one every product carries).
const DISCORD_URL = 'https://lunarwerx.com/discord/agenthydra'

// A portable (--app) window forwarded into an already-running Chromium instance ignores
// --window-size and the saved placement; the daemon/tray tag its URL with the size it should
// be and we correct it here before first paint. No-op in a browser tab or on an un-hinted URL.
applyWindowSizeHint()

const { t } = useI18n()

const { startPolling } = useData()
// Reset notifications. The NATIVE notification is raised by the daemon whether or not this window
// exists (that is the point of it); this mirror is so the news also lands in the app when you do
// happen to be looking at it, with the Acknowledge action that stops persistent mode repeating.
const { startPolling: startNotificationPolling } = useNotifications()

// Which tab you were on, remembered across reloads — and across the daemon landing on a different
// port, which is a different browser origin and therefore a different localStorage. Owned by
// composables/useUiPrefs.ts, which is where every mirrored layout preference lives.
const { view, viewReady } = useUiPrefs()
// The first reveal of the held tab body is instant; the fade is for tab switches after it.
const viewFadeOn = ref(viewReady.value)
watch(viewReady, (ready) => ready && (viewFadeOn.value = true), { flush: 'post' })
// "Open this chat" asked from another view (the Instances move dialog lists chats; clicking one
// should land on its transcript). Hydra Desk 2's copy has no Sessions tab (Michael, 2026-10-04: the
// cloud list is the same thing): Desk opens the chat in its own view (lib/desk-embed.ts).
watch(pendingSessionJump, (j) => {
  if (j) openInDesk(takeSessionJump() ?? j)
})

// In Desk, the tab on screen decides Desk's sidebar (lib/desk-embed.ts): the HSwarm tab's is its tree
// (HSwarmView useDeskSidebar), and any other tab has none, so Desk shows its cloud list beside it.
if (EMBEDDED) watch(view, (v) => setDeskView(v), { immediate: true })
// A click on the tab already on screen changes nothing here, so it sends Desk that tab's sidebar again:
// the one thing anyone tries when the sidebar beside it looks wrong.
function pickTab(id: AppView) {
  if (view.value === id) resendSidebar()
  view.value = id
}
// CliMayte has no tab of its own: it is a node of the HSwarm tab's tree (owner, 2026-10-05: "CliMayte
// should also be an item under that").
function openClimayte() {
  hswarmNodeAsk.value = 'climayte'
  view.value = 'hswarm'
}
watch(freeThreadAsk, (ask) => { if (ask) openClimayte() }, { flush: 'sync' })
// "Open HSwarm" from a stats card (its numbers are HSwarm's savings): the Savings node, not whatever node
// the tree showed last, CliMayte's included.
function openHswarmSavings() {
  hswarmNodeAsk.value = 'savings'
  view.value = 'hswarm'
}
// Desk's sidebar asked for a CliMayte task: the HSwarm tab on its CliMayte node, which opens it
// (CliMayteView takes the ask). Sync, so the tab is switched before anything takes the ask.
watch(
  deskWorkerAsk,
  (id) => {
    if (id) openClimayte()
  },
  { flush: 'sync' },
)
// Desk's sidebar asked for an HSwarm job: the HSwarm tab, whose tree selects that job (HSwarmView takes the ask).
watch(
  deskSwarmAsk,
  (ask) => {
    if (ask) view.value = 'hswarm'
  },
  { flush: 'sync' },
)
// Desk's session header asked for an account's row in Instances: its kind is drawn again if it was left
// out, the row is scrolled to and marked; the other kinds are tried after it.
watch(deskInstanceAsk, async (ask) => {
  if (!ask) return
  deskInstanceAsk.value = null
  view.value = 'instances'
  const { showKind } = useInstanceFilter()
  const others = INSTANCE_KINDS.filter((k) => k !== ask.kind)
  for (const [kind, wait] of [
    [ask.kind, 4000],
    ...others.map((k) => [k, 2500] as const),
  ] as const) {
    showKind(kind)
    const row = await findInstanceRow(ask.num, kind, wait)
    if (row) return flashRow(row)
  }
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
    run: openClimayte,
  },
  {
    keys: 'mod+3',
    labelKey: 'app.shortcutInstances',
    groupKey: 'app.shortcutGroupApp',
    run: () => {
      view.value = 'instances'
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
    keys: 'mod+7',
    labelKey: 'app.shortcutHswarm',
    groupKey: 'app.shortcutGroupApp',
    run: () => {
      view.value = 'hswarm'
    },
  },
])

// The queue drawer docks on the right edge. Settings are Desk's (its Settings dialog holds this
// window's settings since 2026-10-06), and this window has no gear of its own: Desk's Settings gear,
// bottom left, is always there (owner, 2026-10-06).
const { queueOpen, automationOpen } = usePanels()
// The passive "a newer version exists" signal. Its dot sits on Desk's Settings gear, the door to the
// update controls: a newer version is not urgent, but it has to be visible without going looking for
// it. Desk opens Settings on Updates while it shows, and quiets it for the rest of its run.
const { showUpdateDot, startAvailabilityPolling, stopAvailabilityPolling } = useUpdates()
watch(showUpdateDot, (on) => showUpdateDotInDesk(on), { immediate: true })
const anyPanelOpen = computed(() => queueOpen.value)
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

// Applies the stored theme to this window. Desk has one theme, so there is no picker here and no
// Shut down either: the daemon is Desk's engine.
useTheme()

// Top-level tabs. Instances is one tab: its kind choice (All, Desktop, CLI, Free) sits inside it.
const nav: { id: AppView; labelKey: string; icon: typeof Boxes }[] = [
  { id: 'instances', labelKey: 'app.tabInstances', icon: Boxes },
  { id: 'analytics', labelKey: 'app.tabAnalytics', icon: BarChart3 },
  { id: 'hswarm', labelKey: 'app.tabHswarm', icon: Layers },
]
// The tab on screen. Instances is the fallback, as the v-else chain it replaces was.
const VIEW_COMPONENTS: Partial<Record<AppView, Component>> = {
  analytics: AnalyticsView,
  instances: InstancesView,
  hswarm: HSwarmView,
}
const viewComponent = computed(() => VIEW_COMPONENTS[view.value] ?? InstancesView)
const viewKey = computed(() => (view.value in VIEW_COMPONENTS ? view.value : 'instances'))
const viewProps = computed(() => (view.value === 'hswarm' ? { class: 'h-full' } : {}))

provide(OPEN_VIEW, (v: AppView) => {
  if (v === 'hswarm') openHswarmSavings()
  else view.value = v
})


// The "Sync my settings with Connections" sign-in (Desk's Settings, Connections) opens /oauth/login in
// a NEW tab; a tab that boots this window lands back on ?connected=1 / ?connect=failed after the
// daemon's /oauth/callback redirect. Surface the outcome, open Settings so the result is visible, and
// strip the query param so a refresh doesn't re-trigger the toast.
function handleConnectRedirect() {
  const params = new URLSearchParams(window.location.search)
  const connected = params.get('connected')
  const failed = params.get('connect')
  if (!connected && !failed) return
  params.delete('connected')
  params.delete('connect')
  const query = params.toString()
  window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''))
  openSettingsInDesk()
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
// Preload and warm data: the data kinds load once in the background shortly after first paint (when the
// browser is idle, so the window's own load is never slowed), then refresh about every 2 minutes
// (lib/warm-data.ts). Opening a tab, or the Desk pane, refreshes what it shows right then.
onMounted(() => {
  const go = () => {
    startWarmData()
    prefetchViews()
  }
  if ('requestIdleCallback' in window) window.requestIdleCallback(go, { timeout: 4000 })
  else setTimeout(go, 2000)
})
watch(view, (v) => refreshForView(v), { immediate: true })
const onPaneOpen = () => refreshForView(view.value)
// Escape inside the embedded copy asks Desk to close the pane (keys do not cross frames); a dialog or menu
// that is open gets the key first.
const onEscape = (e: KeyboardEvent) => {
  if (!EMBEDDED || e.key !== 'Escape' || e.defaultPrevented) return
  if (document.querySelector('[role=dialog],[role=menu],[role=listbox]')) return
  window.parent.dispatchEvent(new CustomEvent('hydra-desk:close-hydra'))
}
onMounted(() => {
  window.addEventListener(PANE_OPEN_EVENT, onPaneOpen)
  window.addEventListener('keydown', onEscape)
})
onUnmounted(() => {
  window.removeEventListener(PANE_OPEN_EVENT, onPaneOpen)
  window.removeEventListener('keydown', onEscape)
})
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
       toggle lifts the cap altogether; 100vw rather than `none` so max-width still animates.
       No side borders: the faint lines marked where the narrower column starts and ends
       (owner, 2026-10-04: "shouldn't show the slight left and right vertical lines"). -->
  <div
    class="mx-auto flex h-dvh w-full max-w-(--shell-max) flex-col overflow-hidden transition-max-width duration-300 ease-in-out"
    :style="{
      '--shell-max': fullWidth ? '100vw' : `${SHELL_BASE_MAX}px`,
      '--push-shift': `${shiftPx}px`,
      // Inside Desk 2 with its own title bar, the right end keeps clear of the window's buttons (--desk-pad-right).
      '--header-pe': `calc(${shiftPx}px + max(1rem, var(--desk-pad-right, 0px) + 0.5rem))`,
      '--header-ps': 'max(1rem, var(--desk-pad-left, 0px))',
    }"
  >
    <!-- top bar (borderless: the content columns carry their own separators). Shares the
         push-panel padding shift with the main content, or an open drawer would cover the
         right-side buttons instead of nudging them over. In Desk it is the window's title bar: the page's colour, as
         Desk's own title row is (owner, 2026-10-08: its colour changed at the column's edges), and its empty parts
         drag the window (lib/desk-embed.ts). -->
    <header
      v-bind="{ [TITLE_BAR_ATTR]: '' }"
      class="flex shrink-0 items-center gap-3 ps-(--header-ps) pe-(--header-pe) py-2 transition-padding duration-300 ease-in-out"
      :class="EMBEDDED ? 'bg-background' : 'bg-sidebar'"
    >
      <!-- view tabs (no logo or title: Desk's pane already says where you are, owner 2026-10-05) -->
      <nav class="flex items-start gap-1" :aria-label="$t('app.navLabel')">
        <Button
          v-for="n in nav"
          :key="n.id"
          :variant="view === n.id ? 'secondary' : 'ghost'"
          size="sm"
          :title="$t(n.labelKey)"
          :aria-current="view === n.id ? 'page' : undefined"
          @click="pickTab(n.id)"
        >
          <component :is="n.icon" />
          <span class="hidden sm:inline">{{ $t(n.labelKey) }}</span>
        </Button>
      </nav>

      <div class="ms-auto flex items-center gap-2">
        <!-- always-on "is it working?" indicator: scheduler state + live run / next-run -->
        <SchedulerStatus />
        <!-- The queue button is gone from the bar (owner, 2026-10-05); the queue drawer itself stays. -->
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
        <!-- The studio's Discord, as a plain icon: this is the page people keep open and come
             back to, so it carries the invite quietly rather than the landing pages' floating
             badge (owner, 2026-09-27). -->
        <Button variant="ghost" size="icon-sm" as-child>
          <a :href="DISCORD_URL" target="_blank" rel="noopener noreferrer" :title="$t('app.discord')" :aria-label="$t('app.discord')">
            <DiscordMark />
          </a>
        </Button>
      </div>
    </header>

    <!-- main (pushes left when a right-docked panel overlaps the shell) -->
    <div class="min-h-0 flex-1 pe-(--push-shift) transition-padding duration-300 ease-in-out">
      <main
        class="h-full min-h-0"
        :class="view === 'instances' ? 'overflow-y-auto scroll-slim' : ''"
      >
        <!-- Each tab is built the first time it is opened and then kept (KeepAlive), so switching
             back shows it as it was; its data is the shared warm copy (lib/warm-data.ts). -->
        <Transition name="view-fade" mode="out-in" :css="viewFadeOn">
          <KeepAlive>
            <component :is="viewComponent" v-if="viewReady" :key="viewKey" v-bind="viewProps" />
          </KeepAlive>
        </Transition>
      </main>
    </div>

    <QueueBuilder v-if="builderEverOpened" @vue:mounted="builderMounted" />

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
