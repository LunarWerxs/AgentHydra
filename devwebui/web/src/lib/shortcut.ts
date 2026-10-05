import { toast } from "vue-sonner";
import { useI18n } from "vue-i18n";
import { createProcessShortcut, createProjectShortcut, type ShortcutResult } from "@/api";

/**
 * "Add desktop shortcut" for a process or a whole project, plus the toast that
 * reports where the .lnk landed (or why it didn't). Call in a component's setup;
 * the three menus that offer this (ProcessCard, ProcessTable, ProjectPanel) all
 * route through here so the wording and the failure handling stay identical.
 *
 * A failed shortcut arrives as `{ ok: false, reason }` at HTTP 200 rather than as a
 * thrown error — none of the failures mean the request was bad — so the non-ok case
 * is reported as a plain message. A genuine transport/500 failure still throws and
 * is caught below.
 */
export function useShortcutAction() {
  const { t } = useI18n({ useScope: "global" });

  function report(res: ShortcutResult): void {
    if (res.ok) {
      // The .lnk's own filename is the useful part; the full path is noise on a
      // toast, and the file is on the Desktop by construction.
      const file = res.path.replace(/^.*[\\/]/, "").replace(/\.lnk$/i, "");
      toast.success(t("shortcut.created", { name: file }));
      return;
    }
    if (res.reason === "unsupported-platform") toast.info(t("shortcut.unsupported"));
    else toast.error(t("shortcut.failed", { detail: res.detail ?? res.reason }));
  }

  async function run(create: () => Promise<ShortcutResult>): Promise<void> {
    try {
      report(await create());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("shortcut.failed", { detail: "" }));
    }
  }

  return {
    /** Shortcut that starts one process (and its linked group). */
    addProcessShortcut: (id: string) => run(() => createProcessShortcut(id)),
    /** Shortcut that starts every process in a project. */
    addProjectShortcut: (id: string) => run(() => createProjectShortcut(id)),
  };
}
