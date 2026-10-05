export interface InstanceInfo {
  port: number;
  url: string;
  pid: number;
  startedAt: number;
  /** App-published launcher-facing extras (e.g. portableMode). */
  [key: string]: unknown;
}

export interface InstancePointerOptions {
  /** Resolved config dir; runtime.json is written inside it. */
  configDir: string;
  /** If set, findLiveInstance also requires the health body's `service` to equal this. */
  serviceName?: string;
  /** Host used in the recorded url (default "127.0.0.1"). */
  host?: string;
}

export interface InstancePointer {
  instanceFilePath(): string;
  writeInstanceInfo(port: number, extra?: Record<string, unknown>): void;
  /** Merge fields into an existing pointer (no-op when none exists). */
  updateInstanceInfo(fields: Record<string, unknown>): void;
  readInstanceInfo(): InstanceInfo | null;
  clearInstanceInfo(): void;
  /**
   * Probe the recorded instance's /api/health. `attempts` > 1 re-probes before reporting
   * "nothing running" — pass >= 2 anywhere the answer decides whether to SPAWN a daemon,
   * so one missed probe against a briefly-busy daemon can't produce a duplicate instance.
   */
  findLiveInstance(timeoutMs?: number, attempts?: number): Promise<InstanceInfo | null>;
}

export function createInstancePointer(opts: InstancePointerOptions): InstancePointer;
