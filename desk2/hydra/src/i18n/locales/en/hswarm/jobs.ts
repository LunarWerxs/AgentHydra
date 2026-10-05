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
  summary: 'Summary',
  // The X button on an open job's summary, which sits under the job's row in the table: it only
  // folds the summary away (the job itself is untouched; cancelJob is the row's X that ends it).
  closeSummary: 'Hide this summary',
  taskResults: 'Task results',
  taskStatus: 'Status',
  taskModel: 'Model',
  taskCost: 'Tokens',
  taskAnswer: 'Answer',
  noResults: 'No task results yet.',
}
