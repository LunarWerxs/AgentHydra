import { describe, expect, test } from 'bun:test'
import type { TranscriptItem } from '@shared/protocol'
import { groupRows, tasksLine, toolSummary, workflowDots, workflowElapsed, type TaskItem, type ToolItem } from '../../src/components/transcript/lib/groups'
import { CODE_CAP_LINES, createMarkdown, markDiffLines, renderMarkdown } from '../../src/components/transcript/lib/markdown'
import { fileBadge, formatSize, imageSrc } from '../../src/components/transcript/lib/media'

const tool = (id: string, name = 'Bash'): ToolItem => ({ id, ts: 1, kind: 'tool_use', name, input: {}, status: 'done', startedAt: 1 })
const user = (id: string): TranscriptItem => ({ id, ts: 1, kind: 'user', text: 'hi' })
const text = (id: string): TranscriptItem => ({ id, ts: 1, kind: 'assistant_text', text: 'ok' })
const task = (id: string, taskKind: TaskItem['taskKind'], status: TaskItem['status'] = 'completed', extra: Partial<TaskItem> = {}): TaskItem => ({
  id: `task:${id}`,
  ts: 1_000,
  kind: 'task',
  taskId: id,
  description: id,
  status,
  taskKind,
  ...extra,
})

describe('background tasks in the flow', () => {
  test('settled tasks after the text fold into one line; running ones are left to the running-tasks row', () => {
    const rows = groupRows([user('u'), text('t'), task('b1', 'bash'), task('b2', 'bash'), task('b3', 'bash', 'running'), task('a1', 'agent')])
    expect(rows.map((r) => r.id)).toEqual(['u', 't', 'tasks:task:b1'])
    const r = rows[2]
    expect(r.kind === 'tasks' && r.items.map((i) => i.taskId)).toEqual(['b1', 'b2', 'a1'])
    expect(r.kind === 'tasks' && tasksLine(r.items)).toBe('2 background commands and 1 agent completed')
  })

  test('a task that settles inside a tool run joins it: "finished 2 background tasks"', () => {
    const rows = groupRows([user('u'), tool('a'), task('b1', 'bash'), tool('b'), task('b2', 'bash', 'failed'), text('t')])
    expect(rows.map((r) => r.id)).toEqual(['u', 'tools:a', 't'])
    const r = rows[1]
    if (r.kind !== 'tools') throw new Error('expected a tool run')
    const s = toolSummary(r.items, null, r.tasks)
    expect(s.phrases.map((p) => [p.text, p.after].filter(Boolean).join(' ')).join(', ')).toBe('Ran 2 commands, finished 2 background tasks (1 failed)')
  })

  test('a running workflow is a card; a settled one stays a card in the last turn, folds into the line before it', () => {
    const wf = task('w', 'workflow', 'running', { agents: 3 })
    expect(groupRows([user('u'), wf]).map((r) => r.kind)).toEqual(['item', 'item'])
    const done = task('w', 'workflow', 'completed', { agents: 3 })
    expect(groupRows([user('u'), done]).map((r) => r.kind)).toEqual(['item', 'item'])
    const rows = groupRows([user('u'), done, user('u2')])
    expect(rows.map((r) => r.kind)).toEqual(['item', 'tasks', 'item'])
    expect(rows[1].kind === 'tasks' && tasksLine(rows[1].items)).toBe('1 workflow completed')
  })

  test('the line is singular for one', () => {
    expect(tasksLine([task('b', 'bash')])).toBe('1 background command completed')
    expect(tasksLine([task('x', undefined)])).toBe('1 background task completed')
  })

  test('workflow squares and time', () => {
    expect(workflowDots(task('w', 'workflow', 'running', { agents: 3 }))).toEqual(['running', 'running', 'running'])
    expect(workflowDots(task('w', 'workflow', 'failed', { agents: 2 }))).toEqual(['done', 'failed'])
    expect(workflowDots(task('w', 'workflow', 'stopped'))).toEqual(['pending', 'pending', 'pending'])
    expect(workflowElapsed(task('w', 'workflow', 'running'), 1_000 + 660_000)).toBe('11m 00s')
    expect(workflowElapsed(task('w', 'workflow', 'completed', { durationMs: 66_000 }), 0)).toBe('1m 06s')
  })

  test('a handed-over file keeps its own row', () => {
    expect(groupRows([tool('a'), tool('f', 'SendUserFile'), tool('b')]).map((r) => r.id)).toEqual(['tools:a', 'f', 'tools:b'])
  })
})

