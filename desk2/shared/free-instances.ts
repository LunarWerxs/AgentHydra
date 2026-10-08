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
  /** Model for a new chat: a Claude family (owner, 2026-10-07: Haiku 5.5 through free accounts where possible), or a
   *  ChatGPT model the account may offer (2026-10-08, for measured trials); else the account's usual model. */
  model?: FreeModel
}
export const FREE_CLAUDE_MODELS = ['haiku', 'sonnet'] as const
export const FREE_CHATGPT_MODELS = ['gpt-6', 'luna-thinking'] as const
export type FreeModel = (typeof FREE_CLAUDE_MODELS)[number] | (typeof FREE_CHATGPT_MODELS)[number]
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
  /** The signed-in account's address, from a login check. */
  account_email?: string | null
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
  /** `model`: the model a failed message was sent to, when the harness got that far (stats.ts counts it there). */
  error?: { code: string; message: string; chat_id?: string; model?: string }
}
export interface FreeInstance {
  id: string
  num: number
  provider: FreeProvider
  name: string
  /** True while the name follows the signed-in account: set when the account was added without a name; a rename clears it. */
  autoName: boolean
  /** The signed-in account's address (owner, 2026-10-08: the Free rows show and copy it as the others do), from the
   *  last login check; null when the site gave none or the login was logged out, absent until a check has read it. */
  email?: string | null
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
/** How an account's messages (new chats and continuations) ended in the last hour (health.ts). */
export interface FreeHealth {
  sent: number
  failed: number
  /** At least 90% of at least 5 failed: the account needs a look. Anything less is a note, never a mark. */
  failing: boolean
  /** How many failed for each reason the provider or harness gave. */
  reasons: Record<string, number>
}
/** One day's messages on one account and model (stats.ts). `model` is what the provider answered with ('unknown' when
 *  a failure came before it was chosen); '' holds the tokens of messages from before Desk recorded models, with no
 *  messages counted (`sent` 0), so they count in no success rate. */
export interface FreeStatRow { day: string; instanceId: string; model: string; sent: number; failed: number; input: number; output: number }
export interface FreeStatus {
  ready: boolean
  /** Each account's estimate by its id (tokens.ts); an account that never chatted here has none. */
  tokens?: Record<string, FreeTokens>
  /** Each account's last hour by its id (health.ts); an account that sent nothing in it has none. */
  health?: Record<string, FreeHealth>
  instances: FreeInstance[]
  jobs: FreeJob[]
}
