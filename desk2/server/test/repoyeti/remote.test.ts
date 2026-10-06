import { expect, test } from 'bun:test'
import { compareUrl, parseGithubRemote, prBranchName } from '../../src/repoyeti/remote'

test('owner and repo come out of https, ssh and scp-like GitHub remotes', () => {
  const want = { owner: 'example-owner', repo: 'example.repo' }
  for (const url of [
    'https://github.com/example-owner/example.repo.git',
    'https://github.com/example-owner/example.repo',
    'https://user@github.com/example-owner/example.repo.git/',
    'git@github.com:example-owner/example.repo.git',
    'ssh://git@github.com/example-owner/example.repo.git',
    'ssh://git@github.com:example-owner/example.repo'
  ]) {
    expect(parseGithubRemote(url)).toEqual(want)
  }
})

test('another host or a local path has no GitHub page', () => {
  for (const url of ['https://gitlab.com/example-owner/x.git', '../bare.git', 'C:/Users/me/bare.git', '']) expect(parseGithubRemote(url)).toBeNull()
})

test('the compare page keeps the branch slashes and encodes the rest', () => {
  expect(compareUrl({ owner: 'example-owner', repo: 'x' }, 'desk/20261006-1230')).toBe('https://github.com/example-owner/x/compare/desk/20261006-1230?expand=1')
  expect(compareUrl({ owner: 'o', repo: 'x' }, 'fix #1/a b')).toBe('https://github.com/o/x/compare/fix%20%231/a%20b?expand=1')
})

test('a branch name for work on the default branch is dated and never repeats a taken one', () => {
  const now = new Date(Date.UTC(2026, 9, 6, 9, 5))
  expect(prBranchName(now, ['main'])).toBe('desk/20261006-0905')
  expect(prBranchName(now, ['desk/20261006-0905'])).toBe('desk/20261006-0905-2')
})
