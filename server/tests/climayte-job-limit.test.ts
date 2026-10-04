// A worker's job (climayte-job.ts) can hold a ceiling on how many processes the worker has alive at
// once, so one runaway worker (a self-calling shell function started about 3,000 processes on
// 2026-10-03 and froze the desktop) cannot take the machine with it, and it reports how many it had.
// Run in a child process: containWorker puts the calling process in the job.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const JOB = join(import.meta.dir, '../src/climayte-job.ts').replace(/\\/g, '/')

/** Start `want` idle children inside a worker job with this ceiling; what survived and what the job counts. */
async function run(ceiling: number | null, want: number) {
  const dir = mkdtempSync(join(tmpdir(), 'ah-job-'))
  dirs.push(dir)
  const script = join(dir, 'job.ts')
  writeFileSync(
    script,
    `import { containWorker } from '${JOB}'
const job = containWorker(${ceiling === null ? '' : ceiling})
const kids: ReturnType<typeof Bun.spawn>[] = []
let refused = 0
for (let i = 0; i < ${want}; i++) {
  try {
    kids.push(Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 6000)'], { stdout: 'ignore', stderr: 'ignore' }))
  } catch {
    refused++
  }
}
await Bun.sleep(1500)
const alive = kids.filter((k) => k.exitCode === null && k.signalCode === null).length
console.log(JSON.stringify({ job: !!job, alive, refused, active: job?.active() ?? -1 }))
for (const k of kids) k.kill()
process.exit(0)
`,
  )
  const p = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  await p.exited
  return JSON.parse(out.trim().split('\n').pop() as string) as {
    job: boolean
    alive: number
    refused: number
    active: number
  }
}

describe.skipIf(process.platform !== 'win32')('containWorker process ceiling', () => {
  test('without a ceiling every child runs, and the job counts them (and the runner itself)', async () => {
    const r = await run(null, 12)
    expect(r.job).toBe(true)
    expect(r.alive).toBe(12)
    expect(r.refused).toBe(0)
    expect(r.active).toBeGreaterThanOrEqual(13)
  }, 60_000)

  test('with a ceiling the worker never has more processes alive than it, and the rest are refused', async () => {
    const r = await run(6, 12)
    expect(r.job).toBe(true)
    expect(r.alive).toBeLessThan(12)
    expect(r.active).toBeLessThanOrEqual(6)
  }, 60_000)
})
