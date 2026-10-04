//! zscan: the Claude Code transcript scanner behind `hswarm savings`, as a native binary.
//!
//! Same algorithm, same numbers as hswarm/claude_usage.py (the reference): walk a projects tree, take
//! every .jsonl written since the window opened (main transcripts before sub-agent ones), look only at
//! the lines carrying "usage", skip a requestId an earlier file counted without parsing it, count each request
//! once at its fullest line (the largest output_tokens of its streamed lines), bucket by LOCAL day, price
//! at the table read from stdin, and report per day the USD split main loop vs sub-agents plus every sub-agent's USD and token buckets. Nothing is rounded here: the
//! Python side rounds, so every arm prints the same digits.
//!
//!   zscan --root <dir> --since YYYY-MM-DD --until YYYY-MM-DD [--threads N]  < prices.json
//!
//! prices.json: [{"prefix": "claude-sonnet-5", "in": 2.0, "out": 10.0, "read_x": 0.1}, ...], first
//! matching prefix wins. With --threads N the files are read by N workers and folded in file order,
//! so the result is identical to the single-threaded scan.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf, MAIN_SEPARATOR};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::UNIX_EPOCH;

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone};
use memchr::memmem;
use serde::Deserialize;
use serde_json::{json, Map, Value};

const USAGE_NEEDLE: &[u8] = b"\"usage\"";
const RID_NEEDLE: &[u8] = b"\"requestId\":\"";
const FAMILIES: [&str; 4] = ["sonnet", "opus", "fable", "haiku"];

#[derive(Deserialize)]
struct Price {
    prefix: String,
    #[serde(rename = "in")]
    inp: f64,
    out: f64,
    read_x: f64,
}

/// Only the fields the scan reads; serde skips the rest (the message content, which is most of a line).
#[derive(Deserialize)]
struct Rec {
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    timestamp: Option<String>,
    message: Option<Msg>,
}

#[derive(Deserialize)]
struct Msg {
    id: Option<String>,
    model: Option<Value>,
    usage: Option<Value>,
}

#[derive(Clone, Copy, Default)]
struct Toks {
    input: i64,
    cache_read: i64,
    cache_5m: i64,
    cache_1h: i64,
    output: i64,
}

impl Toks {
    fn add(&mut self, o: &Toks) {
        self.input += o.input;
        self.cache_read += o.cache_read;
        self.cache_5m += o.cache_5m;
        self.cache_1h += o.cache_1h;
        self.output += o.output;
    }

    /// The five buckets alone, as every day, model and session reports them.
    fn buckets(&self) -> Value {
        json!({"input": self.input, "cache_read": self.cache_read, "cache_5m": self.cache_5m, "cache_1h": self.cache_1h, "output": self.output})
    }

    fn json(&self, a: &Agent) -> Value {
        json!({"input": self.input, "cache_read": self.cache_read, "cache_5m": self.cache_5m, "cache_1h": self.cache_1h, "output": self.output, "requests": a.requests,
               "model": a.model, "session": a.session, "started": a.started, "workflow": a.workflow, "usd": a.usd})
    }
}

/// One accepted record, before the global dedupe and the day filter.
struct Raw {
    rid: String,
    day: Option<String>,
    model: String,
    toks: Toks,
    ts: String,
}

struct Agent {
    day: String,
    family: String,
    model: String,
    session: String,
    started: String,
    workflow: bool,
    usd: f64,
    toks: Toks,
    requests: u64,
}

/// The FULL session id a transcript belongs to: the file stem for a main transcript, the directory after the
/// project slug for a sub-agent one. Full, not shortened, because an account is looked up by it (accounts.py).
fn session_of(path: &str, sub: bool) -> String {
    let parts: Vec<&str> = path.split(['\\', '/']).collect();
    if !sub {
        return parts
            .last()
            .map(|f| f.strip_suffix(".jsonl").unwrap_or(f).to_string())
            .unwrap_or_default();
    }
    match parts.iter().position(|p| *p == "projects") {
        Some(i) if parts.len() > i + 2 => parts[i + 2].to_string(),
        _ => String::new(),
    }
}

/// The session a sub-agent transcript belongs to, as the rule check matches it: the first 8 characters.
fn agent_session(path: &str) -> String {
    session_of(path, true).chars().take(8).collect()
}

