import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temps: string[] = []

export function tempDir(prefix = 'desk-git-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

export function cleanTemps(): void {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
}

process.on('exit', cleanTemps)

/** Runs git synchronously in cwd for test setup; throws with stderr on failure. */
export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString()}`)
  return r.stdout.toString()
}

/** A fresh repo on branch main with a test identity and no signing. */
export function initRepo(dir = tempDir()): string {
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Desk Test')
  git(dir, 'config', 'user.email', 'desk@test.invalid')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'core.autocrlf', 'false')
  return dir
}

export function commitAll(dir: string, msg = 'c'): void {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '--no-verify', '-m', msg)
}
