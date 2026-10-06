// The REST reads the composer needs. Injectable so the Gallery can render it from fixtures.

import type { InjectionKey } from 'vue'
import type { AccountInfo, AccountRef, GitStatus, McpServerInfo, McpStatus, ModelChoice, SlashCommandInfo } from '@shared/protocol'

export interface FolderListing {
  path: string
  parent: string | null
  dirs: string[]
}

export interface ComposerApi {
  models(): Promise<ModelChoice[]>
  commands(chatId: string, signal?: AbortSignal): Promise<SlashCommandInfo[]>
  git(cwd: string, signal?: AbortSignal): Promise<GitStatus>
  /** The folder menu's Recent list, latest first. */
  recentFolders(): Promise<string[]>
  /** The folder was just chosen: it goes to the top of Recent. Answers the new list. */
  rememberFolder(path: string): Promise<string[]>
  /** Takes the folder off Recent until it is used again. Answers the new list. */
  forgetFolder(path: string): Promise<string[]>
  /** Opens Windows' folder dialog (near `current`); the folder chosen, already on Recent, or null when cancelled. */
  pickFolder(current: string | null): Promise<string | null>
  browse(path?: string, signal?: AbortSignal): Promise<FolderListing>
  accounts(): Promise<AccountInfo[]>
  pickAccount(): Promise<AccountRef>
  /** The MCP servers a chat in `cwd` on the account at `configDir` (null = default login) loads. */
  mcpServers(cwd: string, configDir: string | null): Promise<McpServerInfo[]>
  /** A chat's live session's MCP server states (live false without one). */
  mcpStatus(chatId: string): Promise<McpStatus>
  toggleMcp(chatId: string, name: string, enabled: boolean): Promise<void>
  /** A suggested next prompt for the chat's empty box. Hydra Desk has no source for one yet, so the app leaves it out. */
  suggestion?(chatId: string): string | null
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch('/api' + path, init)
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) msg = body.error
    } catch {}
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export const httpComposerApi: ComposerApi = {
  models: () => getJson('/models'),
  commands: (chatId, signal) => getJson(`/chats/${encodeURIComponent(chatId)}/commands`, { signal }),
  git: (cwd, signal) => getJson(`/git?cwd=${encodeURIComponent(cwd)}`, { signal }),
  recentFolders: () => getJson('/folders/recent'),
  rememberFolder: (path) =>
    getJson('/folders/recent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) }),
  forgetFolder: (path) => getJson(`/folders/recent?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  pickFolder: async (current) => {
    const res = await getJson<{ path: string | null }>('/folders/pick', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ current })
    })
    return res.path
  },
  browse: (path, signal) => getJson(`/folders/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`, { signal }),
  accounts: () => getJson('/accounts'),
  pickAccount: () => getJson('/accounts/pick'),
  mcpServers: (cwd, configDir) =>
    getJson(`/mcp-servers?cwd=${encodeURIComponent(cwd)}${configDir ? `&configDir=${encodeURIComponent(configDir)}` : ''}`),
  mcpStatus: (chatId) => getJson(`/chats/${encodeURIComponent(chatId)}/mcp`),
  toggleMcp: async (chatId, name, enabled) => {
    await getJson(`/chats/${encodeURIComponent(chatId)}/mcp/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled })
    })
  }
}

export const COMPOSER_API: InjectionKey<ComposerApi> = Symbol('composer-api')

/** Window event the composer fires to open the Diff pane (the store has no pane action yet). */
export const OPEN_DIFF_EVENT = 'hydra-desk:open-diff'

/** Window event the composer fires to open the CliMayte pane (detail: { originSessionId }). */
export const OPEN_CLIMAYTE_EVENT = 'hydra-desk:open-climayte'

/** Window event the composer fires to open the RepoYeti pane. */
export const OPEN_REPOYETI_EVENT = 'hydra-desk:open-repoyeti'

/** Window event the composer fires to bring the chat's pending request into view (detail: { chatId }). */
export const SHOW_PENDING_EVENT = 'hydra-desk:show-pending'

/** Window event the composer fires as a message is sent or queued: that chat's transcript goes to its bottom and follows the reply. */
export const CHAT_SENT_EVENT = 'hydra-desk:chat-sent'
export interface ChatSentDetail {
  chatId: string
  sessionId: string | null
}

/** Whether a send was into the transcript shown under `transcriptId`: a Desk chat's id, or an outside session's id (its composer's chat is a stand-in with an id of its own). */
export function sentHere(detail: ChatSentDetail | null | undefined, transcriptId: string): boolean {
  return !!detail && (detail.chatId === transcriptId || detail.sessionId === transcriptId)
}
