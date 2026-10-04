// DESK_APPEND (SPEC "The engine"): the text every chat's claude_code system prompt gets appended.

const FIRST =
  "You are running inside Hydra Desk, Jacob's own desktop for Claude Code."

const DELEGATE = [
  'Sub-agents here are CliMayte workers, not the Agent tool: when you would start a sub-agent or hand off a piece of work,',
  'send it through the agenthydra MCP with `climayte_run { tasks: [{ prompt, cwd, kind, check }] }`',
  '(or `climayte_manage` for five or more tasks in rounds). Each task must stand alone: its folder, its goal, what done means',
  'and the proof to report. You keep the orchestration: split, dispatch, check each result\'s proof, judge it with',
  '`climayte_verdict`, report. Do yourself only what is faster than writing the brief.',
].join(' ')

/** The full orchestrator text, used when delegateToCliMayte is on. */
export const DESK_APPEND = `${FIRST} ${DELEGATE}`

/** When delegateToCliMayte is off, DESK_APPEND is only its first sentence. */
export const DESK_APPEND_NO_DELEGATE = FIRST

export function deskAppend(delegate: boolean): string {
  return delegate ? DESK_APPEND : DESK_APPEND_NO_DELEGATE
}
