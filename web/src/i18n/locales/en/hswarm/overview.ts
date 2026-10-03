// Strings for the HSwarm tab's overview view (components/hswarm/HSwarmOverview.vue).
export default {
  // Lead text
  freshLead:
    'HSwarm lets your AI coding assistant hand busywork to cheaper AI models, many at once, so big jobs cost less and finish sooner. Add one API key to start: Gemini, Groq and Cerebras have free tiers.',
  lead: "What this machine's swarm can run on right now. Nothing here makes a model call unless you press Test, Probe or Ask.",

  // Stat tiles
  liveProviders: 'Live providers',
  withReadyKey: 'with a ready key',
  noReadyKey: 'none has a ready key yet',

  readyKeys: 'Ready keys',
  allUsable: 'all usable now',
  noKeysYet: 'no keys yet',

  starredModels: 'Starred models',
  model: 'model',
  models: 'models',
  usableNow: 'usable now',

  spend14Days: 'Spend, 14 days',
  loading: 'loading…',
  nothingRun: 'nothing has run yet',
  loadFailed: 'could not load',
  task: 'task',
  tasks: 'tasks',
  of: 'of',
  resting: 'resting',
  auto: 'AUTO',

  // Getting started
  gettingStarted: 'Getting started',
  addKey: 'Add an API key',
  addKeyDesc:
    "An API key is a code, like a password, that lets you use a provider's models. Get one on the provider's site and paste it here; it stays on this computer.",
  action0: 'Add a key',

  selectModels: 'Let HSwarm pick the models',
  selectModelsDesc:
    "It picks, for each task, the cheapest model that scored well enough on published tests. A provider's models join in once it has a key.",
  action1: 'See the models',

  connectAssistant: 'Connect your assistant',
  connectAssistantDesc:
    'Tell Claude Code, Claude Desktop or Codex that HSwarm is here, in one click.',
  action2: 'Connect Claude Code',

  // Charts
  spendChart: 'Spend, last 14 days',
  showNumbers: 'Show the numbers',
  spendIn14Days: 'in 14 days',
  day: 'Day',
  cost: 'Cost',
  errors: 'Errors',
  separator: '·',
  timeUnit: 's',

  outcomeChart: 'Failed tasks, share per day',
  taskFailureRate: "Share of the day's tasks that failed",

  noSpendTitle: 'No spend yet',
  noSpendBody: 'Every task the swarm runs is costed here, per day',
  noTasksTitle: 'No tasks yet',
  noTasksBody: 'Finished tasks show up here per day, ok or failed',

  keyHealth: 'Key health by provider',
  moneyChart: 'Where the money went (14 days)',
  chartsEmpty:
    'Spend, failures and key health are charted here once you have a key and the swarm has run a task.',

  results: {
    title: 'Model results',
    days: 'Last {n} days',
    failed: 'Could not load model results:',
    emptyTitle: 'No finished tasks in this window',
    emptyBody:
      'Thumbs up and down, cost and edit survival per model appear once the swarm has run tasks.',
    outcomes: 'Thumbs up and down (ok vs failed tasks)',
    upDown: '{ok} ok / {failed} failed',
    costPerOk: 'Cost per successful task (cheapest first)',
    noOk: 'No model has a successful task yet.',
    survival: 'Edit survival after a day (share of added code still there)',
    noSurvival: 'No model has scored edits yet. Edits are scored after a day.',
    scored: '{n} scored tasks',
    perDay: 'Tasks per day by model',
    other: 'other',
  },

  // Health section
  health: 'Health',
  doctor: 'Doctor',
  doctorDesc: 'Checks keys, binaries and the model registry without spending anything.',
  runDoctor: 'Run doctor',
  running: 'Running…',

  balances: 'Balances',
  balancesDesc: 'Free: asks each provider for its balance and wakes keys that were topped up.',
  probeBalances: 'Probe every balance',

  // Quick ask
  quickAsk: 'Quick ask',
  askPlaceholder: 'Ask the swarm one tool-free question…',
  autoCheapest: 'auto (cheapest that qualifies)',
  ask: 'Ask',
  noAnswer: 'The question got no answer. The server said:',
}
