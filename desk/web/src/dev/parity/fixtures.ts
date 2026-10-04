// What the real captures in docs/reference/real show, as Hydra Desk data: sidebar rows with their dot
// states, transcripts with the same words, the repo strip numbers and the composer draft. Times hang off
// PARITY_NOW so every render is identical.
import type { AccountInfo, ChatStatus, ChatSummary, TranscriptItem } from '@shared/protocol'
import { PARITY_NOW } from './clock'

const MIN = 60_000
const C = 'C:/Users/jacob/Desktop/Project/connections'
const N = 'C:/Users/jacob/Desktop/nexuscode-2d'
const P = 'C:/Users/jacob/Desktop/ParamountJacob'

type Row = [id: string, title: string, cwd: string, status: ChatStatus, extra?: Partial<ChatSummary>]

/** Rows in the order the reference lists them; the order becomes newest-first timestamps. */
function chats(rows: Row[]): ChatSummary[] {
  return rows.map(([id, title, cwd, status, extra], i) => ({
    id,
    sessionId: `s-${id}`,
    title,
    cwd,
    account: { id: '68', label: '#68 eek (Max 20x)', configDir: null, number: 68 },
    accountAuto: true,
    model: 'claude-sonnet-5-5',
    effort: 'max',
    permissionMode: 'bypassPermissions',
    delegateToCliMayte: true,
    status,
    activity: status === 'working' ? 'Bash: bun test' : null,
    turnStartedAt: status === 'working' ? PARITY_NOW - 4 * MIN : null,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: PARITY_NOW - (i + 1) * 60 * MIN,
    updatedAt: PARITY_NOW - (i + 1) * MIN,
    costUsd: 0.4,
    contextPct: 30,
    pendingCount: status === 'needs_you' ? 1 : 0,
    queuedCount: 0,
    climayteActive: 0,
    ...extra
  }))
}

/** user/window.webp: solid grey = running, blue = unread, amber = needs you, ring = idle. */
export const windowChats = (): ChatSummary[] =>
  chats([
    ['avg', 'Apple vs Google design philosophy', C, 'working'],
    ['lambda', 'Lambda teardown and AWS leftovers', C, 'working'],
    ['csm', 'Connections Studio Marketplace UX review', C, 'idle', { unread: true }],
    ['ccd', 'Claude Code desktop replacement', C, 'idle'],
    ['linktree', 'Linktree shops page review', C, 'needs_you'],
    ['ucp', 'Unified connections product consolidation plan', C, 'idle'],
    ['sui', 'Screen UI polish', N, 'working'],
    ['cg', 'Crazy Games resubmission readiness', N, 'needs_you'],
    ['ymca', 'YMCA tune isolation model', P, 'idle']
  ])

/** user/sidebar-crop.png: a later moment of the same window, with its own order and states. */
export const sidebarUserChats = (): ChatSummary[] =>
  chats([
    ['ahs', 'Agent Hydra subprocess issue', C, 'working'],
    ['csm', 'Connections Studio Marketplace UX review', C, 'working'],
    ['ccd', 'Claude Code desktop replacement', C, 'working'],
    ['avg', 'Apple vs Google design philosophy', C, 'working'],
    ['lambda', 'Lambda teardown and AWS leftovers', C, 'working'],
    ['linktree', 'Linktree shops page review', C, 'needs_you'],
    ['ucp', 'Unified connections product consolidation plan', C, 'idle'],
    ['sui', 'Screen UI polish', N, 'working'],
    ['cg', 'Crazy Games resubmission readiness', N, 'needs_you'],
    ['ymca', 'YMCA tune isolation model', P, 'idle']
  ])

/** whole-window.png, sidebar.png and the composer/menu captures taken with it. */
export const harvestChats = (): ChatSummary[] =>
  chats([
    ['pc', 'PC performance issues', C, 'working'],
    ['ccd', 'Claude Code desktop replacement', C, 'idle'],
    ['ucp', 'Unified connections product consolidation plan', C, 'idle'],
    ['avg', 'Apple vs Google design philosophy', C, 'idle'],
    ['csm', 'Connections Studio Marketplace UX review', C, 'idle'],
    ['cg', 'Crazy Games resubmission readiness', N, 'idle', { unread: true }],
    ['ymca', 'YMCA tune isolation model', P, 'working']
  ])

