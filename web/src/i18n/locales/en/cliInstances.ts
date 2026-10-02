// CLI Instances section (the CLI tab, above CliMayte): an isolated CLAUDE_CONFIG_DIR the daemon can
// spawn a real `claude` process against.
export default {
  title: 'CLI instances',
  refresh: 'Refresh',
  createInstance: 'New CLI instance',
  empty: 'No CLI instances found.',
  emptyHint: 'Create your first isolated CLI instance to get started.',
  colName: 'Name',
  colAccount: 'Account',
  colConfigDir: 'Config dir',
  colUsage: 'Usage',
  colActions: 'Actions',
  // The Tokens column: what an account has run, from its own transcripts (cli-instance-tokens.ts).
  colTokens: 'Tokens',
  tokensLabel: '{total} tokens',
  tokensBreakdown:
    '{output} output · {input} input · {cacheRead} cache read · {cacheWrite} cache write',
  tokensSource: 'From this instance’s transcripts on this PC',
  loggedIn: 'Logged in',
  loggedOut: 'Not logged in',
  noAccount: 'No account',
  // Names the marker to look for. "shown on their desktop instance" was true but unactionable —
  // the row it pointed at had no visible sign of the link, so the reader was told where to look
  // and then found nothing there.
  linkedElsewhere: '+ {count} on a desktop row in the Instances tab (⌨ marks them)',
  // "(0)" alone reads as "you have none"; "(0 of 1)" says the missing one is elsewhere, not absent.
  countOfTotal: '{shown} of {total}',
  allLinked: 'Every CLI instance is linked to a desktop instance',
  allLinkedHint:
    'Linked ones sit on their desktop instance’s row in the Instances tab, marked with a terminal icon, since they are the same account. Unlink one to bring it back here.',
  // The pill beside a row's name: Claude sessions live on this login now (GET /api/cli-instances).
  liveSessions:
    '{n} Claude session running on this account, CliMayte’s included | {n} Claude sessions running on this account, CliMayte’s included',
  launch: 'Launch',
  moreActions: 'More actions',
  login: 'Log in',
  // "Log in" on a row points Quick add at that instance (CliQuickAdd.vue, useQuickAddTarget.ts).
  quickAddTarget:
    'Signing in #{num} {name} again: the account you sign in with replaces its current login.',
  quickAddTargetClear: 'Clear: add a new account instead',
  logout: 'Log out',
  associate: 'Associate account',
  rename: 'Rename',
  checkUsage: 'Check usage',
  // Limit reset, through the CLI's own /limit-reset (CliLimitResetDialog.vue, CliLimitResetIcon.vue).
  limitReset: 'Use limit reset',
  limitResetTitle: 'Use the limit reset on {name}?',
  limitResetBody:
    'AgentHydra runs the CLI’s own /limit-reset for this account. Use reset spends one if it is there: a banked reset refills its limits, the weekly session reset refills the 5-hour limit (still counting toward the weekly one). Check only backs out when the CLI asks “Use your reset?”, but the weekly session reset asks nothing, so a check uses that one if it is available.',
  limitResetConfirm: 'Use reset',
  limitResetCheck: 'Check only',
  limitResetAvailableLabel: 'Limit reset available',
  limitResetAvailableHint: '{message} Checked {ago}.',
  limitResetWorking: 'Working… up to a minute',
  limitResetCancel: 'Cancel',
  limitResetFailed: 'Could not run the limit reset.',
  limitResetUsedLabel: 'Limit reset already used',
  limitResetUsedHint: 'Available again {date}. Checked {ago}.',
  limitResetDoneLabel: 'Limit reset used {ago}',
  limitResetDoneHint: 'Next one available {date}.',
  limitResetUnknownDate: 'later',
  delete: 'Delete',
  nameLabel: 'Instance name',
  namePlaceholder: 'e.g. work, personal, client-a',
  createDialogTitle: 'New CLI instance',
  createDialogDescription: 'Create a new isolated CLAUDE_CONFIG_DIR for running the CLI.',
  createDialogSubmit: 'Create',
  createDialogCreating: 'Creating…',
  renameDialogTitle: 'Rename CLI instance',
  renameDialogDescription: "Change this CLI instance's display name.",
  renameDialogSubmit: 'Save',
  renameDialogRenaming: 'Saving…',
  deleteDialogTitle: 'Delete CLI instance',
  deleteDialogDescription:
    'This permanently removes the CLI instance and its local config directory. This cannot be undone.',
  deleteDialogPlaceholder: 'Instance name',
  deleteDialogSubmit: 'Delete instance',
  deleteDialogDeleting: 'Deleting…',
  deleteDialogMismatch: "Name doesn't match.",
  associateDialogTitle: 'Associate account',
  associateDialogDescription:
    'Pick the dispatch account this CLI instance checks usage against (and, later, auto-resumes under).',
  associateAccountLabel: 'Account',
  associateNone: 'None',
  associateDialogSubmit: 'Save',
  associateDialogSaving: 'Saving…',
  linkDesktop: 'Link to desktop instance',
  linkDialogTitle: 'Link to a desktop instance',
  linkDialogDescription:
    "A desktop instance and a CLI instance are two separate logins, but they are usually the same Claude account used two different ways. Linking them lets AgentHydra show them together, and lets each one check usage on the other's behalf if its own sign-in has expired.",
  linkDesktopLabel: 'Desktop instance',
  linkNone: 'Not linked',
  linkDialogSubmit: 'Save',
  linkDialogSaving: 'Saving…',
  toastLinked: 'Linked to desktop instance.',
  toastUnlinked: 'Desktop link removed.',
  toastLinkFailed: 'Failed to save the desktop link.',
  toastCreated: 'CLI instance created.',
  toastCreateFailed: 'Failed to create CLI instance.',
  toastRenamed: 'CLI instance renamed.',
  toastRenameFailed: 'Failed to rename CLI instance.',
  toastAssociated: 'Account association saved.',
  toastAssociateFailed: 'Failed to save account association.',
  toastDeleted: 'CLI instance deleted.',
  toastDeleteFailed: 'Failed to delete CLI instance.',
  toastLaunched: 'CLI instance launched.',
  toastLaunchFailed: 'Failed to launch CLI instance.',
  toastLogout: 'Signed out',
  toastLogoutFailed: 'Could not sign this instance out',
  logoutDialogDescription:
    'Removes the saved Claude login (.credentials.json) from this CLI instance. Its chats, settings and folder stay, and Claude asks for a sign-in the next time it starts. Quit any Claude session running on it first.',
  toastUsageCheckFailed: 'Failed to check usage.',
  // The table's gear, and the keepalive's switch inside it (server/src/session-keepalive.ts; also
  // in Settings).
  tableSettings: 'CLI settings',
  keepaliveSwitch: 'Keep windows running',
  keepaliveSwitchHint:
    'When a signed-in account has no 5-hour window running, AgentHydra sends it one tiny prompt (Haiku, one word back, about two cents at API prices) so its window starts now and resets sooner. Skips accounts at their limit, signed out, busy, or at {floor}% or more of their weekly limit. A timer icon on the row marks a window it started.',
  keepaliveSaveFailed: 'Could not change the setting.',
  // A row's nudge note (lastNudge from GET /api/cli-instances).
  nudgedLabel: 'Window started by AgentHydra {ago}',
  nudgedHint: 'It resets {when}. {model}, {cost} at API prices.',
  nudgeFailedLabel: 'The last nudge did not start the window',
  nudgeFailedHint: '{note} ({ago}). It tries again after an hour.',
  // Moving a login to the other PC (CliLoginMoveDialog.vue, server/src/core/cli-login-move.ts).
  moveOut: 'Copy login to another PC',
  moveIn: 'Import logins from another PC',
  movedAwayLabel: 'Login moved to another PC',
  movedAwayHint:
    'Moved {ago} in {file}. Import that file on the other PC, or here to bring it back.',
  moveOutTitle: 'Copy logins to another PC',
  moveOutBody:
    'Puts the logins in one encrypted file in Downloads. Open it on the other PC with the passphrase below. This PC stays signed in. If both PCs use a login, turn on Login sync too: a refresh on one PC otherwise signs the other out after a while.',
  moveSignOut: 'Also sign this PC out of them (a move)',
  moveOutPick: 'Logins to move',
  moveOutBusy: 'a session is running on it',
  moveOutNone: 'No account here is signed in, so there is nothing to move.',
  passphraseLabel: 'Passphrase',
  passphraseHint:
    'Write it down or copy it: the other PC needs it, and AgentHydra does not keep it. Anyone with the file and the passphrase gets these logins, so do not send both the same way.',
  passphraseCopy: 'Copy passphrase',
  passphraseCopied: 'Passphrase copied.',
  passphraseNew: 'Make a new one',
  passphraseShort: 'At least {min} characters.',
  moveOutSubmit: 'Copy {n} login | Copy {n} logins',
  moveOutWorking: 'Copying…',
  moveFileCopy: 'Copy file path',
  moveFileCopied: 'File path copied.',
  moveInTitle: 'Import logins from another PC',
  moveInBody:
    'Choose the .ahlogins file made by “Copy login to another PC” on your other PC, and type its passphrase. Each login lands on the same account here (or a new instance with the same number when this PC has never used it), and AgentHydra checks that it signs in.',
  moveInFile: 'Login file',
  moveInFrom: 'From {from}, {date}:',
  moveInBadFile: 'That file is not an AgentHydra login file.',
  moveInSubmit: 'Import',
  moveInWorking: 'Importing and checking each sign-in…',
  moveFailed: 'The move failed.',
  copyFailed: 'Could not copy to the clipboard.',
  moveClose: 'Close',
  moveCancel: 'Cancel',
  // Login sync through the owner's own store (CliLoginSyncDialog.vue, server/src/core/cli-login-sync.ts).
  sync: 'Login sync',
  syncHint:
    'Keeps your CLI and desktop logins the same on your PCs through a small store in your own Cloudflare account, so both can stay signed in.',
  syncTitle: 'Login sync',
  // One line each (owner, 2026-10-01: the dialog was "verbose as FUCK"); the long version is
  // cloud/login-sync-worker/README.md.
  syncIntro:
    'Sign in on one PC and the other gets the login within a minute. The store only holds encrypted copies.',
  // Says what goes wrong otherwise: "keep it open on one PC at a time" alone was read twice and
  // still left "what happens if I do not?" (SUE round, 2026-10-01).
  syncDesktopNote:
    'Desktop accounts are on the Instances tab. Don’t run the same one on both PCs at once: its login only syncs to a PC while Claude Desktop is closed there.',
  syncKindDesktop: 'Desktop',
  syncKindCli: 'CLI',
  syncJoinTitle: 'Join from your other PC',
  syncJoinHint:
    'On the PC that already syncs, open Login sync and press Copy pairing code, then paste it here. The code is one line of text that holds the store’s address, its access token and the key that encrypts your logins.',
  syncJoinPlaceholder: 'Pairing code from your other PC',
  syncJoin: 'Join',
  syncSetupTitle: 'Or set up a new store',
  syncSetupHint:
    'The address and access token of your Login sync Worker (cloud/login-sync-worker in the AgentHydra repo says how to deploy one).',
  syncUrl: 'Store address',
  syncToken: 'Access token',
  syncSetup: 'Set up',
  syncWorking: 'Checking the store…',
  // The one switch (owner, 2026-10-01): on means every login syncs and the list stays away.
  syncAll: 'Sync all',
  syncAllHint:
    'Every login on this PC and in the store is kept the same on both PCs. Turn this off to choose which logins sync here.',
  syncPause: 'Pause',
  syncResume: 'Resume',
  syncPaused: 'Paused: nothing syncs until you resume',
  syncPairingHint:
    'One line of text for your other PC: paste it into Login sync there and that PC joins this store. It holds the store’s address, its access token and the key that encrypts your logins, so treat it like a password.',
  syncStore: 'Store: {host}',
  syncLast: 'Last synced {ago}',
  syncFirst: 'First sync is running…',
  syncNow: 'Sync now',
  syncPairing: 'Copy pairing code',
  syncPairingCopied:
    'Pairing code copied. Paste it into Login sync on your other PC; keep it private.',
  syncDisconnect: 'Stop syncing',
  syncCount: '{n} of {total} in sync',
  syncCountArriving: '{n} of {total} in sync, {arriving} on the way',
  syncLogins: 'Logins',
  // A row's state: the word on the row, and (…Hint) the sentence behind it, shown on hover.
  syncStateInSync: 'In sync',
  syncStateInSyncHint: 'This PC and the store hold the same login.',
  // Shown instead of the two below while sync is on: either way the next pass settles it.
  syncStateOnTheWay: 'On the way',
  syncStateHereOnly: 'Not uploaded yet',
  syncStateHereOnlyHint: 'Signed in here; the next sync uploads it to the store.',
  syncStateStoreOnly: 'Not on this PC yet',
  syncStateStoreOnlyHint: 'The store holds it; the next sync signs this PC in to it.',
  syncStatePending: 'Pending',
  syncStatePendingHint: 'Waiting for the next sync.',
  syncStateOut: 'Left out',
  syncStateOutHint: 'Not synced on this PC. Turn its switch on to sync it.',
  syncStateOwn: 'Own sign-in',
  syncStateOwnHint: 'Signed in separately on this PC, so sync leaves it alone.',
  syncStateWaiting: 'Waiting',
  syncStateWaitingHint:
    'A newer login is in the store. It lands here once this desktop instance is closed.',
  syncStateFed: 'From desktop',
  syncStateFedHint: 'This CLI login comes from its desktop instance, which is the one that syncs.',
  syncStateProblem: 'Can’t sync',
  syncInclude: 'Sync this login on this PC',
  syncRecent: 'Recent',
  syncEventPushed: 'uploaded',
  syncEventPulled: 'updated here',
  syncEventCreated: 'added here',
  syncEventSkipped: 'skipped',
  syncEventError: 'error',
}
