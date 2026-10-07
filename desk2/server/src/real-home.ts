// The real home: the one data folder on this PC whose Desk is a peer of the owner's other PCs. A Desk on any other
// folder (HYDRA_DESK_HOME: every test, e2e script and probe) still runs, but never joins Login sync
// (free-instances/sync.ts) and never sets up the Free runtime (free-instances/runtime.ts). Until 2026-10-07 only
// bun test's NODE_ENV kept a throwaway out, so an e2e run or a probe pulled every Free login into a temp folder, and
// a log out or a delete there would have reached every PC.

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const REAL_HOME = join(homedir(), '.hydra-desk-2')

const key = (path: string) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path))

/** Whether a Desk on this data home is the real one. */
export function isRealHome(home: string): boolean {
  return key(home) === key(REAL_HOME)
}
