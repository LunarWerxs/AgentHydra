import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_DIR } from '../config'
import type { CodexInstance } from '../types'
import { codexDesktopRunState } from './codex-desktop'
import { getCodexInstance } from './codex-instances'
import { type CodexRpc, connectCodexRpc } from './codex-rpc'
import { copyCodexTranscript } from './codex-transcript-copy'
import {
  describeStoreRefusal,
  type JsonStoreSpec,
  mutateJsonStore,
  readJsonStore,
} from './json-store'
import { isPathInside, normalizeInstancePath } from './paths'

interface Thread {
  id: string
  name?: string | null
  preview: string
  cwd: string
  path: string | null
  updatedAt: number
  model?: string | null
  modelProvider?: string
  reasoningEffort?: string | null
}

export interface CodexMoveChat {
  id: string
  title: string
  cwd: string
  updatedAt: number
}

export interface CodexMovePlan {
  chats: CodexMoveChat[]
  sourceAccountId: string | null
  targetAccountId: string | null
}

export interface CodexMoveRequest {
  targetId: string
  threadId: string
  updatedAt: number
  sourceAccountId: string | null
  targetAccountId: string | null
}

export interface CodexMoveResult {
  ok: boolean
  destinationThreadId?: string
  transcriptPath?: string
  error?: string
}

interface Receipt {
  phase: 'copying' | 'copied' | 'done'
  destinationThreadId?: string
  /** Where the rekeyed copy was written, so a resumed move resumes the copy it already made. */
  transcriptPath?: string
  updatedAt: number
  ownerPid: number | null
  destination: string
  fingerprint: string
}

interface MoveDependencies {
  getInstance: typeof getCodexInstance
  runState: typeof codexDesktopRunState
  connect: (home: string) => Promise<CodexRpc>
  journalPath: string
}
const defaults: MoveDependencies = {
  getInstance: getCodexInstance,
  runState: codexDesktopRunState,
  connect: connectCodexRpc,
  journalPath: join(CONFIG_DIR, 'codex-chat-moves.json'),
}

function pair(
  fromId: string,
  toId: string,
  deps: MoveDependencies,
): [CodexInstance, CodexInstance] {
  const from = deps.getInstance(fromId)
  const to = deps.getInstance(toId)
  if (!from || !to || from.isExternal || to.isExternal)
    throw new Error('Choose two managed Codex instances.')
  if (
    normalizeInstancePath(realpathSync(from.codexHome)) ===
    normalizeInstancePath(realpathSync(to.codexHome))
  ) {
    throw new Error('Choose a different destination instance.')
  }
  if (to.account?.authMode !== 'chatgpt')
    throw new Error('Sign in to the destination Codex account first.')
  return [from, to]
}

async function activeThreads(rpc: CodexRpc): Promise<Thread[]> {
  const threads: Thread[] = []
  let cursor: string | null = null
  const seen = new Set<string>()
  do {
    const page: { data: Thread[]; nextCursor: string | null } = await rpc.call('thread/list', {
      archived: false,
      limit: 100,
      cursor,
      modelProviders: [],
      sortKey: 'updated_at',
    })
    threads.push(...page.data)
    cursor = page.nextCursor
    if (cursor && seen.has(cursor))
      throw new Error('Codex repeated a chat-list page. Refresh and try again.')
    if (cursor) seen.add(cursor)
  } while (cursor)
  return threads
}

function chatRow(thread: Thread): CodexMoveChat {
  return {
    id: thread.id,
    title: thread.name || thread.preview || thread.id,
    cwd: thread.cwd,
    updatedAt: thread.updatedAt,
  }
}

function hasUnfinishedTurn(transcript: string): boolean {
  let running = false
  for (const line of transcript.split('\n')) {
    try {
      const row = JSON.parse(line)
      if (row.type !== 'event_msg') continue
      if (row.payload?.type === 'task_started') running = true
      if (row.payload?.type === 'task_complete' || row.payload?.type === 'turn_aborted')
        running = false
    } catch {
      /* an incomplete final line will also fail Codex's own fork */
    }
  }
  return running
}

