// Settings strings of the pages that keep their own settings (the Instances gear, the queue's
// automation dialog). The app-wide settings are Desk's Settings dialog since 2026-10-06
// (desk2/web/src/components/panes/agenthydra.ts).
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

  // provider surfaces
  claudeNativeTitle: 'Claude native control',
  claudeNativeHint:
    'A direct local connection for archiving chats and cleaning up the source after a move. Other migration steps may still use desktop controls.',
  claudeNativeAccount: 'Account',
  claudeNativeAccountLabel: '#{n} {name}',
  claudeNativeRefresh: 'Refresh native control settings',
  claudeNativeLoading: 'Loading accounts…',
  claudeNativeNoAccounts: 'No Windows Claude Desktop accounts found',
  claudeNativeAutoLabel: 'Start debugger automatically',
  claudeNativeAutoHint:
    'Opens this Claude Desktop account with a local debugger connection, so AgentHydra can archive chats and clean up after a move directly instead of clicking through the app. Takes effect the next time you open the account from AgentHydra.',
  claudeNativeAutomaticStatus: 'On. Ready the next time you open it from AgentHydra.',
  claudeNativeManualStatus: 'Off. Native control needs a debugger you start yourself.',
  claudeNativeStandardStatus: 'Off. This account uses standard desktop controls.',
  claudeNativeDetails: 'Details',
  claudeNativeNextOpen:
    'Saved changes apply the next time you open this account from AgentHydra. Running desktops are not restarted.',
  claudeNativePort: 'Local connection: 127.0.0.1:{port}',
  claudeNativeReset: 'Use standard controls',
  claudeNativeEnabledAccounts: 'Starts automatically: {accounts}',
  claudeNativeNoAutomaticAccounts: 'Automatic startup is not enabled for any account.',
  claudeNativeSupport:
    'Automatic startup uses a separate managed copy of Claude, rebuilt from whatever Windows Claude is installed. An executable it cannot verify is refused.',
  claudeNativeSaving: 'Saving…',
  claudeNativeSaved: 'Native control settings saved for {account}.',
  claudeNativeSaveFailed: 'Could not save native control settings.',
  providersTitle: 'Providers',
  providersHint:
    'Choose which desktop, CLI, and external AI surfaces AgentHydra shows. Disabling a surface hides its controls; it does not uninstall the provider or delete an account.',
  claudeDesktopProviderLabel: 'Claude Desktop',
  claudeDesktopProviderHint: 'Show and manage isolated Claude Desktop instances.',
  claudeCliProviderLabel: 'Claude CLI',
  claudeCliProviderHint: 'Show and manage isolated Claude CLI logins.',
  codexDesktopProviderLabel: 'Codex Desktop',
  codexDesktopProviderHint: 'Show desktop launch, focus, quit, and running status for Codex.',
  codexCliProviderLabel: 'Codex CLI',
  codexCliProviderHint: 'Show Codex CLI launch and login actions.',
  dshProviderLabel: 'DeepSeek',
  dshProviderHint: 'Show the DeepSeek Harness instances table.',
  // ⛔ THE ONLY SETTING ON THIS SCREEN THAT SPENDS QUOTA. Say so plainly: a toggle whose cost you
  // discover later is a toggle that should not have existed.
  keepaliveFloorLabel: 'Leave alone above (weekly %)',
  keepaliveFloorHint:
    'Accounts at or above this share of their WEEKLY cap are skipped. The weekly window is the one that matters. A 5-hour window refills the same day, so spending the last of a weekly allowance to start one is a bad trade. Set 0 to stop the keepalive spending on anything.',
  // ⛔ SPENDS MONEY: paid extra usage is billed. Off by default, and the hint says what off does.
  extraUsageLabel: 'Allow paid extra usage',
  extraUsageHint:
    'Off by default. Some Claude accounts keep working past their limits on paid extra usage (usage credits) instead of stopping. With this off, nothing AgentHydra manages is allowed to bill it: CliMayte moves a task to an account with free quota before its account would bill, and any Claude session on an account that has extra usage switched on is stopped as that account nears its limit. The chat itself is kept and can carry on later or on another account. Turn it on only if you want work to spend those credits.',
  providerToastFailed: 'Failed to save provider setting.',

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
