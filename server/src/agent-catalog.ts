// server/src/agent-catalog.ts — every coding agent we know where to look for.
//
// WHY A TABLE. AgentHydra grew up reading three stores whose paths were three constants, which is
// fine until the fourth. There are now dozens of coding agents and each keeps its conversations
// somewhere on disk; the only thing that differs between "supported" and "not" for most of them is
// whether anyone has written the path down. So the paths are data, and adding a tool is a row.
//
// WHERE THE PATHS COME FROM. Compiled from the agent registry in kenn-io/agentsview (MIT, Kenn
// Software LLC) — an inventory maintained against real installs across Windows, macOS and Linux.
// Their code is not used here; this is the factual part, re-expressed for this codebase's shapes.
// Anything wrong in it is wrong here too, which is why nothing in this file is load-bearing: a path
// that does not exist costs one `stat` and produces nothing.
//
// TWO TIERS, AND THE DIFFERENCE IS HONESTY.
//
//   * A tool with a `format` writes something we can already read — because it IS one of the three
//     stores, or a fork that kept the format. Those are INDEXED: real sessions, real transcripts,
//     real analytics. OpenClaude forked Claude Code and kept its JSONL; TraeX is a closed-source
//     fork of codex-rs writing byte-compatible rollouts; Kilo, MiMoCode and IcodeMate are built on
//     an OpenCode core and keep the same SQLite schema under a different filename.
//
//   * A tool with `format: null` is DETECTED ONLY: we can say it is installed and roughly how much
//     is in it, and we do not pretend to read it. That is deliberately visible in the UI rather
//     than hidden — "Gemini CLI: 214 files, we cannot read these yet" is useful and true, where
//     silently omitting it lets a user believe AgentHydra looked and found nothing.
//
// THESE ARE SPECULATIVE AND THAT IS THE POINT. Most of these tools are not installed on any given
// machine, and the format claims for the forks are made from documentation rather than from a local
// install. The failure mode is bounded by construction: a wrong path finds nothing, and a wrong
// format claim yields a store that parses to zero sessions. Neither can corrupt the three stores
// that were here first, because nothing here changes how they are read.

import { type Dirent, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentPresence, SessionSource } from './types'

export type { AgentPresence }

/** A store shape we have a reader for. Identical to SessionSource by construction: a format IS the
 *  parser that reads it, and adding a fourth means writing a fourth reader. */
export type StoreFormat = SessionSource

export interface AgentTool {
  /** Stable key. Used in the API, in settings, and as the i18n suffix. */
  id: string
  /** What the user calls it. */
  name: string
  /** Who makes it — the axis the analytics "filter by provider" control offers. */
  vendor: string
  /** Environment variable that relocates the store, honoured before `dirs`. */
  envVar?: string
  /**
   * Home-relative store locations, every platform's spelling in one list.
   *
   * Not split per-OS on purpose: the check is `existsSync`, a Windows path cannot exist on Linux,
   * and a per-OS split would silently drop the case that matters most here — a store carried
   * across platforms, or a layout that moved between releases.
   */
  dirs: string[]
  /** Which of `dirs` hold ARCHIVED conversations, for stores that separate them. */
  archivedDirs?: string[]
  /** How to read it, or null when we can find it but not yet parse it. */
  format: StoreFormat | null
  /** For `opencode`-format tools: the SQLite file inside the root. */
  dbName?: string
  /** Shown beside a detected-but-unreadable tool, so "why not?" has an answer. */
  note?: string
}

const HOME = homedir()

/**
 * The catalog.
 *
 * Ordered with the tools we actually read first, then the rest roughly by how likely they are to be
 * installed. Order is stable and is what the UI lists in.
 */