/// Per model id, per day: requests, the USD split main loop vs sub-agents, and how many sub-agents ran on it.
#[derive(Default)]
struct ModelAgg {
    requests: u64,
    usd: f64,
    main_usd: f64,
    sub_usd: f64,
    agents: u64,
    toks: Toks,
}

/// Per session id, per day: what one chat ran. A session is what an account is recognised by (accounts.py).
#[derive(Default)]
struct SessionAgg {
    usd: f64,
    requests: u64,
    toks: Toks,
}

#[derive(Default)]
struct Day {
    claude_usd: f64,
    main_usd: f64,
    sub_usd: f64,
    requests: u64,
    unpriced: u64,
    agents: Vec<usize>, // indexes into Collector.agents, in first-seen order
    by_model: BTreeMap<String, ModelAgg>,
    toks: Toks,
    by_session: BTreeMap<String, SessionAgg>,
}

#[derive(Default, Clone, Copy)]
struct Stats {
    files: u64,
    candidates: u64,
    parsed: u64,
    records: u64,
}

fn n(u: &Map<String, Value>, k: &str) -> i64 {
    u.get(k).and_then(Value::as_i64).unwrap_or(0)
}

/// The five billable buckets, and whether any raw token field is non-zero (a zero usage line is skipped).
fn tokens(u: &Map<String, Value>) -> (Toks, bool) {
    let create = n(u, "cache_creation_input_tokens");
    let w1h = u
        .get("cache_creation")
        .and_then(Value::as_object)
        .map(|c| n(c, "ephemeral_1h_input_tokens"))
        .unwrap_or(0);
    let t = Toks {
        input: n(u, "input_tokens"),
        cache_read: n(u, "cache_read_input_tokens"),
        cache_5m: (create - w1h).max(0),
        cache_1h: w1h,
        output: n(u, "output_tokens"),
    };
    let any = t.input != 0 || t.cache_read != 0 || create != 0 || t.output != 0;
    (t, any)
}

/// Same arithmetic, same order as claude_usage.price_tokens, so the floats agree bit for bit.
fn price(prices: &[Price], model: &str, t: &Toks) -> Option<f64> {
    let p = prices.iter().find(|p| model.starts_with(&p.prefix))?;
    let weighted_in = t.input as f64
        + t.cache_read as f64 * p.read_x
        + t.cache_5m as f64 * 1.25
        + t.cache_1h as f64 * 2.0;
    Some((weighted_in * p.inp + t.output as f64 * p.out) / 1_000_000.0)
}

fn family(model: &str) -> String {
    FAMILIES
        .iter()
        .find(|f| model.contains(*f))
        .map(|s| s.to_string())
        .unwrap_or_else(|| "other".to_string())
}

/// The requestId without a JSON parse: replayed history is most of the corpus and is skipped on sight.
fn quick_rid(buf: &[u8]) -> Option<&[u8]> {
    let i = memmem::find(buf, RID_NEEDLE)?;
    let start = i + RID_NEEDLE.len();
    let end = memchr::memchr(b'"', &buf[start..])?;
    Some(&buf[start..start + end])
}

fn parse_day(ts: &str) -> Option<String> {
    if let Ok(d) = DateTime::parse_from_rfc3339(ts) {
        return Some(d.with_timezone(&Local).date_naive().to_string());
    }
    // A stamp with no zone is local time, which is how datetime.fromisoformat().astimezone() reads it.
    for fmt in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
    ] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(ts, fmt) {
            return Local
                .from_local_datetime(&naive)
                .earliest()
                .map(|d| d.date_naive().to_string());
        }
    }
    None
}

/// Parsing every timestamp is the hot path; a minute always maps to one local day (same cache as the reference).
fn local_day(cache: &mut HashMap<String, Option<String>>, ts: &str) -> Option<String> {
    let key = if ts.len() > 16 && ts.is_char_boundary(16) {
        &ts[..16]
    } else {
        ts
    };
    if let Some(v) = cache.get(key) {
        return v.clone();
    }
    let v = parse_day(ts);
    cache.insert(key.to_string(), v.clone());
    v
}

