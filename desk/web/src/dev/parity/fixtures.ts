// What the real captures in docs/reference/real show, as Hydra Desk data: sidebar rows with their dot
// states, transcripts of the same shape (invented words), the repo strip numbers and the composer draft. Times hang off
// PARITY_NOW so every render is identical.
import type { AccountInfo, ChatStatus, ChatSummary, TranscriptItem } from '@shared/protocol'
import { PARITY_NOW } from './clock'

const MIN = 60_000
const C = 'C:/Users/me/Desktop/Project/connections'
const N = 'C:/Users/me/Desktop/nexuscode-2d'
const P = 'C:/Users/me/Desktop/audio-lab'

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
    ['nvw', 'Native vs web design trade-offs', C, 'working'],
    ['cfn', 'Cloud function teardown and leftovers', C, 'working'],
    ['mkt', 'Plugin marketplace onboarding UX review', C, 'idle', { unread: true }],
    ['ccd', 'Desktop client rewrite plan', C, 'idle'],
    ['store', 'Storefront landing page review', C, 'needs_you'],
    ['usb', 'Unified settings and billing consolidation plan', C, 'idle'],
    ['sui', 'Screen UI polish', N, 'working'],
    ['game', 'Game store resubmission readiness', N, 'needs_you'],
    ['stem', 'Audio stem isolation model', P, 'idle']
  ])

/** user/sidebar-crop.png: a later moment of the same window, with its own order and states. */
export const sidebarUserChats = (): ChatSummary[] =>
  chats([
    ['ahs', 'Agent Hydra subprocess issue', C, 'working'],
    ['mkt', 'Plugin marketplace onboarding UX review', C, 'working'],
    ['ccd', 'Desktop client rewrite plan', C, 'working'],
    ['nvw', 'Native vs web design trade-offs', C, 'working'],
    ['cfn', 'Cloud function teardown and leftovers', C, 'working'],
    ['store', 'Storefront landing page review', C, 'needs_you'],
    ['usb', 'Unified settings and billing consolidation plan', C, 'idle'],
    ['sui', 'Screen UI polish', N, 'working'],
    ['game', 'Game store resubmission readiness', N, 'needs_you'],
    ['stem', 'Audio stem isolation model', P, 'idle']
  ])

