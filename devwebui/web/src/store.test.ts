// First test suite for web/src/store.ts (previously zero frontend coverage). Covers the two
// things that carry the most risk: SSE event application (the `connect()` switch on
// status/log/projects/errors) and the optimistic-update paths (dismissError/clearErrorsLocal,
// which mutate local state immediately and fire the daemon call in the background).
//
// Runner ownership: this file belongs to Vitest (`bun run test:web`), NOT to `bun test`, whose
// script is scoped to tests/ + server/tests/ precisely so the two runners never scan each
// other's specs. See .github/workflows/ci.yml, which runs both.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import * as api from "./api";
import { useAppStore } from "./store";
import type { AlertEvent, ErrorEvent, ProcessView, ProjectView } from "./types";
import { MAX_LOG_LINES } from "../../shared/constants";

// Keep the rest of "./api" real (getProjects/getErrors/etc. aren't exercised here) and only
// intercept the calls the optimistic-update paths fire in the background.
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    dismissError: vi.fn(async () => {}),
    clearErrors: vi.fn(async () => {}),
    clearAlertEvents: vi.fn(async () => {}),
  };
});

// useEventSource is the one piece of "./store" that can't run for real in a test (no actual SSE
// server) — replaced with plain refs the test drives by hand. Everything else from
// "@vueuse/core" (useLocalStorage, useStorage, usePreferredDark, used by store.ts and the theme
// composable it pulls in) stays real; jsdom provides the localStorage/matchMedia they need (the
// latter polyfilled below). The refs come back to the test through a globalThis side-channel
// rather than a `vi.hoisted` variable — this factory only touches `ref`, so it needs none of
// vitest's variable-hoisting machinery.
vi.mock("@vueuse/core", async (importOriginal) => {
  const { ref } = await import("vue");
  const actual = await importOriginal<typeof import("@vueuse/core")>();
  return {
    ...actual,
    useEventSource: () => {
      const status = ref<"CONNECTING" | "OPEN" | "CLOSED">("OPEN");
      const data = ref<string | null>(null);
      const event = ref<string | null>(null);
      (globalThis as Record<string, unknown>).__sseTestHandle = { status, data, event };
      return { status, data, event, error: ref(null), close: () => {}, eventSource: ref(null) };
    },
  };
});

// jsdom doesn't implement matchMedia; the theme composable useAppStore() pulls in calls it
// (via @vueuse/core's usePreferredDark) as soon as the store is created.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function sseHandle() {
  const h = (globalThis as Record<string, unknown>).__sseTestHandle as
    | {
        status: { value: string };
        data: { value: string | null };
        event: { value: string | null };
      }
    | undefined;
  if (!h) throw new Error("store.connect() must be called before driving a fake SSE event");
  return h;
}

function processView(
  over: Partial<ProcessView> & { id: string; localId: string; projectId: string },
): ProcessView {
  return {
    name: over.localId,
    command: "bun run dev",
    cwd: "C:/repo",
    enabled: true,
    status: "running",
    pid: 111,
    startedAt: 1_700_000_000_000,
    restarts: 0,
    exitCode: null,
    cpu: null,
    memory: null,
    conflict: false,
    projectName: over.projectId,
    ...over,
  } as ProcessView;
}

function projectView(over: Partial<ProjectView> & { id: string }): ProjectView {
  return {
    name: over.id,
    path: `C:/${over.id}/.devwebui`,
    enabled: true,
    processes: [],
    ...over,
  };
}

const mkAlertEvent = (processId: string, id: string): AlertEvent => ({
  id,
  ruleId: "rule1",
  processId,
  processName: "Web",
  projectId: "p1",
  projectName: "P1",
  metric: "cpu",
  threshold: 80,
  value: 91,
  firedAt: 1,
});

const mkErr = (processId: string, fingerprint: string): ErrorEvent => ({
  fingerprint,
  processId,
  localId: "web",
  processName: "Web",
  projectId: "p1",
  projectName: "P1",
  source: "stderr",
  sample: "x",
  count: 1,
  firstSeen: 1,
  lastSeen: 1,
});

