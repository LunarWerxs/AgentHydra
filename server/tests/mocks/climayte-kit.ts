// A stand-in for the daemon's sweep in the CliMayte integration tests. They run the fake CLI, which
// writes a transcript, and an attempt's spend is read from the analytics kit, which only the daemon
// fills. This ingests the attempt's transcript just before each read, with the kit's own line parser
// and pricing, into a scratch store; install it with setSpendKit(harnessKit).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { claudeLineEvent } from '../../src/kit/ingest-claude'
import { KitStore } from '../../src/kit/store'

export const kitStore = new KitStore(':memory:')
function ingestNow(configDir: string, instance: string, session: string): void {
  const files = (dir: string, agent: 'main' | 'subagent'): [string, 'main' | 'subagent'][] =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory()
            ? files(join(dir, e.name), 'subagent')
            : e.name.endsWith('.jsonl')
              ? [[join(dir, e.name), agent] as [string, 'main' | 'subagent']]
              : [],
        )
      : []
  const root = join(configDir, 'projects')
  if (!existsSync(root)) return
  const mine = readdirSync(root).flatMap((p) => [
    ...(existsSync(join(root, p, `${session}.jsonl`))
      ? ([[join(root, p, `${session}.jsonl`), 'main']] as [string, 'main' | 'subagent'][])
      : []),
    ...files(join(root, p, session, 'subagents'), 'subagent'),
  ])
  const owner = { instance, source: 'cli' as const, accountAt: () => null }
  const have = kitStore.db.prepare('select instance from usage_event where id = ?')
  for (const [file, agent] of mine) {
    const at = statSync(file)
    const events = readFileSync(file, 'utf8')
      .split('\n')
      .map((line) =>
        claudeLineEvent(line, at.mtimeMs, {
          session,
          agent,
          owner,
          source: 'climayte',
          pc: null,
          priceVer: 'test',
          accountId: () => null,
        }),
      )
      // a session copied to another account's dir keeps its calls under the first dir's instance
      .filter((e) => {
        if (!e) return false
        const row = have.get(e.id) as { instance: string } | null
        return !row || row.instance === instance
      })
    kitStore.upsertEvents(events as NonNullable<(typeof events)[number]>[])
    kitStore.setCursor({
      path: file,
      size: at.size,
      mtime: Math.floor(at.mtimeMs),
      offset: at.size,
      version: 3,
    })
  }
}
export const harnessKit = { store: kitStore, refresh: ingestNow }
