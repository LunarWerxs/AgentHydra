//! lunarwerx-tray — the native tray host.
//!
//! A port of misc/Tray-Host.ps1, which did its job well but cost ~520 ms of Windows script-host
//! overhead before the daemon process was even created: ~154 ms for wscript.exe plus the .vbs that
//! existed only to suppress a console flash, then ~370 ms for powershell.exe to boot the CLR,
//! Add-Type WinForms and System.Drawing, and parse 1,215 lines. None of that is the app. This
//! binary starts the daemon at ~27 ms instead, and deletes the .vbs outright because
//! CREATE_NO_WINDOW suppresses the console directly.
//!
//! Behaviour is ported, not redesigned. Every interval, retry count and threshold below is the
//! PowerShell host's, because several of them exist to survive a specific production failure (see
//! the comments at each one). The one deliberate change is ORDER: the daemon is spawned before the
//! icon and menu are built, so its boot overlaps our setup instead of queueing behind it.

#![windows_subsystem = "windows"]

mod browser;
mod config;
mod daemon;
mod json;
mod sha256;
mod win;

use config::{Config, StrayPolicy};
use std::cell::RefCell;
use std::path::PathBuf;
use std::ptr::null_mut;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use win::*;

// --- menu ids ---------------------------------------------------------------------------------
const ID_OPEN: usize = 1;
const ID_REBUILD: usize = 2;
const ID_RESTART: usize = 3;
const ID_QUIT: usize = 4;
/// Optional per-app extra item (see Config::action_path).
const ID_ACTION: usize = 5;

// --- timers -----------------------------------------------------------------------------------
const TIMER_HEALTH: usize = 1;
const TIMER_SENTINEL: usize = 2;
/// Health-probe cadence. PowerShell: `$healthTimer.Interval = 5000`.
const HEALTH_INTERVAL_MS: u32 = 5_000;
/// Sentinel-file cadence. PowerShell: `$watchTimer.Interval = 500`.
const SENTINEL_INTERVAL_MS: u32 = 500;

// --- watchdog thresholds (all from Tray-Host.ps1) ----------------------------------------------
/// CONSECUTIVE failed probes before a daemon counts as dead. Must be > 1: a single miss is a
/// hiccup, and reviving on one turns a slow tick into a spurious restart.
const REVIVE_AFTER_MISSES: u32 = 3;
/// After firing a relaunch, wait this long for it to bind before considering another.
const REVIVE_GRACE: Duration = Duration::from_secs(20);
/// Crash-loop guard: this many restarts inside the window pauses auto-restart entirely.
const CRASH_LOOP_MAX: usize = 4;
const CRASH_LOOP_WINDOW: Duration = Duration::from_secs(120);

// --- worker outcomes (passed back through WM_APP_WORKER_DONE's wParam) --------------------------
const WORK_OK_READY: usize = 0;
const WORK_OK_NOT_READY: usize = 1;
const WORK_BUILD_FAILED: usize = 2;
const WORK_CANCELED: usize = 3;
const WORK_ACTION_OK: usize = 4;
const WORK_ACTION_FAILED: usize = 5;
const WORK_ACTION_NO_DAEMON: usize = 6;

struct App {
    cfg: Config,
    token: String,
    url: Mutex<Option<String>>,
    started_by_us: AtomicBool,
    intentional_stop: AtomicBool,
    busy: AtomicBool,
    quitting: AtomicBool,
    auto_restart_paused: AtomicBool,
    health_misses: AtomicU32,
    revive_grace_until: Mutex<Option<Instant>>,
    restart_times: Mutex<Vec<Instant>>,
    /// Set by Quit so an in-flight worker stops instead of resurrecting what we are closing.
    cancel: AtomicBool,
    build_pid: AtomicU32,
    server_pid: AtomicU32,
    /// True when the last worker was a rebuild (so a successful finish re-opens the UI).
    was_rebuild: AtomicBool,
}

static APP: OnceLock<App> = OnceLock::new();
fn app() -> &'static App {
    APP.get().expect("app initialised")
}

/// UI-thread-only handles. The window procedure and every timer tick run on this thread, and
/// nothing else may touch these, which is why they live in a thread-local rather than a global.
struct Ui {
    nid: NOTIFYICONDATAW,
    mutex: HANDLE,
}
thread_local! {
    static UI: RefCell<Option<Ui>> = const { RefCell::new(None) };
}

