import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import treeKill from "tree-kill";
import { freePort, isPortListening, killPids, portOwners } from "../ports";
import { type AnswerRule, answerText, PromptAnswerer } from "../prompt-answers";
import { effectiveRuntime, withRuntime } from "../runtime";
import { planManagedSpawn } from "../spawn-plan";
import { setEnabledOverride, setProjectOverride } from "../state";
import type { FreePortResult, PortOwner, ProcessCompose, ProcessDef, Status } from "../types";
import { composeActive, composeKey, prepareCompose, stopComposeServices } from "./compose";
import { ManagerWithMonitoring } from "./monitoring";
import {
  KILL_GRACE_MS,
  START_STAGGER_MS,
  WAIT_FOR_PORT_POLL_MS,
  WAIT_FOR_PORT_TIMEOUT_MS,
  type Entry,
} from "./types";
import { coStartIds, linkedGroupIds } from "./links";
import { DependencyCycleError, orderByDependency, resolveWaitPort } from "./wait-for-port";

/**
 * Process lifecycle: start/stop/restart of individual processes (and the
 * fleet as a whole), the staggered auto-start queue, spawn/exit handling,
 * the per-process/per-project enable toggles (setters — the predicates live
 * in `ManagerBase`), and the "free this port" confirm-then-kill flow.
 */
export class ManagerWithLifecycle extends ManagerWithMonitoring {
  // Instance-overridable so tests can shrink the timeout/poll cadence rather than
  // waiting out the real 30s default.
  waitForPortTimeoutMs = WAIT_FOR_PORT_TIMEOUT_MS;
  waitForPortPollMs = WAIT_FOR_PORT_POLL_MS;

  // ---- processes ----------------------------------------------------------
  /**
   * Start a process. A no-op when there's nothing to start (already running or
   * mid-start). A crash from a PREVIOUS run is deliberately not surfaced here:
   * crashes are reported once, when they happen, through the errors panel — a
   * process that died last run but is healthy now is not a problem to interrupt on.
   */
  start(id: string): void {
    const e = this.entries.get(id);
    if (!e || e.child || e.pendingStart) return;
    e.generation++; // see Entry.generation — lets an in-flight restart() detect it was overtaken
    this.cancelQueuedStart(id);
    e.stopping = false;
    e.exitCode = null;
    e.configChanged = false; // this start uses the current def, so any held drift is now applied
    e.composeEnv = undefined;
    this.clearStopTimer(e);

    // Compose-managed dependencies come first: a waitForPort or the spawn itself may
    // need the database this brings up. Same pendingStart guard as the steps below,
    // plus a generation check so a stop-then-start during a slow `up` isn't resumed twice.
    const compose = e.def.compose;
    if (composeActive(compose)) {
      const generation = e.generation;
      e.pendingStart = true;
      this.setStatus(e, "waiting");
      this.addLog(e, "stdout", "[devwebui] bringing up compose dependencies...");
      void this.runPrepareCompose(compose, e.def.cwd).then((res) => {
        const current =
          e.pendingStart && e.generation === generation && this.entries.get(e.def.id) === e;
        // A readiness failure after `up` still hands back what `up` started: hold it
        // so the release below (or a later one) stops it in start-and-stop mode.
        const started = res.ok ? res.started : (res.started ?? []);
        if (res.ok || started.length) this.holdCompose(e.def, started, current);
        if (!current) return;
        e.pendingStart = false;
        if (!res.ok) {
          this.releaseCompose(e.def.id); // this process will not run, so it relies on nothing
          this.addLog(e, "stderr", `[devwebui] ${res.reason}; not starting.`);
          this.setStatus(e, "stopped");
          this.resolveExitWaiters(e);
          return;
        }
        e.composeEnv = res.env;
        const injected = Object.entries(res.sources).map(([k, svc]) => `${k} (${svc})`);
        if (injected.length)
          this.addLog(e, "stdout", `[devwebui] compose env: ${injected.join(", ")}`);
        this.startAfterCompose(e);
      });
      return;
    }
    this.startAfterCompose(e);
  }

