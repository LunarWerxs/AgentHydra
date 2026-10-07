// The engine's plugin (SPEC "Server wiring"): the ChatManager, every chat route, models, commands, the folder
// menu's routes (folders/recent, folders/pick), mcp-servers, the `hello` provider, and the chats that kept
// running in their hosts through a restart (taken over before the server answers), with server/shutdown.
// ctx.deps may carry `bridge` (a fake), `queryImpl` (a fake SDK query), `env`, `agentHydraMcp`,
// `storeDebounceMs`, `climaytePollMs`, `openFolder`, `pickFolder`, `queueSettleMs`, `queueRetryMs` and
// `shutdown` (tests).

import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { Context, Hono } from 'hono'
import type { ServerEvent } from '@shared/protocol'
import type { ServerContext } from '../context'
import { bridge } from '../bridge'
import { mainConfigFile, readAgentHydraMcp, type QueryImpl } from '../engine/chat-runtime'
import { claudeCodeBinaryFor } from '../engine/claude-code-binary'
import { listMcpServers } from '../engine/mcp-servers'
import { parseQueueAdd, parseQueuePatch, parseQueueReorder, parseQueueSettings, QueueManager } from '../engine/queue'
import {
  ChatError,
  ChatManager,
  type ManagerBridge,
  parseCreate,
  parseElicitation,
  parseFork,
  parseImport,
  parseImportDesk,
  parsePatch,
  parsePermission,
  parsePlan,
  parseQuestion,
  parseRewind,
  parseSendNow,
  parseSend,
  parseSessionMeta,
} from '../engine/chat-manager'
import { diagnosticsRoute, sinceParam } from '../engine/diagnostics'
import { checkLocalPath, isRemotePath, localFolder, type OpenFile, type OpenFolder, revealFile, revealFolder } from '../engine/reveal'
import { MEDIA_ROUTE, mediaCache } from '../media/cache'
import { nativeFolderPicker, PickError, type PickFolder } from '../folders/pick'
import { RecentFolders } from '../folders/recent'

/** How often climayteActive is re-read from the bridge poller's last worker list. */
const CLIMAYTE_REFRESH_MS = 3000

/** The items one JSON line each, written out a few hundred at a time instead of built as one string. */
function jsonlStream(items: readonly unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let next = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next >= items.length) return controller.close()
      const end = Math.min(items.length, next + 200)
      let chunk = ''
      for (; next < end; next++) chunk += JSON.stringify(items[next]) + '\n'
      controller.enqueue(encoder.encode(chunk))
    },
  })
}

async function body(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw new ChatError(400, 'the body must be JSON')
  }
}

/** A body that may be left out: none is an empty object. */
async function optionalBody(c: Context): Promise<unknown> {
  const text = await c.req.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ChatError(400, 'the body must be JSON')
  }
}

/** A ChatError as its status and reason; anything else goes to the server's 500 handler. */
function answer(c: Context, run: () => Promise<unknown> | unknown): Promise<Response> {
  return Promise.resolve()
    .then(run)
    .then(
      (value) => c.json(value as object),
      (err) => {
        if (err instanceof ChatError) return c.json({ error: err.message }, err.status)
        throw err
      },
    )
}

