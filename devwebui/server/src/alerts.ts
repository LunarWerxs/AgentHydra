// ---------------------------------------------------------------------------
// Adapted from PostHog products/alerts/ (threshold alerting on insights/dashboards),
// MIT licensed, Copyright (c) PostHog Inc. Adapted for DevWebUI: PostHog alerts a
// human-computed metric (a saved query); DevWebUI already computes CPU/memory for every
// managed process every METRICS_INTERVAL tick (see metrics.ts) - this module is the
// PostHog IDEA (a user-defined threshold that must stay breached for a sustained window
// before it fires, not a one-sample blip) carried over to that existing stream, written
// fresh against this codebase's own persistence + recorder conventions (modelled on
// errors.ts, which solved the identical "persist across restarts, but never resurrect a
// stale condition on boot" problem for the error log).
//
// Two independent stores, same shape as errors.ts's ErrorRecorder:
//   - RULES ("alert if this process exceeds 80% CPU for 2 minutes") - small, persisted as
//     plain JSON (state.ts's shape), CRUD'd from the GUI/CLI/MCP.
//   - EVENTS (a rule actually firing) - persisted as capped NDJSON for history, exactly
//     like errors.ndjson.
// The SUSTAINED-BREACH tracker (how long has this rule been over threshold, has it
// already fired for this breach) is deliberately NOT persisted: it lives only in the
// `breach` map below and resets on every daemon restart. That is the same "current,
// never stale" contract errors.ts's isErrorActive() enforces for the error log - a
// breach that started before a restart must breach again for the full duration before
// firing again, rather than firing the instant the daemon comes back up because some
// long-forgotten timer had already elapsed.
// ---------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic, writeJsonAtomic } from "./atomic-write";
import { dataDir } from "./data-dir";
import type { AlertEvent, AlertRule, AlertRuleInput } from "../../shared/dto";

export type { AlertEvent, AlertMetric, AlertRule, AlertRuleInput } from "../../shared/dto";

function rulesFile(): string {
  return path.join(dataDir(), "alerts-rules.json");
}
function eventsFile(): string {
  return path.join(dataDir(), "alerts-events.ndjson");
}

const MAX_ALERT_EVENTS = 200;
const SAVE_DEBOUNCE_MS = 1000;
// Nothing legitimate needs a sustained window longer than a day, and clamping keeps a bad
// client payload (Infinity, a stray extra zero) from creating a rule that can never fire
// or that fires on the very next sample.
const MAX_FOR_MS = 24 * 60 * 60 * 1000;

function clampForMs(ms: unknown): number {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(MAX_FOR_MS, Math.round(n));
}

