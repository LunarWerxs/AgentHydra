import { expect, test } from 'bun:test'
import { type AhCloudRow, toCloudSession } from '../../src/bridge/cloud'

// AgentHydra's session `cwd` can be a subfolder a long session moved into (it reads only a long
// transcript's last 12 MB); its `project` is Claude Code's slug of the folder it started in, the one
// Claude Desktop and Desk's desk list file the chat under. The cloud list must file it there too, or
// turning the cloud on moves the chat to another group.
const row = (cwd: string | null, project?: string): AhCloudRow => ({
  session_id: 's-1',
  title: 'A chat',
  cwd,
  source: 'claude',
  instance: null,
  last_activity_at: 1,
  created_at: null,
  message_count: 2,
  ...(project === undefined ? {} : { project }),
})

test('toCloudSession files a session under the folder it started in, keeping where it works now beside it', () => {
  expect(toCloudSession(row('D:\\Work\\active\\proj\\proj-private', 'D--Work'))).toMatchObject({
    cwd: 'D:\\Work',
    lastCwd: 'D:\\Work\\active\\proj\\proj-private',
  })
  expect(toCloudSession(row('D:\\Work', 'D--Work'))).toMatchObject({ cwd: 'D:\\Work', lastCwd: null })
  // Windows folders ignore case: a transcript may spell the drive differently from the project's slug.
  expect(toCloudSession(row('d:\\Work\\notes', 'D--Work'))).toMatchObject({ cwd: 'd:\\Work', lastCwd: 'd:\\Work\\notes' })
  // The other PC's chats can carry its own kind of path.
  expect(toCloudSession(row('/Users/me/site/docs', '-Users-me-site'))).toMatchObject({ cwd: '/Users/me/site', lastCwd: '/Users/me/site/docs' })
})

test('toCloudSession keeps the cwd as it is when no folder above it matches the project, or there is none', () => {
  // Claude Code shortens and hashes a very long slug: nothing matches it.
  expect(toCloudSession(row('D:\\Work\\notes', 'D--Work-notes-1a2b3c'))).toMatchObject({ cwd: 'D:\\Work\\notes', lastCwd: null })
  expect(toCloudSession(row('D:\\Work\\notes'))).toMatchObject({ cwd: 'D:\\Work\\notes', lastCwd: null })
  expect(toCloudSession(row(null, 'D--Work'))).toMatchObject({ cwd: null, lastCwd: null })
})