fn set_url(url: Option<String>) {
    *app().url.lock().unwrap() = url;
}
fn get_url() -> Option<String> {
    app().url.lock().unwrap().clone()
}

// --- tray plumbing -----------------------------------------------------------------------------

fn balloon(text: &str, flag: u32) {
    UI.with(|ui| {
        let mut slot = ui.borrow_mut();
        let Some(ui) = slot.as_mut() else { return };
        ui.nid.uFlags = NIF_INFO;
        ui.nid.dwInfoFlags = flag;
        fill(&mut ui.nid.szInfoTitle, &app().cfg.display_name);
        fill(&mut ui.nid.szInfo, text);
        unsafe { Shell_NotifyIconW(NIM_MODIFY, &mut ui.nid) };
        // Restore the steady-state flags so a later MODIFY (e.g. the visibility sync) does not
        // re-fire the balloon.
        ui.nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    });
}

/// Live-sync the icon's visibility from the runtime pointer, so flipping "hide tray icon" in the
/// web UI takes effect within one tick without restarting anything.
///
/// Windows has no "hide a NotifyIcon" call, so hiding is DELETE and showing is ADD; the tray data
/// itself is kept either way, because the menu, the timers and Quit all hang off it.
fn sync_icon_visibility() {
    let hidden = std::fs::read_to_string(&app().cfg.info_file)
        .ok()
        .and_then(|s| json::parse(&s))
        .map(|v| v.flag_at("hideTrayIcon"))
        .unwrap_or(false);
    UI.with(|ui| {
        let mut slot = ui.borrow_mut();
        let Some(ui) = slot.as_mut() else { return };
        static SHOWN: AtomicBool = AtomicBool::new(true);
        let shown = SHOWN.load(Ordering::Relaxed);
        if hidden && shown {
            unsafe { Shell_NotifyIconW(NIM_DELETE, &mut ui.nid) };
            SHOWN.store(false, Ordering::Relaxed);
        } else if !hidden && !shown {
            unsafe { Shell_NotifyIconW(NIM_ADD, &mut ui.nid) };
            SHOWN.store(true, Ordering::Relaxed);
        }
    });
}

unsafe fn show_menu(hwnd: HWND) {
    let a = app();
    let menu = CreatePopupMenu();
    let busy = a.busy.load(Ordering::Relaxed);
    let grey = if busy { MF_GRAYED } else { 0 };

    let open = wide(&a.cfg.menu_open_label);
    AppendMenuW(menu, MF_STRING, ID_OPEN, open.as_ptr());
    // "Rebuild & Restart" only exists in a dev tree: a distributed build ships no source, so
    // rebuilding there could only fail. Triple-gated, exactly as before (menu, dispatch, worker).
    if a.cfg.is_dev_tree && a.cfg.rebuild_command.is_some() {
        let rebuild = wide("Rebuild && Restart");
        AppendMenuW(menu, MF_STRING | grey, ID_REBUILD, rebuild.as_ptr());
    }
    let restart = wide("Restart");
    AppendMenuW(menu, MF_STRING | grey, ID_RESTART, restart.as_ptr());
    // The app-action item, for apps that supervise WORK the daemon owns rather than just the
    // daemon itself: Restart and Quit act on the daemon, this acts on what the daemon is running.
    if a.cfg.action_path.is_some() {
        let label = wide(&a.cfg.action_label);
        AppendMenuW(menu, MF_STRING | grey, ID_ACTION, label.as_ptr());
    }
    AppendMenuW(menu, MF_SEPARATOR, 0, null_mut());
    let quit = wide("Quit");
    AppendMenuW(menu, MF_STRING, ID_QUIT, quit.as_ptr());

    let mut pt = POINT::default();
    GetCursorPos(&mut pt);
    // Required, or the menu never dismisses when focus moves elsewhere.
    SetForegroundWindow(hwnd);
    TrackPopupMenu(menu, TPM_RIGHTBUTTON, pt.x, pt.y, 0, hwnd, null_mut());
    DestroyMenu(menu);
}

fn open_current_ui() {
    match get_url() {
        Some(url) => browser::open_ui(&app().cfg, &url),
        None => balloon(
            &format!("{} isn't running.", app().cfg.display_name),
            NIIF_WARNING,
        ),
    }
}

// --- background worker (Rebuild & Restart / Restart) -------------------------------------------

