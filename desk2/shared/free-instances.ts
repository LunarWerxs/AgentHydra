/** Free account instances are web accounts, independent of Desktop and CLI instances. */
export const FREE_PROVIDERS = ['claude', 'chatgpt'] as const
export type FreeProvider = (typeof FREE_PROVIDERS)[number]
export const FREE_COMMANDS = ['auth', 'usage', 'chats', 'read', 'chat', 'resume', 'track', 'login', 'nudge'] as const
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
  /** Claude family for a new chat (owner, 2026-10-07: Haiku 5.5 through free accounts where possible). */
  model?: 'haiku' | 'sonnet'
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
  /** The last keepalive nudge (keepalive.ts): when it ran and whether it worked; null or absent if none ran yet. */
  nudge?: { at: number; ok: boolean } | null
  /** When Desk last asked the provider for this account's usage (a usage read or a login check), worked or not;
   *  the rolling refresh (refresh.ts) goes by it. Absent on older records. */
  usageReadAt?: number | null
}
/** What a deleted account leaves behind until the login sync has told the store (sync.ts). */
export type FreeDeleted = Pick<FreeInstance, 'id' | 'num' | 'provider' | 'name'>
export interface FreeSettings { keepWindows: boolean; weeklyFloorPct: number }
/** Off until switched on, because a nudge spends real quota; 85 is the CLI keepalive's floor. */
export const FREE_SETTINGS_DEFAULTS: FreeSettings = { keepWindows: false, weeklyFloorPct: 85 }
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
  /** About how many characters the conversation holds so far (what a continuation sends the model again), for the
   *  token estimate (tokens.ts). A count, never the text; absent for a chat Desk only saw in a list. */
  contextChars?: number
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
  /** Started by Desk itself (the rolling refresh, a keepalive nudge, a login another PC shared), not by a person
   *  or a chat: the window shows no spinner for it, and an operation someone asks for waits for it, never refused. */
  auto?: boolean
}
/** Estimated tokens: neither provider reports any, so Desk counts the text each message sent (the thread it
 *  continues included) and got back, at about 4 characters a token (tokens.ts). */
export interface FreeTokenParts { input: number; output: number; total: number }
/** One account's estimate for its current 5-hour window, its current week and all time on this PC. */
export interface FreeTokens { fiveHour: FreeTokenParts; week: FreeTokenParts; total: FreeTokenParts }
export interface FreeStatus {
  ready: boolean
  /** Each account's estimate by its id (tokens.ts); an account that never chatted here has none. */
  tokens?: Record<string, FreeTokens>
  instances: FreeInstance[]
  jobs: FreeJob[]
}
