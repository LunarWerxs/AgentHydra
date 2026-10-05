//! The worker's wind-down hook, answered by its runner (what `serveSignal` and `pointSignalHook` in
//! server/src/climayte-signal.ts do for the Bun runner).
//!
//! The daemon writes the worker's signal file; the CLI shows it to the model through a PostToolUse
//! hook that runs after EVERY tool call. As an `http` hook that costs the CLI one POST to 127.0.0.1
//! and starts nothing, and an unreachable hook is a non-blocking error. The runner answers it
//! because it lives exactly as long as the worker: a daemon restart or stall cannot strand or slow
//! a running worker's hook. Before the CLI starts, the runner rewrites the settings file the daemon
//! wrote so the hook points here; until then, and if either step fails, the settings keep the
//! daemon's `cat` form, which costs more processes and loses nothing.

use crate::json::{self, Json};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Longest a tool call waits on the hook (SIGNAL_HOOK_TIMEOUT_S in climayte-signal.ts).
const HOOK_TIMEOUT_S: u32 = 3;
/// A request head larger than this is not the CLI's hook.
const MAX_HEAD: usize = 64 * 1024;
/// A hook input carries the tool's input and result, so it can be large; past this the connection
/// is dropped, which the CLI treats as a non-blocking hook error.
const MAX_BODY: usize = 64 * 1024 * 1024;
/// A client that stops sending is dropped after this, freeing its thread.
const IO_TIMEOUT: Duration = Duration::from_secs(10);

/// Binds a loopback port, points the worker's settings at it, then answers on a thread for as long
/// as this process lives. False, with no port held and the settings untouched, when either step
/// fails.
pub fn serve(signal_file: PathBuf, settings_file: &Path) -> bool {
    let Ok(listener) = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)) else {
        return false;
    };
    let Ok(port) = listener.local_addr().map(|a| a.port()) else {
        return false;
    };
    if !point_hook(settings_file, port) {
        return false;
    }
    let accept = move || {
        for conn in listener.incoming().flatten() {
            let file = signal_file.clone();
            // A thread per call: tool calls run in parallel, and one slow client must not hold up
            // the rest. When no thread can be had the connection is dropped, which the CLI treats
            // as a non-blocking hook error.
            let _ = std::thread::Builder::new().spawn(move || answer(conn, &file));
        }
    };
    std::thread::Builder::new().spawn(accept).is_ok()
}

/// Rewrites the worker's settings so its PostToolUse hook is an http hook at this port, keeping
/// every other key in its place. False, with the file untouched, when it cannot be read or parsed.
pub fn point_hook(settings_file: &Path, port: u16) -> bool {
    let Some(mut settings) = std::fs::read_to_string(settings_file)
        .ok()
        .and_then(|t| json::parse(&t))
    else {
        return false;
    };
    let hook = Json::obj(vec![
        ("matcher", Json::str("*")),
        (
            "hooks",
            Json::Arr(vec![Json::obj(vec![
                ("type", Json::str("http")),
                ("url", Json::str(format!("http://127.0.0.1:{port}/signal"))),
                ("timeout", Json::num(HOOK_TIMEOUT_S)),
            ])]),
        ),
    ]);
    let mut hooks = match settings.get("hooks") {
        Some(h @ Json::Obj(_)) => h.clone(),
        _ => Json::Obj(Vec::new()),
    };
    hooks.set("PostToolUse", Json::Arr(vec![hook]));
    settings.set("hooks", hooks)
        && std::fs::write(settings_file, json::to_string(&settings)).is_ok()
}

