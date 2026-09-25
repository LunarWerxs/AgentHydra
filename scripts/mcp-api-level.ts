#!/usr/bin/env bun
// Freeze or check the MCP tool surface (server/src/mcp-api-levels.ts says why levels exist).
//
//   bun run mcp:api-level           report every break against every committed level, and whether
//                                   this version's level is frozen yet; exits 1 on either
//   bun run mcp:api-level --write   freeze the live surface as server/mcp-api-levels/<version>.json
//                                   (a release step, docs/RELEASING.md); refuses to rewrite a level
//                                   that differs unless --force, since a tagged level is frozen
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SERVER_INFO, TOOLS } from '../server/src/mcp.ts'
import {
  API_LEVELS_DIR,
  breaksBetween,
  loadApiLevels,
  surfaceOf,
} from '../server/src/mcp-api-levels.ts'

const version = SERVER_INFO.version
const levels = loadApiLevels()
const earlier = levels.filter((l) => l.version !== version)
const live = surfaceOf(TOOLS, version, earlier)
const text = `${JSON.stringify(live, null, 2)}\n`
const file = join(API_LEVELS_DIR, `${version}.json`)

const writing = process.argv.includes('--write')
// Freezing may replace this version's own level (--force), so it answers to the earlier ones only;
// a check answers to every committed level, this version's included.
const breaks = (writing ? earlier : levels).flatMap((l) => breaksBetween(l, live))
for (const b of breaks) console.error(`BREAK vs ${b.level}: ${b.path}: ${b.what}`)

if (writing) {
  if (breaks.length) {
    console.error('refusing to freeze a level that breaks an earlier one (see ACCEPTED_BREAKS)')
    process.exit(1)
  }
  let existing: string | null = null
  try {
    existing = readFileSync(file, 'utf8')
  } catch {
    /* not frozen yet */
  }
  if (existing === text) {
    console.log(`level ${version} already frozen and current (${live.tools.length} tools)`)
    process.exit(0)
  }
  if (existing !== null && !process.argv.includes('--force')) {
    console.error(
      `level ${version} is already frozen and differs from the live surface. A released level ` +
        'never changes; bump the version instead, or pass --force if this version is not tagged yet.',
    )
    process.exit(1)
  }
  mkdirSync(API_LEVELS_DIR, { recursive: true })
  writeFileSync(file, text)
  const added = live.tools.filter((t) => t.since === version).length
  console.log(
    `froze level ${version}: ${live.tools.length} tools, ${added} new since the last level`,
  )
  process.exit(0)
}

const frozen = levels.some((l) => l.version === version)
if (!frozen) console.error(`level ${version} is not frozen: run bun run mcp:api-level --write`)
console.log(
  `${levels.length} level(s) checked against ${live.tools.length} live tools: ${breaks.length} break(s)`,
)
process.exit(breaks.length || !frozen ? 1 : 0)
