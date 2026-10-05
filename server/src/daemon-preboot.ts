// The daemon's steps before index.ts loads, in the order they have to happen. main.ts imports this
// module, then calls loadDaemon(). Nothing in main.ts's daemon branch may import config.ts first.
//
// 1. The relaunch identity, before anything loads config.ts. config.ts resolves the store, the
//    config dir and the port from the environment when it loads, and a relaunch successor's
//    identity arrives as a flag (relaunch-identity.ts). boot-watchdog.ts imports config, and
//    main.ts used to load it first, so a side-run's successor had already fixed itself to the
//    machine's own store before index.ts's first import could apply the identity.
// 2. The boot watchdog, before index.ts's import-time work (db.ts, scheduler.ts). See
//    ./boot-watchdog.ts.
// 3. A line in daemon.log for a process that ends before index.ts starts file logging.
//    2026-10-05 01:56-02:05Z: the tray revived a stalled daemon four times; each revive exited 1
//    within 0.1-0.4 s and wrote nothing, because it died before initFileLogging and the tray runs
//    it with a hidden console. The cause could not be proven afterwards. An exit now leaves its
//    code, pid and argv, and a module that throws while loading leaves its error.
import './relaunch-identity-boot'
import { appendDaemonLogLine, armBootWatchdog, DEFAULT_BOOT_DEADLINE_MS } from './boot-watchdog'
import { crashRecordLine } from './crash-record'
import { logFilePath } from './log-file.mjs'

armBootWatchdog(DEFAULT_BOOT_DEADLINE_MS)

// Once initFileLogging has run, index.ts's own exit listener records every exit; this one stands down.
process.on('exit', (code) => {
  if (code === 0 || logFilePath() !== null) return
  appendDaemonLogLine(
    `[agenthydra] daemon exited code=${code} before file logging started pid=${process.pid} ` +
      `uptimeMs=${Math.round(process.uptime() * 1000)} argv=${JSON.stringify(process.argv.slice(2))}`,
  )
})

/** Load the daemon (index.ts). A throw while its modules load would otherwise end the process
 *  with the error on a console nobody sees. */
export async function loadDaemon(
  load: () => Promise<unknown> = () => import('./index'),
): Promise<void> {
  try {
    await load()
  } catch (err) {
    const line = crashRecordLine('daemon failed to load', err)
    console.error(line)
    if (logFilePath() === null) appendDaemonLogLine(line)
    process.exit(1)
  }
}
