import { defineStore } from "pinia";
import { computed, onScopeDispose, ref, watch } from "vue";
import { useEventSource, useLocalStorage } from "@vueuse/core";
import * as api from "./api";
import { useSelfUpdate } from "@/lib/useSelfUpdate";
import { bindSignInNudgeStatus, nudgeOnSettingsChange } from "@/lib/sign-in-nudge";
import { useTheme } from "@/lib/theme";
import { rankProjectsBySearch } from "@/lib/arrange";
import type { AddResult, DetectedProcess } from "./api";
import type { ScanResult } from "./api";
import type { SyncStatus } from "./api";
import type { SafeModeStatus } from "../../shared/dto";
import type { UpdateApplyResult, UpdateStatus } from "./api";
import { MAX_LOG_LINES } from "../../shared/constants";
import type {
  AlertEvent,
  AppNotification,
  ErrorEvent,
  LogEntry,
  LogLine,
  ProcessView,
  ProjectView,
  SortDir,
  SortKey,
  StatusBucket,
  ViewMode,
} from "./types";

const ALL_STATUS_BUCKETS: StatusBucket[] = ["running", "busy", "crashed", "stopped"];
const VIEW_MODE_KEY = "devwebui.viewMode.v2";
const LEGACY_VIEW_MODE_KEY = "devwebui.viewMode";
let notifSeq = 0;
// Monotonic id for every log line the store ever appends (fetch or SSE), so the
// drawer can key its list on stable identity instead of array index (see LogDrawer.vue).
let logSeq = 0;

function parseViewMode(value: string | null): ViewMode | null {
  return value === "cards" || value === "table" ? value : null;
}

function readSavedViewMode(): ViewMode | null {
  try {
    const saved = parseViewMode(localStorage.getItem(VIEW_MODE_KEY));
    if (saved) return saved;
    // The old key's "cards" value may have been written by the previous default.
    return localStorage.getItem(LEGACY_VIEW_MODE_KEY) === "table" ? "table" : null;
  } catch {
    return null;
  }
}

function writeSavedViewMode(mode: ViewMode) {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    /* best-effort display preference */
  }
}

/**
 * The single Pinia store for DevWebUI (setup-store style, matching GitMob).
 * Owns all reactive state + the SSE wiring; api.ts stays a pure fetch layer.
 */
