// The transcript-markdown scene: user/real-markdown-and-file-card.png in shape, with invented words - a SendUserFile
// with its caption and file card, the answer with bold lead-in bullets and '##' headings, 18 settled
// background commands, and one still running (the running-tasks row under the last message).
import type { TranscriptItem } from '@shared/protocol'
import { PARITY_NOW } from './clock'

// A 1x1 PNG: the real picture above the caption is outside the compared region.
const DOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const ANSWER = `It now looks like the desktop app. I sent a screenshot of the live window with sample chats in it. A few things on it are still off, and a second round to fix them has started.

**What’s done:**

- **Sidebar and chat list.** The sidebar is the project-grouped chat list with status dots, plus New, Projects, Artifacts, Customize and More. It collapses with the toggle and Ctrl+B.
- **Chat view and composer.** The chat view, composer and menus were matched against reference screenshots, and side by side they line up to within a pixel. What differs now is mostly the reference app’s private font, which can’t be copied.
- **Checks.** The tests, typecheck and build all pass: 330 tests, typecheck exit 0, build exit 0.

**What round 2 is fixing now (visible in the screenshot):**

- **Account picker.** It shows an email address. It will show only "#128 · Pro", and never an email anywhere.
- **Icon on every row.** Each outside-chat row has an icon the reference doesn’t have. It’s coming off.
- **New-session screen.** The reference has pills for Local, the folder, the branch and "worktree," plus a tip banner above the box. The stats card should show real numbers, and the model should show a real name instead of "Default."
- **Approval cards.** The reference shows permission, question and plan requests above the composer. Ours puts them in the chat.
- **Smaller fixes.** Custom hover tooltips and the menu shadows.
- **Re-check.** Afterwards, a fresh critic re-checks everything on a new build.

**Not building:** the reference’s Routines, Ultracode level, "What’s new" and Send feedback. Hydra Desk has no feature behind them, and fake ones would only mislead.

The Hydra Desk server had stopped, so I restarted it. If the window shows an error, close it and reopen it from the desktop shortcut.

## What I did

Finished round 1 and checked it. Sent the live screenshot and started round 2 on the critics’ findings.

## Am I 100% done?

No. Round 2 is running and its results aren’t in yet.

## Do I recommend anything else?

Nothing. The next screenshot comes when round 2 is done and checked.`

export function markdownSceneItems(): TranscriptItem[] {
  const t = PARITY_NOW - 20 * 60_000
  const items: TranscriptItem[] = [
    { id: 'mu', ts: t, kind: 'user', text: 'how does it look now?' },
    {
      id: 'mf',
      ts: t + 1000,
      kind: 'tool_use',
      name: 'SendUserFile',
      input: {
        files: ['C:\\Users\\me\\Desktop\\Project\\Agent Hydra\\desk\\docs\\screens\\live-round1.png'],
        caption:
          'Hydra Desk right now, live with sample chats. Round 2 is fixing the visible leftovers: the email in the account picker, the icon on every row, the zero stats, and the new-session pills and tip.',
        display: 'render',
      },
      status: 'done',
      startedAt: t + 1000,
      endedAt: t + 1200,
      result: {
        text: 'Sent 1 file',
        isError: false,
        images: [{ mediaType: 'image/png', name: 'live-round1.png', bytes: 68_813, dataBase64: DOT }],
      },
    },
    { id: 'ma', ts: t + 2000, kind: 'assistant_text', text: ANSWER },
  ]
  for (let i = 0; i < 18; i++) {
    items.push({
      id: `task:b${i}`,
      ts: t + 3000 + i,
      kind: 'task',
      taskId: `b${i}`,
      description: `bun test ./web/test/part-${i}.test.ts`,
      status: 'completed',
      summary: `Background command "bun test ./web/test/part-${i}.test.ts" completed (exit code 0)`,
      taskKind: 'bash',
    })
  }
  items.push({
    id: 'task:wf',
    ts: t + 5000,
    kind: 'task',
    taskId: 'wf',
    description: 'bun run parity all',
    status: 'running',
    taskKind: 'bash',
  })
  return items
}

/** The gallery's long markdown sample: every block the transcript styles, in one answer. */
export const MARKDOWN_GALLERY = `# Round 3 review

The transcript now reads a session's own \`.jsonl\`, so **newlines, lists and code fences** survive. See [the parity notes](https://example.com/parity) for the method.

## What changed

1. Injected user text goes through one classifier.
2. Pictures are cached by hash and served by \`/api/media/<sha256>.<ext>\`.
3. Markdown and code look like the real app:
   - headings one level down
   - lists with the real indent

### Numbers

| Area | Files | Tests | Notes |
|---|---:|---:|---|
| Classifier | 2 | 23 | \`<task-notification>\`, reminders, commands |
| Media cache | 2 | 9 | hash lookup only, \`nosniff\` |
| Markdown | 4 | 6 | tables, fences, diff, images |

> The real app's code block was never on screen to measure, so its look follows the tokens.

---

\`\`\`ts
import { createMediaCache } from './media/cache'

export function cacheOf(home: string) {
  const cache = createMediaCache(join(home, 'media'))
  return cache.lookup('0'.repeat(64) + '.png') // null: only real entries are served
}
\`\`\`

\`\`\`json
{ "id": "w5ahe9hto", "status": "completed", "taskKind": "workflow", "agents": 3, "tokens": 539600 }
\`\`\`

\`\`\`diff
@@ -1,4 +1,5 @@
 import { ref } from 'vue'
-const open = ref(false)
+const open = ref(true)
+const width = ref(288)
 export { open }
\`\`\`

\`\`\`bash
cd "C:/Users/me/Desktop/Project/Agent Hydra/desk" && bun test ./server/test/engine/system-text.test.ts ./server/test/media/media.test.ts ./web/test/transcript/tasks-media.test.ts
\`\`\`

\`\`\`ts
${Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1} // a long block is capped with Show more`).join('\n')}
\`\`\`

#### Small heading

Inline \`code\`, **bold**, *italic* and a final paragraph.`

/** The gallery's section: a user message with a picture, a running workflow, the long sample, the scene's answer, file card and tasks. */
export function markdownGalleryItems(): TranscriptItem[] {
  const t = PARITY_NOW - 30 * 60_000
  return [
    {
      id: 'gu',
      ts: t,
      kind: 'user',
      text: 'here is the screenshot, make ours look like this',
      images: [{ mediaType: 'image/png', name: 'real.png', dataBase64: DOT }, { mediaType: 'image/png', name: 'history-only.png' }],
    },
    {
      id: 'task:gw',
      ts: PARITY_NOW - 660_000,
      kind: 'task',
      taskId: 'gw',
      description: 'hydra-desk-parity-round2',
      status: 'running',
      taskKind: 'workflow',
      agents: 3,
    },
    { id: 'ga', ts: t + 1000, kind: 'assistant_text', text: MARKDOWN_GALLERY },
    {
      id: 'gr',
      ts: t + 2000,
      kind: 'tool_use',
      name: 'Read',
      input: { file_path: 'C:/Users/me/Desktop/Project/Agent Hydra/desk/docs/screens/side.png' },
      status: 'done',
      startedAt: t + 2000,
      endedAt: t + 2100,
      result: { text: '[image]', isError: false, images: [{ mediaType: 'image/png', name: 'side.png', dataBase64: DOT }] },
    },
    { id: 'gt', ts: t + 3000, kind: 'task', taskId: 'gt', description: 'bun test', status: 'completed', taskKind: 'bash' },
    ...markdownSceneItems(),
  ]
}
