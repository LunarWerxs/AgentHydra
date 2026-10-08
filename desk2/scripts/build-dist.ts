// `bun run build` of web/ and hydra/ (run in that app's folder): vite builds into a folder of its own, and only a build that
// finished takes the place of dist/. web/dist and hydra/dist are what the running window serves, and vite empties its outDir
// before it starts: a build that failed on another session's half-made edit blanked /ah/ for ten minutes (2026-10-07).
// Each run has its own folder (dist.next-<pid>), so two sessions building at once never write into one. A build whose
// templates use a class its CSS has no rule for is refused the same way (dead-classes.ts).

import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { deadClasses } from './dead-classes'

const app = process.cwd()
const live = join(app, 'dist')
const next = join(app, `dist.next-${process.pid}`)
const old = join(app, `dist.old-${process.pid}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Windows refuses to rename a folder while the server is sending a file from it: try again for a few seconds. */
async function rename(from: string, to: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      if (tries >= 50) throw err
      await sleep(100)
    }
  }
}

const built = Bun.spawnSync([process.execPath, 'run', 'vite', 'build', '--outDir', next, '--emptyOutDir'], { cwd: app, stdio: ['inherit', 'inherit', 'inherit'] })
if (built.exitCode !== 0 || !existsSync(join(next, 'index.html'))) {
  rmSync(next, { recursive: true, force: true })
  console.error(`build failed: ${live} was left as it was`)
  process.exit(built.exitCode || 1)
}
const dead = deadClasses(join(app, 'src'), next)
if (dead.length) {
  rmSync(next, { recursive: true, force: true })
  const list = dead.map((d) => `  ${relative(app, d.file)}: ${d.cls}`).join('\n')
  console.error(`build failed: these classes have no CSS rule, so they do nothing:\n${list}\n${live} was left as it was`)
  process.exit(1)
}
if (existsSync(live)) await rename(live, old)
try {
  await rename(next, live)
} catch (err) {
  await rename(old, live)
  rmSync(next, { recursive: true, force: true })
  throw err
}
rmSync(old, { recursive: true, force: true })
/** A run killed part way leaves its folders behind; another run still building keeps its own. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
for (const name of readdirSync(app)) {
  const pid = /^dist\.(?:next|old)-(\d+)$/.exec(name)?.[1]
  if (pid && !alive(Number(pid))) rmSync(join(app, name), { recursive: true, force: true })
}