beforeEach(() => {
  setActivePinia(createPinia());
  delete (globalThis as Record<string, unknown>).__sseTestHandle;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("SSE event application", () => {
  it("'projects' fully replaces the project list", async () => {
    const store = useAppStore();
    store.connect();
    const incoming = [
      projectView({
        id: "p1",
        processes: [processView({ id: "p1.web", localId: "web", projectId: "p1" })],
      }),
    ];
    const h = sseHandle();
    h.event.value = "projects";
    h.data.value = JSON.stringify(incoming);
    await nextTick();
    expect(store.projects).toEqual(incoming);
  });

  it("'errors' fully replaces the error list", async () => {
    const store = useAppStore();
    store.connect();
    const incoming: ErrorEvent[] = [mkErr("p1.web", "fp1")];
    const h = sseHandle();
    h.event.value = "errors";
    h.data.value = JSON.stringify(incoming);
    await nextTick();
    expect(store.errors).toEqual(incoming);
  });

  it("'status' upserts the matching process within its project, and is a no-op when the project is unknown", async () => {
    const store = useAppStore();
    store.connect();
    const web = processView({ id: "p1.web", localId: "web", projectId: "p1", status: "running" });
    const apiProc = processView({
      id: "p1.api",
      localId: "api",
      projectId: "p1",
      status: "stopped",
    });
    store.projects = [projectView({ id: "p1", processes: [web, apiProc] })];

    const h = sseHandle();
    h.event.value = "status";
    h.data.value = JSON.stringify({ ...web, status: "crashed", exitCode: 1 });
    await nextTick();
    expect(store.projects[0]?.processes.find((p) => p.id === "p1.web")?.status).toBe("crashed");
    // The untouched sibling is unaffected.
    expect(store.projects[0]?.processes.find((p) => p.id === "p1.api")?.status).toBe("stopped");

    // A status event for a process whose project isn't loaded is dropped, not thrown.
    h.data.value = JSON.stringify(
      processView({ id: "other.svc", localId: "svc", projectId: "other" }),
    );
    await nextTick();
    expect(store.projects).toHaveLength(1);
  });

  it("'log' batches lines per process and trims each buffer to MAX_LOG_LINES", async () => {
    const store = useAppStore();
    store.connect();
    const h = sseHandle();

    // A batch spanning two processes routes each line to its own buffer.
    h.event.value = "log";
    h.data.value = JSON.stringify([
      { id: "p1.web", stream: "stdout", line: "web line", ts: 1 },
      { id: "p1.api", stream: "stdout", line: "api line", ts: 2 },
    ]);
    await nextTick();
    expect(store.logs["p1.web"]).toHaveLength(1);
    expect(store.logs["p1.api"]).toHaveLength(1);

    // One batch over the cap trims from the front (oldest dropped), capped at MAX_LOG_LINES.
    const overflow = Array.from({ length: MAX_LOG_LINES + 5 }, (_, i) => ({
      id: "p1.web",
      stream: "stdout" as const,
      line: `line ${i}`,
      ts: i,
    }));
    h.data.value = JSON.stringify(overflow);
    await nextTick();
    const buf = store.logs["p1.web"] ?? [];
    expect(buf).toHaveLength(MAX_LOG_LINES);
    expect(buf.at(-1)?.line).toBe(`line ${MAX_LOG_LINES + 4}`); // the newest line survives
  });

  it("'update_available' sets the banner state, canApply/reason default to open/none, and dismiss clears it", async () => {
    const store = useAppStore();
    store.connect();
    const h = sseHandle();

    // canApply omitted → treated as applicable (only an explicit `false` blocks it).
    h.event.value = "update_available";
    h.data.value = JSON.stringify({ from: "aaaa", to: "bbbb" });
    await nextTick();
    expect(store.updateAvailable).toBe(true);
    expect(store.updateAvailableCanApply).toBe(true);
    expect(store.updateAvailableReason).toBe(null);

    store.dismissUpdateAvailable();
    expect(store.updateAvailable).toBe(false);

    // A blocked update (dirty tree) carries canApply: false + a reason.
    h.data.value = JSON.stringify({ from: "aaaa", to: "bbbb", canApply: false, reason: "dirty" });
    await nextTick();
    expect(store.updateAvailable).toBe(true);
    expect(store.updateAvailableCanApply).toBe(false);
    expect(store.updateAvailableReason).toBe("dirty");
  });

  it("'alerts' fully replaces the fired-event list", async () => {
    const store = useAppStore();
    store.connect();
    const incoming: AlertEvent[] = [mkAlertEvent("p1.web", "e1")];
    const h = sseHandle();
    h.event.value = "alerts";
    h.data.value = JSON.stringify(incoming);
    await nextTick();
    expect(store.alertEvents).toEqual(incoming);
  });

  it("every log line gets a stable seq so the drawer keys on identity, not array index", async () => {
    const store = useAppStore();
    store.connect();
    const h = sseHandle();
    h.event.value = "log";
    h.data.value = JSON.stringify([
      { id: "p1.web", stream: "stdout", line: "a", ts: 1 },
      { id: "p1.web", stream: "stdout", line: "b", ts: 2 },
    ]);
    await nextTick();
    const seqs = (store.logs["p1.web"] ?? []).map((l) => l.seq);
    expect(seqs).toHaveLength(2);
    expect(new Set(seqs).size).toBe(2); // unique
    expect(seqs[1]).toBeGreaterThan(seqs[0] as number);
  });
});

describe("optimistic updates", () => {
  it("dismissError removes the record LOCALLY before the daemon call resolves, and forwards the fingerprint", () => {
    const store = useAppStore();
    store.errors = [mkErr("p1.web", "keep"), mkErr("p1.web", "drop")];
    store.dismissError("drop");
    // Synchronous, no await: the local filter has already happened by the time the call returns.
    expect(store.errors.map((e) => e.fingerprint)).toEqual(["keep"]);
    expect(api.dismissError).toHaveBeenCalledWith("drop");
  });

  it("clearErrorsLocal clears by processId, or everything when omitted, and forwards the same scope to the daemon", () => {
    const store = useAppStore();
    store.errors = [mkErr("p1.web", "a"), mkErr("p1.api", "b")];

    store.clearErrorsLocal("p1.web");
    expect(store.errors.map((e) => e.fingerprint)).toEqual(["b"]);
    expect(api.clearErrors).toHaveBeenCalledWith("p1.web");

    store.errors = [mkErr("p1.web", "a"), mkErr("p1.api", "b")];
    store.clearErrorsLocal();
    expect(store.errors).toEqual([]);
    expect(api.clearErrors).toHaveBeenCalledWith(undefined);
  });

  it("clearAlertEventsLocal clears by processId, or everything when omitted, and forwards the same scope to the daemon", () => {
    const store = useAppStore();
    store.alertEvents = [mkAlertEvent("p1.web", "a"), mkAlertEvent("p1.api", "b")];

    store.clearAlertEventsLocal("p1.web");
    expect(store.alertEvents.map((e) => e.id)).toEqual(["b"]);
    expect(api.clearAlertEvents).toHaveBeenCalledWith("p1.web");

    store.alertEvents = [mkAlertEvent("p1.web", "a"), mkAlertEvent("p1.api", "b")];
    store.clearAlertEventsLocal();
    expect(store.alertEvents).toEqual([]);
    expect(api.clearAlertEvents).toHaveBeenCalledWith(undefined);
  });
});
