// A SIDE-RUN DECLARES ITSELF ON EVERY ANSWER.
//
// A daemon whose store is relocated (AGENTHYDRA_DATA_DIR / AGENTHYDRA_DB pointed somewhere else)
// keeps its pointer beside its own state since 2026-09-12 (instance.ts), so it can no longer hijack
// the machine-wide runtime.json. What it CAN still do is answer a client that was pointed at it on
// purpose or by a stale AGENTHYDRA_URL, and a client that silently reads and writes a scratch
// database is worse than an outage, because it looks like it worked. So the daemon says what it is
// in two places a client cannot miss: /api/health carries `sideRun` and `pointerFile` for a human,
// and every /api/* response carries this header for a program, at no extra request. mcp.ts and
// hydralib.py read the header and warn on every result from then on.
import type { MiddlewareHandler } from 'hono'
import { DB_PATH } from './config'
import { IS_PRIMARY_INSTALL, instanceFilePath } from './instance'

export const SIDE_RUN_HEADER = 'x-agenthydra-side-run'

// A SECOND DAEMON ON THIS STORE IS DECLARED THE SAME WAY (2026-10-02, docs/CLIMAYTE-FIELD-NOTES.md
// note 62). Two daemons on one store each hold their own CliMayte workers in memory, so a client of
// one reads half the fleet as all of it: the MCP answered [] and "worker not found" for 16 workers
// the other held, and the orchestrator dispatched them twice more. The pointer tick in index.ts
// asks findPeerDaemon (instance.ts) once a minute and records the answer here.
export const PEER_HEADER = 'x-agenthydra-peer'

let peer: { url: string; pid: number } | null = null

/** Record the other live daemon on this store (or null once it is gone). */
export function setPeerDaemon(p: { url: string; pid: number } | null): void {
  peer = p
}

export function peerDaemon(): { url: string; pid: number } | null {
  return peer
}

/** The health fields that say where this daemon's state lives and who owns its pointer, and the
 *  other daemon on the same store when there is one. */
export function sideRunHealthFields(): {
  pid: number
  sideRun: boolean
  pointerFile: string
  peer: { url: string; pid: number } | null
} {
  return {
    pid: process.pid,
    sideRun: !IS_PRIMARY_INSTALL,
    pointerFile: instanceFilePath(),
    peer,
  }
}

/** Hono middleware: while `sideRun`, stamp every answer with the store it came from; while another
 *  daemon serves the same store, with that daemon (`<url> pid <pid>`). */
export function sideRunHeader(sideRun = !IS_PRIMARY_INSTALL, store = DB_PATH): MiddlewareHandler {
  return async (c, next) => {
    await next()
    if (sideRun) c.res.headers.set(SIDE_RUN_HEADER, store)
    if (peer) c.res.headers.set(PEER_HEADER, `${peer.url} pid ${peer.pid}`)
  }
}
