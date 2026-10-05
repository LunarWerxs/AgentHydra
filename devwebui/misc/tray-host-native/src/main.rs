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
use std::path::{Path, PathBuf};
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
/// Offered only after an unclean exit (see Config::crash_sentinel_dir).
const ID_SAFE_MODE: usize = 6;

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
    watchdog: Mutex<Watchdog>,
    /// Set by Quit so an in-flight worker stops instead of resurrecting what we are closing.
    cancel: AtomicBool,
    build_pid: AtomicU32,
    /// True when the last worker was a rebuild (so a successful finish re-opens the UI).
    was_rebuild: AtomicBool,
    /// An unclean exit was seen (a leftover run file at cold start, or a death the watchdog
    /// caught), so the menu offers "Restart in Safe Mode" from now on. Never set unless the app
    /// configures crash_sentinel_dir (its statement that it honours safe mode).
    unclean_exit_seen: AtomicBool,
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

/// Whether the SHELL currently holds our icon. Recorded from Shell_NotifyIcon's real return value,
/// never assumed.
///
/// This used to default to `true` on the theory that the startup NIM_ADD had obviously worked.
/// NIM_ADD genuinely fails — the taskbar not existing yet at logon is the common one, and Microsoft
/// documents retrying — and treating a failure as success meant the sync below saw "already shown"
/// forever and never retried. The symptom is the worst kind: the app runs perfectly, there is no
/// icon anywhere (not even in the Windows 11 overflow flyout), and relaunching the shortcut hits
/// the single-instance branch and just opens the UI, so nothing the user can do brings it back.
/// Starting at `false` makes the health tick's sync a free five-second retry loop.
static ICON_SHOWN: AtomicBool = AtomicBool::new(false);

/// The shell's "TaskbarCreated" broadcast id, resolved once at startup (0 until then).
static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);

/// The "hide tray icon" opt-in, read fresh from the runtime pointer every time. A missing or
/// unreadable pointer means visible: the icon is how the user reaches Quit.
fn hide_tray_icon_setting() -> bool {
    std::fs::read_to_string(&app().cfg.info_file)
        .ok()
        .and_then(|s| json::parse(&s))
        .map(|v| v.flag_at("hideTrayIcon"))
        .unwrap_or(false)
}

