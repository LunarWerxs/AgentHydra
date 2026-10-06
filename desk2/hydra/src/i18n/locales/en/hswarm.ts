// HSwarm tab - HSwarm console integration
import clients from './hswarm/clients'
import jobs from './hswarm/jobs'
import models from './hswarm/models'
import money from './hswarm/money'
import overview from './hswarm/overview'
import providers from './hswarm/providers'
import routing from './hswarm/routing'
import savings from './hswarm/savings'
import tools from './hswarm/tools'

export default {
  // Each view's own strings: t('hswarm.v.<view>.<key>').
  v: { overview, savings, providers, models, routing, clients, jobs, tools, money },
  // The left-hand tree (ZSwarm console layout): HSwarmView.vue.
  nav: {
    label: 'HSwarm objects',
    open: 'Open navigation',
    close: 'Close navigation',
    search: 'Search providers, models, jobs…  ( / )',
    searchAria: 'Filter the tree',
    resize: 'Drag to resize, double-click or Enter to reset',
    nothingMatches: 'Nothing matches “{q}”.',
    allModels: 'All models',
    ready: 'ready',
    resting: 'resting',
    noKey: 'no key',
    off: 'off',
    port: 'port {port}',
    noKeys: 'no keys',
    switchedOff: 'switched off',
    restingOnly: 'resting only',
    allKeysDisabled: 'every key disabled',
    priority: 'Priority {n}: click to clear',
    prioritySr: 'priority {n}',
    starIt: 'Star it: AUTO tries starred models first',
    more: '{n} more: search to narrow',
    // The CliMayte row's count and its hover: the tasks that can still change (HSwarmView.vue).
    climayteActive: 'CliMayte tasks queued or running: {n}',
    helpSearch: 'contact support question key token cost price free tier ask doctor',
    clientNames: {
      'claude-code': 'Claude Code',
      'claude-desktop': 'Claude Desktop',
      codex: 'Codex',
    },
  },
  notRunning: 'HSwarm is not running',
  statusRunning: 'Running on port {port}',
  statusError: 'Error: {error}',
  loading: 'Loading…',
  overview: 'Overview',
  savings: 'Savings',
  providers: 'Providers',
  routing: 'Routing & roles',
  clients: 'Clients',
  jobs: 'Jobs',
  help: 'Help',
  addProvider: 'Add provider',
  addModel: 'Add model',
  refresh: 'Reload',
  refreshed: 'Reloaded HSwarm data',
  refreshFailed: 'Failed to reload HSwarm data',
  errorLoading: 'Error loading HSwarm data',
  cancel: 'Cancel',
}
