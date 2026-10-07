// The CreAitor, when this machine has it: a local tool that answers an agent's question the way the owner would, from
// the owner's own past decisions, and says when only the owner can answer. Desk runs it as a hidden child process;
// the question never leaves the machine through Desk. HYDRA_DESK_CREAITOR names the tool, HYDRA_DESK_PYTHON the
// interpreter that runs it.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { CreaitorAnswer } from '@shared/orchestrator'

/** The CreAitor's ask itself waits up to this long for its model; the child gets a little more. */
const ASK_TIMEOUT_S = 45

/** The tool's path, or null when this machine does not have it. */
export function creaitorTool(): string | null {
  const p = process.env.HYDRA_DESK_CREAITOR || join(homedir(), '.claude', 'tools', 'creaitor', 'creaitor.py')
  return existsSync(p) ? p : null
}

/** One question, its choices, the chat's folder (its name is the repo the CreAitor weighs). Never throws. */
export function askCreaitor(tool: string, question: string, options: readonly string[], cwd: string): Promise<CreaitorAnswer | { error: string }> {
  const args = [tool, 'ask', question, '--repo', basename(cwd.replace(/[\\/]+$/, '')), '--timeout', String(ASK_TIMEOUT_S), '--json']
  for (const o of options) args.push('--option', o)
  return new Promise((resolve) => {
    execFile(
      process.env.HYDRA_DESK_PYTHON || 'python',
      args,
      { windowsHide: true, timeout: (ASK_TIMEOUT_S + 15) * 1000, maxBuffer: 1 << 20, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } },
      (err, stdout) => {
        try {
          const r = JSON.parse(stdout) as Record<string, unknown>
          const verdict = r.verdict === 'decide' || r.verdict === 'reversible' ? r.verdict : 'escalate'
          resolve({
            verdict,
            answer: typeof r.answer === 'string' ? r.answer : '',
            option: typeof r.option === 'string' ? r.option : '',
            confidence: typeof r.confidence === 'number' ? r.confidence : 0,
            basis: Array.isArray(r.basis) ? r.basis.filter((b): b is string => typeof b === 'string') : [],
            needLine: typeof r.need_line === 'string' ? r.need_line : null,
            mode: typeof r.mode === 'string' ? r.mode : 'shadow'
          })
        } catch {
          resolve({ error: err ? (err.killed ? 'the CreAitor ran out of time' : err.message.split('\n')[0].slice(0, 200)) : 'the CreAitor gave no answer' })
        }
      }
    )
  })
}