export function parityAccounts(): AccountInfo[] {
  return [
    {
      id: '68',
      label: '#68 eek (Max 20x)',
      configDir: null,
      number: 68,
      email: null,
      plan: 'Max 20x',
      signedIn: true,
      fiveHourPct: 22,
      weeklyPct: 41,
      fiveHourResetsAt: PARITY_NOW + 3 * 60 * MIN,
      weeklyResetsAt: PARITY_NOW + 4 * 24 * 60 * MIN,
      inUse: false
    },
    {
      id: '35',
      label: '#35 sue (Max 5x)',
      configDir: null,
      number: 35,
      email: null,
      plan: 'Max 5x',
      signedIn: true,
      fiveHourPct: 71,
      weeklyPct: 58,
      fiveHourResetsAt: PARITY_NOW + 47 * MIN,
      weeklyResetsAt: PARITY_NOW + 2 * 24 * 60 * MIN,
      inUse: true
    }
  ]
}

type Usage = [id: string, name: string, plan: string | null, fiveHour: number | null, weekly: number | null, signedIn?: boolean]

/** The accounts of ours-accounts-popup.png (Jacob's 42, cut to 14), in AgentHydra's order, not sorted. */
export function popoverAccounts(): AccountInfo[] {
  const rows: Usage[] = [
    ['default', 'Default login', null, null, null],
    ['23', '#23 boardroom', 'Pro', null, null, false],
    ['35', '#35 sue', 'Max 20x', 6, 43],
    ['102', '#102', 'Pro', null, 72],
    ['126', '#126', 'Pro', 0, 86],
    ['129', '#129', 'Pro', 82, 63],
    ['128', '#128', 'Pro', 4, 18],
    ['68', '#68 eek', 'Max 20x', 22, 41],
    ['40', '#40 kai', 'Max 5x', 91, 57],
    ['77', '#77', 'Pro', 35, 12],
    ['81', '#81 ops', 'Pro', 100, 94],
    ['90', '#90', 'Pro', null, null, false],
    ['93', '#93 lab', 'Max 5x', 12, 29],
    ['117', '#117', 'Pro', 58, 61]
  ]
  return rows.map(([id, name, plan, fiveHour, weekly, signedIn = true], i) => ({
    id,
    label: plan ? `${name} (${plan})` : name,
    configDir: null,
    number: id === 'default' ? undefined : Number(id),
    email: null,
    plan,
    signedIn,
    fiveHourPct: signedIn ? fiveHour : null,
    weeklyPct: signedIn ? weekly : null,
    fiveHourResetsAt: fiveHour == null ? null : PARITY_NOW + (30 + i * 17) * MIN,
    weeklyResetsAt: weekly == null ? null : PARITY_NOW + (2 * 24 * 60 + i * 97) * MIN,
    inUse: id === '35'
  }))
}

let seq = 0
const at = (minAgo: number) => PARITY_NOW - minAgo * MIN + seq++

function tool(id: string, name: string, input: Record<string, unknown>, failed = false): TranscriptItem {
  const t = at(30)
  return {
    id,
    ts: t,
    kind: 'tool_use',
    name,
    input,
    status: failed ? 'error' : 'done',
    result: { text: failed ? 'exit code 1' : 'ok', isError: failed },
    startedAt: t,
    endedAt: t + 900
  }
}

const user = (id: string, text: string): TranscriptItem => ({ id, ts: at(40), kind: 'user', text })
const say = (id: string, text: string): TranscriptItem => ({ id, ts: at(20), kind: 'assistant_text', text })

