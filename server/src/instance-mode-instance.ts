// Dedicated running-instance pointer for the lightweight instance launcher. It deliberately lives
// below CONFIG_DIR/instance-mode rather than sharing the full daemon's runtime.json: both modes may
// coexist, and neither is allowed to make the other look stale or steal its port.
import { join } from 'node:path'
import { CONFIG_DIR, HOST } from './config'
import { createInstancePointer, type InstanceInfo } from './instance-pointer.mjs'

export const INSTANCE_MODE_SERVICE_NAME = 'ccmanagerui-instances'
export const INSTANCE_MODE_CONFIG_DIR = join(CONFIG_DIR, 'instance-mode')

const pointer = createInstancePointer({
  configDir: INSTANCE_MODE_CONFIG_DIR,
  serviceName: INSTANCE_MODE_SERVICE_NAME,
  host: HOST,
})

export type { InstanceInfo }
export const writeInstanceModeInfo = pointer.writeInstanceInfo
export const readInstanceModeInfo = pointer.readInstanceInfo
export const clearInstanceModeInfo = pointer.clearInstanceInfo
export const findLiveInstanceMode = pointer.findLiveInstance