/// Run the rebuild (optional) and the daemon restart off the UI thread, then post the outcome back.
///
/// The UI thread must never block on this: a rebuild is a full `bun run build`, and a stop can take
/// seconds waiting out a graceful shutdown.
fn start_worker(hwnd: HWND, rebuild: bool) {
    let a = app();
    if a.busy.swap(true, Ordering::SeqCst) {
        return; // one at a time
    }
    // A manual Restart is the operator saying "try again", so it clears the crash-loop pause.
    a.auto_restart_paused.store(false, Ordering::Relaxed);
    a.restart_times.lock().unwrap().clear();
    a.cancel.store(false, Ordering::Relaxed);
    a.was_rebuild.store(rebuild, Ordering::Relaxed);

    let hwnd_val = hwnd as usize;
    std::thread::spawn(move || {
        let outcome = run_worker(rebuild);
        app().busy.store(false, Ordering::SeqCst);
        unsafe {
            PostMessageW(hwnd_val as HWND, WM_APP_WORKER_DONE, outcome, 0);
        }
    });
}

/// Fire the app-action POST on a background thread.
///
/// Off the UI thread because the request can legitimately take seconds (DevWebUI's stop-all waits
/// out each child's SIGTERM grace), and a tray menu that freezes while it runs is worse than the
/// action itself. Deliberately NOT gated on `busy`: this acts on the daemon's work, not the daemon,
/// so it stays available while a rebuild is in flight.
fn start_action(hwnd: HWND) {
    let a = app();
    let Some(path) = a.cfg.action_path.clone() else {
        return;
    };
    let Some(url) = get_url() else {
        balloon(
            &format!("{} isn't running.", a.cfg.display_name),
            NIIF_WARNING,
        );
        return;
    };
    let hwnd_val = hwnd as usize;
    let timeout = Duration::from_secs(a.cfg.action_timeout_secs);
    std::thread::spawn(move || {
        let ok = daemon::post(&url, &path, timeout);
        let code = if ok { WORK_ACTION_OK } else { WORK_ACTION_FAILED };
        unsafe {
            PostMessageW(hwnd_val as HWND, WM_APP_WORKER_DONE, code, 0);
        }
    });
}

fn run_worker(rebuild: bool) -> usize {
    let a = app();
    let cfg = &a.cfg;

    if rebuild {
        // Defence in depth: refuse a rebuild outside a dev tree even if one was somehow requested.
        if !cfg.is_dev_tree {
            return WORK_BUILD_FAILED;
        }
        let Some(command) = cfg.rebuild_command.as_deref() else {
            return WORK_BUILD_FAILED;
        };
        let log_path = cfg.script_dir.join(&cfg.rebuild_log_name);
        let full = format!(
            "cd /d \"{}\" && {command} > \"{}\" 2>&1",
            cfg.app_root.display(),
            log_path.display()
        );
        use std::os::windows::process::CommandExt;
        let child = std::process::Command::new("cmd.exe")
            .raw_arg(format!("/c \"{full}\""))
            .current_dir(&cfg.app_root)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(0x0800_0000)
            .spawn();
        let Ok(mut child) = child else {
            return WORK_BUILD_FAILED;
        };
        a.build_pid.store(child.id(), Ordering::Relaxed);
        // Poll rather than wait, so Quit can cancel promptly and reap the build tree instead of
        // the app hanging until a full build finishes.
        loop {
            if a.cancel.load(Ordering::Relaxed) {
                daemon::taskkill(child.id());
                return WORK_CANCELED;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    a.build_pid.store(0, Ordering::Relaxed);
                    if !status.success() {
                        return WORK_BUILD_FAILED;
                    }
                    break;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(200)),
                Err(_) => return WORK_BUILD_FAILED,
            }
        }
    }
    if a.cancel.load(Ordering::Relaxed) {
        return WORK_CANCELED;
    }

    let mut ready = restart_once(Duration::from_secs(cfg.worker_wait_secs));
    // Optional extra attempts for a daemon that was slow or failed to bind.
    let mut attempt = 0;
    while !ready && !a.cancel.load(Ordering::Relaxed) && attempt < cfg.restart_retries {
        attempt += 1;
        let pid = a.server_pid.swap(0, Ordering::Relaxed);
        if pid > 0 {
            daemon::taskkill(pid);
        }
        std::thread::sleep(Duration::from_millis(400));
        ready = restart_once(Duration::from_secs(cfg.worker_wait_secs));
    }
    if ready {
        WORK_OK_READY
    } else {
        WORK_OK_NOT_READY
    }
}

