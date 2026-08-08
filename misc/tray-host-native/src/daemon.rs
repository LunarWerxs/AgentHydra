//! Starting, probing and stopping the app's daemon.
//!
//! Every rule here is carried over from Tray-Host.ps1 rather than re-derived, including the poll
//! counts and sleeps, because several of them exist to survive a specific failure that was seen in
//! production. Where a constant looks arbitrary it is quoted with its origin.

use crate::config::Config;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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
    if let Some(port) = pointer.as_ref().and_then(|v| v.num_at("port")).map(|p| p as u16) {
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
/// * Stdio is NULL, never inherited. A tray started from a terminal otherwise hands the daemon that
///   terminal's pipes; nothing drains them, the buffer fills, and the daemon blocks on a console
///   write BEFORE it binds its port. Observed: a live process with no listening socket and no
///   runtime pointer. The daemon tees its own output to logs/daemon.log, so nothing is lost.
pub fn spawn(cfg: &Config, token: &str) -> Option<u32> {
    let command = cfg.resolved_start_command(token);
    let mut cmd = Command::new("cmd.exe");
    cmd.raw_arg(format!("/c \"{command}\""))
        .current_dir(&cfg.app_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    for (k, v) in cfg.resolved_start_env(token) {
        cmd.env(k, v);
    }
    match cmd.spawn() {
        Ok(child) => Some(child.id()),
        Err(_) => None,
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