export const AGENT_TOOLS: AgentTool[] = [
  // --- readable: these ARE the three stores, or forks that kept the format --------------------
  {
    id: 'claude-code',
    name: 'Claude Code',
    vendor: 'Anthropic',
    envVar: 'CLAUDE_PROJECTS_DIR',
    dirs: ['.claude/projects'],
    format: 'claude',
  },
  {
    id: 'openclaude',
    name: 'OpenClaude',
    vendor: 'OpenClaude',
    envVar: 'OPENCLAUDE_PROJECTS_DIR',
    dirs: ['.openclaude/projects'],
    format: 'claude',
  },
  {
    id: 'codex',
    name: 'Codex',
    vendor: 'OpenAI',
    envVar: 'CODEX_SESSIONS_DIR',
    dirs: ['.codex/sessions', '.codex/archived_sessions'],
    archivedDirs: ['.codex/archived_sessions'],
    format: 'codex',
  },
  {
    id: 'traex',
    name: 'TraeX',
    vendor: 'ByteDance',
    envVar: 'TRAEX_SESSIONS_DIR',
    // A closed-source fork of codex-rs: same rollout JSONL, same archive move on `traex archive`.
    dirs: ['.trae/cli/sessions', '.trae/cli/archived_sessions'],
    archivedDirs: ['.trae/cli/archived_sessions'],
    format: 'codex',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    vendor: 'OpenCode',
    envVar: 'OPENCODE_DIR',
    dirs: ['.local/share/opencode'],
    format: 'opencode',
    dbName: 'opencode.db',
  },
  {
    id: 'kilo',
    name: 'Kilo',
    vendor: 'Kilocode',
    envVar: 'KILO_DIR',
    // Rebuilt on an OpenCode core in 2026; the CLI and the extension share this SQLite.
    dirs: ['.local/share/kilo'],
    format: 'opencode',
    dbName: 'kilo.db',
  },
  {
    id: 'mimocode',
    name: 'MiMo Code',
    vendor: 'Xiaomi',
    envVar: 'MIMOCODE_DIR',
    dirs: ['.local/share/mimocode'],
    format: 'opencode',
    dbName: 'mimocode.db',
  },
  {
    id: 'icodemate',
    name: 'IcodeMate',
    vendor: 'IcodeMate',
    envVar: 'ICODEMATE_DIR',
    dirs: ['.local/share/icodemate'],
    format: 'opencode',
    dbName: 'icodemate.db',
  },

  // --- detected only: found on disk, not yet parsed -------------------------------------------
  {
    id: 'gemini',
    name: 'Gemini CLI',
    vendor: 'Google',
    envVar: 'GEMINI_DIR',
    dirs: ['.gemini'],
    format: null,
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    vendor: 'GitHub',
    envVar: 'COPILOT_DIR',
    dirs: ['.copilot'],
    format: null,
    note: 'credits',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    vendor: 'Cursor',
    envVar: 'CURSOR_PROJECTS_DIR',
    dirs: ['.cursor/projects'],
    format: null,
  },
  {
    id: 'amp',
    name: 'Amp',
    vendor: 'Sourcegraph',
    envVar: 'AMP_DIR',
    dirs: ['.local/share/amp/threads'],
    format: null,
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    vendor: 'Alibaba',
    envVar: 'QWEN_PROJECTS_DIR',
    dirs: ['.qwen/projects'],
    format: null,
  },
  {
    id: 'iflow',
    name: 'iFlow',
    vendor: 'iFlow',
    envVar: 'IFLOW_DIR',
    dirs: ['.iflow/projects'],
    format: null,
  },
  {
    id: 'kimi',
    name: 'Kimi CLI',
    vendor: 'Moonshot',
    envVar: 'KIMI_DIR',
    dirs: ['.kimi/sessions', '.kimi-code/sessions'],
    format: null,
  },
  {
    id: 'grok',
    name: 'Grok',
    vendor: 'xAI',
    envVar: 'GROK_DIR',
    dirs: ['.grok/sessions'],
    format: null,
  },
  {
    id: 'deepseek-tui',
    name: 'DeepSeek TUI',
    vendor: 'DeepSeek',
    envVar: 'DEEPSEEK_TUI_SESSIONS_DIR',
    dirs: ['.codewhale/sessions', '.deepseek/sessions'],
    format: null,
  },
  {
    id: 'cowork',
    name: 'Claude Cowork',
    vendor: 'Anthropic',
    envVar: 'COWORK_DIR',
    dirs: [
      'Library/Application Support/Claude/local-agent-mode-sessions',
      '.config/Claude/local-agent-mode-sessions',
      'AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/local-agent-mode-sessions',
      'AppData/Roaming/Claude/local-agent-mode-sessions',
    ],
    format: null,
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    vendor: 'Google',
    envVar: 'ANTIGRAVITY_DIR',
    dirs: ['.gemini/antigravity'],
    format: null,
    // Conversations are encrypted protobuf, not text. Detection is the honest ceiling here until
    // someone writes the decoder.
    note: 'encrypted',
  },
  {
    id: 'antigravity-cli',
    name: 'Antigravity CLI',
    vendor: 'Google',
    envVar: 'ANTIGRAVITY_CLI_DIR',
    dirs: ['.gemini/antigravity-cli'],
    format: null,
    note: 'encrypted',
  },
  {
    id: 'vscode-copilot',
    name: 'VS Code Copilot',
    vendor: 'GitHub',
    envVar: 'VSCODE_COPILOT_DIR',
    dirs: [
      'AppData/Roaming/Code/User',
      'AppData/Roaming/Code - Insiders/User',
      'AppData/Roaming/VSCodium/User',
      'Library/Application Support/Code/User',
      'Library/Application Support/Code - Insiders/User',
      'Library/Application Support/VSCodium/User',
      '.config/Code/User',
      '.config/Code - Insiders/User',
      '.config/VSCodium/User',
    ],
    format: null,
    note: 'credits',
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    vendor: 'Cognition',
    envVar: 'WINDSURF_DIR',
    dirs: [
      'AppData/Roaming/Windsurf/User',
      'AppData/Roaming/Windsurf - Next/User',
      'Library/Application Support/Windsurf/User',
      'Library/Application Support/Windsurf - Next/User',
      '.config/Windsurf/User',
      '.config/Windsurf - Next/User',
    ],
    format: null,
    note: 'credits',
  },
  {
    id: 'trae',
    name: 'Trae',
    vendor: 'ByteDance',
    envVar: 'TRAE_DIR',
    dirs: [
      'AppData/Roaming/Trae/User',
      'AppData/Roaming/Trae CN/User',
      'Library/Application Support/Trae/User',
      'Library/Application Support/Trae CN/User',
      '.config/Trae/User',
      '.config/Trae CN/User',
    ],
    format: null,
    note: 'encrypted',
  },
  {
    id: 'roocode',
    name: 'Roo Code',
    vendor: 'Roo',
    envVar: 'ROOCODE_DIR',
    dirs: [
      'Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline',
      '.config/Code/User/globalStorage/rooveterinaryinc.roo-cline',
      'AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline',
    ],
    format: null,
  },
  {
    id: 'kilo-legacy',
    name: 'Kilo (legacy)',
    vendor: 'Kilocode',
    envVar: 'KILO_LEGACY_DIR',
    dirs: [
      'Library/Application Support/Code/User/globalStorage/kilocode.kilo-code',
      '.config/Code/User/globalStorage/kilocode.kilo-code',
      'AppData/Roaming/Code/User/globalStorage/kilocode.kilo-code',
    ],
    format: null,
  },
  {
    id: 'zed',
    name: 'Zed',
    vendor: 'Zed Industries',
    envVar: 'ZED_DIR',
    dirs: ['Library/Application Support/Zed', '.local/share/zed', 'AppData/Local/Zed'],
    format: null,
  },
  {
    id: 'goose',
    name: 'Goose',
    vendor: 'Block',
    envVar: 'GOOSE_PATH_ROOT',
    dirs: ['.local/share/goose/sessions', 'AppData/Roaming/Block/goose/data/sessions'],
    format: null,
  },
  {
    id: 'openhands',
    name: 'OpenHands CLI',
    vendor: 'OpenHands',
    envVar: 'OPENHANDS_CONVERSATIONS_DIR',
    dirs: ['.openhands/conversations'],
    format: null,
  },
  {
    id: 'warp',
    name: 'Warp',
    vendor: 'Warp',
    envVar: 'WARP_DIR',
    dirs: [
      'Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable',
      '.local/state/warp-terminal',
      'AppData/Local/warp/Warp/data',
    ],
    format: null,
  },
  {
    id: 'aider',
    name: 'Aider',
    vendor: 'Aider',
    envVar: 'AIDER_DIR',
    // No canonical root: Aider writes `.aider.chat.history.md` inside each repo. Opt-in only —
    // scanning $HOME for it is the kind of "helpful" walk that trips macOS privacy prompts.
    dirs: [],
    format: null,
    note: 'opt-in',
  },
  {
    id: 'gptme',
    name: 'gptme',
    vendor: 'gptme',
    envVar: 'GPTME_DIR',
    dirs: ['.local/share/gptme/logs'],
    format: null,
  },
  {
    id: 'qoder',
    name: 'Qoder',
    vendor: 'Alibaba',
    envVar: 'QODER_PROJECTS_DIR',
    dirs: [
      '.qoder/projects',
      '.qoderwork/projects',
      'Library/Application Support/Qoder/SharedClientCache/cli/projects',
      '.config/Qoder/SharedClientCache/cli/projects',
      'AppData/Roaming/Qoder/SharedClientCache/cli/projects',
    ],
    format: null,
  },
  {
    id: 'kiro',
    name: 'Kiro CLI',
    vendor: 'AWS',
    envVar: 'KIRO_SESSIONS_DIR',
    dirs: ['.kiro/sessions/cli', '.local/share/kiro-cli'],
    format: null,
  },
  {
    id: 'kiro-ide',
    name: 'Kiro IDE',
    vendor: 'AWS',
    envVar: 'KIRO_IDE_DIR',
    dirs: [
      'Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent',
      'AppData/Roaming/Kiro/User/globalStorage/kiro.kiroagent',
      '.config/Kiro/User/globalStorage/kiro.kiroagent',
    ],
    format: null,
  },
  {
    id: 'cortex',
    name: 'Cortex Code',
    vendor: 'Snowflake',
    envVar: 'CORTEX_DIR',
    dirs: ['.snowflake/cortex/conversations'],
    format: null,
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    vendor: 'Nous Research',
    envVar: 'HERMES_SESSIONS_DIR',
    dirs: ['.hermes/sessions'],
    format: null,
  },
  {
    id: 'devin',
    name: 'Devin',
    vendor: 'Cognition',
    envVar: 'DEVIN_DIR',
    dirs: ['Library/Application Support/devin', '.local/share/devin'],
    format: null,
  },
  {
    id: 'zencoder',
    name: 'Zencoder',
    vendor: 'Zencoder',
    envVar: 'ZENCODER_DIR',
    dirs: ['.zencoder/sessions'],
    format: null,
  },
  {
    id: 'codebuff',
    name: 'Codebuff',
    vendor: 'Codebuff',
    envVar: 'CODEBUFF_DIR',
    dirs: ['.config/manicode/projects'],
    format: null,
  },
  {
    id: 'commandcode',
    name: 'Command Code',
    vendor: 'Command',
    envVar: 'COMMANDCODE_PROJECTS_DIR',
    dirs: ['.commandcode/projects'],
    format: null,
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    vendor: 'OpenClaw',
    envVar: 'OPENCLAW_DIR',
    dirs: ['.openclaw/agents', '.kimi_openclaw/agents'],
    format: null,
  },
  {
    id: 'qclaw',
    name: 'QClaw',
    vendor: 'QClaw',
    envVar: 'QCLAW_DIR',
    dirs: ['.qclaw/agents'],
    format: null,
  },
  {
    id: 'qwenpaw',
    name: 'QwenPaw',
    vendor: 'Alibaba',
    envVar: 'QWENPAW_DIR',
    dirs: ['.copaw/workspaces'],
    format: null,
  },
  {
    id: 'pi',
    name: 'Pi',
    vendor: 'Pi',
    envVar: 'PI_DIR',
    dirs: ['.pi/agent/sessions'],
    format: null,
  },
  {
    id: 'prime-agent',
    name: 'Prime Agent',
    vendor: 'Prime Intellect',
    envVar: 'PRIME_AGENT_SESSION_DIR',
    dirs: ['.prime/agent/sessions'],
    format: null,
  },
  {
    id: 'omp',
    name: 'Oh My Pi',
    vendor: 'Oh My Pi',
    envVar: 'OMP_DIR',
    dirs: ['.omp/agent/sessions'],
    format: null,
  },
  {
    id: 'vibe',
    name: 'Mistral Vibe',
    vendor: 'Mistral',
    envVar: 'VIBE_SESSIONS_DIR',
    dirs: ['.vibe/logs/session'],
    format: null,
  },
  {
    id: 'shelley',
    name: 'Shelley',
    vendor: 'exe.dev',
    envVar: 'SHELLEY_DIR',
    dirs: ['.config/shelley'],
    format: null,
  },
  {
    id: 'reasonix',
    name: 'Reasonix',
    vendor: 'Reasonix',
    envVar: 'REASONIX_DIR',
    dirs: ['.reasonix', 'AppData/Roaming/reasonix'],
    format: null,
  },
  {
    id: 'omnigent',
    name: 'Omnigent',
    vendor: 'Omnigent',
    envVar: 'OMNIGENT_DIR',
    dirs: ['.omnigent'],
    format: null,
  },
  {
    id: 'forge',
    name: 'Forge',
    vendor: 'Antinomy',
    envVar: 'FORGE_DIR',
    dirs: ['.forge'],
    format: null,
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    vendor: 'WorkBuddy',
    envVar: 'WORKBUDDY_PROJECTS_DIR',
    dirs: ['.workbuddy/projects'],
    format: null,
  },
  {
    id: 'poolside',
    name: 'Poolside',
    vendor: 'Poolside',
    envVar: 'POOLSIDE_DIR',
    dirs: [
      'Library/Application Support/poolside',
      '.local/state/poolside',
      'AppData/Roaming/poolside',
    ],
    format: null,
  },
  {
    id: 'piebald',
    name: 'Piebald',
    vendor: 'Piebald',
    envVar: 'PIEBALD_DIR',
    dirs: [
      '.local/share/piebald',
      'Library/Application Support/piebald',
      'AppData/Roaming/piebald',
    ],
    format: null,
  },
  {
    id: 'zcode',
    name: 'Z Code',
    vendor: 'Z.ai',
    envVar: 'ZCODE_DIR',
    dirs: ['.zcode/cli/db', '.zcode/cli'],
    format: null,
  },
  {
    id: 'positron',
    name: 'Positron Assistant',
    vendor: 'Posit',
    envVar: 'POSITRON_DIR',
    dirs: ['Library/Application Support/Positron/User'],
    format: null,
  },
  {
    id: 'posit-assistant',
    name: 'Posit Assistant',
    vendor: 'Posit',
    envVar: 'POSIT_ASSISTANT_DIR',
    dirs: ['.posit/assistant/workspaces'],
    format: null,
  },
  {
    id: 'visualstudio-copilot',
    name: 'Visual Studio Copilot',
    vendor: 'GitHub',
    envVar: 'VISUALSTUDIO_COPILOT_DIR',
    dirs: [
      'AppData/Local/Temp/VSGitHubCopilotLogs/traces',
      'Library/Caches/VSGitHubCopilotLogs/traces',
      '.cache/VSGitHubCopilotLogs/traces',
    ],
    format: null,
    note: 'credits',
  },
]

