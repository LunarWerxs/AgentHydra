//! Starting, probing and stopping the app's daemon.
//!
//! Every rule here is carried over from Tray-Host.ps1 rather than re-derived, including the poll
//! counts and sleeps, because several of them exist to survive a specific failure that was seen in
//! production. Where a constant looks arbitrary it is quoted with its origin.

use crate::config::Config;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Safe mode for every spawn from now on (server-lib crash-sentinel.mjs): set by "Restart in Safe
/// Mode", cleared by "Restart Normally". A process-wide flag rather than a spawn() parameter so the
/// cold start, the worker and the watchdog, which all call spawn(), cannot disagree about it. The
/// daemon reads it as an env var because the start command is an opaque per-app string a flag
/// cannot be spliced into safely; it is pinned to "0" when off so an inherited value cannot keep
/// the daemon quiet by accident.
pub static SAFE_MODE: AtomicBool = AtomicBool::new(false);
const SAFE_MODE_ENV: &str = "LUNARWERX_SAFE_MODE";
const RUN_PREFIX: &str = "run_";
/// Slack for comparing boot times, as in crash-sentinel.mjs: clock corrections shift them a little.
const BOOT_TOLERANCE_MS: f64 = 5.0 * 60.0 * 1000.0;

/// The daemon's run_* crash-sentinel files, or nothing when the app configures no directory.
fn run_sentinels(cfg: &Config) -> Vec<PathBuf> {
    let Some(dir) = cfg.crash_sentinel_dir.as_ref() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(RUN_PREFIX))
        .map(|e| e.path())
        .collect()
}

/// Did an earlier run end uncleanly? True for any run file whose owner is gone, unreadable (the
/// crash landed mid-write), or written before the last boot (its pid, if alive, is recycled). Read
/// BEFORE the cold start, because the daemon reports and deletes them.
pub fn unclean_run_left(cfg: &Config) -> bool {
    let booted = crate::win::boot_time_ms();
    run_sentinels(cfg).iter().any(|path| {
        let run = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| crate::json::parse(&s));
        let pid = run
            .as_ref()
            .and_then(|v| v.num_at("pid"))
            .map(|n| n as u32)
            .unwrap_or(0);
        let earlier_boot = match (run.as_ref().and_then(|v| v.num_at("bootedAt")), booted) {
            (Some(then), Some(now)) => (then - now).abs() > BOOT_TOLERANCE_MS,
            _ => false,
        };
        pid == 0 || earlier_boot || !crate::win::pid_alive(pid)
    })
}

/// Delete the run files after the tray stopped the daemon ON PURPOSE, so the next launch does not
/// report a deliberate force-kill as a crash.
pub fn clear_run_sentinels(cfg: &Config) {
    for path in run_sentinels(cfg) {
        let _ = std::fs::remove_file(path);
    }
}

/// Pre-spawn "is one already running?" probe. A live daemon on loopback answers in ~2 ms; this
/// budget is only ever reached by a port that is silently dropping, and every millisecond of it
/// sits directly in front of the daemon spawn.
pub const PROBE_FAST: Duration = Duration::from_millis(15);
/// The probe used once we are already waiting, where correctness beats another 10 ms.
pub const PROBE_POLL: Duration = Duration::from_millis(400);