  /** The start steps that follow any compose step: the optional waitForPort, then continueStart. */
  private startAfterCompose(e: Entry): void {
    // Dependency-ordered startup (S): wait for a declared port before spawning. The
    // wait is async, so flag pendingStart — same guard the free-port step below uses
    // — and bail out of every continuation if we were cancelled/replaced meanwhile.
    const waitPort = resolveWaitPort(e.def, this.defsById());
    if (waitPort) {
      e.pendingStart = true;
      e.waitingOnPort = waitPort;
      this.setStatus(e, "waiting");
      void this.waitForPort(waitPort).then((ok) => {
        if (!e.pendingStart || this.entries.get(e.def.id) !== e) return;
        e.waitingOnPort = null;
        if (!ok) {
          e.pendingStart = false;
          const label = typeof e.def.waitForPort === "string" ? e.def.waitForPort : waitPort;
          this.addLog(
            e,
            "stderr",
            `[devwebui] gave up waiting for port ${waitPort} (${label}) after ${this.waitForPortTimeoutMs}ms; not starting.`,
          );
          this.setStatus(e, "stopped");
          this.resolveExitWaiters(e);
          return;
        }
        e.pendingStart = false;
        this.setStatus(e, "starting");
        this.continueStart(e);
      });
    } else {
      this.setStatus(e, "starting");
      this.continueStart(e);
    }
  }

  /**
   * Start a process the way the GUI/MCP "start" action does: the process itself,
   * plus its linked group and the project's companion processes (see links.ts for
   * the semantics). The anchor starts immediately, while the rest go through the
   * ordinary staggered, dependency-ordered batch queue. Already-running members are
   * no-ops, so this is safely idempotent ("bring this group up").
   * `coStarted` lists the OTHER processes this action actually set in motion
   * (already-running/queued members excluded) so the GUI can say "also started …".
   */
  startWithLinks(id: string): { coStarted: string[] } {
    const e = this.entries.get(id);
    if (!e) return { coStarted: [] };
    let extras = coStartIds(e.def, [...this.defsById().values()]);
    this.start(id);
    // startMany() is all-or-nothing on a waitForPort cycle — correct for an
    // explicit batch, but here an unrelated cycle (say, between two companions)
    // would silently block the anchor's real linked group. Strip cycle members
    // (logging against them, same as startMany would) and still start the rest.
    for (;;) {
      try {
        orderByDependency(extras, this.defsById());
        break;
      } catch (err) {
        if (!(err instanceof DependencyCycleError)) throw err;
        for (const cid of err.cycle) {
          const ce = this.entries.get(cid);
          if (ce) this.addLog(ce, "stderr", `[devwebui] ${err.message}; not starting.`);
        }
        const cycle = new Set(err.cycle);
        extras = extras.filter((x) => !cycle.has(x));
      }
    }
    // Same guard queueStart applies: members already running, mid-start, or
    // queued by an earlier batch aren't started BY THIS ACTION — don't report them.
    const coStarted = extras.filter((x) => {
      const xe = this.entries.get(x);
      return !!xe && !xe.child && !xe.pendingStart && !this.queuedStarts.has(x);
    });
    if (extras.length) this.startMany(extras);
    return { coStarted };
  }

  /**
   * Stop a process the way the GUI/MCP "stop" action does: the process itself
   * plus its linked group — a linked group acts as one unit, so stopping any
   * member brings the whole group down. Companions are NOT included: they join
   * starts only (a shared database shouldn't die because one consumer stopped).
   * Resolves to the OTHER group members this action actually brought down
   * (already-stopped members excluded) so the GUI can say "also stopped …".
   */
  async stopWithLinks(id: string): Promise<string[]> {
    const e = this.entries.get(id);
    if (!e) return [];
    const group = linkedGroupIds(e.def, [...this.defsById().values()]);
    const coStopped = group.filter((gid) => {
      const ge = this.entries.get(gid);
      return !!ge && (!!ge.child || ge.pendingStart || this.queuedStarts.has(gid));
    });
    await Promise.all([id, ...group].map((pid) => this.stop(pid)));
    return coStopped;
  }

