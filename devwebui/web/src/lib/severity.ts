// Single source of truth for status/source → presentation. The old PrimeVue
// "severity" strings are gone; instead each state maps to a shadcn Badge variant
// plus a dot colour, so the same semantics live in one place and read correctly in
// both light and dark themes.
import type { BadgeVariants } from "@/components/ui/badge";
import type { Status } from "@/types";

export interface Pill {
  label: string;
  /** The `<Badge>` variant that carries this state's tint (the kit owns the colours). */
  variant: BadgeVariants["variant"];
  /** Background class for a small round status dot. */
  dot: string;
}

/** Shared amber/warning callout-banner color classes (port conflicts, takeover/scaffold notices). */
export const WARNING_BANNER = "border-warning/30 bg-warning/10 text-warning";

export function statusPill(status: Status): Pill {
  switch (status) {
    case "running":
      return { label: status, variant: "success", dot: "bg-success" };
    case "starting":
    case "stopping":
    case "waiting":
      return { label: status, variant: "warning", dot: "bg-warning" };
    case "crashed":
      return { label: status, variant: "destructive", dot: "bg-destructive" };
    default:
      return { label: status, variant: "muted", dot: "bg-muted-foreground" };
  }
}

/** Badge variant for an error record's source (crash / stderr / stdout). */
export function sourceBadgeVariant(source: string): BadgeVariants["variant"] {
  return source === "crash" ? "destructive" : source === "stderr" ? "warning" : "muted";
}
