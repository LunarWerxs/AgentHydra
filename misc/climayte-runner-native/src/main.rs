//! climayte-runner.exe: the process one CliMayte worker's CLI runs under on Windows, OUTSIDE
//! AgentHydra's daemon.
//!
//! Owner, 2026-09-30: "I need to be able to restart AgentHydra without breaking CliMayte runners."
//! So each worker's CLI runs under its own runner, launched through the daemon's WMI hand-off
//! (server/src/detached-spawn.mjs, hidden) and so born outside the daemon's tree. The runner starts
//! the CLI with the attempt's prompt, log and error files as its stdin, stdout and stderr, writes
//! both pids, waits, and writes an exit file. The daemon only ever reads files, so a restarted
//! daemon finds its workers still running and goes on reading them.
//!
//! This used to be AgentHydra itself in `--climayte-runner <spec>` mode: a whole Bun runtime per
//! worker, 123-177 MB each, about 3 GB with 20 workers, to wait on one process (owner, 2026-10-04:
//! "instead of spinning up 50 of one thing"). One small runner per worker is kept on purpose: a
//! runner that dies takes only its own worker with it. The contract with the daemon is unchanged
//! (server/src/climayte-runner.ts holds the spec, pid and exit file shapes):
//!
//! - The spec is a single-owner claim. The runner takes it by renaming it to `.taken` before
//!   reading; the daemon voids an attempt that has not started by renaming it to `.void`. Exactly
//!   one rename wins. The spec holds the CLI's environment, so it is deleted as soon as it is read.
//! - `<pidFile>` gets `{ runner }` the moment the spec is claimed, then `{ runner, child }`.
//! - The runner puts itself in a kill-on-close job (job.rs) before it starts the CLI.
//! - The wind-down hook is answered here over loopback http (signal.rs).
//! - `<exitFile>` gets `{ code, signal, endedAt, left?, peakProcesses? }`, or `{ ..., error }` when
//!   the CLI could not start.
//!
//! A console program, started hidden by the hand-off: its console host is born before the job, so
//! it is never counted or listed as a leftover, and the CLI and everything it starts share that one
//! console, as they did under the Bun runner. Measured 2026-10-04: a CLI given a console of its own
//! (CREATE_NO_WINDOW under a console-less runner) left that console's host in the job for a moment
//! after it exited, and every attempt then listed a conhost.exe it never started.

#[cfg(not(windows))]
compile_error!("climayte-runner is the Windows runner; elsewhere AgentHydra runs its own (server/src/climayte-runner-posix.ts)");

mod job;
mod json;
mod signal;

use json::Json;
use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const WAIT_TIMEOUT: u32 = 0x102;
/// How often the job's live process count is read for `peakProcesses`.
const PEAK_EVERY_MS: u32 = 2_000;

#[link(name = "kernel32")]
extern "system" {
    fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
}

struct Spec {
    argv: Vec<String>,
    cwd: String,
    env: Vec<(String, String)>,
    stdin: String,
    stdout: String,
    stderr: String,
    pid_file: String,
    exit_file: String,
    /// New output files (a check's log): opened for writing, one handle when stdout and stderr are
    /// the same file. Git Bash cannot write through an append-only handle (2026-10-02); the CLI
    /// appends to its logs fine.
    fresh: bool,
    /// The signal file and the settings file whose PostToolUse hook is pointed here.
    signal: Option<(String, String)>,
    /// The most processes the worker's tree may have alive at once, the runner included.
    max_processes: Option<u32>,
}

impl Spec {
    fn read(j: &Json) -> Option<Spec> {
        let text = |key: &str| j.get(key).and_then(Json::as_str).map(str::to_string);
        let argv: Vec<String> = match j.get("argv")? {
            Json::Arr(items) => items
                .iter()
                .map(|a| a.as_str().map(str::to_string))
                .collect::<Option<_>>()?,
            _ => return None,
        };
        if argv.is_empty() {
            return None;
        }
        let env = match j.get("env")? {
            Json::Obj(pairs) => pairs
                .iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                .collect(),
            _ => return None,
        };
        let signal = match j.get("signal") {
            Some(s @ Json::Obj(_)) => Some((
                s.get("file")?.as_str()?.to_string(),
                s.get("settings")?.as_str()?.to_string(),
            )),
            _ => None,
        };
        Some(Spec {
            argv,
            cwd: text("cwd")?,
            env,
            stdin: text("stdin")?,
            stdout: text("stdout")?,
            stderr: text("stderr")?,
            pid_file: text("pidFile")?,
            exit_file: text("exitFile")?,
            fresh: matches!(j.get("fresh"), Some(Json::Bool(true))),
            signal,
            max_processes: j
                .get("maxProcesses")
                .and_then(Json::as_f64)
                .filter(|n| *n >= 1.0)
                .map(|n| n.min(u32::MAX as f64) as u32),
        })
    }
}

