import { toast } from "vue-sonner";
import { useI18n } from "vue-i18n";
import { useAppStore } from "@/store";

/**
 * Linked groups act as one unit, so a single Start/Stop click can ripple to
 * other servers the user didn't touch. Surface that at the moment it happens:
 * "Also started: API, DB". Call this in a component's setup, then invoke the
 * returned function with the `coStarted`/`coStopped` ids a processAction
 * response carried. No-op for an empty ripple (the common, unlinked case).
 */
export function useGroupActionToast() {
  const { t } = useI18n({ useScope: "global" });
  const store = useAppStore();

  return function showGroupActionToast(kind: "started" | "stopped", ids: string[] | undefined) {
    if (!ids?.length) return;
    const nameById = new Map(store.projects.flatMap((p) => p.processes).map((p) => [p.id, p.name]));
    const names = ids.map((id) => nameById.get(id) ?? id).join(", ");
    toast.info(
      t(kind === "started" ? "groupAction.alsoStarted" : "groupAction.alsoStopped", { names }),
    );
  };
}
