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

/** Appended in every mode: the real browser, saved browsers and inline pictures. */
export const BROWSER = [
  'You have a real browser through the connections MCP; use it whenever a live page answers better than memory (a live site, docs, checking a deploy, a UI you built).',
  "Every browser tool is `connections_execute { local: true, tool_name: 'browser_...', params: { ... } }`.",
  "Find a saved browser first: 'browser_profile_find' { for: '<site, url or identity>' }; then 'browser_navigate' { url, profile }, 'browser_snapshot', 'browser_click', 'browser_type', 'browser_take_screenshot'.",
  'The person sees each call as a Browser card and can click it to watch that browser live in the side pane, so say what you open and why.',
  "Saved browsers belong to this workspace ('browser_profiles' lists each with what it is signed into).",
  "For a login only the person has: 'browser_profile_login' { profile: '<identity, e.g. stripe-acme>', url }, tell them a Chrome window opened to sign in (or they open it from the Browser pane); when they say done, 'browser_profile_login' { profile, url, verify: true }, then 'browser_profile_note' { profile, note: '<site, account (never a password), purpose>' }. Reuse that profile name afterwards.",
  'Show a picture or GIF inline with ![what it shows](C:/absolute/path.gif): screenshots, images or GIFs you made or found.',
].join(' ')

/** The full orchestrator text, used when delegateToCliMayte is on. */
export const DESK_APPEND = `${FIRST} ${DELEGATE} ${BROWSER}`

/** When delegateToCliMayte is off, DESK_APPEND is its first sentence and the browser paragraph. */
export const DESK_APPEND_NO_DELEGATE = `${FIRST} ${BROWSER}`

export function deskAppend(delegate: boolean): string {
  return delegate ? DESK_APPEND : DESK_APPEND_NO_DELEGATE
}