  /**
   * All currently-registered process defs, keyed by global id (used to resolve `waitForPort`).
   * Note: `.values()`/`.keys()`/`.entries()` on the returned Map are one-shot iterators.
   * Materialize (`[...]`) before handing one to anything that may walk it twice (see coStartIds).
   */
  private defsById(): Map<string, ProcessDef> {
    const map = new Map<string, ProcessDef>();
    for (const e of this.entries.values()) map.set(e.def.id, e.def);
    return map;
  }

  /** Poll until `port` is listening or the timeout elapses. Resolves false on timeout. */
  private async waitForPort(port: number): Promise<boolean> {
    const deadline = Date.now() + this.waitForPortTimeoutMs;
    for (;;) {
      if (await isPortListening(port)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, this.waitForPortPollMs));
    }
  }

  /** Runs after any `waitForPort` step (or immediately, if there was none): the pre-existing
   *  optional free-port step, then the actual spawn. */
  private continueStart(e: Entry): void {
    if (e.child || e.stopping || this.entries.get(e.def.id) !== e || e.status !== "starting")
      return;
    // Optionally clear the declared port first (kill whatever holds it) so a
    // `--strictPort` server can bind. It's async (probe + kill), so flag the entry
    // pendingStart — that blocks a concurrent start() and lets stop() cancel us —
    // and spawn in the callback only if we weren't cancelled or replaced meanwhile.
    if (this.freePortOnStart && e.def.port) {
      e.pendingStart = true;
      void this.freePortIfBusy(e.def.port).then(() => {
        if (!e.pendingStart || this.entries.get(e.def.id) !== e) return;
        e.pendingStart = false;
        this.spawnEntry(e);
      });
    } else {
      this.spawnEntry(e);
    }
  }

  /** Kill the port's holder only if something is actually listening (skip a needless subprocess). */
  private async freePortIfBusy(port: number): Promise<void> {
    if (await isPortListening(port)) await freePort(port);
  }

  /** Spawn the child for an entry already moved to "starting". */
  private spawnEntry(e: Entry): void {
    // The async free-port window means state may have moved on — bail if so.
    if (e.child || e.stopping || this.entries.get(e.def.id) !== e || e.status !== "starting")
      return;
    const command = withRuntime(
      e.def.command,
      effectiveRuntime(e.def.runtime, this.globalRuntime, e.def.detectedRuntime),
    );
    // Compose-derived connection env sits under the process's own `env`, so a
    // hand-set DATABASE_URL in the .devwebui file always wins over the derived one.
    const env = { ...process.env, ...e.composeEnv, ...e.def.env };
    // Spawn the server DIRECTLY (no cmd.exe/sh wrapper) when the command is a plain
    // executable invocation — which is what `bun …`/`node …` dev servers are — and fall back
    // to `shell: true` only for commands that need a shell (operators, `%VAR%`, `.cmd`/`.bat`
    // shims like npm/vite, odd quoting). The direct path is what stops Task Manager filling
    // with one persistent `cmd.exe` per running server. See server/src/spawn-plan.ts for the
    // exact safe subset and why direct spawn is equivalent there.
    //
    // `windowsHide` (CREATE_NO_WINDOW) stays on BOTH paths. It's redundant on the direct path
    // (a directly-spawned bun/node inherits the daemon's console state), but on the shell
    // fallback it's load-bearing: `cmd /d /s /c` is a console program, and a desktop shortcut
    // boots the daemon detached with no console, so Windows would otherwise give each shell a
    // brand-new console that Windows Terminal hosts as a real window for the server's lifetime.
    // Harmless with the piped stdio below — the console is only ever a window, never our logs.
    const plan = planManagedSpawn(command, { cwd: e.def.cwd, env });
    let child: ChildProcess;
    try {
      child =
        plan.shell === false
          ? spawn(plan.file, plan.args, { cwd: e.def.cwd, env, windowsHide: true })
          : spawn(plan.command, { cwd: e.def.cwd, env, shell: true, windowsHide: true });
    } catch (err) {
      this.handleSpawnError(e, null, err);
      return;
    }
    e.child = child;
    e.pid = child.pid ?? null;
    e.startedAt = e.pid ? Date.now() : null;

    // Prompt answers watch BOTH streams: prompt libraries differ on where they print.
    const answerer = new PromptAnswerer(e.def.answers);
    // A child that closed its stdin makes a late write EPIPE; that must not crash the daemon.
    child.stdin?.on("error", () => {});
    const onOutput = (stream: "stdout" | "stderr") => (d: Buffer) => {
      const text = d.toString();
      this.addLog(e, stream, text);
      this.typeAnswers(e, child, answerer.feed(text));
    };
    child.stdout?.on("data", onOutput("stdout"));
    child.stderr?.on("data", onOutput("stderr"));
    child.on("error", (err) => this.handleSpawnError(e, child, err));
    child.on("exit", (code) => this.handleExit(e, child, code));
    if (e.pid) this.setStatus(e, "running");
    this.typeAnswers(e, child, answerer.start());
  }

  /** Type fired prompt answers into the child's stdin, noting each in its log by rule number:
   *  never the answer (it may be a secret from the .devwebui file), and not the `expect` text
   *  either, so the note cannot trip the error recorder or diagnose.ts on the prompt's words. */
  private typeAnswers(e: Entry, child: ChildProcess, fired: AnswerRule[]): void {
    for (const rule of fired) {
      if (!child.stdin || child.stdin.destroyed || e.child !== child) return;
      child.stdin.write(answerText(rule));
      const n = (e.def.answers?.indexOf(rule) ?? -1) + 1;
      this.addLog(e, "stdout", `[devwebui] typed the reply from answers rule #${n}`);
    }
  }

  // ---- enable/disable: setters (predicates live in ManagerBase) -----------
  // Toggling never starts or stops a live process (use start/stop for that). It
  // only records what should auto-start next time the project loads.
  /** Set one process's toggle and persist it. Does NOT start/stop it. */
  setProcessEnabled(id: string, enabled: boolean): void {
    const e = this.entries.get(id);
    if (!e) return;
    setEnabledOverride(id, enabled);
    this.emitStatus(e); // push the new `enabled` flag to the GUI
  }

  /** Flip a project's master switch and persist it. Does NOT start/stop, and does
   *  NOT touch the individual per-process toggles — it just gates the whole stack. */
  setProjectEnabled(projectId: string, enabled: boolean): void {
    if (!this.projects.has(projectId)) return;
    setProjectOverride(projectId, enabled);
    this.emitProjects(); // ProjectView.enabled changed — refresh the list
  }

  /**
   * Stop a process, then release its hold on any compose stack it brought up.
   * `keepCompose` is for a restart: the stack must survive the few hundred ms the
   * process is down, or a start-and-stop stack would cycle with every restart.
   */
  stop(id: string, opts: { keepCompose?: boolean } = {}): Promise<void> {
    const done = this.stopProcess(id);
    return opts.keepCompose ? done : done.then(() => this.releaseCompose(id));
  }

  private stopProcess(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return Promise.resolve();
    e.generation++; // see Entry.generation — cancels a restart still waiting out its settle delay
    this.cancelQueuedStart(id);
    if (e.pendingStart) {
      // Cancel a start still waiting on a dependency port or the free-port step
      // (no child exists yet).
      e.pendingStart = false;
      e.waitingOnPort = null;
      this.clearStopTimer(e);
      this.setStatus(e, "stopped");
      return Promise.resolve();
    }
    if (!e.child) return Promise.resolve();
    if (e.stopping) return new Promise((resolve) => e.exitWaiters.push(resolve));
    e.stopping = true;
    this.setStatus(e, "stopping");
    const child = e.child;
    const pid = e.pid;
    if (!pid) {
      this.addLog(
        e,
        "stderr",
        "[devwebui] process had no PID while stopping; clearing stale state.",
      );
      this.finishProcess(e, child, "stopped", null);
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      e.exitWaiters.push(resolve);
      const forceKill = (reason: string) => {
        if (e.child !== child || e.pid !== pid) return;
        this.clearStopTimer(e);
        this.addLog(e, "stderr", `[devwebui] ${reason}; sent SIGKILL.`);
        try {
          treeKill(pid, "SIGKILL", (err) => {
            if (e.child !== child || e.pid !== pid) return;
            if (err) {
              this.addLog(
                e,
                "stderr",
                `[devwebui] failed to force stop process ${pid}: ${err.message}`,
              );
              this.finishProcess(e, child, "crashed", null);
            } else {
              this.finishProcess(e, child, "stopped", null);
            }
          });
        } catch (err) {
          this.addLog(
            e,
            "stderr",
            `[devwebui] failed to force stop process ${pid}: ${(err as Error).message}`,
          );
          this.finishProcess(e, child, "crashed", null);
        }
      };
      e.stopTimer = setTimeout(
        () => forceKill(`process did not exit after ${KILL_GRACE_MS}ms`),
        KILL_GRACE_MS,
      );
      // PLATFORM NOTE — this grace window is real on POSIX and nominal on Windows.
      // tree-kill shells out to `taskkill /pid <n> /T /F` on win32 and IGNORES the signal
      // argument, so a Windows stop is always an immediate forced tree kill and the timer
      // above never fires. That is a deliberate trade, not an oversight: `taskkill` WITHOUT
      // /F only posts WM_CLOSE, which a console dev server has no window to receive, so a
      // graceful-first attempt would no-op and then cost every single stop the full
      // KILL_GRACE_MS before escalating. Real graceful shutdown on Windows needs the child
      // spawned in its own process group plus a console-ctrl-event sender; until that
      // exists, forced is both the honest and the faster behavior.
      try {
        treeKill(pid, "SIGTERM", (err) => {
          if (err) forceKill(`SIGTERM failed for process ${pid}: ${err.message}`);
        });
      } catch (err) {
        forceKill(`SIGTERM failed for process ${pid}: ${(err as Error).message}`);
      }
    });
  }

  async restart(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    const wasRunning = !!e.child;
    await this.stop(id, { keepCompose: true });
    // Claim the entry for THIS restart, then re-check after the settle delay. A stop()
    // that lands inside that window bumps the generation, and we abandon the re-start
    // rather than resurrecting a process the user just asked to stop.
    const generation = ++e.generation;
    await new Promise((r) => setTimeout(r, 200));
    if (this.entries.get(id) !== e || e.generation !== generation) return;
    if (wasRunning || e.status === "stopped" || e.status === "crashed") e.restarts += 1;
    this.start(id);
  }

  startAll(): void {
    this.startMany([...this.entries.keys()]);
  }

  /** Restart everything currently running — used when the global runtime changes. */
  async restartRunning(): Promise<void> {
    const running = [...this.entries.entries()].filter(([, e]) => e.child).map(([id]) => id);
    await Promise.all(running.map((id) => this.stop(id, { keepCompose: true })));
    for (const id of running) {
      const e = this.entries.get(id);
      if (e && (e.status === "stopped" || e.status === "crashed")) e.restarts += 1;
    }
    this.startMany(running);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
    // A holder removed from its file never gets a stop() of its own; on a full stop
    // (daemon shutdown included) every stack is released, then waited for.
    for (const hold of this.composeHolds.values())
      for (const user of [...hold.users]) this.releaseCompose(user);
    await Promise.allSettled([...this.composeStops]);
  }

  /** A process removed from its file (or its project) lets go of its stack now, not at stopAll. */
  protected override discardEntry(e: Entry): void {
    super.discardEntry(e);
    this.releaseCompose(e.def.id);
  }

  /** Per compose stack: the processes relying on it and the services this daemon started. */
  private composeHolds = new Map<
    string,
    {
      spec: ProcessCompose;
      cwd: string;
      users: Set<string>;
      started: Set<string>;
      stopOnRelease: boolean;
    }
  >();
  /** In-flight `docker compose stop` calls: a new `up` waits for them, and stopAll awaits them. */
  private composeStops = new Set<Promise<void>>();

  /** Wait out any in-flight compose stop, so an `up` never races a `stop` of the same stack. */
  private async runPrepareCompose(spec: ProcessCompose, cwd: string) {
    await Promise.allSettled([...this.composeStops]);
    return prepareCompose(spec, cwd);
  }

  /** Record `def` as relying on its stack; a cancelled start (not re-started since) lets go at once. */
  private holdCompose(def: ProcessDef, started: string[], current: boolean): void {
    if (!def.compose) return;
    const key = composeKey(def);
    let hold = this.composeHolds.get(key);
    if (!hold) {
      hold = {
        spec: def.compose,
        cwd: def.cwd,
        users: new Set(),
        started: new Set(),
        stopOnRelease: false,
      };
      this.composeHolds.set(key, hold);
    }
    for (const s of started) hold.started.add(s);
    if (def.compose.mode === "start-and-stop") hold.stopOnRelease = true;
    hold.users.add(def.id);
    const e = this.entries.get(def.id);
    if (!current && (!e || (!e.pendingStart && !e.child))) this.releaseCompose(def.id);
  }

  /**
   * Drop `id`'s hold on every stack. The last holder out stops the services this
   * daemon started (never ones that were already running) when any holder asked for
   * start-and-stop; start-only stacks are left up for the next run.
   */
  private releaseCompose(id: string): void {
    for (const [key, hold] of this.composeHolds) {
      if (!hold.users.delete(id) || hold.users.size) continue;
      this.composeHolds.delete(key);
      if (!hold.stopOnRelease || !hold.started.size) continue;
      const services = [...hold.started];
      const e = this.entries.get(id);
      const pending = stopComposeServices(hold.spec, hold.cwd, services).then((err) => {
        this.composeStops.delete(pending);
        if (!e) return;
        if (err) this.addLog(e, "stderr", `[devwebui] ${err}`);
        else
          this.addLog(e, "stdout", `[devwebui] stopped compose services: ${services.join(", ")}`);
      });
      this.composeStops.add(pending);
    }
  }

  /**
   * SYNCHRONOUS best-effort kill of every managed child. For the last-resort crash
   * handlers ONLY (uncaughtException / unhandledRejection in server/src/index.ts), which
   * call `process.exit(1)` immediately and therefore cannot await the ordinary async
   * `stopAll()`. Without it, any unhandled throw anywhere in the daemon orphans every dev
   * server it launched — the app silently stops owning the lifecycle it promises to own,
   * and the user is left hunting PIDs.
   *
   * Deliberately does NOT flush settings, emit events, or wait for exit: the process is
   * already going down and a hung await here would lose the kill entirely. Returns the
   * ids it signalled so the caller can log them.
   */
  killAllSync(): string[] {
    const killed: string[] = [];
    for (const e of this.entries.values()) {
      const pid = e.pid;
      if (!pid) continue;
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } else {
          // Prefer the whole process group (a `sh -c` wrapper's children die with it);
          // fall back to the direct pid when the child isn't its own group leader.
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            process.kill(pid, "SIGKILL");
          }
        }
        killed.push(e.def.id);
      } catch {
        /* best-effort: a child that already exited is not a failure */
      }
    }
    return killed;
  }

  /**
   * Free a process's declared port with a SMALL blast radius:
   *   • a holder we manage is STOPPED cleanly (never SIGKILLed out from under us);
   *   • external (unmanaged) holders are only killed after explicit confirmation, and
   *     only those exact PIDs — never a blind "kill anything on this port" sweep.
   * Returns the external owners + `needsConfirm` when confirmation is required.
   */
  async freeProcessPort(id: string, opts: { confirm?: boolean } = {}): Promise<FreePortResult> {
    const e = this.entries.get(id);
    if (!e?.def.port) return { ok: true };
    const owners = await portOwners(e.def.port);
    if (!owners.length) return { ok: true, owners: [] }; // already free

    const stoppedManaged: string[] = [];
    const external: PortOwner[] = [];
    for (const o of owners) {
      const mine = this.entryByPid(o.pid);
      if (mine) stoppedManaged.push(mine.def.id);
      else external.push(o);
    }
    // Prefer a clean stop of anything we own.
    await Promise.all([...new Set(stoppedManaged)].map((mid) => this.stop(mid)));

    if (!external.length) return { ok: true, stoppedManaged };
    if (!opts.confirm) return { needsConfirm: true, owners: external, stoppedManaged };
    await killPids(external.map((o) => o.pid));
    return { ok: true, stoppedManaged, owners: external };
  }

  // ---- internals: staggered auto-start queue + spawn/exit handling --------
  /**
   * Start a batch (individual start_all/startProject calls, or launch-time autostart).
   * Resolves `waitForPort` dependency ordering within the batch first (simple
   * topological sort — see wait-for-port.ts), so a dependency is queued to start
   * before its dependent, then staggers the (now-ordered) queue same as before.
   * On a dependency cycle, nothing in the batch is started — the error is logged
   * against every process named in the cycle so it's visible in the GUI.
   */
  protected startMany(ids: string[]): void {
    const unique = [...new Set(ids)];
    let ordered: string[];
    try {
      ordered = orderByDependency(unique, this.defsById());
    } catch (err) {
      if (err instanceof DependencyCycleError) {
        for (const id of err.cycle) {
          const e = this.entries.get(id);
          if (e) this.addLog(e, "stderr", `[devwebui] ${err.message}; not starting.`);
        }
        return;
      }
      throw err;
    }
    ordered.forEach((id, i) => {
      this.queueStart(id, i * START_STAGGER_MS);
    });
  }

  private queueStart(id: string, delayMs: number): void {
    const e = this.entries.get(id);
    if (!e || e.child || e.pendingStart || this.queuedStarts.has(id)) return;
    if (delayMs <= 0) {
      this.start(id);
      return;
    }
    const timer = setTimeout(() => {
      this.queuedStarts.delete(id);
      this.start(id);
    }, delayMs);
    this.queuedStarts.set(id, timer);
  }

  private finishProcess(
    e: Entry,
    child: ChildProcess,
    status: Status,
    exitCode: number | null,
  ): void {
    if (e.child !== child) return;
    this.clearStopTimer(e);
    e.child = null;
    e.pid = null;
    e.cpu = null;
    e.memory = null;
    e.exitCode = exitCode;
    e.startedAt = null;
    e.stopping = false;
    this.setStatus(e, status);
    this.resolveExitWaiters(e);
  }

  private handleSpawnError(e: Entry, child: ChildProcess | null, err: unknown): void {
    if (child && e.child !== child) return;
    const current = this.entries.get(e.def.id) === e;
    const message = err instanceof Error ? err.message : String(err);
    this.clearStopTimer(e);
    e.child = null;
    e.pid = null;
    e.cpu = null;
    e.memory = null;
    e.exitCode = null;
    e.startedAt = null;
    const stopped = e.stopping;
    e.stopping = false;
    if (current) {
      this.addLog(e, "stderr", `[devwebui] spawn error: ${message}`);
      this.setStatus(e, stopped ? "stopped" : "crashed");
    }
    this.resolveExitWaiters(e);
  }

  private handleExit(e: Entry, child: ChildProcess, code: number | null): void {
    if (e.child !== child) return;
    const current = this.entries.get(e.def.id) === e;
    const crashed = current && !e.stopping && code !== 0 && code !== null;
    // A crash is reported ONCE, here, into the errors panel — the single channel for
    // "something is wrong right now". Nothing is persisted to replay on the next start:
    // the stderr behind it stays readable in the rotating log file (see log-vault.ts).
    if (crashed) this.errors.record(this.errorInfo(e), "crash", `Process exited with code ${code}`);
    this.finishProcess(e, child, crashed ? "crashed" : "stopped", code);
  }
}