// The window's long user message. Its first lines are scrolled out of view in the reference; the opening
// sentence here is invented, the rest is the visible text word for word.
const WINDOW_USER =
  "Okay, are we in sync with Agent Hydra, and has Michael built a better version of this already? And is CliMayte's account picking smart or is it, " +
  "mate not intelligent? What I mean by that is shouldn't it see oh yeah there's already three chats running on the friggin' pro account let's not throw eight others on there because pro accounts have virtually no usage " +
  "And let's maybe throw it at oh a account with more usage. Are you not smart in your usage deployments? Do you not consider that it's a stinking pro account and thus has very little usage? " +
  "But if it's a 5x or a max, shouldn't those be considered? If not, please make sure it is in the distribution and concurrent chats of the suggested available in these accounts so " +
  "we don't have to change as often and cannot burn our cash tokens as often. So like make sure the picker reads the plan size and what is already running before it picks. " +
  'And what do you mean by subscription logins?'

const WINDOW_REPLY = `Yes, we're now in sync with Agent Hydra, and Michael hasn't built a better version. The Agent Hydra checkout was 110 commits behind. It's caught up to his latest, with nothing behind and nothing ahead. Those 110 commits are speed, analytics and usage-tracking work, and none is a desktop app. My first "no" was checked against the stale copy, so I re-checked, and it still holds.

**The manager:** Michael did build one, the CliMayte wave manager, and that is the one that broke on me. Hydra Desk is not a copy of it, and I've stopped using it.

**Is CliMayte smart about accounts?** Yes, it already does what you describe:

- A Max 5x counts as 5 Pros and a Max 20x as 20.
- It counts the workers already running on an account.
- It caps workers per account, 4 per Pro window scaled by plan, and 2 for a group on a Pro.
- It skips accounts someone is using and follows each account's weekly pace.

**The weak spot was my own code.** Hydra Desk's account picker only looked at the lowest 5-hour usage. It ignored plan size and how many chats were already on an account. A worker is fixing that now to follow Michael's same rules, with chat caps of 1 on a Pro, 5 on a Max 5x and 20 on a Max 20x.

**Why there are still lots of moves:** you have about 40 accounts and only two are big, one Max 20x and one Max 5x. Pro windows are tiny, so heavy work on a Pro runs out in minutes.

**What I meant by "subscription logins":**

- To talk to Claude, a program has to sign in. Your Pro and Max accounts are plan sign-ins, the paid plans AgentHydra already holds. The other option is an API key, a separate pay-per-use key from Anthropic's developer site.
- Hydra Desk uses your plan sign-ins, the same way Claude Desktop does today, so it costs you nothing extra.
- Anthropic's rules say apps built with their developer kit should use an API key, not plan sign-ins. For a personal tool like yours that's a grey area, and the risk is Anthropic flagging an account.
- Stay on plan sign-ins, or move to an API key?

**Faster from here:** no manager layer (done), and I start each next piece the moment one lands. Tasks stay small enough to finish on one account. A fresh chat per task also helps, because this one is huge.

### What I did

- Caught Agent Hydra up and re-checked it.
- Read how CliMayte places work.
- Found the weak account picker in my code and started a worker to fix it.
- Answered your login question in plain English.

### Am I 100% done?

No. Four workers are running: three making the look match, and the picker fix. Nothing has reported back yet.

### Do I recommend anything else?

Stay on your plan sign-ins for now. It's your call and easy to change later.

🔴 NEED: Say "stay" or "API key." I'm holding the real-chat test until you do.`

/** user/window.webp: the collapsed long user message, one folded tool run, the formatted reply. */
export function windowItems(): TranscriptItem[] {
  const bash = Array.from({ length: 9 }, (_, i) => tool(`wb${i}`, 'Bash', { command: `git -C ../.. log --oneline -${i + 1}` }, i === 4))
  return [
    user('wu', WINDOW_USER),
    ...bash.slice(0, 3),
    tool('wg1', 'Grep', { pattern: 'pickAccount' }),
    tool('wg2', 'Grep', { pattern: 'planWeight' }),
    tool('wr', 'Read', { file_path: 'C:/Users/jacob/Desktop/Project/Agent Hydra/src/climayte/index.ts' }),
    ...bash.slice(3),
    tool('wm1', 'mcp__agenthydra__list_usage', {}),
    tool('wm2', 'mcp__agenthydra__climayte_status', {}),
    say('wa', WINDOW_REPLY)
  ]
}

