import path from "node:path";
import { fileURLToPath } from "node:url";
import { createUpdater } from "./updater-engine.mjs";
import type { UpdateApplyResult, UpdateStatus } from "../../shared/dto";
import {
  applyUpdate as applyReleaseUpdate,
  checkForUpdate as checkReleaseUpdate,
  cleanupStaleUpdateArtifacts as cleanupReleaseArtifacts,
} from "./github-updater";
import { isCompiledBinary } from "./launch-vector";

// Thin per-app adapter over the shared kit updater engine (synced in as
// updater-engine.mjs). All the git / spawn / ls-remote / apply logic lives there;
// only DevWebUI's checkout root, update-remote env var, install/build commands, and
// service identity are local. The engine's UpdateStatus.service is `string`; it is
// narrowed back to DevWebUI's DTO here (the runtime value already is "devwebui").
const engine = createUpdater({
  appRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  serviceName: "devwebui",
  appLabel: "DevWebUI",
  updateRepoEnvVar: "DEVWEBUI_UPDATE_REPO",
  installCmd: ["bun", "install"],
  buildCmd: ["bun", "run", "build"],
});

/**
 * `opts.fresh` bypasses the 5-minute status cache, for a user who explicitly clicked
 * "Check for updates". Only the compiled-binary (GitHub Releases) path caches at all —
 * the git engine re-runs `ls-remote` every call — so the flag stops here for source checkouts.
 */
export function checkForUpdate(opts: { fresh?: boolean } = {}): Promise<UpdateStatus> {
  return isCompiledBinary()
    ? checkReleaseUpdate(opts)
    : (engine.checkForUpdate() as Promise<UpdateStatus>);
}

export function applyUpdate(): Promise<UpdateApplyResult> {
  return isCompiledBinary()
    ? applyReleaseUpdate()
    : (engine.applyUpdate() as Promise<UpdateApplyResult>);
}

export function cleanupStaleUpdateArtifacts(): void {
  if (isCompiledBinary()) cleanupReleaseArtifacts();
}
