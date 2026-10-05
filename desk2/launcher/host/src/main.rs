#![cfg_attr(not(test), windows_subsystem = "windows")]
#![allow(clippy::upper_case_acronyms)]
//! Hydra Desk 2's own window: WebView2 in a tao window that is created hidden at the place it was last
//! left, shown once, and never moved after. The place is saved in ~/.hydra-desk-2/window.json
//! ({left,top,right,bottom,maximized,window:{left,top,right,bottom}}, physical pixels).
//!
//!   HydraDesk2.exe [--url <url>] [--dry-run] [--smoke]

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const TITLE: &str = "Hydra Desk 2";
// --bg-page in desk2/web/src/style.css (the body background); the title bar and the WebView use it.
const BG: (u8, u8, u8) = (0x15, 0x15, 0x15);
const TEXT: (u8, u8, u8) = (0xe6, 0xe6, 0xe6);
const DEFAULT_W: i32 = 1500;
const DEFAULT_H: i32 = 950;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl Rect {
    fn w(&self) -> i32 {
        self.right - self.left
    }
    fn h(&self) -> i32 {
        self.bottom - self.top
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
struct Saved {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    maximized: bool,
    window: Rect,
}

fn parse_saved(text: &str) -> Option<Saved> {
    let t = text.trim_start_matches('\u{feff}');
    let s: Saved = serde_json::from_str(t).ok()?;
    if s.window.w() < 200 || s.window.h() < 150 {
        return None;
    }
    Some(s)
}

/// Both ends of the title bar (top-left and top-right pixel) lie on a connected monitor.
fn on_monitor(r: &Rect, monitors: &[Rect]) -> bool {
    let inside = |x: i32, y: i32| {
        monitors
            .iter()
            .any(|m| x >= m.left && x < m.right && y >= m.top && y < m.bottom)
    };
    inside(r.left, r.top) && inside(r.right - 1, r.top)
}

fn default_rect(primary: &Rect) -> Rect {
    let w = DEFAULT_W.min(primary.w());
    let h = DEFAULT_H.min(primary.h());
    let left = primary.left + (primary.w() - w) / 2;
    let top = primary.top + (primary.h() - h) / 2;
    Rect {
        left,
        top,
        right: left + w,
        bottom: top + h,
    }
}

/// (rect, maximized, why)
fn choose_placement(
    saved: Option<Saved>,
    monitors: &[Rect],
    primary: &Rect,
) -> (Rect, bool, String) {
    match saved {
        Some(s) if on_monitor(&s.window, monitors) => {
            (s.window, s.maximized, "saved placement".into())
        }
        Some(_) => (
            default_rect(primary),
            false,
            "default: saved window is not on a connected monitor".into(),
        ),
        None => (
            default_rect(primary),
            false,
            "default: no saved placement".into(),
        ),
    }
}

fn desk_home() -> PathBuf {
    if let Some(h) = std::env::var_os("HYDRA_DESK_HOME").filter(|h| !h.is_empty()) {
        return PathBuf::from(h);
    }
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .unwrap_or_default();
    PathBuf::from(home).join(".hydra-desk-2")
}

fn local_app_data() -> PathBuf {
    PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("HydraDesk2")
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let dest = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &dest)?;
        } else {
            let _ = std::fs::copy(e.path(), dest); // a locked file is skipped, never fatal
        }
    }
    Ok(())
}

/// First run: carry the old Edge app profile's localStorage over before the WebView exists.
fn migrate_local_storage(udf: &Path) {
    if udf.exists() {
        return;
    }
    let old = local_app_data()
        .join("window")
        .join("Default")
        .join("Local Storage");
    if old.is_dir() {
        let _ = copy_dir(
            &old,
            &udf.join("EBWebView").join("Default").join("Local Storage"),
        );
    }
}