/// One `GET /api/health`, over a raw socket.
///
/// The identity rule is the PowerShell host's, unchanged and load-bearing: a responder is ours only
/// when the body carries `"ok":true` AND a `"service"` equal to ours. Silence is not identity and
/// neither is a 200 - a Vite dev server on a neighbouring port answers /api/health with its SPA
/// fallback, which is how a sibling app once latched onto a stranger and reported the wrong thing
/// in both directions.
pub fn health_ok(host: &str, port: u16, service: &str, timeout: Duration) -> bool {
    let Some(addr) = resolve(host, port) else {
        return false;
    };
    let Ok(mut sock) = TcpStream::connect_timeout(&addr, timeout) else {
        return false;
    };
    let _ = sock.set_read_timeout(Some(timeout));
    let _ = sock.set_write_timeout(Some(timeout));
    let req =
        format!("GET /api/health HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    if sock.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut body = String::new();
    let mut buf = [0u8; 4096];
    loop {
        match sock.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                body.push_str(&String::from_utf8_lossy(&buf[..n]));
                if body.len() > 64 * 1024 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let _ = sock.shutdown(Shutdown::Both);
    body.contains("\"ok\":true") && body.contains(&format!("\"service\":\"{service}\""))
}

fn resolve(host: &str, port: u16) -> Option<SocketAddr> {
    use std::net::ToSocketAddrs;
    (host, port).to_socket_addrs().ok()?.next()
}

/// Split `http://host:port/...` into its host and port.
pub fn split_url(url: &str) -> Option<(String, u16)> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split('/').next()?;
    let (host, port) = authority.rsplit_once(':')?;
    Some((host.to_string(), port.parse().ok()?))
}

pub fn port_of(url: &str) -> Option<u16> {
    split_url(url).map(|(_, p)| p)
}

/// The URL of a live instance, or None.
///
/// The runtime pointer's `url` is tried FIRST and VERBATIM, which matters for more than speed: the
/// daemon writes the host it actually bound (127.0.0.1), while an app's configured `urlHost` may be
/// the friendlier "localhost". Those are not the same thing here - localhost can resolve to ::1
/// first, and a daemon listening only on 127.0.0.1 then looks dead. Probing the pointer's own URL
/// asks the daemon where it is instead of guessing.
///
/// The configured host and preferred port remain the fallback for the window before the pointer
/// exists. Identity is validated either way; a pointer is never trusted on its own.
pub fn live_url(cfg: &Config, timeout: Duration) -> Option<String> {
    let pointer = std::fs::read_to_string(&cfg.info_file)
        .ok()
        .and_then(|s| crate::json::parse(&s));

    if let Some(url) = pointer.as_ref().and_then(|v| v.str_at("url")) {
        if let Some((host, port)) = split_url(url) {
            if health_ok(&host, port, &cfg.service_name, timeout) {
                return Some(url.to_string());
            }
        }
    }
    // A pointer written by an older daemon may carry only the port.
    if let Some(port) = pointer
        .as_ref()
        .and_then(|v| v.num_at("port"))
        .map(|p| p as u16)
    {
        if port != 0 && health_ok("127.0.0.1", port, &cfg.service_name, timeout) {
            return Some(format!("http://127.0.0.1:{port}"));
        }
    }
    if cfg.port != 0 && health_ok(&cfg.url_host, cfg.port, &cfg.service_name, timeout) {
        return Some(format!("http://{}:{}", cfg.url_host, cfg.port));
    }
    None
}

/// Launch the daemon.
///
/// Via `cmd.exe /c` so a start command carrying shell syntax keeps working, matching Start-Daemon.
/// Two details are load-bearing:
///
/// * The command is wrapped in ONE MORE quote pair. When the text after `/c` begins with a quote,
///   cmd strips the first and last quote of the whole line, so a quoted interpreter path loses the
///   quotes protecting it and cmd runs nothing - while still starting successfully, so the caller
///   sees success and waits forever for a daemon that never existed.
/// * Stdio is never inherited. A tray started from a terminal otherwise hands the daemon that
///   terminal's pipes; nothing drains them, the buffer fills, and the daemon blocks on a console
///   write BEFORE it binds its port. Observed: a live process with no listening socket and no
///   runtime pointer. stdin and stdout are NULL (the daemon tees its own output to
///   logs/daemon.log); stderr is a FILE, which never fills and needs no reader (`open_stderr_log`).
///
/// `why` names the caller in the tray log (tray start, tray Restart, watchdog revive), so a spawn
/// line says who asked for it.
pub fn spawn(cfg: &Config, token: &str, why: &str) -> Option<u32> {
    let command = cfg.resolved_start_command(token);
    let (stderr, said) = match open_stderr_log(cfg, why) {
        Some((file, path, from)) => (Stdio::from(file), Some((path, from))),
        None => (Stdio::null(), None),
    };
    let mut cmd = Command::new("cmd.exe");
    cmd.raw_arg(format!("/c \"{command}\""))
        .current_dir(&cfg.app_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(stderr)
        .creation_flags(CREATE_NO_WINDOW);
    for (k, v) in cfg.resolved_start_env(token) {
        cmd.env(k, v);
    }
    let safe = SAFE_MODE.load(Ordering::Relaxed);
    cmd.env(SAFE_MODE_ENV, if safe { "1" } else { "0" });
    match cmd.spawn() {
        Ok(child) => {
            let pid = child.id();
            let mode = if safe { " in safe mode" } else { "" };
            // Say which death this birth answers, BEFORE watching for the next one - otherwise the
            // only record of a restart is a pid that silently changed, which is exactly the
            // evidence that was missing on 2026-09-14/15.
            let log = log_path(cfg);
            match take_last_death() {
                Some(prev) => log_line(
                    &log,
                    &format!("respawn pid {pid}{mode} ({why}) - answering {prev}"),
                ),
                None => log_line(&log, &format!("spawn pid {pid}{mode} ({why})")),
            }
            // Before the watcher starts, so even an instant exit clears it again.
            CHILD_PID.store(pid, Ordering::SeqCst);
            watch_child(child, log, said);
            Some(pid)
        }
        Err(_) => None,
    }
}

/// The stderr log rolls to `.1` past this size, at a spawn only: a running daemon holds it open.
const STDERR_LOG_MAX: u64 = 4 * 1024 * 1024;
/// A wrapper that ends non-zero inside this long never got its daemon going, and what it wrote to
/// stderr is the reason, so the death line quotes it.
const FAILED_LAUNCH: Duration = Duration::from_secs(10);

/// WHERE A TRAY-STARTED DAEMON'S STDERR GOES: `<app home>/logs/daemon-stderr.log`, beside the
/// daemon's own daemon.log (the app home is the folder holding the runtime pointer).
///
/// It used to be NULL, and two things were lost with it. cmd.exe's own complaint when it cannot
/// start the command at all: AgentHydra, 2026-10-05, four revives each `exit code 1, up 0.0s` and
/// not one word of why (see `config::plain_path`). And a runtime's native crash report, which goes
/// to stderr and nowhere else: a daemon that ends that way never reaches its own log.
///
/// Returns the file, its path and the offset this launch starts writing at. None (and NULL, as
/// before) when the config names no folder for the pointer or the file cannot be opened: a witness,
/// never a dependency.
fn open_stderr_log(cfg: &Config, why: &str) -> Option<(std::fs::File, PathBuf, u64)> {
    let home = cfg
        .info_file
        .parent()
        .filter(|p| !p.as_os_str().is_empty())?;
    let dir = home.join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("daemon-stderr.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > STDERR_LOG_MAX) {
        let _ = std::fs::rename(&path, dir.join("daemon-stderr.log.1"));
    }
    // The command as CONFIGURED: its {TOKEN} placeholder is still a placeholder here.
    log_line(&path, &format!("-- {why}: {} --", cfg.start_command));
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()?;
    let from = file.metadata().map(|m| m.len()).unwrap_or(0);
    Some((file, path, from))
}

/// What one launch wrote to the stderr log, as one short line for the tray log.
fn stderr_since(path: &Path, from: u64) -> String {
    use std::io::{Seek, SeekFrom};
    let mut text = Vec::new();
    if let Ok(mut f) = std::fs::File::open(path) {
        if f.seek(SeekFrom::Start(from)).is_ok() {
            let _ = f.take(4096).read_to_end(&mut text);
        }
    }
    let line = String::from_utf8_lossy(&text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    line.chars().take(300).collect()
}

/// The last daemon death this process observed, so the NEXT spawn can name what it is answering.
/// A plain Mutex<Option<String>>: one writer per child thread, one reader per spawn, and a poisoned
/// lock here must never take the tray down - every access degrades to "no previous death".
static LAST_DEATH: Mutex<Option<String>> = Mutex::new(None);

fn take_last_death() -> Option<String> {
    LAST_DEATH.lock().ok()?.take()
}

/// Drop the recorded death once a live daemon has been seen after it: a self-update relaunch
/// answers its own wrapper's death, and a revive hours later must not claim that one.
pub fn forget_last_death() {
    let _ = take_last_death();
}

/// The pid of the daemon wrapper this process spawned, for as long as that wrapper runs; 0 once it
/// has exited. It lives here because only the thread watching the child knows when the pid stops
/// being ours, and every reader hands it to `taskkill /T /F`: a pid kept past its process's exit
/// can be reused by any process on the machine, and its whole tree would go with it.
pub static CHILD_PID: AtomicU32 = AtomicU32::new(0);

/// One line in the tray log, for the watchdog's own record.
pub fn tray_log(cfg: &Config, text: &str) {
    log_line(&log_path(cfg), text);
}

fn set_last_death(text: String) {
    if let Ok(mut slot) = LAST_DEATH.lock() {
        *slot = Some(text);
    }
}

/// Where the tray's own log lives: beside the rebuild log, under the script dir.
fn log_path(cfg: &Config) -> PathBuf {
    cfg.script_dir.join(&cfg.tray_log_name)
}

/// Append ONE line, best effort. A tray that cannot write its log still runs the app: this is a
/// witness, never a dependency, so every failure here is swallowed deliberately.
fn log_line(path: &Path, text: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{}] {text}", crate::win::local_timestamp());
    }
}

/// WATCH ONE DAEMON CHILD AND RECORD HOW IT DIED (owner ask, 2026-09-14/15).
///
/// AgentHydra's daemon died three times in one night (01:10Z, 04:23Z, 09:14:17Z, pids 79360 ->
/// 61040), was restarted within seconds, and left NOTHING behind: no `daemon.log` error, no Windows
/// Error Reporting entry naming the process, Task Scheduler history disabled. In-flight orchestrator
/// operations and a fan-out spawn were lost each time and the only evidence was a pid change.
/// AgentHydra's own crash-record covers what the JS process model can see; a process killed from
/// OUTSIDE it writes none of those, and the tray is the only witness left.
///
/// ⛔ `spawn` used to DROP the `Child`, which is why there was nothing to witness with: the exit
/// code existed for exactly as long as that value did. Holding it in a thread costs one parked
/// thread per daemon start and is the whole fix.
///
/// Two honest limits, stated rather than papered over:
/// * The child is the `cmd.exe /c` WRAPPER, not the daemon itself, so this reports the wrapper's
///   exit code. Under `/c` that is the command's own code, which is what we want - but a tree
///   killed with `taskkill /T` can take the wrapper down by its own route, so read the code as
///   "how the wrapper ended", not "what the daemon's last statement was".
/// * Windows has no signals; `ExitStatus::code()` is None only in exotic cases, and that is
///   reported as `unknown` rather than guessed at.
///
/// `said` is where this launch's stderr went and the offset it started at (`open_stderr_log`): a
/// launch that failed outright has its stderr quoted in the death line.
fn watch_child(mut child: std::process::Child, log: PathBuf, said: Option<(PathBuf, u64)>) {
    let started = Instant::now();
    let pid = child.id();
    std::thread::spawn(move || {
        let status = child.wait();
        // While `child` is alive its handle pins the pid, so clearing it here, before the handle
        // drops, closes the reuse window. Only this child's own pid is cleared: a newer spawn owns
        // the slot by now if it already holds a different one.
        let _ = CHILD_PID.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);
        let up = started.elapsed();
        let failed = !matches!(&status, Ok(s) if s.success());
        let how = match status {
            Ok(s) => match s.code() {
                Some(c) => format!("exit code {c}"),
                None => "exit code unknown (terminated without one)".to_string(),
            },
            Err(e) => format!("could not be waited on: {e}"),
        };
        let mut text = format!("death of pid {pid} ({how}, up {:.1}s)", up.as_secs_f64());
        if failed && up < FAILED_LAUNCH {
            let reason = said
                .map(|(path, from)| stderr_since(&path, from))
                .unwrap_or_default();
            if !reason.is_empty() {
                text.push_str(&format!(" - it said: {reason}"));
            }
        }
        // Slot first, line second: whoever sees the line can rely on the slot already holding it.
        set_last_death(text.clone());
        log_line(&log, &text);
    });
}

