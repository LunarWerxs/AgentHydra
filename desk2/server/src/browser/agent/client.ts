// The Desk side of the browser-tools service: starts it detached and hidden when it is not answering, then calls it.

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { detachedCommand } from '../../host/launch'
import type { CallResult, ToolCaller } from './contract'
import { readServiceFile, STAMP, serviceFilePath, type ServiceFile } from './service'

export const SERVICE_ENTRY = join(import.meta.dir, 'service.ts')

export interface AgentClientDeps {
  home: string
  fetch?: typeof fetch
  launch?: () => void
  startWaitMs?: number
}

export interface BrowserAgentClient {
  probe(): Promise<ServiceFile | null>
  ensure(): Promise<ServiceFile>
  call(name: string, params: Record<string, unknown>, caller?: ToolCaller): Promise<CallResult>
  stop(): Promise<void>
}

function launchService(home: string): void {
  const store = process.env.HYDRA_DESK_BROWSER_STORE
  const argv = [process.execPath, SERVICE_ENTRY, '--home', home, ...(store ? ['--store', store] : [])]
  const plan = detachedCommand(process.platform, argv)
  const child = spawn(plan.argv[0]!, plan.argv.slice(1), { stdio: 'ignore', windowsHide: true, detached: plan.detached })
  child.unref()
}

export function createBrowserAgentClient(deps: AgentClientDeps): BrowserAgentClient {
  const doFetch = deps.fetch ?? fetch
  const launch = deps.launch ?? (() => launchService(deps.home))

  async function probe(): Promise<ServiceFile | null> {
    const file = readServiceFile(deps.home)
    if (!file) return null
    try {
      const res = await doFetch(`http://127.0.0.1:${file.port}/health`, { signal: AbortSignal.timeout(1000) })
      const body = (await res.json()) as { ok?: boolean; pid?: number; stamp?: string }
      return res.ok && body.ok === true && body.pid === file.pid && body.stamp === STAMP ? file : null
    } catch {
      return null
    }
  }

  async function ensure(): Promise<ServiceFile> {
    const running = await probe()
    if (running) return running
    launch()
    const deadline = Date.now() + (deps.startWaitMs ?? 15_000)
    while (Date.now() < deadline) {
      await Bun.sleep(100)
      const file = await probe()
      if (file) return file
    }
    throw new Error(`the browser tools service did not answer (see ${serviceFilePath(deps.home)})`)
  }

  async function call(name: string, params: Record<string, unknown>, caller: ToolCaller = {}): Promise<CallResult> {
    const file = await ensure()
    const res = await doFetch(`http://127.0.0.1:${file.port}/api/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${file.token}` },
      body: JSON.stringify({ name, params, caller }),
      signal: AbortSignal.timeout(60_000),
    })
    return (await res.json()) as CallResult
  }

  async function stop(): Promise<void> {
    const file = readServiceFile(deps.home)
    if (!file) return
    try {
      await doFetch(`http://127.0.0.1:${file.port}/api/shutdown`, {
        method: 'POST',
        headers: { authorization: `Bearer ${file.token}` },
        signal: AbortSignal.timeout(2000),
      })
    } catch {
      // floor-ok: a service that already went away has nothing to stop
    }
  }

  return { probe, ensure, call, stop }
}