/// Live-sync the icon's visibility from the runtime pointer, so flipping "hide tray icon" in the
/// web UI takes effect within one tick without restarting anything.
///
/// Windows has no "hide a NotifyIcon" call, so hiding is DELETE and showing is ADD; the tray data
/// itself is kept either way, because the menu, the timers and Quit all hang off it. Also the
/// retry path for a failed ADD, and the re-add path after Explorer restarts (see wndproc).
fn sync_icon_visibility() {
    let hidden = hide_tray_icon_setting();
    UI.with(|ui| {
        let mut slot = ui.borrow_mut();
        let Some(ui) = slot.as_mut() else { return };
        let shown = ICON_SHOWN.load(Ordering::Relaxed);
        if hidden && shown {
            unsafe { Shell_NotifyIconW(NIM_DELETE, &mut ui.nid) };
            ICON_SHOWN.store(false, Ordering::Relaxed);
        } else if !hidden && !shown {
            // Restore the steady-state flags: a balloon leaves NIF_INFO behind if it fired between
            // the icon going away and this add.
            ui.nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
            let added = unsafe { Shell_NotifyIconW(NIM_ADD, &mut ui.nid) } != 0;
            ICON_SHOWN.store(added, Ordering::Relaxed);
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
    // In safe mode, Restart is the way back out, and says so.
    let safe = daemon::SAFE_MODE.load(Ordering::Relaxed);
    let restart = wide(if safe { "Restart Normally" } else { "Restart" });
    AppendMenuW(menu, MF_STRING | grey, ID_RESTART, restart.as_ptr());
    if !safe && a.unclean_exit_seen.load(Ordering::Relaxed) {
        let safe_item = wide("Restart in Safe Mode");
        AppendMenuW(menu, MF_STRING | grey, ID_SAFE_MODE, safe_item.as_ptr());
    }
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
    a.watchdog.lock().unwrap().rearm();
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

/// Restart in the requested mode: the daemon comes back with its auto-start work skipped (safe) or
/// as normal. The mode only flips when a restart will actually run, so a click while busy cannot
/// leave the flag saying one thing and the daemon doing another.
fn restart_in_mode(hwnd: HWND, safe: bool) {
    let a = app();
    if a.busy.load(Ordering::SeqCst) {
        return;
    }
    daemon::SAFE_MODE.store(safe, Ordering::Relaxed);
    let name = &a.cfg.display_name;
    let tip = if safe { format!("{name} (Safe Mode)") } else { name.clone() };
    UI.with(|ui| {
        let mut slot = ui.borrow_mut();
        let Some(ui) = slot.as_mut() else { return };
        fill(&mut ui.nid.szTip, &tip);
        if ICON_SHOWN.load(Ordering::Relaxed) {
            ui.nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
            unsafe { Shell_NotifyIconW(NIM_MODIFY, &mut ui.nid) };
        }
    });
    start_worker(hwnd, false);
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
        let pid = daemon::CHILD_PID.swap(0, Ordering::SeqCst);
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
    // A daemon already dead with its run file left behind crashed on its own: keep that file so the
    // next launch reports it. Only a stop THIS restart causes is cleared as deliberate.
    let crashed_before = daemon::unclean_run_left(cfg);
    daemon::stop(cfg, &a.token, true, false);
    if !crashed_before {
        daemon::clear_run_sentinels(cfg);
    }
    if cfg.use_port_free_wait {
        daemon::wait_port_free(cfg.port, 6);
    }
    std::thread::sleep(Duration::from_millis(300));
    let why = if a.was_rebuild.load(Ordering::Relaxed) { "tray Rebuild & Restart" } else { "tray Restart" };
    if daemon::spawn(cfg, &a.token, why).is_some() {
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

/// Why a health tick that found the daemon dead did not revive it.
///
/// Each one is written to the tray log once per episode (see `Watchdog::report`). Before
/// 2026-09-26 every guard returned without a word, and AgentHydra's watchdog stood down for ~31
/// hours with nothing to show for it but a spawn line that never came.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum StandDown {
    /// A Restart or Rebuild from the menu owns the daemon until its worker finishes.
    Busy,
    /// A token app leaves a daemon it did not start alone (Config::watchdog_requires_ownership).
    NotOurs,
    /// The last revive has not had its grace period to bind yet.
    Grace,
    /// The crash-loop guard paused auto-restart.
    Paused,
}

impl StandDown {
    fn reason(self) -> String {
        match self {
            StandDown::Busy => "a Restart or Rebuild from the tray menu is still running".into(),
            StandDown::NotOurs => {
                "this tray did not start it, and watchdogRequiresOwnership is on".into()
            }
            StandDown::Grace => format!(
                "the last revive is still inside its {}s grace",
                REVIVE_GRACE.as_secs()
            ),
            StandDown::Paused => format!("auto-restart is paused by the crash-loop guard {}", rearm_hint()),
        }
    }
}

fn rearm_hint() -> String {
    format!(
        "(it re-arms once the daemon answers for {}s, or on a tray Restart)",
        CRASH_LOOP_WINDOW.as_secs()
    )
}

/// What one health tick decided.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Verdict {
    /// The daemon answered.
    Alive,
    /// The daemon answered, and has for long enough that a crash-loop pause is lifted.
    Rearmed,
    /// Silent, but not for long enough to count as dead: one slow tick is not a death.
    Hiccup,
    /// Dead, and a guard kept the watchdog from reviving it.
    StandDown(StandDown),
    /// Dead, and one revive too many inside the crash-loop window: auto-restart pauses.
    CrashLoop,
    /// Dead: reap and respawn it.
    Revive,
}

/// The watchdog's memory between ticks, and its whole policy.
///
/// Kept apart from the probe, the clock and the spawn so the policy can be exercised without a
/// daemon: `health_tick` feeds it the probe result and acts on the verdict.
#[derive(Default)]
struct Watchdog {
    misses: u32,
    grace_until: Option<Instant>,
    paused: bool,
    restart_times: Vec<Instant>,
    /// Since when the daemon has answered. Only a death resets it, never a hiccup.
    healthy_since: Option<Instant>,
    /// The stand-down last written to the tray log, so a standing guard is reported once.
    reported: Option<StandDown>,
}

impl Watchdog {
    fn tick(&mut self, now: Instant, alive: bool, busy: bool, not_ours: bool) -> Verdict {
        if alive {
            self.misses = 0;
            let since = *self.healthy_since.get_or_insert(now);
            // The pause must not outlive the crash loop. A daemon that has answered for the whole
            // window has, by the guard's own definition, stopped crash-looping, and a pause kept
            // past that turns the NEXT unrelated death into one nothing revives: AgentHydra paused
            // after four fast revives, the fifth daemon served for 15 hours, and when it was killed
            // the watchdog stood down for good.
            if self.paused && now.duration_since(since) >= CRASH_LOOP_WINDOW {
                self.rearm();
                return Verdict::Rearmed;
            }
            return Verdict::Alive;
        }

        self.misses += 1;
        if self.misses < REVIVE_AFTER_MISSES {
            return Verdict::Hiccup;
        }
        // Dead from here. Every guard below stands the revive down, and says which it was.
        self.healthy_since = None;
        if busy {
            self.misses = 0;
            return Verdict::StandDown(StandDown::Busy);
        }
        if not_ours {
            self.misses = 0;
            return Verdict::StandDown(StandDown::NotOurs);
        }
        if self.grace_until.is_some_and(|until| now < until) {
            return Verdict::StandDown(StandDown::Grace);
        }
        if self.paused {
            return Verdict::StandDown(StandDown::Paused);
        }
        // Crash-loop guard: prune the window, then refuse to keep resurrecting something that will
        // not stay up.
        self.restart_times.retain(|t| now.duration_since(*t) < CRASH_LOOP_WINDOW);
        if self.restart_times.len() >= CRASH_LOOP_MAX {
            self.paused = true;
            return Verdict::CrashLoop;
        }
        self.restart_times.push(now);
        self.grace_until = Some(now + REVIVE_GRACE);
        self.misses = 0;
        Verdict::Revive
    }

    /// Lift a crash-loop pause: a manual Restart, or a daemon that has stayed up.
    fn rearm(&mut self) {
        self.paused = false;
        self.restart_times.clear();
    }

    /// The tray-log line this verdict earns, or None when it would only repeat the last one.
    /// A revive needs none: its own spawn line is the record.
    fn report(&mut self, verdict: Verdict) -> Option<String> {
        const DEAD: &str = "watchdog: the daemon is not answering, and it is NOT being revived";
        match verdict {
            Verdict::Hiccup => None,
            Verdict::Revive => {
                self.reported = None;
                None
            }
            Verdict::Alive => self
                .reported
                .take()
                .map(|_| "watchdog: the daemon answers again".to_string()),
            Verdict::Rearmed => {
                self.reported = None;
                Some(format!(
                    "watchdog: re-armed - the daemon has answered for {}s since the crash-loop guard paused auto-restart",
                    CRASH_LOOP_WINDOW.as_secs()
                ))
            }
            Verdict::CrashLoop => {
                self.reported = Some(StandDown::Paused);
                Some(format!(
                    "{DEAD}: {} revives inside {}s tripped the crash-loop guard, so auto-restart is paused {}",
                    CRASH_LOOP_MAX,
                    CRASH_LOOP_WINDOW.as_secs(),
                    rearm_hint()
                ))
            }
            Verdict::StandDown(why) if self.reported == Some(why) => None,
            Verdict::StandDown(why) => {
                self.reported = Some(why);
                Some(format!("{DEAD}: {}", why.reason()))
            }
        }
    }
}

fn health_tick() {
    let a = app();
    // The visibility sync runs FIRST and unconditionally, so "hide tray icon" keeps working even
    // when every other guard below stands the watchdog down.
    sync_icon_visibility();

    // Quit is tearing the app down and kills this timer next: there is nothing left to watch.
    if a.intentional_stop.load(Ordering::Relaxed) {
        return;
    }
    // Probe BEFORE any guard, so a guard that stands the watchdog down still knows the daemon is
    // dead and can say so. The guards used to return ahead of the probe, silently.
    let url = daemon::live_url(&a.cfg, daemon::PROBE_POLL);
    let busy = a.busy.load(Ordering::Relaxed);
    // Ownership gate: for token apps, leave a daemon another session owns alone. An app can opt out
    // (watchdogRequiresOwnership = false) to revive whatever is there, which is what AgentHydra
    // does to keep parity with its pre-kit launcher.
    let not_ours = !a.token.is_empty()
        && !a.started_by_us.load(Ordering::Relaxed)
        && a.cfg.watchdog_requires_ownership;
    let (verdict, line) = {
        let mut watchdog = a.watchdog.lock().unwrap();
        let verdict = watchdog.tick(Instant::now(), url.is_some(), busy, not_ours);
        (verdict, watchdog.report(verdict))
    };
    if let Some(line) = line {
        daemon::tray_log(&a.cfg, &line);
    }

    match verdict {
        Verdict::Alive | Verdict::Rearmed => {
            set_url(url);
            // A death followed by a live daemon has been answered already: a self-update relaunch
            // hands over to a daemon that is not our child. A later revive must not claim it.
            daemon::forget_last_death();
        }
        Verdict::Hiccup | Verdict::StandDown(_) => {}
        Verdict::CrashLoop | Verdict::Revive => {
            // A death this tray did not cause: from here on, offer the quiet way back in. Only when
            // the app names its crash-sentinel directory, which is its statement that it honours
            // safe mode; an app that ignores LUNARWERX_SAFE_MODE would get a menu item that changes
            // nothing.
            let offers_safe_mode = a.cfg.crash_sentinel_dir.is_some();
            if offers_safe_mode {
                a.unclean_exit_seen.store(true, Ordering::Relaxed);
            }
            if verdict == Verdict::CrashLoop {
                let hint = if offers_safe_mode { "Restart or Restart in Safe Mode" } else { "Restart to try again" };
                balloon(
                    &format!("{} keeps crashing - auto-restart paused. Use {hint}.", a.cfg.display_name),
                    NIIF_ERROR,
                );
            } else {
                revive(a);
            }
        }
    }
}

fn revive(a: &App) {
    a.started_by_us.store(true, Ordering::Relaxed);

    // REAP THE PREDECESSOR FIRST. A daemon that missed three consecutive probes is not always
    // dead - it can be alive and wedged before it ever binds, and spawning a replacement on top of
    // it leaves both running. Observed here: one launch produced a daemon that never bound, the
    // watchdog revived correctly 25s later, and the machine was then left with two bun processes,
    // the orphan still holding its handles. Repeat that a few times and the pile is the problem.
    //
    // This is a deliberate improvement on the PowerShell host, which also re-spawned without
    // reaping. Safe here because the grace period means we only reach this after ~15s of silence:
    // a daemon that has not bound by then is not about to, and taskkill /T takes the cmd.exe
    // wrapper's whole tree with it. CHILD_PID is 0 once that wrapper has exited, so this never
    // kills a recycled pid.
    let previous = daemon::CHILD_PID.swap(0, Ordering::SeqCst);
    if previous > 0 {
        daemon::taskkill(previous);
    }

    daemon::spawn(&a.cfg, &a.token, "watchdog revive");
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
        daemon::CHILD_PID.swap(0, Ordering::SeqCst),
    ] {
        if pid > 0 {
            daemon::taskkill(pid);
        }
    }
    // skip_graceful: the bounded POST above already ran, and a second 20s attempt plus its 10s
    // poll is exactly how Quit used to turn into a ~30 s hang.
    if !use_token {
        daemon::stop(&a.cfg, &a.token, true, false);
        daemon::clear_run_sentinels(&a.cfg);
    } else if owned {
        daemon::stop(&a.cfg, &a.token, true, true);
        daemon::clear_run_sentinels(&a.cfg);
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
                ID_RESTART => restart_in_mode(h, false),
                ID_SAFE_MODE => restart_in_mode(h, true),
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
        // Explorer (re)created the taskbar. EVERY tray icon on the machine was destroyed with the
        // old one, and the shell expects each app to add its own back — an app that does not is
        // simply gone from the tray for the rest of the session while its process keeps running
        // fine. WinForms' NotifyIcon did this for us in the PowerShell host, which is why the
        // hand-rolled port lost it silently: nothing here was wrong until Explorer restarted.
        //
        // This also covers the cold case. A host launched at logon (Startup folder, scheduled
        // task) can beat the taskbar into existence; its first NIM_ADD fails, and this broadcast
        // is precisely the signal that adding will work now.
        //
        // Requires a real top-level window: message-only windows (HWND_MESSAGE parent) do NOT
        // receive broadcasts. Ours passes a null parent, so it does — do not "tidy" that.
        m if m != 0 && m == TASKBAR_CREATED.load(Ordering::Relaxed) => {
            ICON_SHOWN.store(false, Ordering::Relaxed);
            sync_icon_visibility();
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

/// First-run bootstrap (blocking, once) before the daemon can possibly work, then spawn it.
/// Split out of `main` along with `report_not_serving_and_teardown` below so `main` reads as the
/// startup sequence and each non-trivial step's own branching lives in its own named function.
/// Returns false having already reported the failure — the caller must then return immediately.
fn bootstrap_and_spawn_daemon(cfg: &Config, token: &str) -> bool {
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
    if daemon::spawn(cfg, token, "tray start").is_some() {
        return true;
    }
    win::message_box(
        &cfg.display_name,
        &format!("{} could not start its background process.", cfg.display_name),
        MB_ICONERROR,
    );
    false
}

/// "Started but not serving" guidance, torn down and reported. One app's overwhelmingly likely
/// cause is a missing configuration step, and the honest answer is to say which command to run
/// rather than leave a tray icon that quietly does nothing. Returns true when this fired — the
/// caller must then return immediately: a half-started app with a tray icon invites the user to
/// keep clicking it.
unsafe fn report_not_serving_and_teardown(a: &App) -> bool {
    let Some(hint) = a.cfg.not_serving_hint.clone() else {
        return false;
    };
    daemon::stop(&a.cfg, &a.token, true, false);
    let pid = daemon::CHILD_PID.swap(0, Ordering::SeqCst);
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
    true
}

/// Build the (invisible) message window and the tray icon, start the health/sentinel timers, and
/// show the "running in the tray" balloon. Split out of `main` for the same reason as its
/// siblings above. Returns the message window's handle, needed by the message loop and the final
/// `DestroyWindow`.
unsafe fn create_tray_window(display_name: &str, icon_file: &Path, mutex: HANDLE) -> HWND {
    let hinst = GetModuleHandleW(null_mut());
    let class = wide("LunarWerxTrayHost");
    let mut wc: WNDCLASSW = std::mem::zeroed();
    wc.lpfnWndProc = Some(wndproc);
    wc.hInstance = hinst;
    wc.lpszClassName = class.as_ptr();
    RegisterClassW(&wc);
    // A plain top-level window, zero-sized and never shown. It exists to receive the tray
    // callback and timer ticks — but it must NOT become a message-only window (HWND_MESSAGE
    // parent), because those are excluded from broadcasts and TaskbarCreated is a broadcast.
    let title = wide(display_name);
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

    // Subscribe to the taskbar-recreated broadcast BEFORE the icon exists, so a restart that
    // lands during our own startup is still caught.
    TASKBAR_CREATED.store(
        RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()),
        Ordering::Relaxed,
    );

    let mut nid: NOTIFYICONDATAW = std::mem::zeroed();
    nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
    nid.hWnd = hwnd;
    nid.uID = 1;
    nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    nid.uCallbackMessage = WM_APP_TRAY;
    nid.hIcon = hicon;
    fill(&mut nid.szTip, display_name);

    UI.with(|ui| *ui.borrow_mut() = Some(Ui { nid, mutex }));
    // The ADD itself: ICON_SHOWN starts false, so this is the initial add as well as the
    // hide-gate. If it fails, the health tick retries every 5s and TaskbarCreated re-fires it.
    sync_icon_visibility();

    SetTimer(hwnd, TIMER_HEALTH, HEALTH_INTERVAL_MS, null_mut());
    if app().cfg.sentinel_file.is_some() {
        SetTimer(hwnd, TIMER_SENTINEL, SENTINEL_INTERVAL_MS, null_mut());
    }

    if app().unclean_exit_seen.load(Ordering::Relaxed) {
        balloon(
            &format!(
                "{display_name} did not shut down cleanly last time. If it misbehaves, right-click > Restart in Safe Mode."
            ),
            NIIF_WARNING,
        );
    } else {
        balloon("Running in the tray - right-click for options.", NIIF_INFO);
    }
    hwnd
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
    // Before the spawn below: the daemon we are about to start reports and deletes these.
    let unclean_exit_seen = daemon::unclean_run_left(&cfg);
    if started_by_us && !bootstrap_and_spawn_daemon(&cfg, &token) {
        return;
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
        watchdog: Mutex::new(Watchdog::default()),
        cancel: AtomicBool::new(false),
        build_pid: AtomicU32::new(0),
        was_rebuild: AtomicBool::new(false),
        unclean_exit_seen: AtomicBool::new(unclean_exit_seen),
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
        let hwnd = create_tray_window(&display_name, &icon_file, mutex);

        // Only now do we wait: by this point the daemon has had our entire setup as a head start.
        if get_url().is_none() {
            set_url(daemon::wait_for_url(&app().cfg, startup_wait));
        }

        let a = app();
        if get_url().is_none() && report_not_serving_and_teardown(a) {
            return;
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

#[cfg(test)]
mod watchdog_tests {
    use super::*;

    const TICK: Duration = Duration::from_millis(HEALTH_INTERVAL_MS as u64);

    /// Silent ticks until the watchdog does something other than wait (a hiccup or a revive's
    /// grace), which is what one daemon death looks like from here.
    fn die(w: &mut Watchdog, now: &mut Instant) -> Verdict {
        loop {
            *now += TICK;
            let v = w.tick(*now, false, false, false);
            if v != Verdict::Hiccup && v != Verdict::StandDown(StandDown::Grace) {
                return v;
            }
        }
    }

    #[test]
    fn a_crash_loop_pause_is_reported_once_and_lifts_once_the_daemon_stays_up() {
        let mut w = Watchdog::default();
        let mut now = Instant::now();
        // AgentHydra, 2026-09-25: daemons that never answered, revived back to back until the guard
        // paused auto-restart.
        for _ in 0..CRASH_LOOP_MAX {
            assert_eq!(die(&mut w, &mut now), Verdict::Revive);
        }
        assert_eq!(die(&mut w, &mut now), Verdict::CrashLoop);
        assert!(w.report(Verdict::CrashLoop).is_some());
        // Paused and dead: the tray log hears it once, not every 5 s.
        for _ in 0..10 {
            now += TICK;
            let v = w.tick(now, false, false, false);
            assert_eq!(v, Verdict::StandDown(StandDown::Paused));
            assert_eq!(w.report(v), None);
        }
        // The next daemon comes up and stays up for the whole window (that one served 15 hours).
        let mut lifted = false;
        for _ in 0..=CRASH_LOOP_WINDOW.as_secs() / TICK.as_secs() {
            now += TICK;
            lifted |= w.tick(now, true, false, false) == Verdict::Rearmed;
        }
        assert!(lifted, "a daemon healthy for the whole crash-loop window must lift the pause");
        // Then it is killed, and that death is a new one: it gets revived.
        assert_eq!(die(&mut w, &mut now), Verdict::Revive);
    }
}
