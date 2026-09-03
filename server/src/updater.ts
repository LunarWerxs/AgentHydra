// Self-update adapter — dispatches to the right mechanism per distribution:
//   · SOURCE checkout  → the shared git engine (createUpdater / updater-engine.mjs): git pull +
//     reinstall + rebuild.
//   · COMPILED release → the GitHub-Releases updater (./github-updater): download the latest
//     release's platform bundle and swap the self-contained executable in place.
// Both expose the identical UpdateStatus / UpdateApplyResult shape, so the /api/update routes, the
// auto-update loop, and the web UI drive whichever is active without knowing which it is.
import { APP_ROOT, IS_COMPILED, SERVICE_NAME } from './config'
import { applyUpdate as ghApplyUpdate, checkForUpdate as ghCheckForUpdate } from './github-updater'
import { beginUpdateProgress, finishUpdateProgress, setUpdatePhase } from './update-progress'
import { createUpdater, type UpdateApplyResult, type UpdateStatus } from './updater-engine.mjs'

export type { UpdateApplyResult, UpdateStatus }

// Pre-rename override kept working. The shared kit engine takes a SINGLE env-var name, so mirror
// the legacy spelling forward here rather than fork updater-engine.mjs for one alias.
if (!process.env.AGENTHYDRA_UPDATE_REPO && process.env.CCMANAGERUI_UPDATE_REPO) {
  process.env.AGENTHYDRA_UPDATE_REPO = process.env.CCMANAGERUI_UPDATE_REPO
}

const gitUpdater = createUpdater({
  appRoot: APP_ROOT,
  serviceName: SERVICE_NAME,
  appLabel: 'AgentHydra',
  updateRepoEnvVar: 'AGENTHYDRA_UPDATE_REPO',
  installCmd: ['bun', 'install'],
  buildCmd: ['bun', 'run', '--cwd', 'web', 'build'],
})

/** `fresh` bypasses the compiled path's 5-minute result cache, for a check a PERSON asked for.
 *  It is only meaningful there: the source path shells out to git on every call and holds no
 *  cache, so it is already as fresh as it can be and the flag is silently irrelevant rather than
 *  ignored. The shared kit engine's signature is untouched either way. */
export function checkForUpdate(opts: { fresh?: boolean } = {}): Promise<UpdateStatus> {
  return IS_COMPILED ? ghCheckForUpdate(opts) : gitUpdater.checkForUpdate()
}

export async function applyUpdate(): Promise<UpdateApplyResult> {
  // The compiled path publishes its own fine-grained progress (it owns the download loop).
  if (IS_COMPILED) return ghApplyUpdate()

  // The source path cannot: git pull / `bun install` / the web build all run inside the shared kit
  // engine, which is synced and not ours to instrument. So report the phase honestly and say why it
  // is slow, rather than leaving a mute spinner over several minutes of real work — that silence is
  // the whole complaint. Coarse and true beats precise and invented.
  beginUpdateProgress('Starting the update…')
  setUpdatePhase(
    'building',
    'Pulling, reinstalling dependencies and rebuilding the web app. This runs three commands back to back and usually takes a few minutes.',
  )
  try {
    const result = await gitUpdater.applyUpdate()
    finishUpdateProgress(result.ok, result.message ?? (result.ok ? 'Updated.' : 'Update failed.'))
    return result
  } catch (e) {
    finishUpdateProgress(false, e instanceof Error ? e.message : String(e))
    throw e
  }
}
