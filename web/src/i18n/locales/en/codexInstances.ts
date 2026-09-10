export default {
  title: 'Codex instances',
  refresh: 'Refresh',
  createInstance: 'New Codex instance',
  empty: 'No Codex instances found.',
  emptyHint: 'Create an isolated Codex Desktop and CLI profile for each OpenAI login.',
  colStatus: 'Status',
  colName: 'Name',
  colAccount: 'Account',
  colUsage: 'Usage',
  colPlan: 'Plan',
  colHome: 'CODEX_HOME',
  colActions: 'Actions',
  /** "x of y" for a heading whose table is showing fewer rows than it has — the filter is hiding
   *  the rest. */
  countOfTotal: '{shown} of {total}',
  /** An OPENAI_API_KEY login: a valid Codex auth, but no ChatGPT subscription and so no plan
   *  or quota to report. */
  authApiKey: 'API key',
  /** Shown instead of the actions on a row this app didn't create (the default Codex install, or
   *  one running from an outside profile) — readable, but not ours to launch or delete. */
  externalHint: 'not managed here',
  desktopRunning: 'Desktop running',
  desktopStopped: 'Desktop stopped',
  loggedIn: 'Logged in',
  loggedOut: 'Not logged in',
  /** The account column's fallback when nothing is signed in. There is deliberately no "signed in"
   *  twin: an account cell that HAS a name/address already says so, and the status dot's title
   *  carries the long-form `loggedIn` for both states. */
  loggedOutShort: 'signed out',
  /** The row's PRIMARY button, so it reads exactly like the Claude desktop table's: one word, and
   *  which surface it opens is already obvious from the table you are looking at. The kebab menu
   *  keeps the long forms below, where several actions sit side by side and need telling apart. */
  openDesktop: 'Open',
  focusDesktop: 'Focus',
  /** The primary button when the desktop surface is switched off — matches the CLI table's. */
  launch: 'Launch',
  quitDesktop: 'Quit desktop',
  launchCli: 'Launch CLI',
  moreActions: 'More actions',
  login: 'Log in',
  redeemResetCredit: 'Redeem reset credit',
  /** Disabled-button tooltip: the cached usage already shows no banked credits. */
  redeemNoCredits: 'No banked reset credits — nothing to redeem.',
  /** Disabled-button tooltip: a reset would be wasted while a window still has headroom. `pct` is
   *  the busiest window's used percent, matching the server guard's own wording. */
  redeemNotExhausted:
    'Busiest window is only {pct}% used — redeeming now would waste most of the reset.',
  rename: 'Rename',
  delete: 'Delete',
  nameLabel: 'Instance name',
  namePlaceholder: 'e.g. work, personal, client-a',
  createDialogTitle: 'New Codex instance',
  createDialogDescription:
    'Create a new isolated CODEX_HOME and Codex Desktop profile for this OpenAI login.',
  createDialogSubmit: 'Create',
  createDialogCreating: 'Creating…',
  renameDialogTitle: 'Rename Codex instance',
  renameDialogDescription: "Change this Codex instance's display name.",
  renameDialogSubmit: 'Save',
  renameDialogRenaming: 'Saving…',
  deleteDialogTitle: 'Delete Codex instance',
  deleteDialogDescription:
    'This permanently removes the Codex instance, desktop profile, and local CODEX_HOME. This cannot be undone.',
  deleteDialogLabel: 'Type "{name}" to confirm',
  deleteDialogPlaceholder: 'Instance name',
  deleteDialogSubmit: 'Delete instance',
  deleteDialogDeleting: 'Deleting…',
  deleteDialogMismatch: "Name doesn't match.",
  toastCreated: 'Codex instance created.',
  toastCreateFailed: 'Failed to create Codex instance.',
  toastRenamed: 'Codex instance renamed.',
  toastRenameFailed: 'Failed to rename Codex instance.',
  toastDeleted: 'Codex instance deleted.',
  toastDeleteFailed: 'Failed to delete Codex instance.',
  toastCliLaunched: 'Codex CLI launched.',
  toastCliLaunchFailed: 'Failed to launch Codex CLI.',
  toastDesktopOpened: 'Codex Desktop launched.',
  toastDesktopOpenFailed: 'Failed to launch Codex Desktop.',
  toastDesktopFocused: 'Codex Desktop focused.',
  toastDesktopFocusFailed: 'Failed to focus Codex Desktop.',
  toastDesktopQuit: 'Codex Desktop stopped.',
  toastDesktopQuitFailed: 'Failed to stop Codex Desktop.',
  toastLoginOpened: 'Codex login opened in a terminal.',
  toastLoginFailed: 'Failed to open Codex login.',
  toastRedeemed: 'Reset credit redeemed.',
  toastRedeemFailed: 'Failed to redeem reset credit.',
}