export const useAppStore = defineStore("app", () => {
  const projects = ref<ProjectView[]>([]);
  const connected = ref(false);
  const { updateStatus, updateChecking, updateApplying, checkForUpdate, applyUpdate } =
    useSelfUpdate<UpdateStatus, UpdateApplyResult>(api);

  /**
   * An explicit "Check for updates" click, as opposed to the background/mount-time check
   * `checkForUpdate` performs. The daemon caches its release-status answer for 5 minutes
   * (server/src/github-updater.ts), which is right for automatic polling and wrong for a
   * user who just asked: a tab open longer than that would keep reporting "up to date"
   * after a release actually shipped. `?fresh=1` bypasses that cache.
   *
   * Kept HERE rather than in useSelfUpdate: that file is a kit-synced shared lib
   * (lunarwerx-ui/src/lib/useSelfUpdate.ts) and must stay byte-identical across every app,
   * so a DevWebUI-only need is served from DevWebUI-owned code. It writes the same
   * `updateStatus` ref the composable exposes, so both paths stay in sync.
   */
  async function checkForUpdateFresh(): Promise<UpdateStatus | null> {
    if (updateChecking.value) return updateStatus.value;
    updateChecking.value = true;
    try {
      updateStatus.value = await api.checkUpdate({ force: true });
      return updateStatus.value;
    } catch {
      return updateStatus.value;
    } finally {
      updateChecking.value = false;
    }
  }
  const logs = ref<Record<string, LogEntry[]>>({});
  const errors = ref<ErrorEvent[]>([]);
  // Fired-alert-event history (see server/src/alerts.ts); rendered by
  // components/settings/AlertsSection.vue.
  const alertEvents = ref<AlertEvent[]>([]);
  /** Absolute dirs of detected projects the user dismissed (hidden from the background scan). */
  const ignoredProjects = ref<string[]>([]);

  /**
   * Whether the daemon is sampling per-process CPU + memory. Mirrors the server's
   * `monitorResources` setting; when off, the table/card hide those columns (and the
   * daemon spawns no system queries). Loaded on startup and refreshed after a save.
   */
  const monitorResources = ref(true);
  /**
   * Host used when opening a process from its title (`http://<host>:<port>`).
   * Mirrors the server's `linkHost` setting; a blank value means "use this page's
   * own hostname" (resolved at the link site). Loaded on startup, refreshed on save.
   */
  const linkHost = ref("");
  /**
   * Opt-in silent auto-update: the daemon checks the update remote on a schedule and, when a
   * newer commit is available on a CLEAN tree, applies it and self-relaunches. Default OFF (it
   * restarts the daemon unattended). Mirrors the server's `autoUpdate`/`autoUpdateIntervalSecs`
   * settings. Loaded on startup, refreshed after a save.
   */
  const autoUpdate = ref(false);
  const autoUpdateIntervalSecs = ref(21_600);
  /**
   * Notify-only update checks: the daemon checks the update remote on a schedule and TELLS the
   * owner when one lands (SSE `update_available`, surfaced by UpdateBanner.vue) — nothing installs
   * without a click. Default ON. Mirrors the server's `updateNotify` setting. Loaded on startup,
   * refreshed after a save.
   */
  const updateNotify = ref(true);
  /**
   * Live "an update is waiting" state, set by the SSE `update_available` event (see connect()
   * below) — independent of the polled `updateStatus` above, since this arrives unprompted from
   * the daemon's own scheduled check. Cleared by an explicit dismiss or a successful apply.
   */
  const updateAvailable = ref(false);
  const updateAvailableCanApply = ref(true);
  const updateAvailableReason = ref<string | null>(null);
  /** Hide the update-available banner. A "later", not an opt-out — the next scheduled check
   *  (or a fresh SSE reconnect resync) can re-announce it. */
  function dismissUpdateAvailable() {
    updateAvailable.value = false;
  }
  /**
   * Safe mode (server/src/crash-sentinel.ts): the daemon booted after an unclean shutdown, or was
   * asked to, and skipped every launch-time auto-start. Re-read on every SSE (re)connect, since a
   * reconnect is exactly what a tray-revived daemon looks like from here. SafeModeBanner.vue
   * shows it; null until the first read lands.
   */
  const safeMode = ref<SafeModeStatus | null>(null);
  async function refreshSafeMode() {
    try {
      safeMode.value = await api.getSafeMode();
    } catch {
      /* an older daemon without the route, or a blip: keep what we had */
    }
  }
  /** "Leave safe mode": leave safe mode and let the skipped auto-start run. */
  async function exitSafeMode() {
    const result = await api.exitSafeMode();
    await refreshSafeMode();
    return result;
  }
  /**
   * Portable mode: the app UI opens in a chromeless Chromium app window instead of a
   * browser tab, both from the in-app toggle and the tray/desktop launcher. Mirrors the
   * server's `portableMode` setting. Default OFF. Loaded on startup, refreshed after a save.
   */
  const portableMode = ref(false);
  /** Toggle auto-update (and optionally its check cadence in seconds); reflects the saved value. */
  async function setAutoUpdate(enabled: boolean, intervalSecs?: number) {
    const saved = await api.setAutoUpdate(enabled, intervalSecs);
    autoUpdate.value = saved.autoUpdate;
    autoUpdateIntervalSecs.value = saved.autoUpdateIntervalSecs;
    return saved;
  }
  async function loadSettings() {
    try {
      const s = await api.getSettings();
      monitorResources.value = s.monitorResources;
      linkHost.value = s.linkHost ?? ""; // blank → resolved to the page host at the link site; tolerate an older daemon that omits the key
      autoUpdate.value = s.autoUpdate ?? false;
      autoUpdateIntervalSecs.value = s.autoUpdateIntervalSecs ?? 21_600;
      updateNotify.value = s.updateNotify ?? true;
      portableMode.value = s.portableMode ?? false;
    } catch {
      /* keep the optimistic default — Settings still reads/writes directly */
    }
  }

  /**
   * In-app notifications (e.g. the startup scan found new projects). Ephemeral —
   * kept in memory only, since the auto-scan regenerates them on next launch.
   */
  const notifications = ref<AppNotification[]>([]);
  const unreadNotifications = computed(() => notifications.value.filter((n) => !n.read).length);

  /**
   * Record that the startup scan found new configured or detectable projects.
   * The notification carries the full `scan` so the drawer can list exactly WHAT was
   * found (names + paths + process counts) and localize its own title/body.
   */
  function notifyScan(scan: ScanResult) {
    if (!scan.files.length && !(scan.detected?.length ?? 0)) return;
    // One rolling "scan" notification — a re-scan refreshes it rather than stacking.
    const existing = notifications.value.find((n) => n.kind === "scan");
    if (existing) {
      existing.scan = scan;
      existing.ts = Date.now();
      existing.read = false;
    } else {
      notifications.value.unshift({
        id: `scan-${Date.now()}-${notifSeq++}`,
        kind: "scan",
        ts: Date.now(),
        read: false,
        scan,
      });
    }
  }

  function dismissNotification(id: string) {
    notifications.value = notifications.value.filter((n) => n.id !== id);
  }
  function markNotificationsRead() {
    for (const n of notifications.value) n.read = true;
  }
  function clearNotifications() {
    notifications.value = [];
  }

  /**
   * How every project panel lays out its processes — "table" (a dense, scan-friendly
   * row per process; the default) or "cards" (the grid). Persists once the user
   * picks explicitly.
   */
  const viewModePreference = ref<ViewMode | null>(readSavedViewMode());
  const viewMode = computed<ViewMode>({
    get: () => viewModePreference.value ?? "table",
    set: (mode) => {
      viewModePreference.value = mode;
      writeSavedViewMode(mode);
    },
  });

  /**
   * How every panel orders + filters its processes. Shared across the card and
   * table views and persisted, so the table headers and the toolbar menu stay
   * in sync and the choice survives a reload. Default: alphabetical by name.
   */
  // Default ordering: status first (running on top, then busy/crashed/idle), each
  // group sub-sorted by name (arrangeProcesses tie-breaks on name). Key bumped to
  // .v2 so the new default replaces the old "name" default for existing users.
  const sortKey = useLocalStorage<SortKey>("devwebui.sortKey.v2", "status");
  const sortDir = useLocalStorage<SortDir>("devwebui.sortDir.v2", "asc");
  const statusFilter = useLocalStorage<StatusBucket[]>("devwebui.statusFilter", [
    ...ALL_STATUS_BUCKETS,
  ]);
  /**
   * Toolbar text search — filters every project/process by name (see lib/arrange.ts
   * and ProjectPanel.vue). Deliberately NOT persisted: a leftover search term silently
   * hiding everything on next launch would be far more confusing than starting blank.
   */
  const searchQuery = ref("");
  /**
   * Project panels in fuzzy-search relevance order while the toolbar search is active
   * (lib/arrange.ts rankProjectsBySearch), plain list order otherwise.
   */
  const rankedProjects = computed(() => rankProjectsBySearch(projects.value, searchQuery.value));

  /** Click a column: same key flips direction, a new key starts ascending. */
  function toggleSort(key: SortKey) {
    if (sortKey.value === key) {
      sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
    } else {
      sortKey.value = key;
      sortDir.value = "asc";
    }
  }

  /** Add/remove a status bucket from the filter (never let it reach empty). */
  function toggleStatusFilter(bucket: StatusBucket, on: boolean) {
    const next = new Set(statusFilter.value);
    if (on) next.add(bucket);
    else next.delete(bucket);
    statusFilter.value = next.size
      ? ALL_STATUS_BUCKETS.filter((b) => next.has(b))
      : [...ALL_STATUS_BUCKETS];
  }

  /** A single shared clock so uptime counters tick without per-card timers. */
  const now = ref(Date.now());
  const nowTimer = setInterval(() => (now.value = Date.now()), 1000);
  // Pinia disposes a setup store during tests, HMR, and app teardown. Do not leave each old
  // instance's clock running forever after its reactive scope is gone.
  onScopeDispose(() => clearInterval(nowTimer));

  /** Flat view of every process across all projects (for global counts). */
  const allProcesses = computed(() => projects.value.flatMap((p) => p.processes));

  /** Number of distinct error records per process id, for per-server indicators. */
  const errorCountByProcess = computed(() => {
    const m: Record<string, number> = {};
    for (const e of errors.value) m[e.processId] = (m[e.processId] ?? 0) + 1;
    return m;
  });

  /**
   * `errors` is server-authoritative (the daemon re-pushes the whole list over SSE),
   * so both removals below drop records LOCALLY first for instant feedback, then fire
   * the daemon call in the background — the next SSE snapshot confirms it. Without this
   * the drawer's Clear button appeared to hang until the ~2s monitoring tick echoed the
   * cleared list back; if the daemon call fails, that same SSE snapshot resurfaces the
   * record (self-healing), so no toast/await is needed on the happy path.
   */
  function dismissError(fingerprint: string) {
    errors.value = errors.value.filter((e) => e.fingerprint !== fingerprint);
    void api.dismissError(fingerprint).catch(() => {});
  }
  function clearErrorsLocal(processId?: string) {
    errors.value = processId ? errors.value.filter((e) => e.processId !== processId) : [];
    void api.clearErrors(processId).catch(() => {}); // self-healing — doc block above: next SSE snapshot resurfaces on failure
  }

  /** Same optimistic-then-reconcile pattern as {@link clearErrorsLocal} — alertEvents is also
   *  server-authoritative over the "alerts" SSE event (see connect() below). */
  function clearAlertEventsLocal(processId?: string) {
    alertEvents.value = processId ? alertEvents.value.filter((e) => e.processId !== processId) : [];
    void api.clearAlertEvents(processId).catch(() => {});
  }

  function applyStatus(p: ProcessView | null) {
    if (!p) return;
    const proj = projects.value.find((x) => x.id === p.projectId);
    if (!proj) return;
    const i = proj.processes.findIndex((x) => x.id === p.id);
    if (i >= 0) proj.processes[i] = p;
    else proj.processes.push(p);
  }

  async function refresh() {
    const [p, e, a] = await Promise.all([api.getProjects(), api.getErrors(), api.getAlertEvents()]);
    projects.value = p;
    errors.value = e;
    alertEvents.value = a;
  }

  function connect() {
    // A paired browser (daemon enforcing local auth) cannot hand EventSource its Bearer key, so
    // each connect uses a fresh single-use ticket; EventSource's own retry would replay a spent
    // one, so on every drop we mint a new ticket and swap the URL, which reopens the stream.
    const paired = api.getPairedKey() !== null;
    const streamUrl = ref<string | undefined>(paired ? undefined : "/api/stream");
    const reconnectMs = 2500;
    async function refreshStreamTicket() {
      try {
        const { ticket } = await api.getStreamTicket();
        streamUrl.value = `/api/stream?ticket=${encodeURIComponent(ticket)}`;
      } catch {
        setTimeout(refreshStreamTicket, reconnectMs);
      }
    }
    const { status, data, event } = useEventSource(
      streamUrl,
      ["projects", "errors", "status", "log", "update_available", "alerts"],
      { autoReconnect: paired ? false : { retries: -1, delay: reconnectMs } },
    );
    watch(status, (s) => {
      connected.value = s === "OPEN";
      if (s === "OPEN") void refreshSafeMode();
    });
    if (paired) {
      void refreshStreamTicket();
      watch(status, (s) => {
        if (s === "CLOSED") setTimeout(refreshStreamTicket, reconnectMs);
      });
    }
    watch(data, (raw) => {
      if (raw == null) return;
      const parsed = JSON.parse(raw);
      switch (event.value) {
        case "projects":
          projects.value = parsed;
          break;
        case "errors":
          errors.value = parsed;
          break;
        case "status":
          applyStatus(parsed);
          break;
        case "log": {
          // The daemon batches log lines (backpressure): one event carries many lines,
          // possibly spanning processes. Route each to its own process buffer.
          const batch = parsed as LogLine[];
          const byProcess = new Map<string, LogLine[]>();
          for (const l of batch) {
            const lines = byProcess.get(l.id);
            if (lines) lines.push(l);
            else byProcess.set(l.id, [l]);
          }
          for (const [id, lines] of byProcess) {
            logs.value[id] ??= [];
            const arr = logs.value[id];
            arr.push(...lines.map((l) => ({ ...l, seq: logSeq++ })));
            // Trim once per process batch. Splicing after every individual line repeatedly
            // shifted the same reactive array during high-volume output.
            if (arr.length > MAX_LOG_LINES) arr.splice(0, arr.length - MAX_LOG_LINES);
          }
          break;
        }
        case "alerts":
          alertEvents.value = parsed;
          break;
        case "update_available":
          // The daemon's scheduled check (server/src/auto-update.ts) found a newer version while
          // auto-apply was off (or blocked) and announced it — the OFFER, never the act. Nothing
          // installs until the owner clicks "Update now" on UpdateBanner.vue.
          updateAvailable.value = true;
          updateAvailableCanApply.value = parsed.canApply !== false;
          updateAvailableReason.value = typeof parsed.reason === "string" ? parsed.reason : null;
          break;
      }
    });
  }

  async function fetchLogs(id: string) {
    const data = await api.getProcessLogs(id);
    logs.value[id] = data.lines.map((l) => ({ ...l, seq: logSeq++ }));
  }

  // ---- project mutations: hit the daemon, then refresh from the source of truth ----
  async function removeProject(id: string) {
    const index = projects.value.findIndex((p) => p.id === id);
    const removed = projects.value[index];
    if (removed) projects.value = projects.value.filter((p) => p.id !== id);
    try {
      await api.removeProjectRequest(id);
    } catch (e) {
      // Put the panel back where it was (unless an SSE snapshot already restored it); the
      // caller surfaces the error.
      if (removed && !projects.value.some((p) => p.id === id)) {
        const next = [...projects.value];
        next.splice(Math.min(index, next.length), 0, removed);
        projects.value = next;
      }
      throw e;
    }
    await refresh();
  }

  /**
   * Rename + recolor a project (rewrites its .devwebui file). The new name/color show
   * immediately and roll back if the daemon rejects them. Returns the raw result so the
   * caller can surface a validation error; on success the reconcile pushes the updated
   * project over SSE, and we refresh as a belt-and-suspenders in case that snapshot lags.
   */
  async function updateProject(id: string, meta: { name: string; color?: string }) {
    const proj = projects.value.find((p) => p.id === id);
    const previous = proj ? { name: proj.name, color: proj.color } : null;
    if (proj) {
      projects.value = projects.value.map((p) =>
        p.id === id ? { ...p, name: meta.name, color: meta.color } : p,
      );
    }
    // Restore the old name/color on whatever entry is current (an SSE snapshot may have
    // replaced it meanwhile; the daemon's copy already carries the old values then).
    const rollback = () => {
      if (!previous) return;
      projects.value = projects.value.map((p) =>
        p.id === id ? { ...p, name: previous.name, color: previous.color } : p,
      );
    };
    let res: AddResult;
    try {
      res = await api.updateProjectRequest(id, meta);
    } catch (e) {
      rollback();
      throw e;
    }
    if (res?.error) rollback();
    else await refresh();
    return res;
  }

  /** Toggle a process's starred flag (SSE pushes the reloaded project back). */
  async function toggleStar(p: ProcessView) {
    await api.setProcessStarred(p.projectId, p.localId, !p.starred);
  }

  // ---- detected-project ignore list ----
  async function loadIgnoredProjects() {
    try {
      ignoredProjects.value = await api.getIgnoredProjects();
    } catch {
      /* best-effort */
    }
  }
  async function ignoreProject(dir: string) {
    await api.ignoreProjectRequest(dir);
    if (!ignoredProjects.value.some((p) => p.toLowerCase() === dir.toLowerCase()))
      ignoredProjects.value = [...ignoredProjects.value, dir];
  }
  async function unignoreProject(dir: string) {
    await api.unignoreProjectRequest(dir);
    ignoredProjects.value = ignoredProjects.value.filter(
      (p) => p.toLowerCase() !== dir.toLowerCase(),
    );
  }

  async function browseForProject(): Promise<AddResult> {
    const res = await api.browseProjectRequest();
    if (res.ok) await refresh();
    return res;
  }

  async function loadProjectByPath(path: string): Promise<AddResult> {
    const res = await api.loadProjectRequest(path);
    if (res.ok) await refresh();
    return res;
  }

  async function cloneProject(url: string, dest: string): Promise<AddResult> {
    const res = await api.cloneProjectRequest(url, dest);
    if (res.ok) await refresh();
    return res;
  }

  async function scaffoldProject(
    dir: string,
    fileName: string,
    project: { name: string; processes: DetectedProcess[] },
  ): Promise<AddResult> {
    const res = await api.scaffoldProjectRequest(dir, fileName, project);
    if (res.ok) await refresh();
    return res;
  }

  /** Retire a folder's external (VS Code) dev-server auto-start so DevWebUI owns it. */
  async function takeOverAutostart(dir: string) {
    return api.takeOverAutostartRequest(dir);
  }

  // ---- "Sync my settings with Connections" (optional, opt-in) ----
  const { mode: themeMode, setTheme } = useTheme();

  const syncStatus = ref<SyncStatus | null>(null);
  const syncLoading = ref(false);
  const syncError = ref<string | null>(null);
  // Debounce timer for theme-change → pushAppearance.
  let syncPushTimer: ReturnType<typeof setTimeout> | undefined;
  // Set right before applying a pulled appearance, so the theme `watch` below
  // doesn't turn right around and push the value it just received.
  let applyingRemote = false;

  /** The minimal portable appearance blob synced across devices: theme mode only. */
  function currentAppearance(): Record<string, unknown> {
    return { theme: themeMode.value };
  }

  /** Apply a pulled appearance blob to the local theme composable. */
  function applyAppearance(appearance: Record<string, unknown> | null | undefined) {
    if (!appearance) return;
    const theme = appearance.theme;
    if (theme === "light" || theme === "dark" || theme === "system") {
      applyingRemote = true;
      setTheme(theme);
      // Reset on next tick — the theme `watch` handler below runs synchronously
      // off this same assignment, so it's safe to clear right after.
      queueMicrotask(() => {
        applyingRemote = false;
      });
    }
  }

  function absorbSyncResult(res: api.SyncResult) {
    if (res.ok) {
      syncStatus.value = res;
      syncError.value = null;
    } else {
      syncError.value = res.error;
    }
    return res;
  }

  /** Fetch the current sync status; call on mount and after actions. */
  async function loadSyncStatus(opts: { apply?: boolean } = {}) {
    syncLoading.value = true;
    try {
      const s = await api.getSyncStatus();
      syncStatus.value = s;
      syncError.value = null;
      if (opts.apply) applyAppearance(s.appearance);
    } catch (e) {
      syncError.value = e instanceof Error ? e.message : String(e);
    } finally {
      syncLoading.value = false;
    }
  }

  /** Turn sync on, seeding it with the current local appearance. */
  async function enableSync() {
    syncLoading.value = true;
    try {
      const res = await api.setSync({ enabled: true, appearance: currentAppearance() });
      absorbSyncResult(res);
      if (res.ok) applyAppearance(res.appearance);
    } catch (e) {
      syncError.value = e instanceof Error ? e.message : String(e);
    } finally {
      syncLoading.value = false;
    }
  }

  /** Turn sync off. Pass `forget: true` to also disconnect (delete the remote doc + token). */
  async function disableSync(forget = false) {
    syncLoading.value = true;
    try {
      const res = await api.setSync({ enabled: false, forget });
      absorbSyncResult(res);
    } catch (e) {
      syncError.value = e instanceof Error ? e.message : String(e);
    } finally {
      syncLoading.value = false;
    }
  }

  async function pullSync() {
    syncLoading.value = true;
    try {
      const res = await api.syncPull();
      absorbSyncResult(res);
      if (res.ok) applyAppearance(res.appearance);
    } catch (e) {
      syncError.value = e instanceof Error ? e.message : String(e);
    } finally {
      syncLoading.value = false;
    }
  }

  async function pushSync() {
    syncLoading.value = true;
    try {
      absorbSyncResult(await api.syncPush());
    } catch (e) {
      syncError.value = e instanceof Error ? e.message : String(e);
    } finally {
      syncLoading.value = false;
    }
  }

  /** Push the current local appearance (used by the debounced theme watcher below). */
  async function pushAppearance() {
    try {
      absorbSyncResult(await api.setSync({ appearance: currentAppearance() }));
    } catch (e) {
      syncError.value = e instanceof Error ? e.message : String(e);
    }
  }

  // When the user changes the theme AND sync is enabled+connected, debounce and push —
  // but never echo a value we just applied from a pull/enable (`applyingRemote`).
  watch(themeMode, () => {
    if (applyingRemote) return;
    // NOT connected is the interesting case for the sign-in prompt, and it is exactly the branch
    // the push path below discards. Someone who just changed an appearance setting is who "these
    // follow you to your other machines" is a true sentence for, and this is the same instant we
    // WOULD have pushed it. The engine says no to almost every one of these; see lib/sign-in-nudge.
    if (!syncStatus.value?.connected) nudgeOnSettingsChange();
    if (!syncStatus.value?.enabled || !syncStatus.value?.connected) return;
    clearTimeout(syncPushTimer);
    syncPushTimer = setTimeout(() => {
      void pushAppearance();
    }, 800);
  });

  // Point the prompt at the live connection state. Only the STATUS binds here - the session count
  // starts at app boot (main.ts), because this store is lazy and an owner who never opens settings
  // would otherwise never accrue a session.
  bindSignInNudgeStatus(() => syncStatus.value?.connected ?? false);

  return {
    projects,
    connected,
    updateStatus,
    updateChecking,
    updateApplying,
    logs,
    errors,
    alertEvents,
    notifications,
    unreadNotifications,
    monitorResources,
    linkHost,
    autoUpdate,
    autoUpdateIntervalSecs,
    updateNotify,
    updateAvailable,
    updateAvailableCanApply,
    updateAvailableReason,
    safeMode,
    exitSafeMode,
    dismissUpdateAvailable,
    portableMode,
    setAutoUpdate,
    loadSettings,
    notifyScan,
    dismissNotification,
    markNotificationsRead,
    clearNotifications,
    viewMode,
    sortKey,
    sortDir,
    statusFilter,
    searchQuery,
    rankedProjects,
    toggleSort,
    toggleStatusFilter,
    now,
    allProcesses,
    errorCountByProcess,
    dismissError,
    clearErrorsLocal,
    clearAlertEventsLocal,
    refresh,
    toggleStar,
    ignoredProjects,
    loadIgnoredProjects,
    ignoreProject,
    unignoreProject,
    checkForUpdate,
    checkForUpdateFresh,
    applyUpdate,
    connect,
    fetchLogs,
    removeProject,
    updateProject,
    browseForProject,
    loadProjectByPath,
    cloneProject,
    scaffoldProject,
    takeOverAutostart,
    syncStatus,
    syncLoading,
    syncError,
    loadSyncStatus,
    enableSync,
    disableSync,
    pushSync,
    pullSync,
    pushAppearance,
    applyAppearance,
  };
});
