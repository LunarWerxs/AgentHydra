// DeepSeek Harness instances section (below the Codex table): one DSH_HOME per row, which is what a
// second DeepSeek account actually is. No usage or plan columns on purpose — the harness bills a
// pay-as-you-go API key, so there is no 5-hour or weekly window to report and an empty quota column
// would only invite a question with no answer.
//
// The create / rename / delete dialogs are the SHARED ones (CliInstanceNameDialog,
// DeleteCliInstanceDialog) driven by lib/instance-dialog-i18n.ts, which is why the `*Dialog*` keys
// below match that map exactly.
export default {
  title: 'DeepSeek instances',
  refresh: 'Refresh',
  createInstance: 'New DeepSeek instance',
  empty: 'No DeepSeek Harness homes found.',
  // NO literal "@" in this string: vue-i18n reads a bare @ as the start of a linked-message
  // reference and throws at render time — the same trap instances.ts's colAccountHint documents,
  // which is why the package name is spelled without its scope here.
  emptyHint:
    'Install the harness (npm i -g the deepseek-ai/dsh package), or create an instance here to give a second account its own home.',
  colName: 'Name',
  colHome: 'Home',
  colSessions: 'Chats',
  colStatus: 'Status',
  colActions: 'Actions',
  running: 'Serving',
  stopped: 'Not running',
  // The machine's own ~/.dsh (or $DSH_HOME). Marked because it is the one row AgentHydra did not
  // create and will not delete.
  defaultBadge: 'Default',
  defaultHint: 'This machine’s own harness home. AgentHydra reads it; it never created it.',
  port: 'port {port}',
  launch: 'Launch',
  launchHint: 'Start a server for this home and open its window',
  open: 'Open',
  openHint: 'Open a window on the server already serving this home',
  quit: 'Stop',
  quitHint: 'Stop the server serving this home. Chats and credentials are untouched.',
  rename: 'Rename',
  remove: 'Remove from the list',
  removeHint: 'Forget this instance. Its home and chats stay on disk.',
  delete: 'Delete home and chats',
  moreActions: 'More actions',
  copyHome: 'Copy home path',
  copied: 'Copied the home path',
  // Shown while a launch is in flight: the harness prints its address only once the server is up,
  // so this is genuinely a wait rather than decoration.
  launching: 'Starting…',

  nameLabel: 'Name',
  namePlaceholder: 'work, personal, …',
  createDialogTitle: 'New DeepSeek instance',
  createDialogDescription:
    'Creates an empty DSH_HOME. The harness writes its own settings, credentials and chats into it the first time you launch it.',
  createDialogSubmit: 'Create',
  createDialogCreating: 'Creating…',
  renameDialogTitle: 'Rename instance',
  renameDialogDescription: 'Changes the label only. The home directory keeps its name.',
  renameDialogSubmit: 'Rename',
  renameDialogRenaming: 'Renaming…',
  deleteDialogTitle: 'Delete this instance?',
  deleteDialogDescription:
    'Deletes the home directory and every conversation in it. AgentHydra cannot get them back.',
  deleteDialogLabel: 'Type the instance name to confirm',
  deleteDialogPlaceholder: 'instance name',
  deleteDialogMismatch: 'That does not match the instance name.',
  deleteDialogSubmit: 'Delete',
  deleteDialogDeleting: 'Deleting…',
}
