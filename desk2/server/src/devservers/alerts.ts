// Threshold alerts on a server's CPU or memory (ported from DevWebUI's alerts.ts): "alert if this server stays over
// <threshold> for <forMs>". Rules are <home>/devservers/alerts.json, the fired events a capped
// alerts-events.ndjson. The sustained-breach clock is deliberately not saved: after a restart a breach has to last the
// full window again, so nothing fires the instant the service comes back.

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { DevWebAlertEvent, DevWebAlertMetric, DevWebAlertRule, DevWebAlertRuleInput } from '@shared/devwebui'
import { DevServerError } from './contract'
import { writeFileAtomic, writeJsonAtomic } from './project-file'

const MAX_EVENTS = 200
const SAVE_DEBOUNCE_MS = 1000
const MAX_FOR_MS = 24 * 60 * 60 * 1000

/** One server's reading from a metrics sample. */
export interface AlertSample {
  processId: string
  processName: string
  projectId: string
  projectName: string
  cpu: number | null
  memory: number | null
}

const isMetric = (v: unknown): v is DevWebAlertMetric => v === 'cpu' || v === 'memory'

function threshold(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new DevServerError('threshold must be a number of 0 or more', 400)
  return v
}

function forMs(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new DevServerError('forMs must be a number of 0 or more', 400)
  return Math.min(MAX_FOR_MS, Math.round(v))
}

export class AlertStore {
  private rules = new Map<string, DevWebAlertRule>()
  private events: DevWebAlertEvent[] = [] // newest first
  private breach = new Map<string, { since: number; fired: boolean }>()
  private over = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private eventsDirty = false

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now
  ) {
    try {
      const j = JSON.parse(readFileSync(this.rulesFile, 'utf8')) as { rules?: unknown }
      for (const r of Array.isArray(j.rules) ? (j.rules as DevWebAlertRule[]) : []) if (r && typeof r.id === 'string' && typeof r.processId === 'string' && isMetric(r.metric)) this.rules.set(r.id, r)
    } catch {
      // no rules yet
    }
    try {
      for (const line of readFileSync(this.eventsFile, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line) as DevWebAlertEvent
          if (e.id) this.events.push(e)
        } catch {
          // a bad line is skipped
        }
      }
      this.events.sort((a, b) => b.firedAt - a.firedAt)
      this.events.length = Math.min(this.events.length, MAX_EVENTS)
    } catch {
      // no events yet
    }
  }

  private get rulesFile(): string {
    return path.join(this.dir, 'alerts.json')
  }

  private get eventsFile(): string {
    return path.join(this.dir, 'alerts-events.ndjson')
  }

  list(): { rules: DevWebAlertRule[]; events: DevWebAlertEvent[] } {
    return { rules: [...this.rules.values()].sort((a, b) => a.createdAt - b.createdAt), events: [...this.events] }
  }

  /** How many enabled rules of `processId` are over their threshold at the last sample. */
  firing(processId: string): number {
    let n = 0
    for (const id of this.over) if (this.rules.get(id)?.processId === processId) n++
    return n
  }

  add(input: DevWebAlertRuleInput): DevWebAlertRule {
    if (typeof input.processId !== 'string' || !input.processId) throw new DevServerError('processId is required', 400)
    if (!isMetric(input.metric)) throw new DevServerError('metric must be "cpu" or "memory"', 400)
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new DevServerError('enabled must be true or false', 400)
    const rule: DevWebAlertRule = { id: randomUUID(), processId: input.processId, metric: input.metric, threshold: threshold(input.threshold), forMs: forMs(input.forMs), enabled: input.enabled ?? true, createdAt: this.now() }
    this.rules.set(rule.id, rule)
    this.saveRules()
    return rule
  }

  /** Omitted fields keep their value; a changed rule's sustained window starts over. */
  update(id: string, patch: Partial<DevWebAlertRuleInput>): DevWebAlertRule {
    const cur = this.rules.get(id)
    if (!cur) throw new DevServerError(`No alert rule with id "${id}".`, 404)
    if (patch.processId !== undefined && (typeof patch.processId !== 'string' || !patch.processId)) throw new DevServerError('processId must be a non-empty text', 400)
    if (patch.metric !== undefined && !isMetric(patch.metric)) throw new DevServerError('metric must be "cpu" or "memory"', 400)
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new DevServerError('enabled must be true or false', 400)
    const next: DevWebAlertRule = {
      ...cur,
      processId: patch.processId ?? cur.processId,
      metric: patch.metric ?? cur.metric,
      threshold: patch.threshold !== undefined ? threshold(patch.threshold) : cur.threshold,
      forMs: patch.forMs !== undefined ? forMs(patch.forMs) : cur.forMs,
      enabled: patch.enabled ?? cur.enabled,
    }
    this.rules.set(id, next)
    this.breach.delete(id)
    this.over.delete(id)
    this.saveRules()
    return next
  }

  remove(id: string): void {
    if (!this.rules.delete(id)) throw new DevServerError(`No alert rule with id "${id}".`, 404)
    this.breach.delete(id)
    this.over.delete(id)
    this.saveRules()
  }

  /** Rules of servers that left their project are dropped. */
  removeForProcess(processId: string): void {
    let changed = false
    for (const [id, r] of this.rules)
      if (r.processId === processId) {
        this.rules.delete(id)
        this.breach.delete(id)
        this.over.delete(id)
        changed = true
      }
    if (changed) this.saveRules()
  }

  clearEvents(): void {
    this.events = []
    this.scheduleEvents()
  }

  /**
   * Checks every enabled rule against this tick's samples. A rule fires once its metric has stayed over the threshold
   * for a continuous `forMs`, then stays quiet until it drops under and breaches again (one incident, one event).
   */
  evaluate(samples: AlertSample[]): DevWebAlertEvent[] {
    const at = this.now()
    const by = new Map(samples.map((s) => [s.processId, s]))
    const fired: DevWebAlertEvent[] = []
    for (const rule of this.rules.values()) {
      const s = by.get(rule.processId)
      const value = s ? (rule.metric === 'cpu' ? s.cpu : s.memory) : null
      if (!rule.enabled || !s || value === null || value <= rule.threshold) {
        this.breach.delete(rule.id)
        this.over.delete(rule.id)
        continue
      }
      this.over.add(rule.id)
      let b = this.breach.get(rule.id)
      if (!b) this.breach.set(rule.id, (b = { since: at, fired: false }))
      if (b.fired || at - b.since < rule.forMs) continue
      b.fired = true
      const event: DevWebAlertEvent = { id: randomUUID(), ruleId: rule.id, processId: s.processId, processName: s.processName, projectId: s.projectId, projectName: s.projectName, metric: rule.metric, threshold: rule.threshold, value, firedAt: at }
      this.events.unshift(event)
      fired.push(event)
    }
    if (fired.length) {
      this.events.length = Math.min(this.events.length, MAX_EVENTS)
      this.scheduleEvents()
    }
    return fired
  }

  private saveRules(): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      writeJsonAtomic(this.rulesFile, { rules: this.list().rules })
    } catch {
      // the next edit writes it again
    }
  }

  private scheduleEvents(): void {
    this.eventsDirty = true
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS)
    this.timer.unref?.()
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.eventsDirty) return
    this.eventsDirty = false
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileAtomic(this.eventsFile, `${this.events.map((e) => JSON.stringify(e)).join('\n')}\n`)
    } catch {
      // best effort
    }
  }
}