/** By id, for the API and for settings that name a tool. */
export function agentTool(id: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.id === id)
}

/** One tool's store on THIS machine. `archived` follows the tool's own archive split. */
export interface AgentRoot {
  tool: AgentTool
  /** Absolute path to the store root. */
  root: string
  archived: boolean
}

/**
 * Absolute roots for one tool, existing ones only.
 *
 * An `envVar` override replaces the defaults outright rather than adding to them — that is what an
 * override means, and a user who repointed CLAUDE_PROJECTS_DIR at a copy does not want the original
 * silently merged back in. Multiple paths may be given, separated by the platform's path delimiter.
 */
export function rootsFor(tool: AgentTool, home: string = HOME): AgentRoot[] {
  const override = tool.envVar ? process.env[tool.envVar]?.trim() : ''
  const candidates: Array<{ path: string; archived: boolean }> = override
    ? override
        .split(process.platform === 'win32' ? ';' : ':')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((path) => ({ path, archived: false }))
    : tool.dirs.map((rel) => ({
        path: join(home, ...rel.split('/')),
        archived: tool.archivedDirs?.includes(rel) ?? false,
      }))

  const out: AgentRoot[] = []
  for (const c of candidates) {
    // A `dbName` tool's root is a directory holding that file; the directory existing without the
    // file is an installed tool with no conversations, which is not a store.
    const target = tool.dbName ? join(c.path, tool.dbName) : c.path
    if (!existsSync(target)) continue
    out.push({ tool, root: c.path, archived: c.archived })
  }
  return out
}

