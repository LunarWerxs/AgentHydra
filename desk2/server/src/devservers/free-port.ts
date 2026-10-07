// Who holds a port and whether it may be ended (DevWebUI's freeProcessPort, with the guards this app adds). Pure over a
// port scan, so the manager feeds it a scan and acts on the answer. AgentHydra's own programs (Desk, this service, the
// daemon, a chat's host), an OS service and a tool daemon are never ended: the answer is a refusal that says why. A
// holder that is a server this manager runs is stopped cleanly by the manager; anything else needs the person's confirm.

import type { DevWebPortOwner, LocalServerKind } from '@shared/devwebui'
import { classify, isDescendant, type Scan } from '../localhost/ports'
import type { AdoptContext } from './adopt'

export interface PortHolder extends DevWebPortOwner {
  kind: LocalServerKind
  /** The id of the server this manager runs that this program is (or runs under). */
  managedId?: string
}

function formatUptime(createdAt: number | null, now: number): string | undefined {
  if (!createdAt) return undefined
  const s = Math.max(0, Math.floor((now - createdAt) / 1000))
  const days = Math.floor(s / 86400)
  const hours = Math.floor((s % 86400) / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

/** Every program listening on `port` in the scan, one row per pid. `managed` is the servers this manager runs. */
export function portHolders(port: number, scan: Scan, ctx: Pick<AdoptContext, 'selfPids' | 'deskPid' | 'deskPort'>, managed: { id: string; pid: number }[], now: number): PortHolder[] {
  const out: PortHolder[] = []
  for (const l of scan.listeners) {
    if (l.port !== port || out.some((o) => o.pid === l.pid)) continue
    const proc = scan.procs.get(l.pid)
    const kind: LocalServerKind = ctx.selfPids.includes(l.pid) ? 'desk' : classify(l, proc, { deskPid: ctx.deskPid, deskPort: ctx.deskPort })
    const mine = managed.find((m) => isDescendant(l.pid, m.pid, scan.procs))
    out.push({ pid: l.pid, name: proc?.name || String(l.pid), ...(proc?.command ? { cmdline: proc.command } : {}), ...(formatUptime(proc?.created ?? null, now) ? { uptime: formatUptime(proc?.created ?? null, now) } : {}), kind, ...(mine ? { managedId: mine.id } : {}) })
  }
  return out
}

const WHY: Partial<Record<LocalServerKind, string>> = {
  desk: "one of AgentHydra's own windows or chat hosts",
  agenthydra: "AgentHydra's own daemon",
  system: 'an operating-system service',
  service: 'a tool daemon (an MCP server, a cache or an indexer)',
}

/** Why the port will not be freed, or null when every holder may be ended (a server of ours is stopped, others need a confirm). */
export function refusal(port: number, holders: PortHolder[]): string | null {
  const bad = holders.find((h) => !h.managedId && WHY[h.kind])
  return bad ? `Port ${port} is held by ${bad.name} (pid ${bad.pid}), ${WHY[bad.kind]}. AgentHydra never ends that.` : null
}

/**
 * Why ending these holders is refused, or null. Ending a holder ends its whole process tree, so a holder with
 * AgentHydra's own process under it, or with a listener under it that refusal() would protect, is refused too.
 */
export function treeRefusal(holders: PortHolder[], scan: Scan, ctx: Pick<AdoptContext, 'selfPids' | 'deskPid' | 'deskPort'>): string | null {
  for (const h of holders) {
    const self = ctx.selfPids.find((pid) => isDescendant(pid, h.pid, scan.procs))
    if (self !== undefined) return `Ending ${h.name} (pid ${h.pid}) would also end AgentHydra's own process (pid ${self}). AgentHydra never ends that.`
    for (const l of scan.listeners) {
      if (l.pid === h.pid || !isDescendant(l.pid, h.pid, scan.procs)) continue
      const proc = scan.procs.get(l.pid)
      const kind = classify(l, proc, { deskPid: ctx.deskPid, deskPort: ctx.deskPort })
      if (WHY[kind]) return `Ending ${h.name} (pid ${h.pid}) would also end ${proc?.name || l.pid} (pid ${l.pid}), ${WHY[kind]}. AgentHydra never ends that.`
    }
  }
  return null
}

/** The shape DevWebFreePort's owners take: without the internal fields. */
export const asOwner = ({ pid, name, cmdline, uptime }: PortHolder): DevWebPortOwner => ({ pid, name, ...(cmdline ? { cmdline } : {}), ...(uptime ? { uptime } : {}) })