/// The daemon pid a witness thread is parked on; 0 for none.
static WITNESSED_PID: AtomicU32 = AtomicU32::new(0);

/// WITNESS THE DAEMON ITSELF, WHOEVER STARTED IT (owner ask, 2026-10-05).
///
/// `watch_child` sees only a wrapper this tray spawned. Most of the time the serving daemon is
/// not that: a self-update hands over to a successor created through WMI, and a daemon opened by
/// hand was never ours. AgentHydra's daemon ended three times in 36 hours with no last line, no
/// crash record and no Windows error event, each one such a successor, so the one fact that would
/// have told a native crash from an outside kill, its exit code, was held by nobody.
///
/// Called on every tick that finds the daemon answering. A pid already being watched costs one
/// pointer read; a new one is opened once and waited on in a parked thread, like `watch_child`.
pub fn witness(cfg: &Config) {
    let Some(pointer) = std::fs::read_to_string(&cfg.info_file)
        .ok()
        .and_then(|s| crate::json::parse(&s))
    else {
        return;
    };
    let pid = pointer.num_at("pid").map(|n| n as u32).unwrap_or(0);
    if pid == 0 || WITNESSED_PID.load(Ordering::SeqCst) == pid {
        return;
    }
    // A pointer can outlive its daemon, and a pid gets reused: only a pid whose OWN url answers as
    // this service is the daemon's.
    let answers = pointer
        .str_at("url")
        .and_then(split_url)
        .is_some_and(|(host, port)| health_ok(&host, port, &cfg.service_name, PROBE_POLL));
    if !answers {
        return;
    }
    // Stored even when the open fails, so a pid that cannot be opened is not retried every tick.
    WITNESSED_PID.store(pid, Ordering::SeqCst);
    if let Some(handle) = crate::win::open_for_exit(pid) {
        watch_pid(pid, handle, log_path(cfg));
    }
}

