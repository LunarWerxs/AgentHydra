/** Free account instances are web accounts, independent of Desktop and CLI instances. */
export const FREE_PROVIDERS = ['claude', 'chatgpt'] as const
export type FreeProvider = (typeof FREE_PROVIDERS)[number]
export const FREE_COMMANDS = ['auth', 'usage', 'chats', 'read', 'chat', 'resume', 'track', 'login'] as const
export type FreeCommand = (typeof FREE_COMMANDS)[number]
/** Run by Desk itself, never accepted as a job: 'forget' is log out (it also stops a live ChatGPT worker). */
export type FreeHarnessCommand = FreeCommand | 'forget'

/** Internal subprocess paths; managed automatically, outside the source tree. */
export interface FreeConfig { harnessDir: string; python: string; stateDir: string; cacheDir: string }
export interface FreeRequest {
  requestId: string
  instanceId: string
  provider: FreeProvider
  command: FreeCommand
  chatId?: string
  prompt?: string
  name?: string
  webSearch?: boolean
}
export interface FreeChat {
  chat_id: string
  name: string | null
  server_conversation_id?: string
  is_temporary: boolean | null
  status: string
  created_at?: string
  updated_at?: string
}
export interface FreeMessage {
  id: string
  role: string
  text: string
  code_blocks: { language: string; code: string }[]
  citations: { title: string; url: string }[]
}
export interface FreeUsage {
  available: boolean
  unlimited_text?: boolean
  text_model?: string
  plan?: string | null
  is_snapshot: boolean
  observed_at: string | null
  note: string
  windows: { id: string; used_percent: number | null; remaining_percent: number | null; resets_at: string | null; reset_passed: boolean }[]
}
export interface FreeResult {
  ok: boolean
  model?: string
  authenticated?: boolean
  account_label?: string | null
  chat_id?: string
  chat_name?: string | null
  server_conversation_id?: string
  is_temporary?: boolean
  response?: string
  messages?: FreeMessage[]
  chats?: FreeChat[]
  usage?: FreeUsage
  incomplete?: boolean
  warnings?: string[]
  error?: { code: string; message: string; chat_id?: string }
}
export interface FreeInstance {
  id: string
  num: number
  provider: FreeProvider
  name: string
  /** True while the name follows the signed-in account: set when the account was added without a name; a rename clears it. */
  autoName: boolean
  loggedIn: boolean
  checkedAt: number | null
  /** When this account was last seen signed in; null if it never was or you logged it out. Set while signed out,
   *  the login ended by itself, and the row offers "Sign in again" (owner, 2026-10-06). */
  lastSignedInAt: number | null
  lastActiveAt: number | null
  usage: FreeUsage | null
}
/** Metadata only. Message content stays at the provider and in ephemeral job results. */
export interface FreeThread {
  id: string
  instanceId: string
  provider: FreeProvider
  chatId: string
  serverId?: string
  title: string
  status: 'running' | 'done' | 'failed'
  createdAt: number
  updatedAt: number
  error: string | null
}
export interface FreeJob {
  id: string
  instanceId: string
  provider: FreeProvider
  command: FreeCommand
  state: 'running' | 'done'
  phase: 'setup' | 'working'
  startedAt: number
  finishedAt?: number
  chatId?: string
  result?: FreeResult
}
export interface FreeStatus {
  ready: boolean
  instances: FreeInstance[]
  jobs: FreeJob[]
}