struct Request {
    /// Names lowercased, values trimmed.
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

fn answer(mut conn: TcpStream, signal_file: &Path) {
    let _ = conn.set_read_timeout(Some(IO_TIMEOUT));
    let _ = conn.set_write_timeout(Some(IO_TIMEOUT));
    let Some(req) = read_request(&mut conn) else {
        return;
    };
    let (status, body) = respond(&req, signal_file);
    let head = format!(
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let _ = conn
        .write_all(head.as_bytes())
        .and_then(|_| conn.write_all(body.as_bytes()));
    let _ = conn.flush();
    let _ = conn.shutdown(Shutdown::Write);
}

fn respond(req: &Request, signal_file: &Path) -> (&'static str, String) {
    if let Some(reason) = refused(req) {
        return (
            "403 Forbidden",
            format!("{{\"error\":\"forbidden: {reason}\"}}"),
        );
    }
    // A tool call inside one of the worker's sub-agents always gets `{}`: the handoff is the
    // worker's to write, and a sub-agent told to write it quits mid-task and overwrites the
    // worker's own (2026-10-04). The CLI sends `agent_id` only inside a sub-agent.
    if from_subagent(&req.body) {
        return ("200 OK", "{}".into());
    }
    // Read afresh each time, so the signal shows on every call from the moment it is written until
    // the file is removed. No file, or one caught half written: nothing to say.
    let body = std::fs::read(signal_file)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .filter(|t| json::parse(t).is_some())
        .unwrap_or_else(|| "{}".into());
    ("200 OK", body)
}

fn from_subagent(body: &[u8]) -> bool {
    std::str::from_utf8(body)
        .ok()
        .and_then(json::parse)
        .and_then(|input| {
            input
                .get("agent_id")
                .and_then(Json::as_str)
                .map(|id| !id.trim().is_empty())
        })
        .unwrap_or(false)
}

/// The guard every AgentHydra loopback server runs (server/src/loopback-guard.mjs), in its
/// exact-origin mode with an empty allowlist: a web page on any local port carries an Origin and is
/// refused, as is a browser's cross-site request or a rebinding Host. The CLI's hook sends none.
fn refused(req: &Request) -> Option<&'static str> {
    if req
        .header("sec-fetch-site")
        .is_some_and(|v| v.eq_ignore_ascii_case("cross-site"))
    {
        return Some("cross-site request rejected");
    }
    if req.header("origin").is_some_and(|v| !v.is_empty()) {
        return Some("origin not in allowlist");
    }
    if req
        .header("host")
        .is_some_and(|v| !v.is_empty() && !is_loopback_host(v))
    {
        return Some("non-loopback Host rejected");
    }
    None
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or(rest)
    } else {
        host.rsplit_once(':').map_or(host.as_str(), |(h, _)| h)
    };
    matches!(name, "127.0.0.1" | "localhost" | "::1")
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Reads more into `buf`; None at the end of the stream or on an error.
fn more(conn: &mut TcpStream, buf: &mut Vec<u8>) -> Option<()> {
    let mut chunk = [0u8; 16 * 1024];
    let n = conn.read(&mut chunk).ok()?;
    if n == 0 {
        return None;
    }
    buf.extend_from_slice(&chunk[..n]);
    Some(())
}

/// One whole request, its body read to the end: closing a socket with unread input resets it, and
/// the CLI would see its call fail.
fn read_request(conn: &mut TcpStream) -> Option<Request> {
    let mut buf = Vec::new();
    let head_end = loop {
        if let Some(i) = find(&buf, b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_HEAD {
            return None;
        }
        more(conn, &mut buf)?;
    };
    let head = std::str::from_utf8(&buf[..head_end]).ok()?;
    let headers: Vec<(String, String)> = head
        .split("\r\n")
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let req = Request {
        headers,
        body: Vec::new(),
    };
    let rest = buf[head_end + 4..].to_vec();
    if req
        .header("expect")
        .is_some_and(|v| v.eq_ignore_ascii_case("100-continue"))
    {
        conn.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").ok()?;
    }
    let chunked = req
        .header("transfer-encoding")
        .is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    let body = if chunked {
        read_chunked(conn, rest)?
    } else {
        let len: usize = match req.header("content-length") {
            Some(v) => v.parse().ok()?,
            None => 0,
        };
        if len > MAX_BODY {
            return None;
        }
        let mut body = rest;
        while body.len() < len {
            more(conn, &mut body)?;
        }
        body.truncate(len);
        body
    };
    Some(Request { body, ..req })
}

/// A chunked body (RFC 9112 section 7.1), decoded; trailers are read and ignored.
fn read_chunked(conn: &mut TcpStream, mut buf: Vec<u8>) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    let mut at = 0;
    loop {
        let line_end = line(conn, &mut buf, at)?;
        let size_text = std::str::from_utf8(&buf[at..line_end]).ok()?;
        let size_hex = size_text.split(';').next()?.trim();
        if size_hex.is_empty() || !size_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let size = usize::from_str_radix(size_hex, 16).ok()?;
        at = line_end + 2;
        if size == 0 {
            loop {
                let end = line(conn, &mut buf, at)?;
                let blank = end == at;
                at = end + 2;
                if blank {
                    return Some(body);
                }
            }
        }
        // The size is the client's to name, up to usize::MAX: compared without adding to it, so
        // it cannot wrap past the cap.
        if size > MAX_BODY - body.len() {
            return None;
        }
        while buf.len() < at + size + 2 {
            more(conn, &mut buf)?;
        }
        body.extend_from_slice(&buf[at..at + size]);
        at += size + 2;
    }
}

/// Where the next CRLF from `from` starts, reading more as needed.
fn line(conn: &mut TcpStream, buf: &mut Vec<u8>, from: usize) -> Option<usize> {
    loop {
        if let Some(i) = find(&buf[from..], b"\r\n") {
            return Some(from + i);
        }
        if buf.len() - from > MAX_HEAD {
            return None;
        }
        more(conn, buf)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_hosts_are_told_apart_from_others_as_the_guard_does() {
        for ok in [
            "127.0.0.1:7787",
            "localhost",
            "LOCALHOST:1",
            "[::1]:80",
            "[::1]",
            " 127.0.0.1 ",
        ] {
            assert!(is_loopback_host(ok), "{ok}");
        }
        for bad in [
            "evil.com",
            "evil.com:7787",
            "127.0.0.2",
            "::1",
            "localhost.evil.com",
            "",
        ] {
            assert!(!is_loopback_host(bad), "{bad}");
        }
    }

    /// Any local process can reach the port, and a panic aborts the runner, which ends the job and
    /// the worker's CLI with it.
    #[test]
    fn a_chunk_size_past_the_cap_drops_the_request_instead_of_overflowing() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        client
            .write_all(
                b"POST /signal HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nA\r\nffffffffffffffff\r\nX",
            )
            .unwrap();
        let (mut conn, _) = listener.accept().unwrap();
        assert!(read_request(&mut conn).is_none());
    }
}