fn main() {
    std::process::exit(run());
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis())
}

fn write_json(path: &str, v: &Json) -> bool {
    std::fs::write(path, json::to_string(v)).is_ok()
}

/// The exit file: `code`, `signal` and `endedAt` always, in that order, then `fields` (a `code`
/// among them replaces the null).
fn write_exit(path: &str, fields: Vec<(&str, Json)>) {
    let mut all: Vec<(&str, Json)> = vec![
        ("code", Json::Null),
        ("signal", Json::Null),
        ("endedAt", Json::num(now_ms())),
    ];
    for (k, v) in fields {
        match all.iter_mut().find(|(key, _)| *key == k) {
            Some(slot) => slot.1 = v,
            None => all.push((k, v)),
        }
    }
    write_json(path, &Json::obj(all));
}

fn run() -> i32 {
    let Some(spec_path) = std::env::args_os().nth(1).map(PathBuf::from) else {
        return 2;
    };
    let mut taken = spec_path.clone().into_os_string();
    taken.push(".taken");
    let taken = PathBuf::from(taken);
    match std::fs::rename(&spec_path, &taken) {
        Ok(()) => {}
        // The daemon voided it first (a cancel or an urgent message before this runner got here):
        // the attempt is over, so nothing starts and nothing is written.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return 0,
        Err(_) => return 1,
    }
    let text = std::fs::read_to_string(&taken);
    let _ = std::fs::remove_file(&taken);
    let Some(spec) = text
        .ok()
        .and_then(|t| json::parse(&t))
        .as_ref()
        .and_then(Spec::read)
    else {
        return 1;
    };
    let me = std::process::id();
    // Before anything slow: a stop that lost the claim kills this runner by this pid.
    if !write_json(&spec.pid_file, &Json::obj(vec![("runner", Json::num(me))])) {
        return 1;
    }
    let job = job::Job::contain(spec.max_processes);
    // The wind-down hook is answered from here once the settings say so; if they cannot be
    // rewritten the CLI keeps the shell form the daemon wrote, and no port is held.
    if let Some((file, settings)) = &spec.signal {
        signal::serve(PathBuf::from(file), Path::new(settings));
    }
    let mut child = match start(&spec) {
        Ok(child) => child,
        Err(e) => {
            write_exit(&spec.exit_file, vec![("error", Json::str(e))]);
            return 1;
        }
    };
    write_json(
        &spec.pid_file,
        &Json::obj(vec![
            ("runner", Json::num(me)),
            ("child", Json::num(child.id())),
        ]),
    );
    // What one worker really costs: the most processes its tree had alive at once, console hosts
    // included (the ceiling does not count those, so this can read above it). A failed read ends
    // the sampling, never the runner.
    let mut peak = 0u32;
    let mut sampling = job.is_some();
    let mut sample = |peak: &mut u32| {
        if !sampling {
            return;
        }
        match job.as_ref().and_then(job::Job::active) {
            Some(n) => *peak = (*peak).max(n),
            None => sampling = false,
        }
    };
    sample(&mut peak);
    // SAFETY: the handle is the live child's, owned by `child` for the whole wait.
    while unsafe { WaitForSingleObject(child.as_raw_handle().cast(), PEAK_EVERY_MS) }
        == WAIT_TIMEOUT
    {
        sample(&mut peak);
    }
    let code = match child.wait() {
        // The exit code as Windows holds it (a DWORD), whole: its low byte alone reads a Git Bash
        // killed by a signal (code signal << 8) as 0, a pass.
        Ok(status) => status.code().map_or(Json::Null, |c| Json::num(c as u32)),
        Err(_) => Json::Null,
    };
    let left = job.as_ref().map(|j| j.leftovers(me)).unwrap_or_default();
    let mut fields = vec![("code", code)];
    if !left.is_empty() {
        let list = left
            .into_iter()
            .map(|l| {
                let mut entry = vec![("pid", Json::num(l.pid)), ("name", Json::str(l.name))];
                if let Some(command) = l.command {
                    entry.push(("command", Json::str(command)));
                }
                Json::obj(entry)
            })
            .collect();
        fields.push(("left", Json::Arr(list)));
    }
    if peak > 0 {
        fields.push(("peakProcesses", Json::num(peak)));
    }
    write_exit(&spec.exit_file, fields);
    // Returning ends this process, which closes the job: everything in `left` ends with it.
    0
}

