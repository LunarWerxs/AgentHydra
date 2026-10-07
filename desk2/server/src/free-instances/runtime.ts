import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FreeConfig, FreeProvider } from '@shared/free-instances'
import { isRealHome } from '../real-home'

export interface FreeRuntime {
  ready(): boolean
  config(instanceId: string): FreeConfig
  ensure(provider: FreeProvider): Promise<void>
}

/** zendriver drives the installed Chrome or Edge, so no browser download is needed. */
const PYTHON_PACKAGES = ['requests==2.34.2', 'zendriver==0.17.0']

/** Node's restricted reader cannot follow Bun links into a global package store. */
export function nodeDependenciesReady(directory: string): boolean {
  try {
    const root = realpathSync(directory)
    const packageDir = join(directory, 'node_modules', 'happy-dom')
    for (const file of ['package.json', 'lib/index.js']) {
      const path = relative(root, realpathSync(join(packageDir, file)))
      if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) return false
    }
    return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version === '20.14.5'
  } catch { return false }
}

/** Only this owned process tree is stopped, including a sign-in window it created. */
export function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, shell: false, stdio: 'ignore' })
    killer.on('error', () => child.kill())
  } else child.kill()
}

/** Setup logs stay private; argv is fixed by the runtime, never supplied by a page. */
function setup(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, env, shell: false, windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => { terminate(child); reject(new Error('setup_failed')) }, 600_000)
    child.once('error', () => { clearTimeout(timer); reject(new Error('setup_failed')) })
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('setup_failed')) })
  })
}

/** Setup refused on purpose, with the reason a person reads (any other setup error is a broken install). */
export class SetupRefused extends Error {}

/** Source is bundled with Desk; dependencies and state belong to Desk's data home. */
export class ManagedFreeRuntime implements FreeRuntime {
  private root: string
  private python: string
  private harnessDir = join(dirname(fileURLToPath(import.meta.url)), 'harness')
  private preparing: Promise<void> | null = null
  private prepared = new Set<string>()
  constructor(private home: string) {
    this.root = join(home, 'free', 'runtime')
    this.python = join(this.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  }
  // The marker records the package list: an install made with another one (Camoufox, Playwright) is rebuilt.
  ready(): boolean {
    try { return readFileSync(join(this.root, 'python-ready'), 'utf8') === PYTHON_PACKAGES.join(' ') && existsSync(this.python) }
    catch { return false }
  }
  config(instanceId: string): FreeConfig {
    return { harnessDir: this.harnessDir, python: this.python, stateDir: join(this.home, 'free', 'instances', instanceId), cacheDir: join(this.root, 'cache') }
  }
  async ensure(provider: FreeProvider): Promise<void> {
    // Only the real home's Desk sets it up (real-home.ts): a test's or a probe's would build it in a folder that is thrown away.
    if (!isRealHome(this.home)) throw new SetupRefused('Free accounts run only in AgentHydra’s real home (~/.hydra-desk-2); this AgentHydra runs on another folder.')
    // Concurrent accounts share one dependency installation, never their cookies or locks.
    while (this.preparing) await this.preparing
    if (this.prepared.has(provider)) return
    const task = this.prepare(provider)
    this.preparing = task
    try { await task; this.prepared.add(provider) } finally { if (this.preparing === task) this.preparing = null }
  }
  private async prepare(provider: FreeProvider): Promise<void> {
    mkdirSync(this.root, { recursive: true })
    const c = this.config('setup')
    // The setup run's own state goes to Desk's data home too: without it the harness fell back to a
    // folder beside its code, inside the repo.
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', CLAUDFREE_CACHE_DIR: c.cacheDir, CLAUDFREE_STATE_DIR: join(this.root, 'state') }
    if (!this.ready()) {
      // A stale venv keeps the old packages (and their ~5 GB browser) otherwise.
      rmSync(join(this.root, '.venv'), { recursive: true, force: true })
      if (process.platform === 'win32') {
        try { await setup('py', ['-3', '-m', 'venv', join(this.root, '.venv')], this.root) }
        catch { await setup('python', ['-m', 'venv', join(this.root, '.venv')], this.root) }
      } else await setup('python3', ['-m', 'venv', join(this.root, '.venv')], this.root)
      await setup(this.python, ['-m', 'pip', 'install', '--disable-pip-version-check', ...PYTHON_PACKAGES], this.root, env)
      writeFileSync(join(this.root, 'python-ready'), PYTHON_PACKAGES.join(' '))
    }
    if (provider === 'chatgpt') {
      const dependencyDir = join(c.cacheDir, 'chatgpt-runtime')
      mkdirSync(dependencyDir, { recursive: true })
      if (!nodeDependenciesReady(dependencyDir)) {
        writeFileSync(join(dependencyDir, 'package.json'), JSON.stringify({ private: true, dependencies: { 'happy-dom': '20.14.5' } }))
        await setup(process.execPath, ['install', '--ignore-scripts', '--linker', 'hoisted', '--backend', 'copyfile', '--force'], dependencyDir, env)
        if (!nodeDependenciesReady(dependencyDir)) throw new Error('setup_failed')
      }
      try { await setup(this.python, ['-c', 'from claudfree.chatgpt.runtime import installation; installation()'], this.harnessDir, env) }
      catch { await setup(this.python, ['-c', 'from claudfree.chatgpt.runtime import download_assets, installation; download_assets(); installation()'], this.harnessDir, env) }
    }
  }
}
