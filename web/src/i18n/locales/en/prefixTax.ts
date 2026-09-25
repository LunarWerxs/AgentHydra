// Prefix tax section (below the instance tables): what each Claude/Codex home re-ships on every
// spawn. Measured through a loopback sink, so the hints say plainly that no quota is spent but the
// home's MCP servers are started.
export default {
  title: 'Prefix tax per spawn',
  refresh: 'Refresh',
  measureAll: 'Measure all',
  measureAllHint:
    'Start each home once against a local sink and read its first request. No model runs and no quota is spent, but each home boots its MCP servers.',
  measure: 'Measure',
  measureHint:
    'Start this home once against a local sink and read its first request. No quota is spent.',
  measuring: 'Measuring…',
  measured: 'Homes measured: {count}',
  someFailed: 'Homes that could not be measured: {count}',
  empty: 'No Claude or Codex homes found.',
  notMeasured: 'Not measured yet.',
  colName: 'Home',
  colTools: 'Tools',
  colSchemas: 'Schemas',
  colPrefix: 'Prefix',
  colHeaviest: 'Heaviest MCP servers',
  colActions: 'Actions',
  kindClaude: 'Claude',
  kindCodex: 'Codex',
  kb: '{kb} kB',
  tools: '{tools} ({mcp} MCP)',
  mcpShare: 'MCP share: {kb}',
  tokens: '~{tokens} tokens',
  prefixHint:
    'System prompt, tool schemas and opening context of the first request, at about 4 bytes per token.',
  noMcp: 'No MCP tools',
  server: '{server} {kb} ({tools})',
}