fn watch_pid(pid: u32, handle: usize, log: PathBuf) {
    let started = Instant::now();
    std::thread::spawn(move || {
        let code = crate::win::wait_for_exit(handle);
        let _ = WITNESSED_PID.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);
        let watched = started.elapsed().as_secs_f64();
        log_line(
            &log,
            &format!(
                "daemon pid {pid} ended ({}, watched {watched:.0}s)",
                describe_exit(code)
            ),
        );
    });
}

/// An exit code as Windows shows it (NTSTATUS values in hex), with what the common ones mean for
/// a process nobody was holding. The meaning is a reading aid, so it says "or" where a code has
/// two sources.
fn describe_exit(code: Option<u32>) -> String {
    let Some(code) = code else {
        return "exit code unknown".to_string();
    };
    let meaning = match code {
        0 => "a clean exit",
        1 => "its own exit(1), or ended from outside: taskkill /F and End task both leave 1",
        3 => "abort(), how a runtime's crash handler ends the process",
        0x4001_0004 => "ended by Windows at logoff or shutdown",
        0xC000_0005 => "access violation",
        0xC000_00FD => "stack overflow",
        0xC000_013A => "its console was closed, or Ctrl+C",
        0xC000_0409 => "fail-fast, a corrupted stack or heap",
        _ => "",
    };
    let shown = if code >= 0x4000_0000 {
        format!("0x{code:08X}")
    } else {
        code.to_string()
    };
    if meaning.is_empty() {
        format!("exit code {shown}")
    } else {
        format!("exit code {shown}: {meaning}")
    }
}