fn restart_once(budget: Duration) -> bool {
    let a = app();
    let cfg = &a.cfg;
    daemon::stop(cfg, &a.token, true, false);
    if cfg.use_port_free_wait {
        daemon::wait_port_free(cfg.port, 6);
    }
    std::thread::sleep(Duration::from_millis(300));
    if let Some(pid) = daemon::spawn(cfg, &a.token) {
        a.server_pid.store(pid, Ordering::Relaxed);
        a.started_by_us.store(true, Ordering::Relaxed);
    }
    match daemon::wait_for_url(cfg, budget) {
        Some(url) => {
            set_url(Some(url));
            true
        }
        None => false,
    }
}

// --- watchdog ----------------------------------------------------------------------------------

fn health_tick() {
    let a = app();
    // The visibility sync runs FIRST and unconditionally, so "hide tray icon" keeps working even
    // when every other guard below stands the watchdog down.
    sync_icon_visibility();

    if a.intentional_stop.load(Ordering::Relaxed) || a.busy.load(Ordering::Relaxed) {
        a.health_misses.store(0, Ordering::Relaxed);
        return;
    }
    // Ownership gate: for token apps, leave a daemon another session owns alone. An app can opt out
    // (watchdogRequiresOwnership = false) to revive whatever is there, which is what AgentHydra
    // does to keep parity with its pre-kit launcher.
    let use_token = !a.token.is_empty();
    if use_token
        && !a.started_by_us.load(Ordering::Relaxed)
        && a.cfg.watchdog_requires_ownership
    {
        a.health_misses.store(0, Ordering::Relaxed);
        return;
    }

    if let Some(url) = daemon::live_url(&a.cfg, daemon::PROBE_POLL) {
        set_url(Some(url));
        a.health_misses.store(0, Ordering::Relaxed);
        return;
    }

    let misses = a.health_misses.fetch_add(1, Ordering::Relaxed) + 1;
    if misses < REVIVE_AFTER_MISSES {
        return;
    }
    if let Some(until) = *a.revive_grace_until.lock().unwrap() {
        if Instant::now() < until {
            return;
        }
    }
    if a.auto_restart_paused.load(Ordering::Relaxed) {
        return;
    }

    // Crash-loop guard: prune the window, then refuse to keep resurrecting something that will not
    // stay up. Only a manual Restart/Rebuild clears the pause.
    {
        let mut times = a.restart_times.lock().unwrap();
        let now = Instant::now();
        times.retain(|t| now.duration_since(*t) < CRASH_LOOP_WINDOW);
        if times.len() >= CRASH_LOOP_MAX {
            a.auto_restart_paused.store(true, Ordering::Relaxed);
            drop(times);
            balloon(
                &format!(
                    "{} keeps crashing - auto-restart paused. Use Restart to try again.",
                    a.cfg.display_name
                ),
                NIIF_ERROR,
            );
            return;
        }
        times.push(now);
    }
    *a.revive_grace_until.lock().unwrap() = Some(Instant::now() + REVIVE_GRACE);
    a.started_by_us.store(true, Ordering::Relaxed);

    // REAP THE PREDECESSOR FIRST. A daemon that missed three consecutive probes is not always
    // dead - it can be alive and wedged before it ever binds, and spawning a replacement on top of
    // it leaves both running. Observed here: one launch produced a daemon that never bound, the
    // watchdog revived correctly 25s later, and the machine was then left with two bun processes,
    // the orphan still holding its handles. Repeat that a few times and the pile is the problem.
    //
    // This is a deliberate improvement on the PowerShell host, which also re-spawned without
    // reaping. Safe here because the grace period above means we only reach this after ~15s of
    // silence: a daemon that has not bound by then is not about to, and taskkill /T takes the
    // cmd.exe wrapper's whole tree with it.
    let previous = a.server_pid.swap(0, Ordering::Relaxed);
    if previous > 0 {
        daemon::taskkill(previous);
    }

    if let Some(pid) = daemon::spawn(&a.cfg, &a.token) {
        a.server_pid.store(pid, Ordering::Relaxed);
    }
    a.health_misses.store(0, Ordering::Relaxed);
    balloon(
        &format!("{} stopped unexpectedly - restarting.", a.cfg.display_name),
        NIIF_WARNING,
    );
}