fn open_out(path: &str, fresh: bool) -> std::io::Result<File> {
    if fresh {
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
    } else {
        OpenOptions::new().append(true).create(true).open(path)
    }
}

fn start(spec: &Spec) -> Result<std::process::Child, String> {
    let program = program(&spec.argv[0], &spec.env, Path::new(&spec.cwd))?;
    let fail = |what: &str, e: std::io::Error| format!("{what}: {e}");
    let stdin = File::open(&spec.stdin).map_err(|e| fail(&format!("open {}", spec.stdin), e))?;
    let stdout = open_out(&spec.stdout, spec.fresh)
        .map_err(|e| fail(&format!("open {}", spec.stdout), e))?;
    let stderr = if spec.fresh && spec.stderr == spec.stdout {
        stdout.try_clone().map_err(|e| fail("share the log", e))?
    } else {
        open_out(&spec.stderr, spec.fresh).map_err(|e| fail(&format!("open {}", spec.stderr), e))?
    };
    Command::new(&program)
        .args(&spec.argv[1..])
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::from(stdin))
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|e| fail(&format!("start {}", program.display()), e))
}

/// The extensions Bun.spawn runs as given, in the order it tries them on a name without one.
const RUN_EXTS: [&str; 3] = ["exe", "cmd", "bat"];

/// The program to start, found the way Bun.spawn found it: a path (relative to the CLI's own
/// folder) or a bare name on the PATH the CLI is given, taken as is when it ends in `.exe`, `.cmd`
/// or `.bat` and otherwise tried with each of them, so npm's extensionless `claude` shim resolves
/// to the `claude.cmd` beside it. A path none of that finds is started as given, for an error that
/// names it. A `.cmd` or `.bat` is run through cmd.exe by Rust's standard library, with its
/// arguments escaped for it.
fn program(argv0: &str, env: &[(String, String)], cwd: &Path) -> Result<PathBuf, String> {
    let given = Path::new(argv0);
    if argv0.contains(['\\', '/', ':']) {
        let full = if given.is_absolute() {
            given.to_path_buf()
        } else {
            cwd.join(given)
        };
        return Ok(runnable(&full).unwrap_or(full));
    }
    let path = env
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
        .map_or("", |(_, v)| v.as_str());
    path.split(';')
        .map(|d| d.trim().trim_matches('"'))
        .filter(|d| !d.is_empty())
        .find_map(|dir| runnable(&Path::new(dir).join(argv0)))
        .ok_or_else(|| format!("start {argv0}: not found on the PATH the CLI was given"))
}

/// `base` when it ends in one of RUN_EXTS and exists, else the first `base.<ext>` that exists.
fn runnable(base: &Path) -> Option<PathBuf> {
    let has_ext = base
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| RUN_EXTS.iter().any(|x| e.eq_ignore_ascii_case(x)));
    if has_ext {
        return base.is_file().then(|| base.to_path_buf());
    }
    RUN_EXTS
        .iter()
        .map(|ext| {
            let mut name = base.as_os_str().to_owned();
            name.push(".");
            name.push(ext);
            PathBuf::from(name)
        })
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// npm's layout: an extensionless sh shim beside the `.cmd` that Windows runs. Bun.spawn
    /// started the `.cmd`; the shim itself fails to start ("not a valid Win32 application").
    #[test]
    fn an_extensionless_path_or_name_resolves_to_the_cmd_beside_it_as_bun_did() {
        let dir =
            std::env::temp_dir().join(format!("climayte-runner-program-{}", std::process::id()));
        let bin = dir.join("bin");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("tool"), "#!/bin/sh\n").unwrap();
        std::fs::write(bin.join("tool.cmd"), "@echo off\n").unwrap();
        let path = [("Path".to_string(), bin.display().to_string())];
        let cmd = bin.join("tool.cmd");
        let absolute = bin.join("tool").display().to_string();
        assert_eq!(program(&absolute, &[], &dir), Ok(cmd.clone()));
        assert_eq!(program("bin\\tool", &[], &dir), Ok(cmd.clone()));
        assert_eq!(program("tool", &path, &dir), Ok(cmd.clone()));
        assert_eq!(program("tool.cmd", &path, &dir), Ok(cmd));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