/** whole-window.png, sidebar.png and the composer/menu captures taken with it. */
export const harvestChats = (): ChatSummary[] =>
  chats([
    ['pc', 'Slow build investigation', C, 'working'],
    ['ccd', 'Desktop client rewrite plan', C, 'idle'],
    ['usb', 'Unified settings and billing consolidation plan', C, 'idle'],
    ['nvw', 'Native vs web design trade-offs', C, 'idle'],
    ['mkt', 'Plugin marketplace onboarding UX review', C, 'idle'],
    ['game', 'Game store resubmission readiness', N, 'idle', { unread: true }],
    ['stem', 'Audio stem isolation model', P, 'working']
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

/** The accounts of ours-accounts-popup.png (42 accounts, cut to 14), in AgentHydra's order, not sorted. */
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

// The window's long user message and its reply. The words are invented (this repo is public, so no
// real chat goes in it); they keep the reference's length and shape: a run-on message that folds, then
// a reply with bold lead-ins, a list, three '###' headings and a closing NEED line.
const WINDOW_USER =
  "Quick check before we go further: is our copy up to date with the main repo, and did anyone already build this somewhere else? And how does the scheduler choose an account, " +
  "is it actually smart about it? It feels like it keeps stacking jobs on the smallest plan even when three are already running there, and those small plans run out in no time " +
  "while the bigger plans sit mostly idle. Shouldn't it look at plan size first and send heavy jobs to the account with the most room? " +
  "And if it's a 5x or a 20x, shouldn't that count for more? Please make sure plan size and what is already running both go into the choice, so " +
  "we switch accounts less often and waste less of the quota we pay for. So basically: read the plan size and the current load before it picks. " +
  'And what did you mean earlier by subscription logins?'

const WINDOW_REPLY = `Yes, the copy is now up to date, and nobody had built this elsewhere. The checkout was 110 commits behind. It's caught up now, with nothing behind and nothing ahead. Those 110 commits are speed, analytics and usage-tracking work, and none is a desktop app. My first answer was checked against the stale copy, so I checked again, and it still holds.

**The old manager:** there was an earlier wave manager for workers, and that is the one that kept failing. This app is not a copy of it, and I've stopped using it.

**Does the scheduler weigh accounts?** Yes, it already does what you describe:

- A Max 5x counts as 5 Pros and a Max 20x as 20.
- It counts the workers already running on an account.
- It caps workers per account, 4 per Pro window scaled by plan, and 2 for a group on a Pro.
- It skips accounts someone is using and follows each account's weekly pace.

**The weak spot was this app's own picker.** It only looked at the lowest 5-hour usage. It ignored plan size and how many chats were already on an account. A worker is fixing that now to follow the scheduler's rules, with chat caps of 1 on a Pro, 5 on a Max 5x and 20 on a Max 20x.

**Why there are still lots of moves:** most of the accounts are small and only two are big, one Max 20x and one Max 5x. Pro windows are tiny, so heavy work on a Pro runs out in minutes.

**What "subscription logins" means:**

- To talk to Claude, a program has to sign in. A Pro or Max plan is one kind of sign-in. The other option is an API key, a separate pay-per-use key from the developer console.
- This app uses plan sign-ins, the same way the desktop app does, so it costs nothing extra.
- The developer kit's terms ask apps built on it to use an API key, not plan sign-ins. For a personal tool that is a grey area, and the risk is an account being flagged.
- Stay on plan sign-ins, or move to an API key?

**Faster from here:** no manager layer (done), and each next piece starts the moment one lands. Tasks stay small enough to finish on one account. A fresh chat per task also helps, because this one is long.

### What I did

- Brought the checkout up to date and checked it again.
- Read how the scheduler places work.
- Found the weak picker in this app and started a worker to fix it.
- Answered the login question in plain English.

### Am I 100% done?

No. Four workers are running: three on the visual match, one on the picker fix. Nothing has reported back yet.

### Do I recommend anything else?

Stay on plan sign-ins for now. It's easy to change later.

🔴 NEED: Say "stay" or "API key." The live-chat test waits on that answer.`

/** user/window.webp: the collapsed long user message, one folded tool run, the formatted reply. */
export function windowItems(): TranscriptItem[] {
  const bash = Array.from({ length: 9 }, (_, i) => tool(`wb${i}`, 'Bash', { command: `git -C ../.. log --oneline -${i + 1}` }, i === 4))
  return [
    user('wu', WINDOW_USER),
    ...bash.slice(0, 3),
    tool('wg1', 'Grep', { pattern: 'pickAccount' }),
    tool('wg2', 'Grep', { pattern: 'planWeight' }),
    tool('wr', 'Read', { file_path: 'C:/Users/me/Desktop/Project/Agent Hydra/src/climayte/index.ts' }),
    ...bash.slice(3),
    tool('wm1', 'mcp__agenthydra__list_usage', {}),
    tool('wm2', 'mcp__agenthydra__climayte_status', {}),
    say('wa', WINDOW_REPLY)
  ]
}

const HARVEST_BEFORE = `The shell, the sidebar and the composer come next. After that I build, run the full check, and open the window to prove it.

### Do I recommend anything else?

Nothing right now.`

const HARVEST_LIST = `Pieces are landing quickly: 10 of the 14 are committed, but none is verified yet. I'll check each one when the wave finishes.

- **Finished:**
  - the project skeleton
  - the chat engine's core logic
  - the link to the account manager (accounts, other chats, active workers)
  - git status and diff
  - the window shell with the status sidebar
  - the worker panel and the "Elsewhere" list
  - the composer
  - the diff pane, settings and accounts popover
  - the launcher (its desktop icon is in place; I haven't opened it yet)
- **Still building:** the live chat runtime and the transcript view. The chat manager waits on the runtime.
- **Queued behind those:** the real-account test of the engine, and the real-window test.

**Matching the desktop app:** my first pass used rough measurements from a few small screenshots. A worker is now taking exact measurements from the running desktop app, read-only: full-resolution screenshots of each part, every color, size, font and label, and the exact items in each menu. It will not type, send or delete anything, and it leaves the selected chat where it was.

The visual match is judged against those measurements. Once the first build is verified, a second pass puts the two apps side by side and fixes every difference. After that we improve on it, starting with the working/needs-you status the desktop app hides.

### What I did

Checked the wave (10 of 14 pieces committed, 2 building, the rest queued) and started a read-only measurement of the desktop app so the copy is exact.

### Am I 100% done?

No. The build is still running and nothing is verified yet. Next I check the proof on each piece, run the full test and build, and open the window to compare the two.

### Do I recommend anything else?

Nothing right now.`

/** whole-window.png: the end of the previous turn, a short user message, three folded tool runs between replies. */
export function harvestItems(): TranscriptItem[] {
  return [
    say('ha0', HARVEST_BEFORE),
    user('hu', 'how is it going? remember the goal: a 1-to-1 copy of the desktop UI first, then we improve on it'),
    tool('hb1', 'Bash', { command: 'git log --oneline -14' }),
    tool('hm1', 'mcp__agenthydra__climayte_status', {}),
    say('ha1', "10 of 14 pieces are committed, and the 1-to-1 goal stands. Next I take high-resolution screenshots of the running desktop app so the workers copy the real UI instead of rough measurements."),
    tool('hb2', 'Bash', { command: 'powershell -File shot.ps1' }),
    tool('hb3', 'Bash', { command: 'powershell -File shot.ps1 -Half' }),
    tool('hb4', 'Bash', { command: 'ls tmp' }),
    tool('hr1', 'Read', { file_path: 'C:/Users/me/Desktop/Project/Agent Hydra/desk/tmp/screen-half.png' }),
    say('ha2', "Now measuring the desktop app exactly (colors, spacing, fonts, labels), read-only, so the copy matches 1-to-1 instead of approximately. A worker gets that data while the build wave continues."),
    tool('hm2', 'mcp__agenthydra__climayte_run', { tasks: [] }),
    say('ha3', HARVEST_LIST)
  ]
}

export const WINDOW_GIT = { branch: 'main', added: 15832, removed: 4769 }
export const HARVEST_GIT = { branch: 'main', added: 13658, removed: 4852 }
export const WINDOW_DRAFT = 'stay on plan logins'
export const HARVEST_DRAFT = 'how is it going'
export const CWD = C
