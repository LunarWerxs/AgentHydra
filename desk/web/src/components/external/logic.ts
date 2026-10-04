// An outside session Hydra Desk can carry on (ExternalSession.canResume) opens like one of its own
// chats: this is the stand-in chat the composer works on until the first message imports the
// session under its account (the CLI instance that holds it, one picked in the title bar, else the one
// the server places it on: a copy there) and resumes it.
import type { AccountInfo, AccountRef, ChatPatch, ChatSummary, ExternalSession } from '@shared/protocol'
import { accountLabel } from '@/components/accounts/format'
import { sourceLabel } from '@/components/sidebar/logic'

export const EXTERNAL_CHAT_PREFIX = 'ext:'
/** The machine's own ~/.claude login's account id. */
const DEFAULT_LOGIN = 'default'

export const isExternalChatId = (id: string): boolean => id.startsWith(EXTERNAL_CHAT_PREFIX)
export const externalChatId = (sessionId: string): string => `${EXTERNAL_CHAT_PREFIX}${sessionId}`
export const sessionOfChatId = (id: string): string => id.slice(EXTERNAL_CHAT_PREFIX.length)

/** A Claude Code session from Claude Desktop or a terminal: one Hydra Desk can carry on once it is idle. */
export function resumable(s: Pick<ExternalSession, 'source'>): boolean {
  return s.source === 'desktop' || s.source === 'cli'
}

/** An account as the composer shows it. */
export function accountRefOf(a: AccountInfo): AccountRef {
  return { id: a.id, label: a.label, configDir: a.configDir, ...(a.number !== undefined ? { number: a.number } : {}) }
}

/** The CLI instance that holds the session, when it can resume it in place: a signed-out login cannot. */
export function holderOf(s: Pick<ExternalSession, 'accountId'>, accounts: AccountInfo[]): AccountInfo | undefined {
  const owner = s.accountId ? accounts.find((x) => x.id === s.accountId) : undefined
  return owner?.signedIn ? owner : undefined
}

/** The account a session continues under: the one picked for it, the CLI instance that holds it, else where the window lands it; null while none of them is known. */
export function knownResumeAccount(s: Pick<ExternalSession, 'accountId'>, accounts: AccountInfo[], picked: string | undefined, landing: AccountRef | null): AccountRef | null {
  const chosen = picked && picked !== 'auto' ? accounts.find((x) => x.id === picked) : undefined
  if (chosen) return accountRefOf(chosen)
  const holder = holderOf(s, accounts)
  if (holder) return accountRefOf(holder)
  return landing
}

/** The account a session continues under, as the composer shows it (the default login until one is known). */
export function resumeAccountRef(s: Pick<ExternalSession, 'accountId'>, accounts: AccountInfo[], picked: string | undefined, landing: AccountRef | null): AccountRef {
  return knownResumeAccount(s, accounts, picked, landing) ?? { id: DEFAULT_LOGIN, label: 'Default', configDir: null }
}

/**
 * The quiet line over a stand-in's composer, said before the first message: it continues in place on
 * the CLI instance that holds the session, else as a copy on the account it lands on. The default login
 * is never landed on unasked (the server refuses it), so landing there means no account has room; one
 * `picked` in the title bar is where it goes. '' while the account is unknown.
 */
export function continueLine(s: Pick<ExternalSession, 'accountId'>, account: AccountRef | null, picked = false): string {
  if (!account) return ''
  const name = accountLabel(account.label, /\(([^()]+)\)\s*$/.exec(account.label)?.[1]?.trim() ?? null, account.id)
  if (account.id === s.accountId) return `Continues in place on ${name}.`
  if (account.id === DEFAULT_LOGIN && !picked) return 'No account has room to continue this session now.'
  return `Continues as a copy on ${name}. The original stays as it is.`
}

/** The stand-in chat: closed (the next message resumes it), with any change made before that. */
export function externalChat(s: ExternalSession, accounts: AccountInfo[], patch: ChatPatch = {}, landing: AccountRef | null = null, now = Date.now()): ChatSummary {
  return {
    id: externalChatId(s.id),
    sessionId: s.id,
    title: patch.title ?? s.title,
    cwd: s.cwd ?? '',
    account: resumeAccountRef(s, accounts, patch.accountId, landing),
    accountAuto: false,
    model: patch.model !== undefined ? patch.model : s.model,
    effort: patch.effort ?? null,
    permissionMode: patch.permissionMode ?? 'default',
    delegateToCliMayte: false,
    status: 'closed',
    activity: null,
    turnStartedAt: null,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: s.lastActivityAt ?? now,
    updatedAt: s.lastActivityAt ?? now,
    costUsd: 0,
    contextPct: null,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 0
  }
}

/** 'Claude Desktop (eek)': where it runs, for the quiet bar while it works there. */
export function whereLabel(s: Pick<ExternalSession, 'source' | 'instance'>): string {
  return `${sourceLabel(s.source)}${s.instance ? ` (${s.instance})` : ''}`
}
