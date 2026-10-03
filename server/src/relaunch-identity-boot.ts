// Side-effect module: must stay the FIRST import of index.ts. ES imports evaluate in order, so
// this runs before config.ts reads the environment to decide which store the daemon opens. See
// relaunch-identity.ts for why a relaunch successor needs its predecessor's identity first.
import { applyRelaunchIdentity } from './relaunch-identity'

const identity = applyRelaunchIdentity()
if (!identity.ok) {
  console.error(
    `[agenthydra] refusing to start: ${identity.reason}. Starting would open the machine's own store instead of the predecessor's.`,
  )
  process.exit(1)
}