/// Wait for the daemon to come up and return the URL it ACTUALLY bound.
///
/// The interval RAMPS rather than sitting flat: this loop is the last thing between the daemon
/// being ready and the user's window opening, and once a daemon boots in ~120 ms a flat 250 ms grid
/// costs more on average than the boot it is waiting on.
pub fn wait_for_url(cfg: &Config, budget: Duration) -> Option<String> {
    let started = Instant::now();
    while started.elapsed() < budget {
        if let Some(u) = live_url(cfg, PROBE_POLL) {
            return Some(u);
        }
        let waited = started.elapsed().as_millis();
        let nap = if waited < 1000 {
            15
        } else if waited < 4000 {
            100
        } else {
            250
        };
        std::thread::sleep(Duration::from_millis(nap));
    }
    live_url(cfg, PROBE_POLL)
}

/// PIDs LISTENING on a port, via netstat (always present).
///
/// Plain `netstat -ano`, NOT `-p tcp`, so IPv4 and IPv6 listeners are both included. That omission
/// is deliberate in the original and must not be "cleaned up".
pub fn port_pids(port: u16) -> Vec<u32> {
    let Ok(out) = Command::new("netstat")
        .args(["-ano"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let suffix = format!(":{port}");
    let mut pids = Vec::new();
    for line in text.lines() {
        if !line.contains("LISTENING") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }
        if !parts[1].ends_with(&suffix) {
            continue;
        }
        if let Ok(pid) = parts[4].parse::<u32>() {
            if pid > 0 && !pids.contains(&pid) {
                pids.push(pid);
            }
        }
    }
    pids
}

pub fn taskkill(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

pub fn is_port_listening(port: u16) -> bool {
    !port_pids(port).is_empty()
}

/// Wait for the listen socket to actually release after a force-kill (Windows can hold it briefly),
/// so a follow-on start does not lose the port race. 150 ms grid, matching Wait-PortFree.
pub fn wait_port_free(port: u16, secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if !is_port_listening(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// Ask the daemon to shut itself down cleanly. Token-gated: only a daemon this session started
/// honours our token. Header names are `<prefix>-shutdown-token` / `<prefix>-shutdown-source`.
pub fn request_shutdown(cfg: &Config, url: &str, token: &str, timeout: Duration) -> bool {
    let Some(port) = port_of(url) else {
        return false;
    };
    let Some(addr) = resolve(&cfg.url_host, port) else {
        return false;
    };
    let Ok(mut sock) = TcpStream::connect_timeout(&addr, timeout) else {
        return false;
    };
    let _ = sock.set_read_timeout(Some(timeout));
    let _ = sock.set_write_timeout(Some(timeout));
    let req = format!(
        "POST /api/shutdown HTTP/1.1\r\nHost: {}:{port}\r\n{}: {token}\r\n{}: ui\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        cfg.url_host,
        cfg.shutdown_header("shutdown-token"),
        cfg.shutdown_header("shutdown-source"),
    );
    if sock.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut body = String::new();
    let _ = sock.read_to_string(&mut body);
    body.starts_with("HTTP/1.1 2") || body.starts_with("HTTP/1.0 2")
}

/// POST to an arbitrary path on the live daemon, for the optional app-action menu item.
/// Returns whether the daemon answered 2xx.
pub fn post(url: &str, path: &str, timeout: Duration) -> bool {
    let Some((host, port)) = split_url(url) else {
        return false;
    };
    let Some(addr) = resolve(&host, port) else {
        return false;
    };
    let Ok(mut sock) = TcpStream::connect_timeout(&addr, timeout) else {
        return false;
    };
    let _ = sock.set_read_timeout(Some(timeout));
    let _ = sock.set_write_timeout(Some(timeout));
    let req = format!(
        "POST {path} HTTP/1.1
Host: {host}:{port}
Content-Length: 0
Connection: close

"
    );
    if sock.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut body = String::new();
    let _ = sock.read_to_string(&mut body);
    body.starts_with("HTTP/1.1 2") || body.starts_with("HTTP/1.0 2")
}

/// Stop the live daemon, in the PowerShell host's two flavours.
///
/// Token flavour: graceful POST first (unless `skip_graceful`, which Quit sets because it already
/// ran its own bounded POST and a second 20s attempt would turn Quit into a ~30 s hang), then poll
/// 40x250 ms for it to go, then force-kill the port owners and settle 20x200 ms.
/// Force-kill flavour: straight to the kill, then settle 25x200 ms.
///
/// Both cover BOTH the preferred port and the pointer's actually-bound port, which is what handles
/// a daemon that hopped.
pub fn stop(cfg: &Config, token: &str, force_kill: bool, skip_graceful: bool) {
    let url = live_url(cfg, PROBE_POLL);
    let use_token = !token.is_empty();

    if use_token {
        let Some(url) = url.as_deref() else { return };
        if !force_kill {
            return; // only ever act on a daemon we own
        }
        if !skip_graceful && request_shutdown(cfg, url, token, Duration::from_secs(20)) {
            for _ in 0..40 {
                if live_url(cfg, PROBE_POLL).is_none() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        }
        kill_port_owners(cfg, url);
        for _ in 0..20 {
            if live_url(cfg, PROBE_POLL).is_none() {
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    } else {
        kill_port_owners(cfg, url.as_deref().unwrap_or(""));
        for _ in 0..25 {
            if live_url(cfg, PROBE_POLL).is_none() {
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

fn kill_port_owners(cfg: &Config, url: &str) {
    let mut ports = vec![cfg.port];
    if let Some(p) = port_of(url) {
        if p > 0 && !ports.contains(&p) {
            ports.push(p);
        }
    }
    for port in ports {
        if port == 0 {
            continue;
        }
        for pid in port_pids(port) {
            taskkill(pid);
        }
    }
}

#[cfg(test)]
mod death_record_tests {
    use super::*;

    /// Every watched death writes the one process-wide LAST_DEATH slot, and the test runner runs
    /// tests on parallel threads, so a test that reads the slot must not share it with another
    /// test's child dying at the same moment.
    static SLOT: Mutex<()> = Mutex::new(());

    /// A real short-lived process, so the exit code under test is Windows' own and not a fake.
    fn exiting_with(code: i32) -> std::process::Child {
        Command::new("cmd.exe")
            .raw_arg(format!("/c \"exit {code}\""))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("cmd.exe should spawn")
    }

    fn temp_log(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "lunarwerx-tray-test-{tag}-{}.log",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&p);
        p
    }

    /// Wait for the watcher thread to land its line. Polling beats a flat sleep: a wait on a
    /// process that has already exited returns in single-digit ms.
    fn wait_for_log(path: &PathBuf) -> String {
        for _ in 0..200 {
            if let Ok(s) = std::fs::read_to_string(path) {
                if !s.trim().is_empty() {
                    return s;
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        String::new()
    }

    #[test]
    fn a_dead_child_is_recorded_with_its_pid_exit_code_and_uptime() {
        let _slot = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        let log = temp_log("death");
        let child = exiting_with(3);
        let pid = child.id();
        watch_child(child, log.clone(), None);
        let body = wait_for_log(&log);
        // The whole point of the item: the pid, HOW it went, and how long it had been up - the
        // three facts that were missing when AgentHydra's daemon died three times in a night.
        assert!(body.contains(&format!("death of pid {pid}")), "got: {body}");
        assert!(body.contains("exit code 3"), "got: {body}");
        assert!(body.contains("up "), "got: {body}");
        // And a wall-clock stamp, so it can be lined up against Event Viewer.
        assert!(body.starts_with('['), "got: {body}");
        let _ = std::fs::remove_file(&log);
    }

    #[test]
    fn the_next_spawn_names_the_death_it_answers() {
        let _slot = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        let log = temp_log("answers");
        let child = exiting_with(1);
        let pid = child.id();
        watch_child(child, log.clone(), None);
        wait_for_log(&log);
        // take_last_death is what spawn() consults; it must carry the previous death exactly once.
        let first = take_last_death();
        assert!(
            first
                .as_deref()
                .unwrap_or("")
                .contains(&format!("pid {pid}")),
            "expected the death to be handed to the next spawn, got: {first:?}"
        );
        // Taken, not copied: a second spawn must not claim to answer a death already answered.
        assert!(take_last_death().is_none());
        let _ = std::fs::remove_file(&log);
    }

    /// A compiled release laid out as the zip is, under a folder whose name has a space:
    /// `<root>/App.exe` (a real Windows program that exits 0) and `<root>/misc/tray.json` with
    /// `appRoot: ".."`, so the root is resolved, and canonicalized, exactly as a release's is.
    fn release_tree(tag: &str, extra: &str) -> (PathBuf, Config) {
        let root =
            std::env::temp_dir().join(format!("lunarwerx tray {tag} {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("misc")).expect("temp tree");
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        std::fs::copy(
            Path::new(&system).join("System32").join("whoami.exe"),
            root.join("App.exe"),
        )
        .expect("whoami.exe should copy");
        let pointer = root
            .join("home")
            .join("runtime.json")
            .display()
            .to_string()
            .replace('\\', "\\\\");
        let config = root.join("misc").join("tray.json");
        std::fs::write(
            &config,
            format!(
                r#"{{ "displayName": "Test", "serviceName": "test", "mutexName": "TestTray",
                     "appRoot": "..", "compiledExe": "App.exe", "startCommand": "unused",
                     "infoFile": "{pointer}"{extra} }}"#
            ),
        )
        .expect("config");
        (root, Config::load(&config).expect("valid config"))
    }

    fn wait_for_line(path: &Path, needle: &str) -> String {
        for _ in 0..400 {
            if let Ok(s) = std::fs::read_to_string(path) {
                if s.contains(needle) {
                    return s;
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        std::fs::read_to_string(path).unwrap_or_default()
    }

    #[test]
    fn a_compiled_release_is_started_by_the_real_spawn() {
        // AgentHydra, 2026-10-05: every watchdog revive of the compiled exe ended `exit code 1, up
        // 0.0s`, because the command named it by the canonicalized root's \\?\ path, which cmd.exe
        // cannot run. Through spawn() itself, so the command line under test is the shipped one.
        let _slot = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        let (root, cfg) = release_tree("start", "");
        let pid = spawn(&cfg, "token", "test").expect("cmd.exe should spawn");
        let body = wait_for_line(&log_path(&cfg), &format!("death of pid {pid} "));
        assert!(
            body.contains(&format!("death of pid {pid} (exit code 0,")),
            "got: {body}"
        );
        let _ = take_last_death();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_launch_that_fails_outright_says_why_in_its_death_line() {
        // A program cmd.exe cannot find: before, the tray log held an exit code and nothing else.
        let _slot = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        let (root, cfg) = release_tree(
            "fails",
            r#", "startCommandCompiled": "\"{COMPILED}.missing\"""#,
        );
        let pid = spawn(&cfg, "token", "test").expect("cmd.exe should spawn");
        // By pid: a respawn line also says "death of pid", naming the death it answers.
        let body = wait_for_line(&log_path(&cfg), &format!("death of pid {pid} "));
        // cmd.exe names the program it could not run, in whatever language Windows speaks.
        let death = body
            .lines()
            .find(|l| l.contains(&format!("death of pid {pid} ")))
            .unwrap_or("");
        assert!(death.contains("exit code 1,"), "got: {body}");
        assert!(
            death.contains(" - it said: ") && death.contains("App.exe.missing"),
            "got: {body}"
        );
        // And the stderr log names the launch it belongs to, by the command as configured.
        let stderr =
            std::fs::read_to_string(root.join("home").join("logs").join("daemon-stderr.log"))
                .unwrap_or_default();
        assert!(stderr.contains("-- test: "), "got: {stderr}");
        let _ = take_last_death();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_daemon_this_tray_did_not_start_has_its_exit_code_recorded() {
        // The witness's own half: a real process, opened by pid alone as a relaunch successor is.
        let log = temp_log("witness");
        let child = exiting_with(7);
        let pid = child.id();
        let handle = crate::win::open_for_exit(pid).expect("a live child can be opened");
        watch_pid(pid, handle, log.clone());
        let body = wait_for_log(&log);
        assert!(
            body.contains(&format!("daemon pid {pid} ended (exit code 7,")),
            "got: {body}"
        );
        drop(child);
        let _ = std::fs::remove_file(&log);
    }

    #[test]
    fn an_exit_code_reads_as_windows_shows_it() {
        assert_eq!(describe_exit(Some(87)), "exit code 87");
        assert!(
            describe_exit(Some(0xC000_0005)).starts_with("exit code 0xC0000005: access violation")
        );
        assert!(describe_exit(Some(1)).starts_with("exit code 1: "));
        assert_eq!(describe_exit(None), "exit code unknown");
    }

    #[test]
    fn logging_never_panics_on_an_unwritable_path() {
        // A witness must never be a dependency: the tray keeps running the app regardless.
        let bad = PathBuf::from("Z:\no-such-drive\nested\tray.log");
        log_line(&bad, "this must not panic");
    }
}
