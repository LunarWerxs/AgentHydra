#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { CONFIG_DIR } from '../server/src/config'
import { moveCodexChat, planCodexChatMove } from '../server/src/core/codex-chat-move'
import { codexDesktopRunState } from '../server/src/core/codex-desktop'
import {
  getCodexInstance,
  listCodexInstances,
  quitCodexDesktopInstance,
} from '../server/src/core/codex-instances'
import { normalizeInstancePath } from '../server/src/core/paths'

// One explicit account drain through the production mover. No model turns or archive sweep.
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    from: { type: 'string' },
    to: { type: 'string', default: 'here' },
    'all-active': { type: 'boolean', default: false },
    'close-source': { type: 'boolean', default: false },
  },
})
if (!values.from) throw new Error('Specify --from <account name, email, number or id>.')
const instances = (await listCodexInstances()).filter((row) => !row.isExternal)
function resolveAccount(selector: string) {
  if (selector === 'here') {
    const home = process.env.CODEX_HOME
    if (!home) throw new Error('CODEX_HOME is required to resolve here.')
    const found = instances.filter(
      (row) => normalizeInstancePath(row.codexHome) === normalizeInstancePath(home),
    )
    if (found.length !== 1) throw new Error('The calling Codex account could not be identified.')
    return found[0]!
  }
  const key = selector.toLowerCase()
  const exact = instances.filter((row) =>
    [row.id, row.name, row.account?.email, row.account?.name, String(row.num)].some(
      (value) => value?.toLowerCase() === key,
    ),
  )
  const matches = exact.length
    ? exact
    : instances.filter((row) =>
        [row.name, row.account?.email, row.account?.name].some((value) =>
          value?.toLowerCase().includes(key),
        ),
      )
  if (matches.length !== 1)
    throw new Error(`Account '${selector}' must match exactly one instance.`)
  return matches[0]!
}
const source = resolveAccount(values.from)
const target = resolveAccount(values.to!)
let plan = await planCodexChatMove(source.id, target.id)
console.log(JSON.stringify({ from: source.name, to: target.name, chats: plan.chats.length }))
if (!values['all-active']) {
  console.log(JSON.stringify({ dryRun: true, plan }))
  process.exit(0)
}
const runDir = join(CONFIG_DIR, 'backups', `codex-move-${Date.now()}`)
mkdirSync(runDir, { recursive: true })
const reportPath = join(runDir, 'report.json')
const report = { sourceId: source.id, targetId: target.id, plan, results: [] as unknown[] }
const save = () => writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
save()
let state = await codexDesktopRunState(source)
if (state.state === 'running' && values['close-source']) {
  const stopped = await quitCodexDesktopInstance(source.id)
  if (!stopped.ok) throw new Error(stopped.message ?? 'Could not close the source desktop.')
  const deadline = Date.now() + 30_000
  do {
    state = await codexDesktopRunState(source)
    if (state.state !== 'running') break
    await Bun.sleep(500)
  } while (Date.now() < deadline)
}
if (state.state !== 'stopped') throw new Error('Close the source account before moving its chats.')
plan = await planCodexChatMove(source.id, target.id)
report.plan = plan
save()
for (const [index, chat] of plan.chats.entries()) {
  // The mover rechecks account identity, transcript state and source process on every chat.
  if (!getCodexInstance(source.id) || !getCodexInstance(target.id))
    throw new Error('An account was removed during the batch.')
  const result = await moveCodexChat(source.id, {
    targetId: target.id,
    threadId: chat.id,
    updatedAt: chat.updatedAt,
    sourceAccountId: plan.sourceAccountId,
    targetAccountId: plan.targetAccountId,
  })
  report.results.push({ sourceThreadId: chat.id, title: chat.title, ...result })
  save()
  console.log(JSON.stringify({ chat: index + 1, total: plan.chats.length, ...result }))
  if (!result.ok) {
    console.error(`The source was retained. Report: ${reportPath}`)
    process.exit(1)
  }
}
console.log(JSON.stringify({ complete: true, moved: report.results.length, reportPath }))
