// Strings for the HSwarm tab's routing view (components/hswarm/HSwarmRouting.vue).
export default {
  spendingLimit: 'Spending limit',
  spendingLimitDesc: 'Control how much HSwarm can spend per day',
  dailyCap: 'Daily cap',
  noLimit: 'none',
  dailyCapUpdated: 'Daily cap updated',
  dailyCapHint:
    "Once today's spend reaches this, HSwarm refuses new work until tomorrow. Leave empty for no cap.",

  roles: 'Roles',
  rolesDesc:
    '{onAuto} of {total} on auto | A role is a kind of work a task can ask for. Each is set to auto (HSwarm picks the model) unless you choose one.',
  auto: 'auto',
  roleUpdated: 'Role {role} set to {model}',

  previewAuto: 'Preview AUTO',
  previewAutoDesc: 'See what models AUTO would pick for a given profile and tools',
  taskProfile: 'Task profile',
  profileRoutine: 'routine',
  profileGeneral: 'general',
  profileCode: 'code',
  profileDecision: 'decision',
  profileResearch: 'research',
  profileCritical: 'critical',
  tools: 'Tools',
  noTools: 'no tools',
  readTools: 'read tools',
  editTools: 'edit tools',
  preview: 'Preview',
  previewHint: 'No model call · starred models (★) that qualify come first',
  previewError: 'Preview error',
  model: 'Model',
  provider: 'Provider',
  testCost: 'Test-run cost',
  backupModel: 'backup from the same provider, not tested itself',

  advanced: 'Advanced',
  expand: '▶',
  collapse: '▼',
  priceRouting: 'Price routing',
  priceRoutingDesc: 'Serve a model from its cheapest equivalent path and fail over between paths',
  priceRoutingOn: 'Price routing on',
  priceRoutingOff: 'Price routing off',

  loadBias: 'Load bias',
  loadBiasDesc:
    'How strongly AUTO spreads a batch over near-equal providers before one saturates (0 = off)',
  loadBiasSaved: 'Load bias saved',

  defaultConcurrency: 'Default concurrency',
  api: 'api',
  cc: '· cc',
  defaultConcurrencyDesc:
    'Per job; a task list can ask for more (api up to {maxApi}, cc up to {maxCc})',
}
