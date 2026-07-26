// Self-update adapter — dispatches to the right mechanism per distribution:
//   · SOURCE checkout  → the shared git engine (createUpdater / updater-engine.mjs): git pull +
//     reinstall + rebuild.
//   · COMPILED release → the GitHub-Releases updater (./github-updater): download the latest
//     release's platform bundle and swap the self-contained executable in place.
// Both expose the identical UpdateStatus / UpdateApplyResult shape, so the /api/update routes, the
// auto-update loop, and the web UI drive whichever is active without knowing which it is.
import { APP_ROOT, IS_COMPILED, SERVICE_NAME } from './config'
import { applyUpdate as ghApplyUpdate, checkForUpdate as ghCheckForUpdate } from './github-updater'
import { createUpdater, type UpdateApplyResult, type UpdateStatus } from './updater-engine.mjs'

export type { UpdateApplyResult, UpdateStatus }

const gitUpdater = createUpdater({
  appRoot: APP_ROOT,
  serviceName: SERVICE_NAME,
  appLabel: 'CC Manager UI',
  updateRepoEnvVar: 'CCMANAGERUI_UPDATE_REPO',
  installCmd: ['bun', 'install'],
  buildCmd: ['bun', 'run', '--cwd', 'web', 'build'],
})

export function checkForUpdate(): Promise<UpdateStatus> {
  return IS_COMPILED ? ghCheckForUpdate() : gitUpdater.checkForUpdate()
}

export function applyUpdate(): Promise<UpdateApplyResult> {
  return IS_COMPILED ? ghApplyUpdate() : gitUpdater.applyUpdate()
}
