// App shell strings: top bar tabs, queue toggle, settings toggle, the one-time rebrand notice.
export default {
  tabSessions: 'Sessions',
  tabInstances: 'Instances',
  queue: 'Queue',
  settings: 'Settings',
  settingsUpdateAvailable: 'Settings — an update is available',
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
}
