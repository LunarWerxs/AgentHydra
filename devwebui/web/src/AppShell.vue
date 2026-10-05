<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { storeToRefs } from "pinia";
import { Plus } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import AppContainer from "@/shell/AppContainer.vue";
import { usePushPanel } from "@/shell/usePushPanel";
import TopBar from "./components/TopBar.vue";
import UpdateBanner from "./components/UpdateBanner.vue";
import SafeModeBanner from "./components/SafeModeBanner.vue";
import ProjectPanel from "./components/ProjectPanel.vue";
import ProcessForm from "./components/ProcessForm.vue";
import AddProjectDialog from "./components/AddProjectDialog.vue";
import Settings from "./components/Settings.vue";
import LogDrawer from "./components/LogDrawer.vue";
import NotificationsDrawer from "./components/NotificationsDrawer.vue";
import AppFooter from "@/shell/AppFooter.vue";
import { useAppStore } from "./store";
import { toast } from "vue-sonner";
import { getSettings, saveSettings, scanForDevWebUI, type ScanResult } from "@/api";
import type { AppNotification, ProcessView } from "@/types";

const { t } = useI18n({ useScope: "global" });

const store = useAppStore();
const { projects, rankedProjects, connected, allProcesses } = storeToRefs(store);

const selected = ref<string | null>(null);
const drawerOpen = ref(false);
const notificationsOpen = ref(false);
const errorsFilter = ref<string | null>(null);
const addOpen = ref(false);
const addScanOnOpen = ref(false);
const addPrefillScan = ref<ScanResult | null>(null);
const settingsOpen = ref(false);
// Any right-side panel (settings, logs, notifications) pushes the page content.
const anyPanel = computed(() => settingsOpen.value || drawerOpen.value || notificationsOpen.value);
// Shell content is centered at the shared `--container-max` token (styles/kit-base.css); keep
// the push panel's content shift limited to its actual overlap with that centered column.
const { side: panelSide, shiftPx: panelShiftPx } = usePushPanel(anyPanel, {
  shellMaxWidth: () => 800,
});

// Process add/edit form state.
const formOpen = ref(false);
const formMode = ref<"add" | "edit">("add");
const formProjectId = ref("");
const formInitial = ref<ProcessView | null>(null);

// Only one right-side panel is visible at a time — opening one closes the others (they dock in
// the same region). `keep` is the panel being opened.
function closeOtherPanels(keep: "settings" | "logs" | "notifications") {
  if (keep !== "settings") settingsOpen.value = false;
  if (keep !== "logs") drawerOpen.value = false;
  if (keep !== "notifications") notificationsOpen.value = false;
}

function openSettings() {
  if (settingsOpen.value) {
    settingsOpen.value = false;
    return;
  }
  closeOtherPanels("settings");
  settingsOpen.value = true;
}

function openLogs(id: string) {
  // Toggle: the same process's logs button closes its open drawer; a different
  // process's button just switches the drawer over to it.
  if (drawerOpen.value && selected.value === id) {
    drawerOpen.value = false;
    return;
  }
  closeOtherPanels("logs");
  selected.value = id;
  drawerOpen.value = true;
}

function openNotifications() {
  // Toggle: a second bell click closes the panel — unless it's showing a single
  // process's errors (openProcessErrors), where the bell means "show me all".
  if (notificationsOpen.value && errorsFilter.value === null) {
    notificationsOpen.value = false;
    return;
  }
  closeOtherPanels("notifications");
  errorsFilter.value = null;
  notificationsOpen.value = true;
  store.markNotificationsRead();
}

function openProcessErrors(processId: string) {
  closeOtherPanels("notifications");
  errorsFilter.value = processId;
  notificationsOpen.value = true;
}

/**
 * "Review & add" on a scan notification: open the Add dialog prefilled. The
 * notification is intentionally LEFT in place — it's only ever removed when the
 * user explicitly dismisses it (or clears the list), so a stray/mis-click never
 * loses the find before they've actually added anything.
 */
function reviewNotification(n: AppNotification) {
  if (!n.scan) return;
  addScanOnOpen.value = false;
  addPrefillScan.value = n.scan;
  addOpen.value = true;
  notificationsOpen.value = false;
}

function onAddProcess(projectId: string) {
  formMode.value = "add";
  formProjectId.value = projectId;
  formInitial.value = null;
  formOpen.value = true;
}

function onEditProcess(projectId: string, process: ProcessView) {
  formMode.value = "edit";
  formProjectId.value = projectId;
  formInitial.value = process;
  formOpen.value = true;
}

/** Open the Add dialog, forcing a fresh open transition even if it's already showing. */
async function reopenAdd() {
  if (addOpen.value) {
    addOpen.value = false;
    await nextTick();
  }
  addOpen.value = true;
}

function onAddProject() {
  addScanOnOpen.value = false;
  addPrefillScan.value = null;
  void reopenAdd();
}

function onScan() {
  addPrefillScan.value = null;
  addScanOnOpen.value = true;
  void reopenAdd();
}

