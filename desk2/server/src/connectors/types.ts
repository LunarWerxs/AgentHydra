// What one connector is on the server side (shared/connectors.ts says what a connector is to the page). Each one
// lives in its own file here and the registry polls them in the background, so a chat's buildOptions, which is
// synchronous, reads the last status instead of probing.

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { ConnectorInfo, ConnectorStatus } from '@shared/connectors'

/** What a connector found the last time it looked; the registry adds enabled, givesChats and checkedAt. */
export type Detected = Pick<ConnectorStatus, 'state' | 'url' | 'version' | 'reason'>

/** What a chat gets from a running, enabled connector. */
export interface ConnectorChat {
  /**
   * Added to the chat's mcpServers under these names. stdio or http only: the options cross to a chat host
   * process, so an in-process SDK server would not survive it. Never logged: a config can carry a credential.
   */
  mcpServers?: Record<string, McpServerConfig>
  /** One paragraph appended to the chat's system prompt after Desk's own. */
  prompt?: string
}

export interface ConnectorDef {
  info: ConnectorInfo
  /** Where it stands now. Cheap: a runtime file and a health probe capped near 1.5 s; never throws. */
  detect(): Promise<Detected>
  /**
   * Download its release asset for this platform, check it against the release's SHA256SUMS.txt, put it in
   * <Desk home>/apps/<id>/, and start it. `progress` takes one short line at a time for the Settings row.
   * Absent when Desk cannot install it itself.
   */
  install?(progress: (line: string) => void): Promise<void>
  /** Start it hidden when it is installed and not answering (never a visible console window). */
  start?(): Promise<void>
  /** What a chat in `cwd` gets while this connector is enabled; synchronous, from the cached status. */
  chat?(cwd: string, status: ConnectorStatus): ConnectorChat | null
}