fn parse_candidate(
    buf: &[u8],
    day_cache: &mut HashMap<String, Option<String>>,
    stats: &mut Stats,
) -> Option<Raw> {
    stats.parsed += 1;
    let text = String::from_utf8_lossy(buf);
    let rec: Rec = serde_json::from_str(&text).ok()?;
    let msg = rec.message?;
    let usage = msg.usage.as_ref()?.as_object()?;
    let rid = rec
        .request_id
        .filter(|s| !s.is_empty())
        .or_else(|| msg.id.clone().filter(|s| !s.is_empty()))?;
    let (toks, any) = tokens(usage);
    if !any {
        return None;
    }
    let ts = rec.timestamp.unwrap_or_default();
    let day = local_day(day_cache, &ts);
    let model = msg
        .model
        .as_ref()
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Some(Raw {
        rid,
        day,
        model,
        toks,
        ts,
    })
}

struct Collector {
    since: String,
    until: String,
    prices: Vec<Price>,
    seen: HashSet<Vec<u8>>,
    days: BTreeMap<String, Day>,
    agents: Vec<Agent>,
    agent_idx: HashMap<String, usize>,
    stats: Stats,
}

impl Collector {
    fn apply(&mut self, r: Raw, agent: Option<&str>, session: &str) {
        if self.seen.contains(r.rid.as_bytes()) {
            return;
        }
        let day = match r.day {
            Some(d) => d,
            None => return,
        };
        if day.as_str() < self.since.as_str() || day.as_str() > self.until.as_str() {
            return;
        }
        self.seen.insert(r.rid.into_bytes());
        self.stats.records += 1;
        let d = self.days.entry(day.clone()).or_default();
        d.requests += 1;
        let m = d.by_model.entry(r.model.clone()).or_default();
        m.requests += 1;
        // Tokens are counted before the price: a model with no list price still ran them.
        d.toks.add(&r.toks);
        m.toks.add(&r.toks);
        let named = !session.is_empty();
        if named {
            let s = d.by_session.entry(session.to_string()).or_default();
            s.requests += 1;
            s.toks.add(&r.toks);
        }
        let usd = match price(&self.prices, &r.model, &r.toks) {
            Some(u) => u,
            None => {
                d.unpriced += 1;
                return;
            }
        };
        d.claude_usd += usd;
        m.usd += usd;
        if named {
            if let Some(s) = d.by_session.get_mut(session) {
                s.usd += usd;
            }
        }
        if agent.is_some() {
            d.sub_usd += usd;
            m.sub_usd += usd;
        } else {
            d.main_usd += usd;
            m.main_usd += usd;
        }
        if let Some(path) = agent {
            let idx = match self.agent_idx.get(path) {
                Some(&i) => i,
                None => {
                    let sep = format!("{}workflows{}", MAIN_SEPARATOR, MAIN_SEPARATOR);
                    self.agents.push(Agent {
                        day,
                        family: family(&r.model),
                        model: r.model.clone(),
                        session: agent_session(path),
                        started: r.ts.clone(),
                        workflow: path.contains(&sep),
                        usd: 0.0,
                        toks: Toks::default(),
                        requests: 0,
                    });
                    let i = self.agents.len() - 1;
                    self.agent_idx.insert(path.to_string(), i);
                    i
                }
            };
            let a = &mut self.agents[idx];
            a.usd += usd;
            a.toks.add(&r.toks);
            a.requests += 1;
        }
    }

    /// The single-threaded scan: one file at a time through the same extraction the parallel arm uses, the
    /// global seen-set (requests earlier files counted) skipping replayed lines before they are parsed.
    fn read_file(&mut self, path: &Path, agent: Option<&str>, session: &str) {
        let raws = extract_file(
            path,
            &self.since,
            &self.until,
            Some(&self.seen),
            &mut self.stats,
        );
        for r in raws {
            self.apply(r, agent, session);
        }
    }

    fn finish(&mut self) {
        for (i, a) in self.agents.iter().enumerate() {
            if let Some(d) = self.days.get_mut(&a.day) {
                d.agents.push(i);
                d.by_model.entry(a.model.clone()).or_default().agents += 1;
            }
        }
    }