const HARVEST_BEFORE = `The window shell, sidebar and composer are next. Next I build, run the full check, and open the real window to prove it.

### Do I recommend anything else?

Nothing right now.`

const HARVEST_LIST = `Pieces are landing fast: 10 of the 14 are already committed in the private repo, but none are verified yet. I'll check each one when the wave finishes.

- **Finished:**
  - the project skeleton
  - the chat engine's core logic
  - the Agent Hydra link (accounts, other chats, active CliMayte workers)
  - git status and diff
  - the window shell with the status sidebar
  - the CliMayte panel and the "Elsewhere" list
  - the composer
  - the diff pane, settings and accounts popover
  - the launcher (a "Hydra Desk" icon is already on your desktop; I haven't opened it yet)
- **Still building:** the live chat runtime and the transcript view. The chat manager waits on the runtime.
- **Queued behind those:** the real-account test of the engine, and the real-window test.

**1-to-1 with Claude Desktop:** my first look was only rough measurements from a few small screenshots. I've sent a worker to take exact measurements from your running Claude Desktop, read-only. It will gather full-resolution screenshots of each part, every color, size, font and label, and the exact items in each menu. It will not type, send or delete anything, and it puts your selected chat back where it was.

The window's visual match is judged against those measurements. Once the first build is verified, I'll run a second pass that puts the two apps side by side and fixes every difference. After that we improve on it, starting with the working/needs-you status that Claude Desktop hides.

### What I did

Checked the wave (10 of 14 pieces committed, 2 building, the rest queued) and started a read-only measurement of the real Claude Desktop so the copy is exact.

### Am I 100% done?

No. The build is still running and nothing is verified yet. Next I check the proof on each piece, run the full test and build, and open the window to compare it with Claude Desktop.

### Do I recommend anything else?

Nothing right now.`

/** whole-window.png: the end of the previous turn, a short user message, three folded tool runs between replies. */
export function harvestItems(): TranscriptItem[] {
  return [
    say('ha0', HARVEST_BEFORE),
    user('hu', 'how we looking and rmeovber I want to to have basicly a 1-1 claude cde desktop ui as there is clean we can imprive from ther'),
    tool('hb1', 'Bash', { command: 'git log --oneline -14' }),
    tool('hm1', 'mcp__agenthydra__climayte_status', {}),
    say('ha1', "10 of 14 pieces are already committed, and I'm keeping your 1-1 requirement in mind. Now grabbing real, high-resolution screenshots of the live Claude Code Desktop so the workers can copy the actual UI instead of rough measurements."),
    tool('hb2', 'Bash', { command: 'powershell -File shot.ps1' }),
    tool('hb3', 'Bash', { command: 'powershell -File shot.ps1 -Half' }),
    tool('hb4', 'Bash', { command: 'ls tmp' }),
    tool('hr1', 'Read', { file_path: 'C:/Users/jacob/Desktop/Project/Agent Hydra/desk/tmp/screen-half.png' }),
    say('ha2', "I'm extracting the real Claude Desktop's exact measurements—colors, spacing, fonts, labels—read-only, so the replica matches 1-to-1 instead of using approximations. I'll pass that data to a CliMayte worker while the build wave continues."),
    tool('hm2', 'mcp__agenthydra__climayte_run', { tasks: [] }),
    say('ha3', HARVEST_LIST)
  ]
}

export const WINDOW_GIT = { branch: 'main', added: 15832, removed: 4769 }
export const HARVEST_GIT = { branch: 'main', added: 13658, removed: 4852 }
export const WINDOW_DRAFT = 'stay on plan logins'
export const HARVEST_DRAFT = 'how we looking'
export const CWD = C
