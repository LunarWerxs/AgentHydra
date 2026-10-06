// Settings strings of the pages that keep their own settings (the queue's automation dialog). The
// app-wide settings, and the Instances tables' (Instances → CLI, Desktop and Free), are Desk's Settings
// dialog since 2026-10-06 (desk2/web/src/components/panes/agenthydra.ts).
export default {
  // usage section
  usageAutoRefreshLabel: 'Auto-refresh usage',
  usageAutoRefreshHint:
    "Keep every instance's quota numbers up to date in the background, so the Instances table is never stale. Checking your quota does not use any of it, and each check takes about a third of a second, so this costs you nothing. Turn it off to only ever check when you click Refresh.",
  usageIntervalLabel: 'Refresh every',
  usageIntervalHint:
    'How often to re-check. Quota moves over hours, not seconds, so there is little reason to go below 15 minutes.',
  usageIntervalMinutes: '{minutes} min',
  usageToastFailed: 'Failed to save usage setting.',

  toastSchedulerFailed: 'Failed to update scheduler settings.',

  // the Connections sign-in's return (App.vue handleConnectRedirect)
  cloudSyncEnableToggle: 'Sync settings',
  cloudSyncConnectFailed: "Couldn't connect to Connections. Try again.",

  // scheduler section
  scheduler: 'Scheduler',
  schedulerHint:
    "When enabled, the scheduler automatically spawns real claude runs for queued items; this spends the selected account's quota and acts on real repositories. Leave it off.",
  // AH-12: AgentHydra never runs a chat nobody can see (headless-policy.ts's headlessRunsAllowed()
  // is hardcoded false). It exists to spawn those runs automatically, so it can never
  // actually dispatch anything in this build. Read alongside web/src/lib/headless.ts's
  // HEADLESS_QUEUEING_ENABLED, which is what the panel below branches on to disable these controls
  // rather than leave them offering a toggle that would only fail moments after flipping.
  schedulerUnavailable: 'Can’t dispatch in this build.',
  schedulerUnavailableHint:
    'Disabled: the scheduler exists to automatically spawn real claude runs for queued items, but AgentHydra never runs a chat nobody can see, so it can never dispatch one in this build. Reply straight into the session’s own desktop chat, use fan_out from an MCP client, or import the session into a desktop app to get work done instead.',
  schedulerEnabledLabel: 'Enabled',
  running: 'running',
  queued: 'queued',
  advanced: 'Advanced',
  tomorrowTimeLabel: 'Tomorrow preset time',
  tomorrowTimeHint:
    'The time of day the composer\'s "Tomorrow …" quick option schedules for. Saved immediately.',
  spacingLabel: 'Spacing (s)',
  pollLabel: 'Poll (s)',
  maxConcurrentLabel: 'Max concurrent',

  // auto-resume monitor section
  monitorTitle: 'Auto-resume monitor',
  monitorHint:
    'Watches sessions that stopped on a rate limit and, once the 5-hour window resets, resumes them automatically. Off by default; it prompts sessions while you are away, so review the settings below before turning it on.',
  monitorEnabledLabel: 'Enabled',
  monitorMaxAttemptsLabel: 'Max resume attempts',
  monitorBufferLabel: 'Resume buffer (min)',
  monitorEmpty: 'Nothing to resume right now.',
  monitorEmptyHint:
    'A session appears here once it stops on a rate limit, whether the app ran it or you started it yourself in a terminal, which the monitor finds by checking recent transcripts. The monitor then tracks it until the window resets and resumes it. An empty list means nothing is currently waiting on a limit, not that monitoring is off.',
  monitorAttempts: '{n} attempts',
  monitorDiscovered: 'Found',
  monitorDiscoveredHint:
    'The monitor found this session stopped at a rate limit on disk. You started it outside the app, so there was no queued run to watch.',
  monitorStateScheduled: 'Scheduled',
  monitorStateBlockedWeekly: 'Blocked (weekly limit)',
  monitorStateNeedsHuman: 'Needs you',
  monitorStateDone: 'Done',
  monitorAccountOverridesLabel: 'Per-account overrides',
  monitorToastEnabled: 'Auto-resume monitor enabled.',
  monitorToastDisabled: 'Auto-resume monitor disabled.',
  monitorToastFailed: 'Failed to save auto-resume monitor settings.',
}