    fn output(&self, threads: usize) -> Value {
        let mut days = Map::new();
        for (day, d) in &self.days {
            let mut agents: Map<String, Value> = Map::new();
            let mut agent_tokens: Map<String, Value> = Map::new();
            for &i in &d.agents {
                let a = &self.agents[i];
                agents
                    .entry(a.family.clone())
                    .or_insert_with(|| Value::Array(vec![]))
                    .as_array_mut()
                    .unwrap()
                    .push(json!(a.usd));
                agent_tokens
                    .entry(a.family.clone())
                    .or_insert_with(|| Value::Array(vec![]))
                    .as_array_mut()
                    .unwrap()
                    .push(a.toks.json(a));
            }
            let mut by_model: Map<String, Value> = Map::new();
            for (model, m) in &d.by_model {
                by_model.insert(model.clone(), json!({"requests": m.requests, "usd": m.usd, "main_usd": m.main_usd, "sub_usd": m.sub_usd,
                                                      "agents": m.agents, "tokens": m.toks.buckets()}));
            }
            let mut by_session: Map<String, Value> = Map::new();
            for (sid, s) in &d.by_session {
                by_session.insert(
                    sid.clone(),
                    json!({"usd": s.usd, "requests": s.requests, "tokens": s.toks.buckets()}),
                );
            }
            days.insert(day.clone(), json!({
                "claude_usd": d.claude_usd, "main_usd": d.main_usd, "sub_usd": d.sub_usd,
                "requests": d.requests, "unpriced_requests": d.unpriced, "agents": agents, "agent_tokens": agent_tokens, "by_model": by_model,
                "tokens": d.toks.buckets(), "by_session": by_session,
            }));
        }
        json!({
            "days": days, "threads": threads,
            "stats": {"files": self.stats.files, "candidates": self.stats.candidates, "parsed": self.stats.parsed, "records": self.stats.records},
        })
    }
}

/// One file's requests, each at its fullest line. A streamed request is several lines with one requestId: the
/// first is written when the reply starts and carries a placeholder output_tokens (8, say), the last the final
/// count, so a request is billed at its largest output (as the reference, usage-tokens.ts and the analytics kit
/// count it) and the whole file is read before anything is counted. `global` holds the requests earlier files
/// counted (the fold in file order; None for the parallel arm, which folds afterwards): a replayed line is
/// skipped before it is parsed.
///
/// The window is applied HERE as well, because the local dedupe must see exactly what the global one does: a
/// record outside the window is dropped by the fold without marking its id as seen, so if it were allowed to
/// claim the id here, a LATER line replaying that same request inside the window would be skipped before it was
/// ever parsed and the request would vanish from the parallel arm only. That cost 3 requests and $1.83 of a
/// real day, deterministically, and both native arms had it (found by the A/B, 2026-09-17).
fn extract_file(
    path: &Path,
    since: &str,
    until: &str,
    global: Option<&HashSet<Vec<u8>>>,
    stats: &mut Stats,
) -> Vec<Raw> {
    stats.files += 1;
    let mut out: Vec<Raw> = Vec::new();
    let f = match File::open(path) {
        Ok(f) => f,
        Err(_) => return out,
    };
    let mut rd = BufReader::with_capacity(1 << 20, f);
    let mut buf: Vec<u8> = Vec::with_capacity(1 << 16);
    let mut at: HashMap<String, usize> = HashMap::new(); // request id -> its place in `out`
    let mut day_cache = HashMap::new();
    loop {
        buf.clear();
        match rd.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if memmem::find(&buf, USAGE_NEEDLE).is_none() {
            continue;
        }
        stats.candidates += 1;
        if let (Some(g), Some(q)) = (global, quick_rid(&buf)) {
            if g.contains(q) {
                continue;
            }
        }
        if let Some(raw) = parse_candidate(&buf, &mut day_cache, stats) {
            let in_window = raw.day.as_deref().is_some_and(|d| d >= since && d <= until);
            if !in_window {
                continue; // the fold will drop it too, and it must not claim the id a later replay needs
            }
            match at.get(&raw.rid) {
                Some(&i) => {
                    if raw.toks.output > out[i].toks.output {
                        out[i] = raw;
                    }
                }
                None => {
                    at.insert(raw.rid.clone(), out.len());
                    out.push(raw);
                }
            }
        }
    }
    out
}

/// Every .jsonl under root written since since_ts: main transcripts first, then sub-agent ones.
fn list_files(root: &Path, since_ts: f64) -> Vec<(PathBuf, bool)> {
    let sep = format!("{}subagents{}", MAIN_SEPARATOR, MAIN_SEPARATOR);
    let mut main = Vec::new();
    let mut sub = Vec::new();
    for e in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !e.file_type().is_file() || !e.file_name().to_string_lossy().ends_with(".jsonl") {
            continue;
        }
        let fresh = e
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() >= since_ts)
            .unwrap_or(false);
        if !fresh {
            continue;
        }
        let p = e.into_path();
        if p.to_string_lossy().contains(&sep) {
            sub.push(p);
        } else {
            main.push(p);
        }
    }
    main.into_iter()
        .map(|p| (p, false))
        .chain(sub.into_iter().map(|p| (p, true)))
        .collect()
}

