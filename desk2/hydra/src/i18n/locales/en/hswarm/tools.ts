// Strings for the HSwarm tab's tools view (components/hswarm/HSwarmTools.vue).
export default {
  tabAsk: 'Ask',
  tabDoctor: 'Doctor',
  tabHelp: 'Help',

  // ASK view
  askTitle: 'Ask the Swarm',
  askDesc: 'Ask a tool-free question to the swarm of AI models',
  askPromptLabel: 'Question',
  askPromptPlaceholder: 'Ask the swarm one tool-free question…',
  askModelLabel: 'Model',
  askModelAuto: 'auto (cheapest that qualifies)',
  askButton: 'Ask',
  askAsking: 'Asking…',
  clear: 'Clear result',
  askSuccess: 'Answer received',
  askEmpty: 'Please type a question',
  askFailed: 'Failed to get an answer',
  askError: 'No answer',
  askAnswered: 'Answer',
  askSwarm: 'swarm',
  separator: '·',
  seconds: 's',
  free: 'free',
  noReadyKey: 'No provider has a ready key yet',

  // DOCTOR view
  doctorTitle: 'Health Check',
  doctorDesc: 'Run a health check on your setup without spending anything',
  doctorButton: 'Run Doctor',
  doctorChecking: 'Checking…',
  doctorSuccess: 'Health check complete',
  doctorFailed: 'Health check failed',
  doctorClaudeBin: 'Claude Code binary',
  doctorRipgrep: 'ripgrep',
  doctorBash: 'bash',
  doctorConfig: 'Provider files',
  doctorRoutes: 'Default routes',
  doctorRoutesOk: 'every default route can serve now',
  doctorKeys: 'Key balances',
  doctorApi: 'Default provider API',
  doctorFaults: 'Fault injection',
  doctorFullReport: 'Full report (JSON)',

  // HELP view
  helpWhatIsHswarm: {
    title: 'What is HSwarm?',
    body1:
      'A helper for AI coding assistants (Claude Code, Claude Desktop, Codex). When your assistant has a pile of small jobs, such as reading fifty files, it hands them to HSwarm.',
    body2:
      'HSwarm runs them on cheaper AI models, many at once, and hands back the answers. It runs on this computer; this page is its settings.',
  },
  helpApiKey: {
    title: 'What is an API key, and where do I get one?',
    body: "An API key is a code a provider (a company that runs AI models) gives you, like a password, so you can use its models. You make one on the provider's website and paste it on that provider's page here. It stays on this computer.",
    freeTiers: 'These have free tiers:',
    getKey: 'get a key',
  },
  helpFreeTier: {
    title: 'What is a free tier?',
    body: 'A provider with a free tier lets you use some of its models without paying, up to a limit per minute or per day. Past the limit, requests wait until it resets. Nothing is charged unless you add a payment method with the provider. The prices shown here are what it charges past its free limits.',
  },
  helpToken: {
    title: 'What is a token, and what does a task cost?',
    body1:
      'AI models read and write text in tokens; a token is about three quarters of a word. Prices are in dollars per million tokens.',
    body2:
      'A small task here uses about 3,000 tokens and a big one about 50,000, so at $0.40 per million a task costs a tenth of a cent to 2 cents. On a free tier it costs nothing within the limits. You pay each provider directly; HSwarm itself is free.',
  },
  helpWhichModel: {
    title: 'Which model should I pick?',
    body: 'None: leave them on. For each task HSwarm picks the cheapest model whose published test scores are good enough for that kind of work, and moves on to the next if it fails. The AUTO tag marks the models it ranks that way. A star (☆) puts a model first in that order; you never need one.',
  },
  helpRoles: {
    title: 'What are roles?',
    body: 'A role is a kind of work a task can name, such as code or summarize. Each is set to auto, and most people leave them that way.',
  },
  helpConnect: {
    title: 'How do I connect it to my assistant?',
    body: 'On the Clients tab, press Install next to Claude Code, Claude Desktop or Codex, then open a new chat there.',
  },
  helpQuestion: {
    title: 'Where can I ask a question?',
    body: 'Ask in the LunarWerx Discord (https://discord.gg/PsWpeNUzhk), or open an issue on GitHub. Check the full guide at https://github.com/Lunarwerx/HSwarm#readme for everything in more depth.',
  },
}
