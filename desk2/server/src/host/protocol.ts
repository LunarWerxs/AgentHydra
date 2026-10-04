// The chat host's wire protocol (SPEC "Chat hosts"), shared by the host (chat-host.ts, core.ts) and the
// server's side of it (client.ts). A host runs one chat's SDK query outside the server, so restarting the
// server leaves the chat running: the new server connects again and replays what it missed from the host's
// journal. A host speaks the version it started with for its whole life, so a newer server must keep
// answering every version a running host may still have. This is version 1.

import type { CanUseTool, ElicitationRequest, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AccountRef } from '@shared/protocol'

export const HOST_PROTOCOL = 1

/** query() options without the callbacks: the host puts forwarding ones in their place. */
export type HostOptions = Omit<Options, 'canUseTool' | 'onElicitation' | 'stderr' | 'abortController' | 'hooks' | 'spawnClaudeCodeProcess'>

/** What the server writes for a new host. The host deletes it the moment it has read it: it carries the chat's environment. */
export interface HostSpec {
  protocol: number
  chatId: string
  /** The shared secret a connection must name. */
  token: string
  /** Where the host writes `<chatId>.json` while it runs. */
  dir: string
  /** The account the process runs under (the runtime's startedAs). */
  account: AccountRef
  options: HostOptions
  /** Minutes the host stays up with no server connected once its chat is not working. */
  orphanMinutes: number
  /** The server's own state for the chat, kept for the next server (hello hands back the latest; ack replaces it). */
  carry: unknown
}

/** `<dir>/<chatId>.json` while a host runs: how to reach it. */
export interface HostFile {
  protocol: number
  chatId: string
  pid: number
  port: number
  token: string
  startedAt: number
}

/** What a server replays after a restart, in the order it happened (seq rises by one per entry). */
export type JournalEntry =
  | { seq: number; at: number; kind: 'sdk'; msg: SDKMessage }
  | { seq: number; at: number; kind: 'input'; msg: SDKUserMessage }
  | { seq: number; at: number; kind: 'interrupt' }

/** canUseTool's options, all of them but the abort signal (which stays in the host): a newer server may read more of them. */
export type ToolRequestOptions = Omit<Parameters<CanUseTool>[2], 'signal'>

/** A canUseTool or onElicitation call waiting for its answer; `callId` is the SDK's requestId. */
export type HostRequest =
  | { callId: string; kind: 'tool'; toolName: string; input: Record<string, unknown>; options: ToolRequestOptions }
  | { callId: string; kind: 'elicitation'; request: ElicitationRequest }

/** The query ended: `error` null when the CLI exited cleanly. */
export interface HostEnd {
  error: string | null
  stderrTail: string
}

/** Host to server. A connection opens with hello, the journal as replay entries, then ready; live traffic follows. */
export type HostMessage =
  /**
   * `acked`: the seq the last ack named (journal inputs at or below it are ones a later turn may send again);
   * `carry`: what that ack left. `delivered`: the newest entry a server was sent; `unshown`: the open requests no
   * server was sent. What came after, no one was told of: the new server tells it.
   */
  | {
      type: 'hello'
      protocol: number
      chatId: string
      pid: number
      startedAt: number
      account: AccountRef
      requests: HostRequest[]
      end: HostEnd | null
      acked: number
      carry: unknown
      delivered: number
      unshown: string[]
    }
  | { type: 'replay'; entry: JournalEntry }
  | { type: 'ready' }
  | { type: 'entry'; entry: JournalEntry }
  | { type: 'request'; request: HostRequest }
  | { type: 'abort'; callId: string }
  | { type: 'stderr'; data: string }
  | { type: 'end'; end: HostEnd }
  | { type: 'reply'; rpcId: number; ok: boolean; value?: unknown; error?: string }

/** Server to host. */
export type ServerMessage =
  | { type: 'input'; msg: SDKUserMessage }
  | { type: 'answer'; callId: string; result: unknown }
  /** JSON has no undefined: `undefinedAt` names the arguments that were (setModel(undefined) is not setModel(null)). */
  | { type: 'call'; rpcId: number; method: string; args: unknown[]; undefinedAt?: number[] }
  /** Entries up to seq are done with: dropped, but for the inputs a later turn may still have to send again. */
  | { type: 'ack'; upTo: number; keepInputs: string[]; carry: unknown }
  /** The server lets go (it stops): it handled the entries up to `seen` and holds the requests in `shown`; the rest waits for the next one. */
  | { type: 'detach'; seen: number; shown: string[] }
  | { type: 'close' }

/** Query methods a server may not call through a host: they take what cannot cross a process, or have their own message. */
export const NOT_CALLABLE = new Set(['streamInput', 'close', 'next', 'return', 'throw'])