#[cfg(windows)]
mod win {
    use super::Rect;
    use std::ffi::c_void;
    type Hwnd = isize;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct RECT {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct POINT {
        x: i32,
        y: i32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct WINDOWPLACEMENT {
        length: u32,
        flags: u32,
        show_cmd: u32,
        min: POINT,
        max: POINT,
        normal: RECT,
    }
    #[repr(C)]
    struct MONITORINFO {
        size: u32,
        monitor: RECT,
        work: RECT,
        flags: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetWindowRect(h: Hwnd, r: *mut RECT) -> i32;
        fn GetWindowPlacement(h: Hwnd, p: *mut WINDOWPLACEMENT) -> i32;
        fn MonitorFromWindow(h: Hwnd, flags: u32) -> isize;
        fn GetMonitorInfoW(m: isize, i: *mut MONITORINFO) -> i32;
        fn EnumDisplayMonitors(
            dc: isize,
            clip: *const RECT,
            cb: extern "system" fn(isize, isize, *mut RECT, isize) -> i32,
            data: isize,
        ) -> i32;
        fn SetWindowPos(h: Hwnd, after: Hwnd, x: i32, y: i32, w: i32, hh: i32, flags: u32) -> i32;
        fn FindWindowW(class: *const u16, title: *const u16) -> Hwnd;
        fn IsIconic(h: Hwnd) -> i32;
        fn IsWindowVisible(h: Hwnd) -> i32;
        fn ShowWindow(h: Hwnd, cmd: i32) -> i32;
        fn SetForegroundWindow(h: Hwnd) -> i32;
        fn LoadImageW(
            inst: isize,
            name: *const u16,
            kind: u32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> isize;
        fn SendMessageW(h: Hwnd, msg: u32, w: usize, l: isize) -> isize;
        fn SetProcessDpiAwarenessContext(v: isize) -> i32;
    }
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(h: Hwnd, attr: u32, v: *const c_void, size: u32) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attrs: *const c_void, owner: i32, name: *const u16) -> isize;
        fn GetLastError() -> u32;
    }
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            h: Hwnd,
            op: *const u16,
            file: *const u16,
            params: *const u16,
            dir: *const u16,
            show: i32,
        ) -> isize;
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    fn rect(r: RECT) -> Rect {
        Rect {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
        }
    }

    pub fn dpi_aware() {
        unsafe { SetProcessDpiAwarenessContext(-4) }; // per-monitor v2
    }

    /// (all monitors, primary monitor), full monitor rectangles.
    pub fn monitors() -> (Vec<Rect>, Rect) {
        extern "system" fn cb(m: isize, _: isize, _: *mut RECT, data: isize) -> i32 {
            let v = unsafe { &mut *(data as *mut Vec<(Rect, bool)>) };
            let mut i = MONITORINFO {
                size: std::mem::size_of::<MONITORINFO>() as u32,
                monitor: RECT::default(),
                work: RECT::default(),
                flags: 0,
            };
            if unsafe { GetMonitorInfoW(m, &mut i) } != 0 {
                v.push((rect(i.monitor), i.flags & 1 != 0));
            }
            1
        }
        let mut v: Vec<(Rect, bool)> = Vec::new();
        unsafe { EnumDisplayMonitors(0, std::ptr::null(), cb, &mut v as *mut _ as isize) };
        let primary = v
            .iter()
            .find(|m| m.1)
            .or(v.first())
            .map(|m| m.0)
            .unwrap_or(Rect {
                left: 0,
                top: 0,
                right: 1920,
                bottom: 1080,
            });
        (v.into_iter().map(|m| m.0).collect(), primary)
    }

    pub fn set_outer_rect(h: isize, r: &Rect) {
        // SWP_NOZORDER | SWP_NOACTIVATE
        unsafe { SetWindowPos(h, 0, r.left, r.top, r.w(), r.h(), 0x0004 | 0x0010) };
    }