/// The full-shutdown sentinel: the daemon drops this file when the user picks "Shut down" in the
/// web UI, and the tray must then tear the WHOLE app down instead of reviving it.
fn sentinel_tick(hwnd: HWND) {
    let a = app();
    if a.intentional_stop.load(Ordering::Relaxed) || a.busy.load(Ordering::Relaxed) {
        return;
    }
    let Some(path) = a.cfg.sentinel_file.as_ref() else {
        return;
    };
    if path.exists() {
        let _ = std::fs::remove_file(path);
        quit_app(hwnd);
    }
}

// --- quit --------------------------------------------------------------------------------------

fn quit_app(hwnd: HWND) {
    let a = app();
    if a.quitting.swap(true, Ordering::SeqCst) {
        return; // the menu item and the sentinel watcher can both land here
    }
    a.intentional_stop.store(true, Ordering::Relaxed);
    unsafe {
        KillTimer(hwnd, TIMER_HEALTH);
        KillTimer(hwnd, TIMER_SENTINEL);
    }
    if let Some(path) = a.cfg.sentinel_file.as_ref() {
        let _ = std::fs::remove_file(path);
    }
    a.cancel.store(true, Ordering::Relaxed);

    let use_token = !a.token.is_empty();
    let owned = a.started_by_us.load(Ordering::Relaxed);

    // A short graceful POST first, so a daemon that can close cleanly does. Bounded at 3s: Quit
    // must never feel like a hang, and the force-kill below is the guaranteed backstop.
    if use_token && owned {
        if let Some(url) = get_url() {
            daemon::request_shutdown(&a.cfg, &url, &a.token, Duration::from_secs(3));
        }
    }
    // Reap anything a worker spawned before killing the daemon itself.
    for pid in [
        a.build_pid.swap(0, Ordering::Relaxed),
        a.server_pid.swap(0, Ordering::Relaxed),
    ] {
        if pid > 0 {
            daemon::taskkill(pid);
        }
    }
    // skip_graceful: the bounded POST above already ran, and a second 20s attempt plus its 10s
    // poll is exactly how Quit used to turn into a ~30 s hang.
    if !use_token {
        daemon::stop(&a.cfg, &a.token, true, false);
    } else if owned {
        daemon::stop(&a.cfg, &a.token, true, true);
    }

    UI.with(|ui| {
        let mut slot = ui.borrow_mut();
        if let Some(ui) = slot.as_mut() {
            unsafe {
                Shell_NotifyIconW(NIM_DELETE, &mut ui.nid);
                if !ui.mutex.is_null() {
                    ReleaseMutex(ui.mutex);
                    CloseHandle(ui.mutex);
                    ui.mutex = null_mut();
                }
            }
        }
    });
    unsafe { PostQuitMessage(0) };
}

// --- window procedure --------------------------------------------------------------------------

unsafe extern "system" fn wndproc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    match msg {
        WM_APP_TRAY => {
            match l as u32 {
                WM_RBUTTONUP => show_menu(h),
                WM_LBUTTONDBLCLK => open_current_ui(),
                _ => {}
            }
            0
        }
        WM_COMMAND => {
            match w & 0xFFFF {
                ID_OPEN => open_current_ui(),
                ID_REBUILD => start_worker(h, true),
                ID_RESTART => start_worker(h, false),
                ID_ACTION => start_action(h),
                ID_QUIT => quit_app(h),
                _ => {}
            }
            0
        }
        WM_TIMER => {
            match w {
                TIMER_HEALTH => health_tick(),
                TIMER_SENTINEL => sentinel_tick(h),
                _ => {}
            }
            0
        }
        WM_APP_WORKER_DONE => {
            let a = app();
            match w {
                WORK_BUILD_FAILED => balloon(
                    &format!("Build failed. See misc\\{}.", a.cfg.rebuild_log_name),
                    NIIF_ERROR,
                ),
                WORK_OK_NOT_READY => balloon(
                    &format!("Restarted, but {} isn't answering yet.", a.cfg.display_name),
                    NIIF_WARNING,
                ),
                WORK_OK_READY => {
                    // A rebuild is "show me the new build"; a plain Restart is not.
                    if a.was_rebuild.load(Ordering::Relaxed) {
                        open_current_ui();
                    }
                }
                WORK_ACTION_OK => {
                    balloon(&a.cfg.action_ok_text.replace("{APP}", &a.cfg.display_name), NIIF_INFO)
                }
                WORK_ACTION_FAILED => balloon(
                    &a.cfg.action_fail_text.replace("{APP}", &a.cfg.display_name),
                    NIIF_WARNING,
                ),
                WORK_ACTION_NO_DAEMON => balloon(
                    &format!("{} isn't running.", a.cfg.display_name),
                    NIIF_WARNING,
                ),
                _ => {}
            }
            0
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(h, msg, w, l),
    }
}

