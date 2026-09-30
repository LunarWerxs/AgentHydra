// "Startup cost per new chat" (below the instance tables; the code calls it the prefix tax): what
// each Claude/Codex account sends before a new chat says a word. Measured through a loopback sink,
// so the hints say plainly that no quota is spent but the account's MCP servers are started. On
// 2026-09-30 the owner said "Prefix tax per spawn" meant nothing, so every label here is plain words.
export default {
  title: 'Startup cost per new chat',
  subtitle:
    'What every new Claude or Codex chat on each account sends before it starts: the system prompt plus its tool and MCP definitions. Measured on this PC, so it uses none of your quota.',
  refresh: 'Refresh',
  measureAll: 'Measure all',
  measureAllHint:
    'Start each account once against a local stand-in and read what it sends first. No model runs and no quota is used, but each account starts its MCP servers.',
  measure: 'Measure',
  measureHint:
    'Start this account once against a local stand-in and read what it sends first. No quota is used.',
  measuring: 'Measuring…',
  measured: 'Accounts measured: {count}',
  someFailed: 'Accounts that could not be measured: {count}',
  empty: 'No Claude or Codex accounts found.',
  notMeasured: 'Not measured yet.',
  colName: 'Account',
  colTools: 'Tools',
  colSchemas: 'Tool definitions',
  colPrefix: 'Sent per chat',
  colHeaviest: 'Largest MCP servers',
  colActions: 'Actions',
  kindClaude: 'Claude',
  kindCodex: 'Codex',
  kb: '{kb} kB',
  tools: '{tools} ({mcp} MCP)',
  mcpShare: 'MCP share: {kb}',
  tokens: '~{tokens} tokens',
  prefixHint:
    'System prompt, tool definitions and opening context of a new chat’s first request, at about 4 bytes per token.',
  noMcp: 'No MCP tools',
  server: '{server} {kb} ({tools})',
}
