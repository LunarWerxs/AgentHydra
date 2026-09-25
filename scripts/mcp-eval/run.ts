// `bun run eval:mcp` - the behavioural eval of the AgentHydra MCP server. See harness.ts.
//
//   bun scripts/mcp-eval/run.ts                     reference agent over stdio; exit 1 on any miss
//   bun scripts/mcp-eval/run.ts --serve             fixture + server config for a VISIBLE agent chat
//   bun scripts/mcp-eval/run.ts --score <file>      score that agent's answers file
//   --pairs <file>   another qa-pairs XML          --json   print the whole report as JSON
//
// WHY --serve rather than an agent loop in here: a loop would launch a model nobody can watch,
// which AgentHydra never does (headless-policy.ts). A person opens a chat, adds the printed server,
// and lets the agent answer; --score does the rest.

import { readFileSync } from 'node:fs'
import {
  type AgentAnswer,
  DEFAULT_PAIRS,
  evalServerConfig,
  formatReport,
  loadQaPairs,
  runReferenceEval,
  scoreAnswers,
  startEvalEnvironment,
} from './harness'

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(name)
const value = (name: string) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const pairs = loadQaPairs(value('--pairs') ?? DEFAULT_PAIRS)

if (flag('--serve')) {
  const env = startEvalEnvironment()
  const server = evalServerConfig(env.fixture.url, env.home)
  console.log('MCP eval fixture is up. Add this server to a chat you can see:\n')
  console.log(JSON.stringify({ mcpServers: { 'agenthydra-eval': server } }, null, 2))
  console.log('\nAsk the agent to answer each question using ONLY that server, and to write')
  console.log('a JSON array of {"id","answer","feedback","toolCalls"} (feedback: what about the')
  console.log('tools helped or got in the way). Then: bun run eval:mcp --score <that file>\n')
  for (const p of pairs) console.log(`  ${p.id}: ${p.question}`)
  console.log('\nCtrl+C stops the fixture.')
  process.on('SIGINT', () => {
    console.log(`\nfixture served ${env.fixture.requests.length} request(s)`)
    if (env.fixture.refused.length) {
      console.log(`refused mutations: ${env.fixture.refused.join(', ')}`)
    }
    env.stop()
    process.exit(0)
  })
} else {
  const file = value('--score')
  const report = file
    ? scoreAnswers(pairs, JSON.parse(readFileSync(file, 'utf8')) as AgentAnswer[])
    : await runReferenceEval(pairs)
  console.log(flag('--json') ? JSON.stringify(report, null, 2) : formatReport(report))
  process.exit(report.correct === report.total ? 0 : 1)
}
