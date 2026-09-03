import { ref, type Ref } from "vue";

/**
 * Shared self-update state machine for all LunarWerx apps. Wraps an app's two
 * update endpoints in the identical check/apply guards each app was duplicating:
 * `checkForUpdate()` is single-flight (a re-entrant call returns the cached
 * status), and `applyUpdate()` toggles `updateApplying` while folding the
 * returned status back into `updateStatus`.
 *
 * Call it INSIDE a Pinia setup store and spread the returned refs/functions into
 * that store's `return {}` (mirroring how each app already composes its other
 * setup helpers). `TStatus`/`TApply` stay the app's own DTOs, pass them as the
 * generic args: `useSelfUpdate<UpdateStatus, UpdateApplyResult>(api)`.
 */
export function useSelfUpdate<TStatus, TApply extends { status: TStatus }>(api: {
  checkUpdate(): Promise<TStatus>;
  applyUpdate(): Promise<TApply>;
}) {
  const updateStatus = ref<TStatus | null>(null) as Ref<TStatus | null>;
  const updateChecking = ref(false);
  const updateApplying = ref(false);

  async function checkForUpdate(): Promise<TStatus | null> {
    if (updateChecking.value) return updateStatus.value;
    updateChecking.value = true;
    try {
      updateStatus.value = await api.checkUpdate();
      return updateStatus.value;
    } catch {
      return updateStatus.value;
    } finally {
      updateChecking.value = false;
    }
  }

  async function applyUpdate(): Promise<TApply> {
    updateApplying.value = true;
    try {
      const result = await api.applyUpdate();
      updateStatus.value = result.status;
      return result;
    } finally {
      updateApplying.value = false;
    }
  }

  return { updateStatus, updateChecking, updateApplying, checkForUpdate, applyUpdate };
}
