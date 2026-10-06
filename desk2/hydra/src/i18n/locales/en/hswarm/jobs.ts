export default {
  title: 'Jobs',
  reload: 'Reload',
  noJobs: 'No jobs yet',
  noJobsDescription:
    'A batch an agent runs through the swarm shows up here with its cost and outcome.',
  failedToLoad: 'Could not load the jobs',
  table: {
    jobId: 'Job',
    label: 'Label',
    state: 'State',
    tasks: 'Tasks',
    cost: 'Tokens',
    created: 'Created',
  },
  runningNow: 'Running now',
  allRecentJobs: 'All recent jobs',
  // The X button on a running job's row, which cancels the job (after confirmCancel).
  cancelJob: 'Cancel this job',
  confirmCancel: 'Cancel job {id}? Tasks already finished keep their results.',
  jobCancelled: 'Job cancelled',
  jobNotFound: 'Job not found',
  // The X button on an open job, which sits under the job's row in the table: it only folds the job's
  // summary and task results away (the job itself is untouched; cancelJob is the row's X that ends it).
  closeSummary: 'Hide this summary',
  // A job's task counts, in the Tasks column and the open job's summary line.
  countDone: '{n} done',
  countFailed: '{n} failed',
  countRunning: '{n} running',
  countQueued: '{n} queued',
  countCancelled: '{n} cancelled',
  // Hovers on the open job's summary line: its counts, its cost and its time.
  countsHint: 'Tasks in this job: {n}',
  costHint: '{tokens} tokens; the cost is at list price',
  timeHint: 'Started {created}',
  timeHintFinished: 'Started {created}, finished {finished}',
  // How long a job or a task ran: {span} is spanSeconds..spanDays.
  tookTime: 'took {span}',
  runningTime: 'running for {span}',
  spanSeconds: '{s}s',
  spanMinutes: '{m}m',
  spanHours: '{h}h {m}m',
  spanDays: '{d}d {h}h',
  // The chat that started the open job: its title, or this with a short id when AgentHydra's chat
  // list does not name it. A click opens it in Desk (callerOpen); callerHint when it cannot be opened.
  callerUnnamed: 'Chat {id}',
  callerOpen: 'The chat that started this job: click to open it',
  callerHint: 'The chat that started this job',
  // The open job's task list: its heading (folded past {n} tasks), the info icon beside it, and its lines.
  taskResults: 'Task results',
  taskResultsHint:
    'A job is a batch of tasks a chat handed to HSwarm. This is what each task came back with, one line per task: a mark for how it ended, its id, the model that did it, what it cost at list price and the first line of its answer. Click a line to read the whole answer. With more than {n} tasks the list starts folded: click its heading to open it.',
  taskListLabel: 'Task results, one line per task',
  taskShowMore: 'Show {n} more of {total}',
  // A task's mark, on hover and for screen readers; {status} is HSwarm's own word (error, timeout, loop).
  markDone: 'Done',
  markFailed: 'Failed ({status})',
  markRunning: 'Running',
  markQueued: 'Queued',
  markCancelled: 'Cancelled',
  noAnswer: 'No answer.',
  noAnswerYet: 'Still running: no answer yet.',
  noAnswerQueued: 'Queued: not started yet.',
  noResults: 'No task results yet.',
}