fn scan_parallel(coll: &mut Collector, files: &[(PathBuf, bool)], threads: usize) {
    let queue = Arc::new(Mutex::new(0usize));
    let paths: Arc<Vec<PathBuf>> = Arc::new(files.iter().map(|(p, _)| p.clone()).collect());
    let (since, until) = (Arc::new(coll.since.clone()), Arc::new(coll.until.clone()));
    let (tx, rx) = mpsc::channel::<(usize, Vec<Raw>, Stats)>();
    for _ in 0..threads {
        let (queue, paths, tx) = (queue.clone(), paths.clone(), tx.clone());
        let (since, until) = (since.clone(), until.clone());
        thread::spawn(move || loop {
            let i = {
                let mut next = queue.lock().unwrap();
                if *next >= paths.len() {
                    break;
                }
                let i = *next;
                *next += 1;
                i
            };
            let mut st = Stats::default();
            let raws = extract_file(&paths[i], &since, &until, None, &mut st);
            if tx.send((i, raws, st)).is_err() {
                break;
            }
        });
    }
    drop(tx);
    // Fold strictly in file order (main before sub, walk order within), holding only the files that arrived early.
    let mut pending: BTreeMap<usize, Vec<Raw>> = BTreeMap::new();
    let mut next = 0usize;
    for (i, raws, st) in rx {
        coll.stats.files += st.files;
        coll.stats.candidates += st.candidates;
        coll.stats.parsed += st.parsed;
        pending.insert(i, raws);
        while let Some(raws) = pending.remove(&next) {
            let path = files[next].0.to_string_lossy().into_owned();
            let session = session_of(&path, files[next].1);
            let agent = if files[next].1 { Some(path) } else { None };
            for r in raws {
                coll.apply(r, agent.as_deref(), &session);
            }
            next += 1;
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (mut root, mut since, mut until, mut threads) =
        (String::new(), String::new(), String::new(), 1usize);
    let mut i = 1;
    while i + 1 < args.len() {
        match args[i].as_str() {
            "--root" => root = args[i + 1].clone(),
            "--since" => since = args[i + 1].clone(),
            "--until" => until = args[i + 1].clone(),
            "--threads" => threads = args[i + 1].parse().unwrap_or(1).max(1),
            other => {
                eprintln!("zscan: unknown argument {other}");
                std::process::exit(2);
            }
        }
        i += 2;
    }
    if root.is_empty() || since.is_empty() || until.is_empty() {
        eprintln!("usage: zscan --root <dir> --since YYYY-MM-DD --until YYYY-MM-DD [--threads N] < prices.json");
        std::process::exit(2);
    }
    let mut prices_json = String::new();
    io::stdin()
        .read_to_string(&mut prices_json)
        .expect("prices on stdin");
    let prices: Vec<Price> = serde_json::from_str(&prices_json)
        .expect("prices: a JSON list of {prefix, in, out, read_x}");
    let since_date = NaiveDate::parse_from_str(&since, "%Y-%m-%d").expect("--since YYYY-MM-DD");
    let since_ts = Local
        .from_local_datetime(&since_date.and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .expect("local midnight")
        .timestamp() as f64;
    let root_path = std::fs::canonicalize(&root).unwrap_or_else(|_| PathBuf::from(&root));
    let files = list_files(&root_path, since_ts);
    let mut coll = Collector {
        since,
        until,
        prices,
        seen: HashSet::new(),
        days: BTreeMap::new(),
        agents: Vec::new(),
        agent_idx: HashMap::new(),
        stats: Stats::default(),
    };
    if threads <= 1 {
        for (p, sub) in &files {
            let path = p.to_string_lossy().into_owned();
            let session = session_of(&path, *sub);
            let agent = if *sub { Some(path) } else { None };
            coll.read_file(p, agent.as_deref(), &session);
        }
    } else {
        scan_parallel(&mut coll, &files, threads);
    }
    coll.finish();
    let out = serde_json::to_string(&coll.output(threads)).unwrap();
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    lock.write_all(out.as_bytes()).unwrap();
    lock.write_all(b"\n").unwrap();
}