    /// (on-screen rect, floating rect, maximized); None while minimized.
    pub fn read_placement(h: isize) -> Option<(Rect, Rect, bool)> {
        unsafe {
            let mut p = WINDOWPLACEMENT {
                length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
                ..Default::default()
            };
            let mut r = RECT::default();
            if GetWindowPlacement(h, &mut p) == 0 || GetWindowRect(h, &mut r) == 0 {
                return None;
            }
            if p.show_cmd == 2 {
                return None;
            }
            let maximized = p.show_cmd == 3;
            let outer = rect(r);
            // rcNormalPosition is in workspace coordinates: shift by the monitor's work-area offset.
            let mon = MonitorFromWindow(h, 2);
            let mut i = MONITORINFO {
                size: std::mem::size_of::<MONITORINFO>() as u32,
                monitor: RECT::default(),
                work: RECT::default(),
                flags: 0,
            };
            let (dx, dy) = if GetMonitorInfoW(mon, &mut i) != 0 {
                (i.work.left - i.monitor.left, i.work.top - i.monitor.top)
            } else {
                (0, 0)
            };
            let n = rect(p.normal);
            let normal = Rect {
                left: n.left + dx,
                top: n.top + dy,
                right: n.right + dx,
                bottom: n.bottom + dy,
            };
            Some((outer, normal, maximized))
        }
    }

    pub fn title_bar(h: isize, bg: (u8, u8, u8), text: (u8, u8, u8)) {
        let col = |c: (u8, u8, u8)| (c.0 as u32) | ((c.1 as u32) << 8) | ((c.2 as u32) << 16);
        unsafe {
            let dark: u32 = 1;
            DwmSetWindowAttribute(h, 20, &dark as *const _ as *const c_void, 4);
            let b = col(bg);
            DwmSetWindowAttribute(h, 35, &b as *const _ as *const c_void, 4);
            let t = col(text);
            DwmSetWindowAttribute(h, 36, &t as *const _ as *const c_void, 4);
        }
    }

    pub fn set_icon(h: isize, path: &std::path::Path) {
        let p = wide(&path.to_string_lossy());
        unsafe {
            // IMAGE_ICON, LR_LOADFROMFILE
            for (kind, size) in [(1usize, 32), (0usize, 16)] {
                let ic = LoadImageW(0, p.as_ptr(), 1, size, size, 0x10);
                if ic != 0 {
                    SendMessageW(h, 0x0080, kind, ic);
                }
            }
        }
    }

    /// True when this is the first instance; otherwise focuses the open window and returns false.
    pub fn single_instance(title: &str) -> bool {
        let name = wide("Local\\HydraDesk2Host");
        unsafe {
            let m = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
            let _ = m; // held for the life of the process
            if GetLastError() != 183 {
                return true;
            }
            let t = wide(title);
            let h = FindWindowW(std::ptr::null(), t.as_ptr());
            if h != 0 {
                if IsIconic(h) != 0 {
                    ShowWindow(h, 9);
                }
                if IsWindowVisible(h) != 0 {
                    SetForegroundWindow(h);
                }
            }
            false
        }
    }