// --- startup -----------------------------------------------------------------------------------

/// A shutdown token, from the OS CSPRNG. Only a daemon this session started knows it, which is what
/// makes `POST /api/shutdown` safe to expose on a passwordless loopback API.
fn new_token() -> String {
    #[link(name = "advapi32")]
    extern "system" {
        #[link_name = "SystemFunction036"]
        fn RtlGenRandom(buf: *mut u8, len: u32) -> u8;
    }
    let mut bytes = [0u8; 16];
    let ok = unsafe { RtlGenRandom(bytes.as_mut_ptr(), bytes.len() as u32) };
    if ok == 0 {
        // Never fall back to something predictable; without randomness, run untokened instead.
        return String::new();
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn config_path() -> PathBuf {
    if let Some(arg) = std::env::args().nth(1) {
        let p = PathBuf::from(&arg);
        if p.is_absolute() {
            return p;
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                return dir.join(arg);
            }
        }
        return p;
    }
    let mut p = std::env::current_exe().expect("exe path");
    p.set_extension("json");
    p
}

fn main() {
    let t0 = Instant::now();
    let path = config_path();
    let cfg = match Config::load(&path) {
        Ok(c) => c,
        Err(e) => {
            win::message_box("Tray host", &e, MB_ICONERROR);
            return;
        }
    };
    let bench = std::env::var("LUNARWERX_TRAY_BENCH").is_ok();
    let token = if cfg.shutdown_token_env_var.is_some() {
        new_token()
    } else {
        String::new()
    };

    // One tray host per app, claimed BEFORE anything is created. The loser opens the running UI and
    // exits without ever showing a second icon.
    let mutex_name = wide(&cfg.mutex_name);
    let mutex = unsafe { CreateMutexW(null_mut(), 1, mutex_name.as_ptr()) };
    let already_hosted = mutex.is_null() || unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    if already_hosted {
        match daemon::live_url(&cfg, daemon::PROBE_POLL) {
            Some(url) => browser::open_ui(&cfg, &url),
            // Nothing serving yet means the winner is still cold-starting. Opening a browser at a
            // guessed URL would just show connection-refused, so say so instead.
            None => win::message_box(
                &cfg.display_name,
                &format!(
                    "{} is already starting in the tray. Wait a moment, then open it from the tray icon.",
                    cfg.display_name
                ),
                MB_ICONWARNING,
            ),
        }
        return;
    }

    // Is a daemon already alive without our tray?
    let existing = daemon::live_url(&cfg, daemon::PROBE_FAST);
    if let Some(url) = &existing {
        if cfg.on_stray_daemon == StrayPolicy::Warn {
            win::message_box(
                &cfg.display_name,
                &format!(
                    "{} is already serving at {url}, but the tray icon is not running. Stop that process, then run the shortcut again.",
                    cfg.display_name
                ),
                MB_ICONWARNING,
            );
            return;
        }
    }

    let started_by_us = existing.is_none();
    let mut server_pid = 0;
    if started_by_us {
        // First-run bootstrap (blocking, once) before the daemon can possibly work.
        for step in &cfg.first_run {
            if cfg.app_root.join(&step.missing).exists() {
                continue;
            }
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("cmd.exe")
                .raw_arg(format!(
                    "/c \"cd /d \"{}\" && {}\"",
                    cfg.app_root.display(),
                    step.run
                ))
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .creation_flags(0x0800_0000)
                .status();
        }
        // SPAWNED BEFORE ANY UI IS BUILT. This is the whole point: the daemon's ~120 ms boot runs
        // concurrently with our window, icon and menu setup rather than after it.
        match daemon::spawn(&cfg, &token) {
            Some(pid) => server_pid = pid,
            None => {
                win::message_box(
                    &cfg.display_name,
                    &format!("{} could not start its background process.", cfg.display_name),
                    MB_ICONERROR,
                );
                return;
            }
        }
    }

    let display_name = cfg.display_name.clone();
    let icon_file = cfg.icon_file.clone();
    let startup_wait = Duration::from_secs(cfg.startup_wait_secs);
    APP.set(App {
        cfg,
        token,
        url: Mutex::new(existing.clone()),
        started_by_us: AtomicBool::new(started_by_us),
        intentional_stop: AtomicBool::new(false),
        busy: AtomicBool::new(false),
        quitting: AtomicBool::new(false),
        auto_restart_paused: AtomicBool::new(false),
        health_misses: AtomicU32::new(0),
        revive_grace_until: Mutex::new(None),
        restart_times: Mutex::new(Vec::new()),
        cancel: AtomicBool::new(false),
        build_pid: AtomicU32::new(0),
        server_pid: AtomicU32::new(server_pid),
        was_rebuild: AtomicBool::new(false),
    })
    .ok();

    if bench {
        let ready = daemon::wait_for_url(&app().cfg, startup_wait);
        println!(
            "native-tray: daemon spawned at +{}ms, serving at +{}ms ({:?})",
            25,
            t0.elapsed().as_millis(),
            ready
        );
        return;
    }

    unsafe {
        let hinst = GetModuleHandleW(null_mut());
        let class = wide("LunarWerxTrayHost");
        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.lpfnWndProc = Some(wndproc);
        wc.hInstance = hinst;
        wc.lpszClassName = class.as_ptr();
        RegisterClassW(&wc);
        // A message-only window: it exists solely to receive the tray callback and timer ticks.
        let title = wide(&display_name);
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            title.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            null_mut(),
            null_mut(),
            hinst,
            null_mut(),
        );

        let icon_path = wide(&icon_file.to_string_lossy());
        let hicon = LoadImageW(
            null_mut(),
            icon_path.as_ptr(),
            IMAGE_ICON,
            0,
            0,
            LR_LOADFROMFILE | LR_DEFAULTSIZE,
        );

        let mut nid: NOTIFYICONDATAW = std::mem::zeroed();
        nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        nid.hWnd = hwnd;
        nid.uID = 1;
        nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        nid.uCallbackMessage = WM_APP_TRAY;
        nid.hIcon = hicon;
        fill(&mut nid.szTip, &display_name);
        Shell_NotifyIconW(NIM_ADD, &mut nid);

        UI.with(|ui| *ui.borrow_mut() = Some(Ui { nid, mutex }));
        sync_icon_visibility();

        SetTimer(hwnd, TIMER_HEALTH, HEALTH_INTERVAL_MS, null_mut());
        if app().cfg.sentinel_file.is_some() {
            SetTimer(hwnd, TIMER_SENTINEL, SENTINEL_INTERVAL_MS, null_mut());
        }

        balloon("Running in the tray - right-click for options.", NIIF_INFO);

        // Only now do we wait: by this point the daemon has had our entire setup as a head start.
        if get_url().is_none() {
            set_url(daemon::wait_for_url(&app().cfg, startup_wait));
        }

        // "Started but not serving" guidance. One app's overwhelmingly likely cause is a missing
        // configuration step, and the honest answer is to say which command to run rather than
        // leave a tray icon that quietly does nothing. Tear the whole thing down after saying so:
        // a half-started app with a tray icon invites the user to keep clicking it.
        let a = app();
        if get_url().is_none() {
            if let Some(hint) = a.cfg.not_serving_hint.clone() {
                daemon::stop(&a.cfg, &a.token, true, false);
                let pid = a.server_pid.swap(0, Ordering::Relaxed);
                if pid > 0 {
                    daemon::taskkill(pid);
                }
                UI.with(|ui| {
                    let mut slot = ui.borrow_mut();
                    if let Some(ui) = slot.as_mut() {
                        Shell_NotifyIconW(NIM_DELETE, &mut ui.nid);
                        if !ui.mutex.is_null() {
                            ReleaseMutex(ui.mutex);
                            CloseHandle(ui.mutex);
                            ui.mutex = null_mut();
                        }
                    }
                });
                win::message_box(&a.cfg.display_name, &hint, MB_ICONWARNING);
                return;
            }
        }
        open_current_ui();

        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        UI.with(|ui| {
            let mut slot = ui.borrow_mut();
            if let Some(ui) = slot.as_mut() {
                Shell_NotifyIconW(NIM_DELETE, &mut ui.nid);
                if !ui.mutex.is_null() {
                    ReleaseMutex(ui.mutex);
                    CloseHandle(ui.mutex);
                }
            }
        });
        DestroyWindow(hwnd);
    }
}
