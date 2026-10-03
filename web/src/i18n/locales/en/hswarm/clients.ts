// Strings for the HSwarm tab's clients view (components/hswarm/HSwarmClients.vue).
export default {
  title: 'Register hswarm as an MCP server',
  description:
    "Connect hswarm to Claude Code, Claude Desktop, or Codex. Each button edits only the hswarm entry in that client's config file.",
  agents: 'Agents',
  client: 'Client',
  status: 'Status',
  configFile: 'Config file',
  actions: 'Actions',
  registered: 'Registered',
  notRegistered: 'Not registered',
  checking: 'Checking…',
  exists: 'Exists',
  notExists: 'Not found',
  install: 'Install',
  reinstall: 'Re-install',
  remove: 'Remove',
  removeConfirm: 'Remove hswarm from {client}?',
  installed: 'Installed',
  removed: 'Removed',
  includeInstructions:
    'Also write the short "how to use hswarm" block into the client\'s global instructions (CLAUDE.md / AGENTS.md)',
  instructionsHelp:
    'When checked, a re-run replaces the instruction block and --remove takes it out.',
  loadError: 'Could not load clients',
  installLog: 'Installation log',
  apiTitle: 'HTTP API',
  apiDescription:
    'Everything in this console is a JSON call to http://127.0.0.1:7793/api/ with the header X-Hswarm-Token, whose value is the contents of ~/.hswarm/console-token. Only this machine can reach it.',
}
