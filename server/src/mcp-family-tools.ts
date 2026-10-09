// server/src/mcp-family-tools.ts - the MCP tools that let an agent meet the rest of the Hydra family
// (hydra-family.ts): which members exist and are up, and which project a folder belongs to.
// mcp.ts spreads FAMILY_TOOLS into TOOLS. Both are read-only and answer without the daemon.
import { familyAnswer, projectContext } from './hydra-family'
import { daemonBase, S, str } from './mcp-client'
import type { McpEngineTool } from './mcp-stdio.mjs'

export const FAMILY_TOOLS: McpEngineTool[] = [
  {
    name: 'hydra_family',
    description:
      'The Hydra family on this PC and which members are up. Project Hydra: every codebase, its ' +
      'state, launch rows and marketability. AgentHydra (this server): Claude/Codex accounts, ' +
      'quota, sessions, CliMayte, HSwarm. MonkeyWerx: the marketing platform (form outreach, ' +
      'social posts, email, Reddit, Google Business Profile). Each row says what the member is ' +
      'for and how to reach it (MCP, HTTP or command line); a member that is down is skipped, ' +
      'never an error.',
    inputSchema: S(),
    run: () => familyAnswer(daemonBase()),
  },
  {
    name: 'project_context',
    description:
      "Which project a folder is: its name, group, the owner's mark (watch or retired means " +
      'hands off: do not edit, run or build it), production score and marketability. Call it ' +
      'with a folder before working in a repo you did not start in. Asks Project Hydra; answers ' +
      '{available:false, reason} when it is not installed or fails.',
    inputSchema: S(
      { cwd: { type: 'string', description: 'Absolute path of the folder to look up.' } },
      ['cwd'],
    ),
    run: (args) => {
      const cwd = str(args.cwd).trim()
      // A leading dash would reach Project Hydra's command line as an option.
      if (!cwd || cwd.startsWith('-')) throw new Error('cwd must be a folder path')
      return projectContext(cwd)
    },
  },
]