/** Every existing root across every tool with the given format. */
export function rootsWithFormat(format: StoreFormat, home: string = HOME): AgentRoot[] {
  return AGENT_TOOLS.filter((t) => t.format === format).flatMap((t) => rootsFor(t, home))
}

/**
 * The three tools whose stores AgentHydra read before this catalog existed.
 *
 * They keep their own constants in config.ts — including env overrides (`CODEX_HOME`,
 * `AGENTHYDRA_OPENCODE_DB`) that predate this file and that a lot of tests set. The indexer scans
 * those constants first and then asks the catalog for the OTHERS, so adding this file cannot change
 * where the original three are read from. Belt and braces: it also means a mistake in the catalog's
 * paths cannot break the stores people actually use.
 */
export const BUILT_IN_TOOL_IDS = new Set(['claude-code', 'codex', 'opencode'])

/** Catalog roots for a format, EXCLUDING the three the indexer already handles by constant. */
export function extraRootsWithFormat(format: StoreFormat, home: string = HOME): AgentRoot[] {
  return AGENT_TOOLS.filter((t) => t.format === format && !BUILT_IN_TOOL_IDS.has(t.id)).flatMap(
    (t) => rootsFor(t, home),
  )
}

/** Files counted per tool before the walk gives up. A detection scan answers "is this here and is
 *  it live", and neither answer improves past a thousand files. */
