import { toast } from "vue-sonner";
import { useI18n } from "vue-i18n";
import { freePort } from "@/api";
import type { ProcessView } from "@/types";

/**
 * "Free this port" with a guarded confirm step. A managed holder is stopped cleanly by
 * the daemon; if EXTERNAL (unmanaged) processes hold the port, the daemon reports them
 * and we surface a confirm toast — killing them only when the user clicks "Kill anyway".
 * Call this in a component's setup, then invoke the returned function from a click.
 */
export function useFreePortAction() {
  const { t } = useI18n({ useScope: "global" });

  // Keep the toast from ballooning into a wall of text: a command line can be arbitrarily
  // long (interpreter + full script path + args), so truncate what we show per owner.
  const CMDLINE_MAX = 80;
  function truncateCmdline(cmd: string): string {
    return cmd.length > CMDLINE_MAX ? `${cmd.slice(0, CMDLINE_MAX)}…` : cmd;
  }

  async function run(proc: ProcessView, confirm: boolean): Promise<void> {
    try {
      const res = await freePort(proc.id, confirm);
      if (res.needsConfirm && res.owners?.length) {
        const names = res.owners.map((o) => `${o.name} (PID ${o.pid})`).join(", ");
        // One extra detail line per owner — cmdline + uptime when the OS reported them,
        // else the owner is skipped (nothing to add beyond the title's name/PID).
        const details = res.owners
          .filter((o) => o.cmdline || o.uptime)
          .map((o) => {
            const parts: string[] = [];
            if (o.cmdline) parts.push(truncateCmdline(o.cmdline));
            if (o.uptime) parts.push(t("freePort.uptime", { uptime: o.uptime }));
            return `${o.name} (PID ${o.pid}): ${parts.join(" — ")}`;
          })
          .join("\n");
        const body = t("freePort.confirmBody", { port: proc.port ?? 0 });
        toast.warning(t("freePort.confirmTitle", { names }), {
          description: details ? `${body}\n${details}` : body,
          action: {
            label: t("freePort.killAnyway"),
            onClick: () => void run(proc, true),
          },
        });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("freePort.failed"));
    }
  }

  return (proc: ProcessView) => run(proc, false);
}