export async function planCodexChatMove(
  fromId: string,
  toId: string,
  overrides: Partial<MoveDependencies> = {},
): Promise<CodexMovePlan> {
  const deps = { ...defaults, ...overrides }
  const [from, to] = pair(fromId, toId, deps)
  const rpc = await deps.connect(from.codexHome)
  try {
    return {
      chats: (await activeThreads(rpc)).map(chatRow),
      sourceAccountId: from.account?.accountId ?? null,
      targetAccountId: to.account?.accountId ?? null,
    }
  } finally {
    await rpc.close()
  }
}

function receiptStore(file: string): JsonStoreSpec<Record<string, Receipt>> {
  return {
    path: file,
    empty: () => ({}),
    decode: (value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, Receipt>)
        : null,
  }
}

/** A receipt is claimed under an interprocess lock, including across daemon restarts. */
function claimReceipt(
  file: string,
  key: string,
  updatedAt: number,
  destination: string,
  fingerprint: string,
): Receipt {
  const result = mutateJsonStore(receiptStore(file), (rows) => {
    const old = rows[key]
    if (old && old.destination !== destination)
      throw new Error(
        'This chat already has a move to another account. Finish or review that move first.',
      )
    if (old?.ownerPid) {
      let alive = false
      try {
        process.kill(old.ownerPid, 0)
        alive = true
      } catch {
        /* owner exited */
      }
      if (alive) throw new Error('This chat is already being moved.')
    }
    if (old?.phase === 'copying')
      throw new Error(
        'A previous copy could not be confirmed. Check the destination before attempting another move.',
      )
    if (old && (old.updatedAt !== updatedAt || old.fingerprint !== fingerprint))
      throw new Error(
        'The source chat changed after its copy was created. The original has been kept.',
      )
    const receipt: Receipt = {
      ...(old ?? { phase: 'copying', updatedAt, destination, fingerprint }),
      ownerPid: process.pid,
    }
    rows[key] = receipt
    return { result: receipt, changed: true }
  })
  if (!result.ok) throw new Error(describeStoreRefusal('Codex move history', file, result))
  return result.result
}

function saveReceipt(file: string, key: string, receipt: Receipt) {
  const result = mutateJsonStore(receiptStore(file), (rows) => {
    rows[key] = receipt
    return { result: null, changed: true }
  })
  if (!result.ok) throw new Error(describeStoreRefusal('Codex move history', file, result))
}

/** Import into the destination's own home, verify it, then archive the source. No turn is started,
 * credentials are never copied, and an archive failure resumes from the saved destination id. */