describe('pictures and file cards', () => {
  test('only cache urls and pictures the window sent load', () => {
    expect(imageSrc({ mediaType: 'image/png', url: `/api/media/${'a'.repeat(64)}.png` })).toBe(`/api/media/${'a'.repeat(64)}.png`)
    expect(imageSrc({ mediaType: 'image/png', dataBase64: 'AAAA' })).toBe('data:image/png;base64,AAAA')
    expect(imageSrc({ mediaType: 'image/svg+xml', dataBase64: 'AAAA' })).toBeNull()
    expect(imageSrc({ mediaType: 'image/png', url: 'https://evil.example/x.png' })).toBeNull()
    expect(imageSrc({ mediaType: 'text/markdown', name: 'a.md', bytes: 3 })).toBeNull()
  })

  test('the card badge and size read like the real one', () => {
    expect(fileBadge({ mediaType: 'image/png', name: 'live-round1.png' })).toBe('PNG')
    expect(fileBadge({ mediaType: 'image/svg+xml' })).toBe('SVG')
    expect(formatSize(68_813)).toBe('67.2KB')
    expect(formatSize(812)).toBe('812B')
    expect(formatSize(1_468_006)).toBe('1.4MB')
  })
})

describe('markdown as Claude Code draws it', () => {
  test('headings go one level down ("## What I did" is an h3)', () => {
    expect(renderMarkdown('## What I did')).toBe('<h3>What I did</h3>\n')
    expect(renderMarkdown('# Title')).toBe('<h2>Title</h2>\n')
    expect(renderMarkdown('###### six')).toBe('<h6>six</h6>\n')
  })

  test('tables scroll in their own box', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(html.startsWith('<div class="md-table"><table>')).toBe(true)
    expect(html).toMatch(/<\/table>\s*<\/div>\s*$/)
  })

  test('the code block header has a Copy button that can say Copied, and long blocks are capped', () => {
    const short = renderMarkdown('```bash\nbun test\n```')
    expect(short).toContain('Copy</span>')
    expect(short).toContain('Copied</span>')
    expect(short).not.toContain('md-code-long')
    const long = renderMarkdown('```ts\n' + Array.from({ length: CODE_CAP_LINES + 1 }, (_, i) => `const a${i} = ${i}`).join('\n') + '\n```')
    expect(long).toContain('md-code md-code-long')
    expect(long).toContain('data-more')
  })

  test('diff fences mark added, removed and hunk lines, with or without a highlighter', () => {
    const code = '@@ -1 +1 @@\n-old\n+new\n same'
    const plain = renderMarkdown('```diff\n' + code + '\n```')
    expect(plain).toContain('<span class="line diff-hunk">@@ -1 +1 @@</span>')
    expect(plain).toContain('<span class="line diff-del">-old</span>')
    expect(plain).toContain('<span class="line diff-add">+new</span>')
    expect(plain).toContain('<span class="line"> same</span>')
    const md = createMarkdown(() => (c, lang) => (lang === 'diff' ? `<pre class="shiki"><code>${c.split('\n').map((l) => `<span class="line"><span>${l}</span></span>`).join('\n')}</code></pre>` : null))
    expect(md.render('```diff\n' + code + '\n```')).toContain('<span class="line diff-add"><span>+new</span></span>')
    expect(markDiffLines('<span class="line">+++ b/x</span>', '+++ b/x')).toBe('<span class="line">+++ b/x</span>')
  })

  test('a cached picture renders and zooms; a local path or remote image is a chip and never loads', () => {
    const url = `/api/media/${'b'.repeat(64)}.png`
    const cached = renderMarkdown(`![shot](${url})`)
    expect(cached).toContain(`<button type="button" class="md-img" data-zoom="${url}"`)
    expect(cached).toContain(`<img src="${url}" alt="shot" loading="lazy">`)
    const local = renderMarkdown('![after](C:/Users/jacob/shots/after.png)')
    expect(local).toContain('class="md-file-chip"')
    expect(local).not.toContain('<img')
    const remote = renderMarkdown('![x](https://example.com/x.png)')
    expect(remote).not.toContain('<img')
    expect(renderMarkdown(`![x](/api/media/../../settings.json)`)).not.toContain('<img')
  })
})