/** Sweep the machine on launch (if enabled) and offer configured/detectable projects. */
async function autoScanOnStart() {
  try {
    const s = await getSettings();
    // Auto-scan is OFF by default now, but the VERY FIRST launch still sweeps once so a brand-new
    // install isn't an empty screen. `firstScanDone` latches that one-time run (persisted per
    // machine); after it, only the explicit auto-scan toggle triggers a startup sweep.
    const firstRun = !s.firstScanDone;
    if (!s.autoScan && !firstRun) return;
    // Mark it done up front (best-effort, fire-and-forget) so a fast second mount can't double-fire.
    if (firstRun) void saveSettings({ firstScanDone: true });
    await store.loadIgnoredProjects();
    // Thorough background sweep (server-owned "startup" preset: all drives, depth 12,
    // ~30s budget). Deferred + notification-only, so the depth costs us nothing.
    const result = await scanForDevWebUI({ preset: "startup", detectPackages: true });
    const loadedFiles = new Set(projects.value.map((p) => p.path.toLowerCase()));
    const loadedDirs = new Set(
      projects.value.map((p) => p.path.replace(/[\\/][^\\/]+$/, "").toLowerCase()),
    );
    const fresh = result.files.filter((f) => !loadedFiles.has(f.path.toLowerCase()));
    const ignored = new Set(store.ignoredProjects.map((p) => p.toLowerCase()));
    const detected = (result.detected ?? []).filter(
      (p) => !loadedDirs.has(p.path.toLowerCase()) && !ignored.has(p.path.toLowerCase()),
    );
    // Surface finds as a (non-intrusive) notification rather than hijacking with a dialog.
    if (fresh.length || detected.length) store.notifyScan({ ...result, files: fresh, detected });
  } catch {
    /* scan is best-effort */
  }
}

/** Run work when the browser is idle (or shortly after) — keeps it off the startup path. */
function scheduleIdle(fn: () => void) {
  const ric = (
    window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }
  ).requestIdleCallback;
  if (ric) ric(fn, { timeout: 4000 });
  else window.setTimeout(fn, 1500);
}

/**
 * Load sync status on every mount, applying any pulled appearance. If the daemon
 * just bounced us back from `/oauth/login` (`?connected=1` / `?connect=failed`),
 * surface the outcome and strip the query param so a refresh doesn't re-trigger it.
 */
async function initSync() {
  const params = new URLSearchParams(window.location.search);
  const connectedFlag = params.get("connected");
  const failedFlag = params.get("connect");
  if (connectedFlag || failedFlag) {
    params.delete("connected");
    params.delete("connect");
    const query = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : ""));
  }
  await store.loadSyncStatus({ apply: true });
  if (connectedFlag === "1") toast.success(t("cloudSync.enableToggle"));
  else if (failedFlag === "failed") toast.error(t("cloudSync.error"));
}

onMounted(async () => {
  store.connect();
  void store.loadSettings(); // pull monitorResources so the CPU/Mem columns reflect the saved toggle
  void store.loadIgnoredProjects();
  void initSync();
  await store.refresh().catch(() => {}); // best-effort initial load — a failed fetch just leaves
  // the empty/previous project list until the SSE stream or next poll catches it up
  // Defer the machine sweep so the UI paints first (low-priority background scan).
  scheduleIdle(() => void store.checkForUpdate());
  scheduleIdle(() => void autoScanOnStart());
});
</script>

<template>
  <div
    class="safe-bottom panel-shift flex min-h-dvh flex-col pe-(--panel-shift)"
    :style="{ '--panel-shift': `${panelShiftPx || 0}px` }"
  >
    <TopBar
      :connected="connected"
      :processes="allProcesses"
      @add="onAddProject"
      @notifications="openNotifications"
      @settings="openSettings"
      @scan="onScan"
    />

    <main class="flex-1 py-6">
      <AppContainer>
      <SafeModeBanner class="mb-4" @view-crash="openProcessErrors" />
      <UpdateBanner class="mb-4" />
      <div v-if="projects.length" v-auto-animate class="flex flex-col gap-4">
        <ProjectPanel
          v-for="proj in rankedProjects"
          :key="proj.id"
          :project="proj"
          @logs="openLogs"
          @add-process="onAddProcess"
          @edit-process="onEditProcess"
          @errors-process="openProcessErrors"
        />
      </div>

      <div v-else class="mx-auto mt-28 flex max-w-md flex-col items-center gap-6 px-6 text-center">
        <h2 class="text-xl font-semibold tracking-tight">{{ t("home.noProjectsYet") }}</h2>
        <Button @click="onAddProject"><Plus class="size-4" /> {{ t("home.addProject") }}</Button>
      </div>
      </AppContainer>
    </main>

    <ProcessForm
      v-model:open="formOpen"
      :mode="formMode"
      :project-id="formProjectId"
      :initial="formInitial"
    />
    <AddProjectDialog
      v-model:open="addOpen"
      :scan-on-open="addScanOnOpen"
      :prefill-scan="addPrefillScan"
    />
    <Settings v-model:open="settingsOpen" :side="panelSide" />
    <LogDrawer v-model:open="drawerOpen" :process-id="selected" />
    <NotificationsDrawer
      v-model:open="notificationsOpen"
      :process-id="errorsFilter"
      @clear-filter="errorsFilter = null"
      @review="reviewNotification"
    />

    <AppFooter discord="https://lunarwerx.com/discord/devwebui" />
  </div>
</template>