export async function moveCodexChat(
  fromId: string,
  request: CodexMoveRequest,
  overrides: Partial<MoveDependencies> = {},
): Promise<CodexMoveResult> {
  const deps = { ...defaults, ...overrides }
  let source: CodexRpc | undefined
  let target: CodexRpc | undefined
  let receipt: Receipt | undefined
  let key = ''
  try {
    const [from, to] = pair(fromId, request.targetId, deps)
    if (
      (from.account?.accountId ?? null) !== request.sourceAccountId ||
      (to.account?.accountId ?? null) !== request.targetAccountId
    ) {
      throw new Error('An account changed since this move was prepared. Review a fresh move list.')
    }
    const state = await deps.runState(from)
    if (state.state !== 'stopped')
      throw new Error(
        state.state === 'running'
          ? 'Close the source Codex desktop and its CLI sessions before moving chats.'
          : 'Could not verify whether the source Codex desktop is stopped. Try again.',
      )
    source = await deps.connect(from.codexHome)
    key = createHash('sha256')
      .update(
        JSON.stringify([
          normalizeInstancePath(realpathSync(from.codexHome)),
          request.sourceAccountId,
          request.threadId,
        ]),
      )
      .digest('hex')
    const destination = JSON.stringify([
      normalizeInstancePath(realpathSync(to.codexHome)),
      request.targetAccountId,
    ])
    const saved = readJsonStore(receiptStore(deps.journalPath))
    if (saved.status === 'ok') {
      const old = saved.value[key]
      if (
        old?.phase === 'done' &&
        old.destination === destination &&
        old.updatedAt === request.updatedAt
      ) {
        return { ok: true, destinationThreadId: old.destinationThreadId }
      }
    }
    // Find only among active chats. Never import an archived chat via a forged/stale request.
    const thread = (await activeThreads(source)).find((row) => row.id === request.threadId)
    if (!thread) throw new Error('The source chat is no longer active. Refresh the move list.')
    if (thread.updatedAt !== request.updatedAt)
      throw new Error('The source chat changed. Review a fresh move list.')
    if (
      !thread.path ||
      !existsSync(thread.path) ||
      !isPathInside(realpathSync(join(from.codexHome, 'sessions')), realpathSync(thread.path))
    ) {
      throw new Error('This chat has no local transcript in the source instance.')
    }
    const before = statSync(thread.path)
    target = await deps.connect(to.codexHome)
    const transcript = readFileSync(thread.path)
    if (hasUnfinishedTurn(transcript.toString('utf8'))) {
      throw new Error(
        'This chat has an unfinished turn. Stop or finish it in Codex before moving it.',
      )
    }
    const fingerprint = createHash('sha256').update(transcript).digest('hex')
    receipt = claimReceipt(deps.journalPath, key, thread.updatedAt, destination, fingerprint)
    if (!receipt.destinationThreadId) {
      const destinationThreadId = randomUUID()
      const stamp = new Date().toISOString()
      const transcriptPath = join(
        to.codexHome,
        'sessions',
        ...stamp.slice(0, 10).split('-'),
        `rollout-${stamp.slice(0, 19).replaceAll(':', '-')}-${destinationThreadId}.jsonl`,
      )
      const content = copyCodexTranscript(
        transcript.toString('utf8'),
        thread.id,
        destinationThreadId,
      )
      mkdirSync(dirname(transcriptPath), { recursive: true })
      if (!isPathInside(realpathSync(to.codexHome), realpathSync(dirname(transcriptPath)))) {
        throw new Error('The destination session directory points outside this instance.')
      }
      writeFileSync(transcriptPath, content, { flag: 'wx', mode: 0o600 })
      receipt = { ...receipt, phase: 'copied', destinationThreadId, transcriptPath }
      saveReceipt(deps.journalPath, key, receipt)
    }
    const destinationThreadId = receipt.destinationThreadId!
    // Resume only the NEW local copy. This lets Codex build both its thread index and paginated
    // history database without consulting a source id that only exists in another CODEX_HOME.
    // A new id has no goal/queue to auto-continue, and we never issue turn/start.
    await target.call('thread/resume', {
      threadId: destinationThreadId,
      path: receipt.transcriptPath,
      cwd: thread.cwd,
      excludeTurns: true,
      ...(thread.model ? { model: thread.model } : {}),
      ...(thread.modelProvider ? { modelProvider: thread.modelProvider } : {}),
      ...(thread.reasoningEffort
        ? { config: { model_reasoning_effort: thread.reasoningEffort } }
        : {}),
    })
    await target.call('thread/name/set', {
      threadId: destinationThreadId,
      name: chatRow(thread).title,
    })
    const copied = await target.call<{ thread: Thread }>('thread/read', {
      threadId: destinationThreadId,
      includeTurns: false,
    })
    if (
      copied.thread.id !== destinationThreadId ||
      !copied.thread.path ||
      !isPathInside(realpathSync(to.codexHome), realpathSync(copied.thread.path))
    ) {
      throw new Error('The destination copy could not be verified. The source was kept.')
    }
    // Unload the new task so app-server does not leave a live session behind when it exits.
    await target.call('thread/unsubscribe', { threadId: destinationThreadId })
    const after = statSync(thread.path)
    const latest = (await activeThreads(source)).find((row) => row.id === thread.id)
    const stopped = await deps.runState(from)
    if (
      stopped.state !== 'stopped' ||
      !latest ||
      latest.updatedAt !== thread.updatedAt ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error(
        'The source changed during the copy. Both chats were kept; review them before continuing.',
      )
    }
    await source.call('thread/archive', { threadId: thread.id })
    receipt = { ...receipt, phase: 'done' }
    saveReceipt(deps.journalPath, key, receipt)
    return { ok: true, destinationThreadId }
  } catch (error) {
    return {
      ok: false,
      destinationThreadId: receipt?.destinationThreadId,
      error: error instanceof Error ? error.message : 'Could not move the Codex chat.',
    }
  } finally {
    await source?.close()
    await target?.close()
    if (receipt) {
      try {
        saveReceipt(deps.journalPath, key, { ...receipt, ownerPid: null })
      } catch {
        /* keep the durable receipt */
      }
    }
  }
}