const DETECT_FILE_CAP = 1000
/** Directory depth. Deep enough for `projects/<encoded-cwd>/<id>.jsonl` and the dated Codex tree,
 *  shallow enough that pointing a root at a home directory cannot become a full-disk walk. */
const DETECT_DEPTH = 5

function walkCount(
  dir: string,
  depth: number,
  state: { files: number; newest: number | null },
): void {
  if (depth > DETECT_DEPTH || state.files >= DETECT_FILE_CAP) return
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (state.files >= DETECT_FILE_CAP) return
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkCount(path, depth + 1, state)
      continue
    }
    if (!entry.isFile()) continue
    state.files++
    try {
      const mtime = statSync(path).mtimeMs
      if (state.newest === null || mtime > state.newest) state.newest = mtime
    } catch {
      // A file that vanished between readdir and stat contributes its count and no date.
    }
  }
}

/**
 * Which of these tools are on this machine.
 *
 * Synchronous and bounded: every tool costs one `existsSync` when absent, which is the case for
 * nearly all of them, and a capped walk when present. Measured at a few milliseconds for a catalog
 * this size on a machine with three of them installed.
 */
export function detectAgentTools(home: string = HOME): AgentPresence[] {
  const out: AgentPresence[] = []
  for (const tool of AGENT_TOOLS) {
    const roots = rootsFor(tool, home)
    if (roots.length === 0) continue
    const state = { files: 0, newest: null as number | null }
    for (const r of roots) walkCount(r.root, 0, state)
    out.push({
      id: tool.id,
      name: tool.name,
      vendor: tool.vendor,
      roots: roots.map((r) => r.root),
      files: state.files,
      truncated: state.files >= DETECT_FILE_CAP,
      lastActivityAt: state.newest,
      format: tool.format,
      note: tool.note,
    })
  }
  return out
}
