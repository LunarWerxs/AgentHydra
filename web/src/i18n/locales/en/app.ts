// App shell strings: top bar tabs, queue toggle, settings toggle, the one-time rebrand notice.
export default {
  tabSessions: 'Sessions',
  tabInstances: 'Instances',
  queue: 'Queue',
  settings: 'Settings',
  settingsUpdateAvailable: 'Settings — an update is available',
  restartNeeded: 'Restart to load new code',
  restarting: 'Restarting…',
  restartNeededHint:
    'AgentHydra is still running the code it started with ({boot}), but its folder has moved on to {disk}. Anything added since is missing until it restarts. Restarting keeps the same address and reloads this page.',
  restartFailed: 'Restart did not happen: {reason}',
  rebrandTitle: 'CC Manager UI is now AgentHydra',
  rebrandBody:
    'It manages Claude, Codex and OpenCode, so it is named for the many-headed thing it is. Your queue, settings and instance names came across. Old shortcuts pointing at CCManagerUI.exe need re-creating.',
  rebrandAction: 'Details',
  // --- keyboard shortcuts (composables/useShortcuts.ts) ---
  shortcutsTitle: 'Keyboard shortcuts',
  shortcutsHint: 'What is bound right now, on this view.',
  shortcutsNone: 'Nothing is bound on this view.',
  shortcutGroupApp: 'App',
  shortcutShowSheet: 'Show this list',
  shortcutSessions: 'Go to Sessions',
  shortcutInstances: 'Go to Instances',
  shortcutAnalytics: 'Go to Analytics',
  tabAnalytics: 'Analytics',
}