function clampThreshold(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** This tick's live sample for one process - the same values `ProcessView.cpu`/`.memory` carry. */
export interface AlertSample {
  processId: string;
  processName: string;
  projectId: string;
  projectName: string;
  cpu: number | null;
  memory: number | null;
}

export class AlertStore {
  private rules = new Map<string, AlertRule>();
  private events: AlertEvent[] = []; // newest first, capped at MAX_ALERT_EVENTS
  // ruleId -> in-memory sustained-breach tracker. NOT persisted - see file header.
  private breach = new Map<string, { since: number; fired: boolean }>();
  private eventsDirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onChange: () => void;

  constructor(onChange: () => void = () => {}) {
    this.onChange = onChange;
    this.loadRules();
    this.loadEvents();
  }

  // ---- rules: CRUD (persisted immediately - infrequent, user-driven writes) --------
  listRules(): AlertRule[] {
    return [...this.rules.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  getRule(id: string): AlertRule | null {
    return this.rules.get(id) ?? null;
  }

  addRule(input: AlertRuleInput): AlertRule {
    const rule: AlertRule = {
      id: randomUUID(),
      processId: input.processId,
      metric: input.metric,
      threshold: clampThreshold(input.threshold),
      forMs: clampForMs(input.forMs),
      enabled: input.enabled ?? true,
      createdAt: Date.now(),
    };
    this.rules.set(rule.id, rule);
    this.saveRules();
    return rule;
  }

  /** Replace a rule's editable fields; omitted fields keep their current value. */
  updateRule(id: string, input: Partial<AlertRuleInput>): AlertRule | null {
    const existing = this.rules.get(id);
    if (!existing) return null;
    const updated: AlertRule = {
      ...existing,
      processId: input.processId ?? existing.processId,
      metric: input.metric ?? existing.metric,
      threshold:
        input.threshold !== undefined ? clampThreshold(input.threshold) : existing.threshold,
      forMs: input.forMs !== undefined ? clampForMs(input.forMs) : existing.forMs,
      enabled: input.enabled ?? existing.enabled,
    };
    this.rules.set(id, updated);
    // The rule's definition changed - a partial breach measured against the OLD
    // threshold/duration is no longer meaningful, so its sustained window starts over.
    this.breach.delete(id);
    this.saveRules();
    return updated;
  }

  removeRule(id: string): boolean {
    const had = this.rules.delete(id);
    if (had) {
      this.breach.delete(id);
      this.saveRules();
    }
    return had;
  }

  /** Drop every rule targeting a process that no longer exists (removed from its project). */
  removeRulesForProcess(processId: string): void {
    let changed = false;
    for (const [id, r] of this.rules)
      if (r.processId === processId) {
        this.rules.delete(id);
        this.breach.delete(id);
        changed = true;
      }
    if (changed) this.saveRules();
  }

  // ---- events: the fired-alert history (persisted NDJSON, capped, debounce-saved) --
  listEvents(): AlertEvent[] {
    return this.events;
  }

  clearEvents(processId?: string): void {
    this.events = processId ? this.events.filter((e) => e.processId !== processId) : [];
    this.scheduleSaveEvents();
    this.onChange();
  }

  /**
   * Evaluate every enabled rule against this tick's live samples. Called once per
   * metrics tick (manager/monitoring.ts, METRICS_INTERVAL). A rule fires the instant its
   * metric has stayed over `threshold` for a continuous `forMs` window - and then stays
   * quiet until the metric drops back under threshold and breaches again, so one
   * sustained incident is one event, not one every tick for as long as it lasts.
   * Returns the events that fired on THIS call (for the caller to push out over SSE).
   */
  evaluate(samples: AlertSample[], now: number = Date.now()): AlertEvent[] {
    const byProcess = new Map(samples.map((s) => [s.processId, s]));
    const fired: AlertEvent[] = [];
    for (const rule of this.rules.values()) {
      const event = this.evaluateRule(rule, byProcess, now);
      if (event) fired.push(event);
    }
    if (fired.length) {
      this.scheduleSaveEvents();
      this.onChange();
    }
    return fired;
  }

  /**
   * One rule against this tick's samples: the event it just fired, or null. Keeps `this.breach`
   * in step on the way — the breach window is cleared whenever the rule is not currently over,
   * and opened on the first over-threshold tick.
   */
  private evaluateRule(
    rule: AlertRule,
    byProcess: Map<string, AlertSample>,
    now: number,
  ): AlertEvent | null {
    if (!rule.enabled) {
      this.breach.delete(rule.id);
      return null;
    }
    const sample = byProcess.get(rule.processId);
    const value = sample ? (rule.metric === "cpu" ? sample.cpu : sample.memory) : null;
    const over = value != null && value > rule.threshold;
    if (!over || !sample) {
      this.breach.delete(rule.id); // stopped, missing, or dropped back under - breach resets
      return null;
    }
    let state = this.breach.get(rule.id);
    if (!state) {
      state = { since: now, fired: false };
      this.breach.set(rule.id, state);
    }
    if (state.fired || now - state.since < rule.forMs) return null;
    state.fired = true;
    const event: AlertEvent = {
      id: randomUUID(),
      ruleId: rule.id,
      processId: sample.processId,
      processName: sample.processName,
      projectId: sample.projectId,
      projectName: sample.projectName,
      metric: rule.metric,
      threshold: rule.threshold,
      value,
      firedAt: now,
    };
    this.events.unshift(event);
    if (this.events.length > MAX_ALERT_EVENTS) this.events.length = MAX_ALERT_EVENTS;
    return event;
  }

  // ---- persistence: rules (plain JSON, small + infrequent) -------------------------
  private saveRules(): void {
    try {
      mkdirSync(dataDir(), { recursive: true });
      writeJsonAtomic(rulesFile(), { rules: this.listRules() }, { trailingNewline: false });
    } catch {
      /* best-effort - losing a rule edit is recoverable via the GUI */
    }
  }

  private loadRules(): void {
    try {
      const j = JSON.parse(readFileSync(rulesFile(), "utf8"));
      const arr = Array.isArray(j?.rules) ? j.rules : [];
      for (const r of arr) {
        if (r && typeof r.id === "string" && typeof r.processId === "string")
          this.rules.set(r.id, r);
      }
    } catch {
      /* no rules file yet */
    }
  }

  // ---- persistence: events (NDJSON, debounce-saved like errors.ts) -----------------
  private scheduleSaveEvents(): void {
    this.eventsDirty = true;
    if (this.saveTimer) return;
    // Resolve the DESTINATION now, not when the timer fires. `eventsFile()` reads
    // `dataDir()`, which reads DEVWEBUI_HOME lazily, so a debounced write used to land
    // wherever that pointed a moment LATER - a different directory than the state it was
    // scheduled for. Production never moves its data dir, so this only ever bit tests:
    // alerts.test.ts gives each test its own throwaway home and restores the shared one in
    // afterEach, and whichever side of that restore the timer landed on decided where the
    // fired events were written. On macOS it lost the race, the events went to the SUITE's
    // home, and alert-routes.test.ts then read them back and failed its "list starts empty"
    // assertion - a cross-file failure with no visible connection to either file.
    const target = eventsFile();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.eventsDirty) this.saveEvents(target);
    }, SAVE_DEBOUNCE_MS);
  }

  private saveEvents(target: string = eventsFile()): void {
    this.eventsDirty = false;
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, `${this.events.map((e) => JSON.stringify(e)).join("\n")}\n`);
    } catch {
      /* best-effort */
    }
  }

  private loadEvents(): void {
    try {
      for (const line of readFileSync(eventsFile(), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as AlertEvent;
          if (e.id) this.events.push(e);
        } catch {
          /* skip bad line */
        }
      }
      this.events.sort((a, b) => b.firedAt - a.firedAt);
      if (this.events.length > MAX_ALERT_EVENTS) this.events.length = MAX_ALERT_EVENTS;
    } catch {
      /* no events log yet */
    }
  }
}