    pub fn open_external(url: &str) {
        let (op, u) = (wide("open"), wide(url));
        unsafe {
            ShellExecuteW(
                0,
                op.as_ptr(),
                u.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
    }
}

#[cfg(not(windows))]
mod win {
    compile_error!("HydraDesk2 host is Windows only");
}

fn origin_of(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    format!("{}://{}", url.split("://").next().unwrap_or("http"), host)
}

fn save_atomic(file: &Path, s: &Saved) {
    let Ok(text) = serde_json::to_string(s) else {
        return;
    };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = file.with_extension("json.tmp");
    if std::fs::write(&tmp, text).is_ok() && std::fs::rename(&tmp, file).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |f: &str| args.iter().any(|a| a == f);
    let port = std::env::var("HYDRA_DESK_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(7798);
    let mut url = format!("http://127.0.0.1:{port}");
    if let Some(i) = args.iter().position(|a| a == "--url") {
        if let Some(u) = args.get(i + 1) {
            url = u.clone();
        }
    }
    let dry = flag("--dry-run");
    let smoke = flag("--smoke");

    win::dpi_aware();
    let (monitors, primary) = win::monitors();
    let state_file = desk_home().join("window.json");
    let saved = std::fs::read_to_string(&state_file)
        .ok()
        .and_then(|t| parse_saved(&t));
    let (rect, maximized, why) = choose_placement(saved, &monitors, &primary);
    let udf = if smoke {
        std::env::temp_dir().join(format!("HydraDesk2-smoke-{}", std::process::id()))
    } else {
        local_app_data().join("webview")
    };

    if dry {
        println!("url: {url}");
        println!("data folder: {}", udf.display());
        println!("placement file: {}", state_file.display());
        println!(
            "rect: left={} top={} right={} bottom={} ({}x{})",
            rect.left,
            rect.top,
            rect.right,
            rect.bottom,
            rect.w(),
            rect.h()
        );
        println!("maximized: {maximized}");
        println!("why: {why}");
        return;
    }

    if !smoke && !win::single_instance(TITLE) {
        return;
    }
    if !smoke {
        migrate_local_storage(&udf);
    }
    run(url, udf, state_file, rect, maximized, smoke);
}

enum Ev {
    Loaded,
}

fn run(url: String, udf: PathBuf, state_file: PathBuf, rect: Rect, maximized: bool, smoke: bool) {
    use tao::{
        dpi::{PhysicalPosition, PhysicalSize},
        event::{Event, WindowEvent},
        event_loop::{ControlFlow, EventLoopBuilder},
        platform::windows::{WindowBuilderExtWindows, WindowExtWindows},
        window::{Theme, WindowBuilder},
    };
    use wry::{NewWindowResponse, WebContext, WebViewBuilder};

    let event_loop = EventLoopBuilder::<Ev>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title(TITLE)
        .with_visible(false)
        .with_theme(Some(Theme::Dark))
        .with_position(PhysicalPosition::new(rect.left, rect.top))
        .with_inner_size(PhysicalSize::new(rect.w() as u32, rect.h() as u32))
        .with_undecorated_shadow(true)
        .build(&event_loop)
        .expect("window");
    let hwnd = window.hwnd();
    win::set_outer_rect(hwnd, &rect);
    win::title_bar(hwnd, BG, TEXT);
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            win::set_icon(hwnd, &dir.join("hydra-desk.ico"));
        }
    }
    if maximized {
        window.set_maximized(true);
    }

    let origin = origin_of(&url);
    let nav_origin = origin.clone();
    let win_origin = origin.clone();
    let mut ctx = WebContext::new(Some(udf.clone()));
    let load_proxy = proxy.clone();
    let webview = WebViewBuilder::new_with_web_context(&mut ctx)
        .with_url(&url)
        .with_background_color((BG.0, BG.1, BG.2, 255))
        .with_devtools(true)
        .with_navigation_handler(move |u| {
            if origin_of(&u) == nav_origin
                || u.starts_with("about:")
                || u.starts_with("blob:")
                || u.starts_with("data:")
            {
                true
            } else {
                win::open_external(&u);
                false
            }
        })
        .with_new_window_req_handler(move |u, _| {
            if origin_of(&u) == win_origin {
                NewWindowResponse::Allow
            } else {
                win::open_external(&u);
                NewWindowResponse::Deny
            }
        })
        .with_on_page_load_handler(move |ev, _| {
            if matches!(ev, wry::PageLoadEvent::Finished) {
                let _ = load_proxy.send_event(Ev::Loaded);
            }
        })
        .build(&window)
        .expect("webview");

    if smoke {
        let started = Instant::now();
        std::thread::spawn(move || {
            while started.elapsed() < Duration::from_secs(20) {
                std::thread::sleep(Duration::from_millis(200));
            }
            std::process::exit(2);
        });
    } else {
        window.set_visible(true);
        window.set_focus();
    }

    let mut dirty: Option<Instant> = None;
    let save_now = move |window: &tao::window::Window| {
        if let Some((outer, normal, max)) = win::read_placement(window.hwnd()) {
            save_atomic(
                &state_file,
                &Saved {
                    left: outer.left,
                    top: outer.top,
                    right: outer.right,
                    bottom: outer.bottom,
                    maximized: max,
                    window: normal,
                },
            );
        }
    };
    let _keep = (&webview, &ctx);
    event_loop.run(move |event, _, flow| {
        *flow = match dirty {
            Some(t) => ControlFlow::WaitUntil(t),
            None => ControlFlow::Wait,
        };
        match event {
            Event::UserEvent(Ev::Loaded) => {
                if smoke {
                    let _ = std::fs::remove_dir_all(&udf);
                    std::process::exit(0);
                }
            }
            Event::WindowEvent {
                event: WindowEvent::Moved(_) | WindowEvent::Resized(_),
                ..
            } if !smoke => {
                dirty = Some(Instant::now() + Duration::from_millis(400));
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                if !smoke {
                    save_now(&window);
                }
                *flow = ControlFlow::Exit;
            }
            Event::NewEvents(_) | Event::MainEventsCleared => {
                if let Some(t) = dirty {
                    if Instant::now() >= t {
                        dirty = None;
                        save_now(&window);
                    }
                }
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const MON: Rect = Rect {
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1080,
    };

    #[test]
    fn parses_saved_shape_with_bom() {
        let t = "\u{feff}{\"left\":1412,\"top\":228,\"right\":2795,\"bottom\":1281,\"maximized\":false,\"window\":{\"left\":1412,\"top\":228,\"right\":2795,\"bottom\":1281}}";
        let s = parse_saved(t).unwrap();
        assert_eq!(s.window.w(), 1383);
        assert!(!s.maximized);
        assert!(parse_saved("{}").is_none());
        assert!(parse_saved("{\"left\":0,\"top\":0,\"right\":1,\"bottom\":1,\"maximized\":false,\"window\":{\"left\":0,\"top\":0,\"right\":10,\"bottom\":10}}").is_none());
    }

    #[test]
    fn title_bar_ends_must_be_on_a_monitor() {
        let two = [
            MON,
            Rect {
                left: 1920,
                top: 0,
                right: 3840,
                bottom: 1080,
            },
        ];
        assert!(on_monitor(
            &Rect {
                left: 100,
                top: 100,
                right: 900,
                bottom: 700
            },
            &two
        ));
        assert!(on_monitor(
            &Rect {
                left: 1500,
                top: 50,
                right: 2500,
                bottom: 700
            },
            &two
        )); // spans both
        assert!(!on_monitor(
            &Rect {
                left: 100,
                top: 100,
                right: 900,
                bottom: 700
            },
            &[Rect {
                left: 1920,
                top: 0,
                right: 3840,
                bottom: 1080
            }]
        ));
        assert!(!on_monitor(
            &Rect {
                left: 1500,
                top: -200,
                right: 2500,
                bottom: 700
            },
            &two
        )); // title bar above
    }

    #[test]
    fn default_is_centred_and_clamped() {
        let r = default_rect(&MON);
        assert_eq!((r.left, r.top, r.w(), r.h()), (210, 65, 1500, 950));
        let small = default_rect(&Rect {
            left: 0,
            top: 0,
            right: 1280,
            bottom: 720,
        });
        assert_eq!((small.w(), small.h()), (1280, 720));
    }

    #[test]
    fn placement_falls_back_when_off_screen() {
        let off = Saved {
            left: 5000,
            top: 0,
            right: 5800,
            bottom: 600,
            maximized: true,
            window: Rect {
                left: 5000,
                top: 0,
                right: 5800,
                bottom: 600,
            },
        };
        let (r, max, why) = choose_placement(Some(off), &[MON], &MON);
        assert_eq!(r, default_rect(&MON));
        assert!(!max && why.contains("not on a connected monitor"));
        let ok = Saved {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
            maximized: true,
            window: Rect {
                left: 100,
                top: 100,
                right: 900,
                bottom: 700,
            },
        };
        let (r, max, _) = choose_placement(Some(ok), &[MON], &MON);
        assert_eq!(r, ok.window);
        assert!(max);
    }

    #[test]
    fn origin_compare() {
        assert_eq!(
            origin_of("http://127.0.0.1:7798/ah/x?y=1"),
            "http://127.0.0.1:7798"
        );
        assert_ne!(
            origin_of("https://example.com/"),
            origin_of("http://127.0.0.1:7798/")
        );
    }
}