export default async function plugin(app: Hono, ctx: ServerContext): Promise<void> {
  const deps = ctx.deps
  // The send queue sees every chat event; it is built after the manager it sends through.
  let toQueue: (event: ServerEvent) => void = () => {}
  const manager = new ChatManager({
    home: ctx.home,
    emit: (event) => {
      ctx.broadcast(event)
      // Nothing the queue throws may reach the chat that emitted: its message has already gone to the CLI.
      try {
        toQueue(event)
      } catch (err) {
        console.warn(`[desk] the send queue could not take in ${event.type}: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    settings: ctx.settings,
    bridge: (deps.bridge as ManagerBridge | undefined) ?? bridge(),
    queryImpl: deps.queryImpl as QueryImpl | undefined,
    env: deps.env as Record<string, string | undefined> | undefined,
    agentHydraMcp: deps.agentHydraMcp as McpServerConfig | null | undefined,
    mainClaudeJson: deps.mainClaudeJson as string | null | undefined,
    claudeHome: deps.claudeHome as string | undefined,
    storeDebounceMs: typeof deps.storeDebounceMs === 'number' ? deps.storeDebounceMs : undefined,
    newChats: deps.newChats === 'sdk' ? 'sdk' : undefined,
  })
  const queue = new QueueManager({
    home: ctx.home,
    manager,
    emit: ctx.broadcast,
    settleMs: typeof deps.queueSettleMs === 'number' ? deps.queueSettleMs : undefined,
    retryMs: typeof deps.queueRetryMs === 'number' ? deps.queueRetryMs : undefined,
  })
  toQueue = (event) => queue.observe(event)
  // Stop hooks run in order: this one before closeAll (below), so the chats closing do not read as their turns ending.
  ctx.onStop(() => queue.stop())

  ctx.registerHello(() => ({ type: 'hello', version: ctx.version, chats: manager.list({ archived: true }), settings: ctx.settings(), queue: queue.state() }))

  // The send queue (SPEC "Send queue"); static paths before /api/queue/:id.
  app.get('/api/queue', (c) => c.json(queue.state()))
  app.post('/api/queue', (c) => answer(c, async () => queue.add(parseQueueAdd(await body(c)))))
  app.patch('/api/queue', (c) => answer(c, async () => queue.configure(parseQueueSettings(await body(c)))))
  app.post('/api/queue/reorder', (c) => answer(c, async () => queue.reorder(parseQueueReorder(await body(c)))))
  app.post('/api/queue/chats/:chatId/resume', (c) => answer(c, () => queue.resume(c.req.param('chatId'))))
  app.patch('/api/queue/:id', (c) => answer(c, async () => queue.edit(c.req.param('id'), parseQueuePatch(await body(c)))))
  app.delete('/api/queue/:id', (c) =>
    answer(c, () => {
      queue.remove(c.req.param('id'))
      return { ok: true }
    }),
  )
  app.post('/api/queue/:id/send-now', (c) => answer(c, () => queue.sendNow(c.req.param('id'))))
  app.post('/api/queue/:id/retry', (c) => answer(c, () => queue.retry(c.req.param('id'))))

  // Diagnostics (SPEC "Diagnostics"): ?since= (epoch ms or a date), ?cause=, ?limit= (default 100, at most 1000).
  diagnosticsRoute(app, 'failures', (c) => {
    const limit = Number(c.req.query('limit'))
    return manager.failures.read({
      since: sinceParam(c.req.query('since')),
      cause: c.req.query('cause') || undefined,
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 100,
    })
  })

  app.get('/api/chats', (c) => {
    const flag = c.req.query('archived')
    return c.json(manager.list({ archived: flag === '1' || flag === 'true' }))
  })
  app.post('/api/chats', (c) => answer(c, async () => manager.create(parseCreate(await body(c)))))
  // Before /api/chats/:id so 'import' is never read as a chat id.
  app.post('/api/chats/import', (c) => answer(c, async () => manager.importSession(parseImport(await body(c)))))
  // Hydra Desk's own chats (desk/, ~/.hydra-desk unless HYDRA_DESK_IMPORT_FROM names another data folder) copied in.
  app.post('/api/chats/import-desk', (c) =>
    answer(c, async () => manager.importDesk(process.env.HYDRA_DESK_IMPORT_FROM || join(homedir(), '.hydra-desk'), parseImportDesk(await body(c)).ids)),
  )
  app.get('/api/chats/:id', (c) => answer(c, () => manager.get(c.req.param('id'))))
  app.get('/api/chats/:id/items', (c) =>
    answer(c, async () => {
      // The Desk file answers at once; the worker's live JSONL is read behind it and its new items come over /ws.
      void manager.syncWorkers(c.req.param('id'))
      const from = Date.now()
      const items = manager.listItems(c.req.param('id'))
      manager.timings.span({ stage: 'chat_open', ms: Date.now() - from, chatId: c.req.param('id'), n: items.length })
      return items
    }),
  )
  // The warm start (SPEC "Speed (timings)"): the window asks when the owner begins typing in a closed chat.
  app.post('/api/chats/:id/warm', (c) => answer(c, () => manager.warm(c.req.param('id'))))
  // Retry under "Could not get Claude Code": the download starts again.
  app.post('/api/chats/:id/claude-code/retry', (c) => answer(c, () => manager.retryClaudeCode(c.req.param('id'))))
  // The chat's whole record, oldest first, for other programs: JSON items, or one per line with ?format=jsonl.
  app.get('/api/chats/:id/transcript', async (c) => {
    const id = c.req.param('id')
    try {
      await manager.syncWorkers(id)
      const items = manager.listItems(id)
      if (c.req.query('format') === 'jsonl') return c.body(jsonlStream(items), 200, { 'content-type': 'application/x-ndjson; charset=utf-8' })
      return c.json(items)
    } catch (err) {
      if (err instanceof ChatError) return c.json({ error: err.message }, err.status)
      throw err
    }
  })
  app.post('/api/chats/:id/messages', (c) =>
    answer(c, async () => {
      const { text, images } = parseSend(await body(c))
      // A person's send: to a running CliMayte worker it goes now (SendOptions.now), not after its whole task.
      return manager.send(c.req.param('id'), text, images, { now: true })
    }),
  )
  // AgentHydra's CliMayte ping to the chat that dispatched workers, by its Claude session id: a turn starts (a closed
  // chat is resumed), or the note queues behind a running one. 404 when no chat here owns the session, so AgentHydra
  // falls back to the CLI's own pipe.
  app.post('/api/sessions/:sessionId/ping', (c) =>
    answer(c, async () => {
      const { text } = parseSend(await body(c))
      const chatId = manager.chatForSession(c.req.param('sessionId'))
      if (!chatId) throw new ChatError(404, 'no chat here owns that session')
      const { queued } = await manager.send(chatId, text, undefined, { noTitle: true })
      return { ok: true, chatId, queued }
    }),
  )
  app.post('/api/chats/:id/send-now', (c) =>
    answer(c, async () => {
      const id = c.req.param('id')
      const { itemId } = parseSendNow(await optionalBody(c))
      const held = queue.state().held[id] !== undefined
      const r = await manager.sendNow(id, itemId)
      // The stop only hands the queued message its turn: the send queue's own messages to this chat are not held by it.
      if (!held) queue.resume(id)
      return r
    }),
  )
  app.post('/api/chats/:id/interrupt', (c) =>
    answer(c, async () => {
      await manager.interrupt(c.req.param('id'))
      return { ok: true }
    }),
  )
  app.post('/api/chats/:id/tasks/:taskId/stop', (c) => answer(c, async () => ({ item: await manager.stopTask(c.req.param('id'), c.req.param('taskId')) })))
  app.post('/api/chats/:id/permission/:requestId', (c) =>
    answer(c, async () => {
      manager.respondPermission(c.req.param('id'), c.req.param('requestId'), parsePermission(await body(c)))
      return { ok: true }
    }),
  )
  app.post('/api/chats/:id/question/:requestId', (c) =>
    answer(c, async () => {
      manager.answerQuestion(c.req.param('id'), c.req.param('requestId'), parseQuestion(await body(c)))
      return { ok: true }
    }),
  )
  app.post('/api/chats/:id/plan/:requestId', (c) =>
    answer(c, async () => {
      manager.respondPlan(c.req.param('id'), c.req.param('requestId'), parsePlan(await body(c)))
      return { ok: true }
    }),
  )
  app.post('/api/chats/:id/elicitation/:requestId', (c) =>
    answer(c, async () => {
      manager.answerElicitation(c.req.param('id'), c.req.param('requestId'), parseElicitation(await body(c)))
      return { ok: true }
    }),
  )
  app.patch('/api/chats/:id', (c) => answer(c, async () => manager.patch(c.req.param('id'), parsePatch(await body(c)))))
  app.post('/api/chats/:id/fork', (c) =>
    answer(c, async () => {
      const { at } = parseFork(await optionalBody(c))
      return at ? manager.forkBefore(c.req.param('id'), at) : manager.fork(c.req.param('id'))
    }),
  )
  app.post('/api/chats/:id/rewind', (c) => answer(c, async () => manager.rewind(c.req.param('id'), parseRewind(await body(c)).at)))
  app.patch('/api/external/sessions/:id/meta', (c) => answer(c, async () => manager.patchSessionMeta(c.req.param('id'), parseSessionMeta(await body(c)))))
  app.delete('/api/chats/:id', (c) =>
    answer(c, async () => {
      await manager.delete(c.req.param('id'))
      return { ok: true }
    }),
  )
  app.get('/api/chats/:id/commands', (c) => answer(c, () => manager.commands(c.req.param('id'))))
  app.get('/api/models', (c) => answer(c, () => manager.models()))
  const folders = new RecentFolders(join(ctx.home, 'folders.json'))
  const recent = () => folders.list(manager.list({ archived: true }))
  const pickFolder = (deps.pickFolder as PickFolder | undefined) ?? nativeFolderPicker(ctx.home)
  app.get('/api/folders/recent', (c) => c.json(recent()))
  app.post('/api/folders/recent', (c) =>
    answer(c, async () => {
      folders.remember(localFolder(await body(c)))
      return recent()
    }),
  )
  app.delete('/api/folders/recent', (c) =>
    answer(c, () => {
      const path = c.req.query('path') ?? ''
      if (!isAbsolute(path)) throw new ChatError(400, 'path must be an absolute path')
      folders.forget(path)
      return recent()
    }),
  )
  app.post('/api/folders/pick', (c) =>
    answer(c, async () => {
      const current = ((await body(c)) as { current?: unknown } | null)?.current
      const start = typeof current === 'string' && isAbsolute(current) && !isRemotePath(current) ? dirname(resolve(current)) : null
      let picked: string | null
      try {
        picked = await pickFolder(start)
      } catch (err) {
        if (err instanceof PickError) throw new ChatError(502, err.message)
        throw err
      }
      if (picked === null) return { path: null }
      if (isRemotePath(picked)) throw new ChatError(400, 'choose a folder on this computer: network folders are not supported')
      const path = localFolder({ path: picked })
      folders.remember(path)
      return { path }
    }),
  )
  const openFolder = deps.openFolder as OpenFolder | undefined
  app.post('/api/folders/reveal', (c) => answer(c, async () => revealFolder(await body(c), openFolder)))
  const openFile = deps.openFile as OpenFile | undefined
  app.post('/api/files/reveal', (c) =>
    answer(c, async () =>
      revealFile(await body(c), MEDIA_ROUTE, { file: openFile, folder: openFolder, sourceOf: (id) => mediaCache(manager.store.home)?.sourceOf(id) ?? null }),
    ),
  )
  app.get('/api/mcp-servers', (c) =>
    answer(c, () => {
      const cwd = c.req.query('cwd') ?? ''
      const configDir = c.req.query('configDir') || null
      if (!isAbsolute(cwd)) throw new ChatError(400, 'cwd must be an absolute path')
      if (configDir && !isAbsolute(configDir)) throw new ChatError(400, 'configDir must be an absolute path')
      checkLocalPath(cwd, 'cwd')
      if (configDir) checkLocalPath(configDir, 'configDir')
      const agentHydraMcp = deps.agentHydraMcp === undefined ? readAgentHydraMcp() : (deps.agentHydraMcp as McpServerConfig | null)
      const mainFile = mainConfigFile(deps.mainClaudeJson as string | null | undefined, deps.agentHydraMcp)
      return listMcpServers({ cwd, configDir, agentHydraMcp, mainFile })
    }),
  )
  app.get('/api/chats/:id/mcp', (c) => answer(c, () => manager.mcpStatus(c.req.param('id'))))
  app.post('/api/chats/:id/mcp/:name', (c) =>
    answer(c, async () => {
      const enabled = ((await body(c)) as { enabled?: unknown } | null)?.enabled
      if (typeof enabled !== 'boolean') throw new ChatError(400, 'enabled must be true or false')
      await manager.toggleMcp(c.req.param('id'), c.req.param('name'), enabled)
      return { ok: true }
    }),
  )

  // Where Claude Code's binary is from (the installed package, the cache, a download running or still needed): a
  // release has no package, so this is how a smoke test or a person sees whether the first chat will wait.
  app.get('/api/claude-code', (c) => answer(c, () => claudeCodeBinaryFor(ctx.home).status()))

  // The launcher's stop and restart (SPEC "Launcher"): the server stops the way SIGTERM stops it, the chats running
  // on in their hosts for the next server; `chats: true` ends them first.
  const shutdown = (deps.shutdown as (() => void) | undefined) ?? (() => void process.emit('SIGTERM'))
  app.post('/api/server/shutdown', (c) =>
    answer(c, async () => {
      const chats = ((await c.req.json().catch(() => null)) as { chats?: unknown } | null)?.chats === true
      if (chats) await manager.closeAll({ chats: true })
      // After this answer has left.
      setTimeout(shutdown, 50)
      return { ok: true, chats }
    }),
  )

  const pollMs = typeof deps.climaytePollMs === 'number' ? deps.climaytePollMs : CLIMAYTE_REFRESH_MS
  const timer = setInterval(() => manager.refreshClimayte(), pollMs)
  ;(timer as { unref?: () => void }).unref?.()

  ctx.onStop(async () => {
    clearInterval(timer)
    await manager.closeAll()
  })

  // Chats that kept running through the restart, before any window asks for them (SPEC "Chat hosts").
  try {
    const adopted = await manager.attachHosts(Number(process.env.HYDRA_DESK_PORT) || 7798)
    if (adopted) console.log(`[desk] took over ${adopted} chat${adopted === 1 ? '' : 's'} that kept running through the restart`)
  } catch (err) {
    console.error('[desk] could not take over the chats still running:', err)
  }
}
