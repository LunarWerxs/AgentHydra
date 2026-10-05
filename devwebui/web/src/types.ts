import type { LogLine, ScanResult } from "../../shared/dto";

// Cross-boundary DTOs are defined once in the shared module and re-exported here
// so existing `import { ProcessView } from "@/types"` call sites keep working.
export type {
  Status,
  ProcessView,
  ProjectView,
  LogLine,
  ProcessInput,
  ProjectMetaInput,
  ErrorEvent,
  ErrorSource,
  AlertEvent,
  AlertMetric,
  AlertRule,
  AlertRuleInput,
} from "../../shared/dto";

/** How a project panel lays out its processes. */
export type ViewMode = "cards" | "table";

/**
 * A `LogLine` augmented with a monotonic client-side sequence number, assigned once
 * as each line is pushed into the store (see store.ts). `LogLine.id` is the PROCESS
 * id (shared by every line in a buffer), so it can't key a v-for by itself — `seq` can.
 */
export interface LogEntry extends LogLine {
  seq: number;
}

/** An in-app notification (currently: the startup scan found new projects). */
export interface AppNotification {
  id: string;
  kind: "scan";
  /** Optional override; "scan" notifications derive their title/body from `scan`. */
  title?: string;
  body?: string;
  ts: number;
  read: boolean;
  /** For a "scan" notification: the fresh files, fed straight into the Add dialog. */
  scan?: ScanResult;
}

/** Column a process list is ordered by. */
export type SortKey = "name" | "status" | "port" | "cpu" | "memory" | "uptime";
export type SortDir = "asc" | "desc";

/** Coarse status group used for filtering (collapses starting/stopping into "busy"). */
export type StatusBucket = "running" | "busy" | "crashed" | "stopped";
