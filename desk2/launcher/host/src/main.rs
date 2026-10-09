#![cfg_attr(not(test), windows_subsystem = "windows")]
#![allow(clippy::upper_case_acronyms)]
//! Hydra Desk 2's own window: WebView2 in a tao window that is created hidden at the place it was last
//! left, shown once, and never moved after. The place is saved in ~/.hydra-desk-2/window.json
//! ({left,top,right,bottom,maximized,window:{left,top,right,bottom}}, physical pixels).
//!
//!   HydraDesk2.exe [--url <url>] [--dry-run] [--smoke]

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

// AgentHydra 2.0, once called Hydra Desk 2 (owner, 2026-10-06). The tray's hidden window has this title
// too (the tray host names it after the app), so single_instance looks for a visible one.
const TITLE: &str = "AgentHydra";
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
/// A smoke run cannot delete its own WebView2 folder (the browser processes still hold it as the host
/// exits), so each smoke run removes the ones earlier runs left, past the 20 s a run can last.
fn sweep_smoke_dirs(keep: &Path) {
    let Ok(dir) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for e in dir.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(120));
        if old
            && e.path() != keep
            && e.file_name()
                .to_string_lossy()
                .starts_with("HydraDesk2-smoke-")
        {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

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
        fn FindWindowExW(parent: Hwnd, after: Hwnd, class: *const u16, title: *const u16) -> Hwnd;
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
        fn GetSystemMetrics(index: i32) -> i32;
        fn SetProcessDpiAwarenessContext(v: isize) -> i32;
        #[allow(clippy::too_many_arguments)]
        fn CreateWindowExW(
            ex: u32,
            class: *const u16,
            title: *const u16,
            style: u32,
            x: i32,
            y: i32,
            w: i32,
            h: i32,
            parent: Hwnd,
            menu: isize,
            inst: isize,
            param: *const c_void,
        ) -> Hwnd;
        fn DestroyWindow(h: Hwnd) -> i32;
        fn IsZoomed(h: Hwnd) -> i32;
        fn GetDpiForWindow(h: Hwnd) -> u32;
        fn GetSystemMetricsForDpi(index: i32, dpi: u32) -> i32;
        fn SetLayeredWindowAttributes(h: Hwnd, key: u32, alpha: u8, flags: u32) -> i32;
        fn TrackMouseEvent(t: *mut TRACKMOUSEEVENT) -> i32;
    }
    #[repr(C)]
    struct TRACKMOUSEEVENT {
        size: u32,
        flags: u32,
        track: Hwnd,
        hover_time: u32,
    }
    // wry already subclasses the main window through this, so the exe imports it either way.
    #[link(name = "comctl32")]
    extern "system" {
        fn SetWindowSubclass(
            h: Hwnd,
            f: extern "system" fn(Hwnd, u32, usize, isize, usize, usize) -> isize,
            id: usize,
            data: usize,
        ) -> i32;
        fn DefSubclassProc(h: Hwnd, msg: u32, wparam: usize, lparam: isize) -> isize;
        fn RemoveWindowSubclass(
            h: Hwnd,
            f: extern "system" fn(Hwnd, u32, usize, isize, usize, usize) -> isize,
            id: usize,
        ) -> i32;
    }
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(h: Hwnd, attr: u32, v: *const c_void, size: u32) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attrs: *const c_void, owner: i32, name: *const u16) -> isize;
        fn GetLastError() -> u32;
        fn GetModuleHandleW(name: *const u16) -> isize;
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

    /// AgentHydra's icon, compiled into this exe as icon 1 (build.rs), at the sizes Windows draws: the
    /// big one (SM_CXICON) for the taskbar and Alt+Tab, the small one (SM_CXSMICON) for the title bar.
    pub fn set_icon(h: isize) {
        unsafe {
            let exe = GetModuleHandleW(std::ptr::null());
            // ICON_BIG / ICON_SMALL; IMAGE_ICON, MAKEINTRESOURCE(1)
            for (kind, metric) in [(1usize, 11), (0usize, 49)] {
                let size = GetSystemMetrics(metric);
                let ic = LoadImageW(
                    exe,
                    std::ptr::without_provenance::<u16>(1),
                    1,
                    size,
                    size,
                    0,
                );
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
            // The first window of this title that is shown (a minimised one counts): never the tray's
            // hidden one, which shares the title.
            let t = wide(title);
            let mut h = FindWindowExW(0, 0, std::ptr::null(), t.as_ptr());
            while h != 0 && IsWindowVisible(h) == 0 {
                h = FindWindowExW(0, h, std::ptr::null(), t.as_ptr());
            }
            if h != 0 {
                if IsIconic(h) != 0 {
                    ShowWindow(h, 9);
                }
                SetForegroundWindow(h);
            }
            false
        }
    }

    /// A plain child window of the main one that holds one page tab's browser view, hidden until placed. The view is
    /// a child of this, not of the main window: wry's drop of a child view unhooks its parent's resize subclass, which
    /// on the main window is the one that keeps the window's own page sized to it.
    pub fn page_host(parent: Hwnd) -> Hwnd {
        let class = wide("STATIC");
        // WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS | SS_NOTIFY (a static is click-through without it)
        unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                0x4000_0000 | 0x0200_0000 | 0x0400_0000 | 0x0100,
                0,
                0,
                1,
                1,
                parent,
                0,
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null(),
            )
        }
    }

    /// Shows the holder at `r` (client pixels of the main window) above the window's page, or hides it.
    pub fn place_page_host(h: Hwnd, r: Option<&Rect>) {
        unsafe {
            match r {
                // HWND_TOP; SWP_NOACTIVATE | SWP_SHOWWINDOW
                Some(r) => SetWindowPos(h, 0, r.left, r.top, r.w(), r.h(), 0x0010 | 0x0040),
                // SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_HIDEWINDOW
                None => SetWindowPos(h, 0, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0080),
            }
        };
    }

    /// NCCALCSIZE_PARAMS: rgrc[0] is the window's proposed rectangle on the way in and the client rectangle on the way out.
    #[repr(C)]
    struct NcCalcSize {
        rgrc: [RECT; 3],
        pos: *const c_void,
    }
    const CAPTION_SUBCLASS: usize = 0x4147_4e43; // "AGNC": this window's own subclass, apart from wry's and tao's
    const WM_NCCALCSIZE: u32 = 0x0083;
    const SM_CYFRAME: i32 = 33;
    const SM_CXPADDEDBORDER: i32 = 92;

    /// The frame a maximized window hangs past its monitor's edges, at the window's dpi (96 if Windows does not say).
    fn maximized_pad(h: Hwnd) -> i32 {
        let dpi = match unsafe { GetDpiForWindow(h) } {
            0 => 96,
            d => d,
        };
        unsafe {
            GetSystemMetricsForDpi(SM_CYFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi)
        }
    }

    /// Keeps the client area at the window's proposed top, so the caption is gone while the left, right and bottom
    /// keep their native sizing borders and shadow. Maximized, the frame hangs past the monitor, so the client starts below it.
    extern "system" fn caption_subclass(
        h: Hwnd,
        msg: u32,
        wp: usize,
        lp: isize,
        _id: usize,
        _data: usize,
    ) -> isize {
        if msg != WM_NCCALCSIZE || wp == 0 {
            return unsafe { DefSubclassProc(h, msg, wp, lp) };
        }
        let p = lp as *mut NcCalcSize;
        let proposed_top = unsafe { (*p).rgrc[0].top };
        let r = unsafe { DefSubclassProc(h, msg, wp, lp) };
        let pad = if unsafe { IsZoomed(h) } != 0 {
            maximized_pad(h)
        } else {
            0
        };
        unsafe { (*p).rgrc[0].top = proposed_top + pad };
        r
    }

    /// Takes Windows' caption off the main window (caption_subclass). False when the subclass could not be added.
    pub fn remove_caption(h: Hwnd) -> bool {
        if unsafe { SetWindowSubclass(h, caption_subclass, CAPTION_SUBCLASS, 0) } == 0 {
            return false;
        }
        // SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE: the frame is worked out again, nothing moves.
        unsafe { SetWindowPos(h, 0, 0, 0, 0, 0, 0x0020 | 0x0002 | 0x0001 | 0x0004 | 0x0010) };
        true
    }

    /// One of the page's three window buttons.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum CaptionButton {
        Minimize,
        Maximize,
        Close,
    }

    impl CaptionButton {
        /// The hit-test value Windows knows the button by (HTMINBUTTON, HTMAXBUTTON, HTCLOSE).
        fn hit(self) -> isize {
            match self {
                CaptionButton::Minimize => 8,
                CaptionButton::Maximize => 9,
                CaptionButton::Close => 20,
            }
        }
        fn from_hit(hit: usize) -> Option<Self> {
            match hit {
                8 => Some(CaptionButton::Minimize),
                9 => Some(CaptionButton::Maximize),
                20 => Some(CaptionButton::Close),
                _ => None,
            }
        }
        /// The button under `x` (screen pixels) in a sink spanning `left..right`: the page draws three of equal width.
        pub fn at(x: i32, left: i32, right: i32) -> Self {
            let w = (right - left).max(1);
            match ((x - left).clamp(0, w - 1) * 3) / w {
                0 => CaptionButton::Minimize,
                1 => CaptionButton::Maximize,
                _ => CaptionButton::Close,
            }
        }
    }

    /// What the pointer does over the sink: the page draws hover and press from it, a click is the button's action.
    #[derive(Debug, PartialEq)]
    pub enum SinkEvent {
        Hover(Option<CaptionButton>),
        Press(Option<CaptionButton>),
        Click(CaptionButton),
    }

    struct Sink {
        tell: Box<dyn Fn(SinkEvent)>,
        hover: Option<CaptionButton>,
        pressed: Option<CaptionButton>,
        tracking: bool,
    }

    impl Sink {
        fn hover(&mut self, b: Option<CaptionButton>) {
            if self.hover != b {
                self.hover = b;
                (self.tell)(SinkEvent::Hover(b));
            }
        }
        fn press(&mut self, b: Option<CaptionButton>) {
            if self.pressed != b {
                self.pressed = b;
                (self.tell)(SinkEvent::Press(b));
            }
        }
    }

    const SINK_SUBCLASS: usize = 0x4147_534b; // "AGSK"

    /// The caption sink's messages. Over it Windows asks which part of a window the pointer is on (WM_NCHITTEST), and
    /// the answer is the page's button there, so Windows 11 shows its snap layouts over Maximize as it does over its
    /// own. The buttons' pointer messages then come here as non-client ones: hover and press go to the page, which
    /// draws them, and a release on the button pressed is its click. Windows Terminal draws its caption the same way.
    extern "system" fn sink_proc(
        h: Hwnd,
        msg: u32,
        wp: usize,
        lp: isize,
        _id: usize,
        data: usize,
    ) -> isize {
        const WM_NCDESTROY: u32 = 0x0082;
        const WM_NCHITTEST: u32 = 0x0084;
        const WM_NCMOUSEMOVE: u32 = 0x00A0;
        const WM_NCLBUTTONDOWN: u32 = 0x00A1;
        const WM_NCLBUTTONUP: u32 = 0x00A2;
        const WM_NCLBUTTONDBLCLK: u32 = 0x00A3;
        const WM_NCMOUSELEAVE: u32 = 0x02A2;
        if msg == WM_NCDESTROY {
            unsafe { RemoveWindowSubclass(h, sink_proc, SINK_SUBCLASS) };
            drop(unsafe { Box::from_raw(data as *mut Sink) });
            return unsafe { DefSubclassProc(h, msg, wp, lp) };
        }
        let sink = unsafe { &mut *(data as *mut Sink) };
        match msg {
            WM_NCHITTEST => {
                let x = (lp & 0xffff) as i16 as i32;
                let mut r = RECT::default();
                unsafe { GetWindowRect(h, &mut r) };
                CaptionButton::at(x, r.left, r.right).hit()
            }
            WM_NCMOUSEMOVE => {
                if !sink.tracking {
                    // TME_LEAVE | TME_NONCLIENT: WM_NCMOUSELEAVE once the pointer leaves.
                    let mut t = TRACKMOUSEEVENT {
                        size: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                        flags: 0x2 | 0x10,
                        track: h,
                        hover_time: 0,
                    };
                    sink.tracking = unsafe { TrackMouseEvent(&mut t) } != 0;
                }
                sink.hover(CaptionButton::from_hit(wp));
                0
            }
            WM_NCMOUSELEAVE => {
                sink.tracking = false;
                sink.hover(None);
                sink.press(None);
                0
            }
            WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK => {
                sink.press(CaptionButton::from_hit(wp));
                0
            }
            WM_NCLBUTTONUP => {
                let on = CaptionButton::from_hit(wp);
                let clicked = on.filter(|b| sink.pressed == Some(*b));
                sink.press(None);
                if let Some(b) = clicked {
                    (sink.tell)(SinkEvent::Click(b));
                }
                0
            }
            _ => unsafe { DefSubclassProc(h, msg, wp, lp) },
        }
    }

    /// A see-through child of the main window that goes over the page's window buttons (place_sink), hidden until
    /// placed. Layered with no surface of its own (WS_EX_LAYERED | WS_EX_NOREDIRECTIONBITMAP), so the page shows
    /// through; Windows makes a child layered only for an exe that says it is for Windows 8 or later (build.rs's
    /// manifest). None when Windows refuses it: the page's buttons then take their clicks as before.
    pub fn caption_sink(parent: Hwnd, tell: Box<dyn Fn(SinkEvent)>) -> Option<Hwnd> {
        let class = wide("STATIC");
        let h = unsafe {
            CreateWindowExW(
                0x0008_0000 | 0x0020_0000,
                class.as_ptr(),
                std::ptr::null(),
                0x4000_0000 | 0x0400_0000, // WS_CHILD | WS_CLIPSIBLINGS
                0,
                0,
                0,
                0,
                parent,
                0,
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null(),
            )
        };
        if h == 0 {
            return None;
        }
        // LWA_ALPHA, fully opaque: the whole rectangle takes the pointer, though nothing is drawn in it.
        unsafe { SetLayeredWindowAttributes(h, 0, 255, 0x2) };
        let sink = Box::into_raw(Box::new(Sink {
            tell,
            hover: None,
            pressed: None,
            tracking: false,
        }));
        if unsafe { SetWindowSubclass(h, sink_proc, SINK_SUBCLASS, sink as usize) } == 0 {
            drop(unsafe { Box::from_raw(sink) });
            unsafe { DestroyWindow(h) };
            return None;
        }
        Some(h)
    }

    /// Puts the sink over `r` (client pixels of the main window) above the window's page, or hides it.
    pub fn place_sink(h: Hwnd, r: Option<&Rect>) {
        place_page_host(h, r);
    }

    pub fn destroy(h: Hwnd) {
        unsafe { DestroyWindow(h) };
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

// ---- the browser pane's page tabs: desk2/web/src/components/servers/native-browser.ts is the other end ----
// An iframe cannot show a site that sends X-Frame-Options or CSP frame-ancestors (most sites with a sign-in), so a
// page tab asks this window for a browser view of its own, placed over the tab. The window's page says where (client
// pixels) and what to show through window.ipc; each view reports its address and title back as an
// `agenthydra:browser` window event.

/// The most page views at once; an Open past it is refused (the page tab keeps its own placeholder).
const MAX_PAGES: usize = 24;

/// What the window's page asks of a page tab's browser view (HostBrowserIn in native-browser.ts).
#[derive(Debug, PartialEq, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum BrowserCmd {
    /// Show `url` in view `id`, made on first use; no `rect` keeps it hidden.
    Open {
        id: String,
        url: String,
        rect: Option<Rect>,
    },
    /// Move view `id` to `rect`, or hide it.
    Place {
        id: String,
        rect: Option<Rect>,
    },
    Back {
        id: String,
    },
    Forward {
        id: String,
    },
    Reload {
        id: String,
    },
    Close {
        id: String,
    },
    /// Mute or unmute view `id` (ICoreWebView2_8::put_IsMuted).
    Mute {
        id: String,
        muted: bool,
    },
}

impl BrowserCmd {
    fn id(&self) -> &str {
        match self {
            BrowserCmd::Open { id, .. }
            | BrowserCmd::Place { id, .. }
            | BrowserCmd::Back { id }
            | BrowserCmd::Forward { id }
            | BrowserCmd::Reload { id }
            | BrowserCmd::Close { id }
            | BrowserCmd::Mute { id, .. } => id,
        }
    }
}

/// A browser message from the window's page, or None for anything else. A rect with no area means hidden.
fn parse_browser_cmd(text: &str) -> Option<BrowserCmd> {
    #[derive(Deserialize)]
    struct Kind {
        kind: String,
    }
    if serde_json::from_str::<Kind>(text).ok()?.kind != "browser" {
        return None;
    }
    let mut cmd: BrowserCmd = serde_json::from_str(text).ok()?;
    if cmd.id().is_empty() || cmd.id().len() > 64 {
        return None;
    }
    if let BrowserCmd::Open { rect, .. } | BrowserCmd::Place { rect, .. } = &mut cmd {
        *rect = rect.filter(|r| r.w() > 0 && r.h() > 0 && r.w() <= 32_000 && r.h() <= 32_000);
    }
    Some(cmd)
}

// ---- the window's own frame: the page's host bridge is the other end ----
// The page draws its top row as the title bar: `ready` turns Windows' caption off (once), the page's own buttons ask for
// minimize, maximize, close or a resize drag, and the window answers with an `agenthydra:window` event.

/// What the window's page asks of the window (`{"op":"window","action":...}`).
#[derive(Debug, PartialEq)]
enum WindowCmd {
    /// The page has loaded: turn the caption off (once) and say what the window is now.
    Ready,
    Minimize,
    /// Maximize, or restore when maximized.
    Maximize,
    /// What the caption's X does: the placement is saved and the window closes.
    Close,
    /// Start a native resize drag from this edge.
    Resize(Edge),
    /// Start the window's move, as a press on the caption does (a title bar the page's drag regions cannot cover).
    Drag,
    /// Where the page's three window buttons are, in client pixels, or None while it shows none: the caption sink
    /// goes over them (win::caption_sink).
    Buttons(Option<Rect>),
}

/// The edges the page starts a resize drag from (the top ones: the page draws those).
#[derive(Debug, PartialEq)]
enum Edge {
    North,
    NorthEast,
    NorthWest,
}

/// A window message from the window's page, or None for anything else; an unknown action is ignored.
fn parse_window_cmd(text: &str) -> Option<WindowCmd> {
    #[derive(Deserialize)]
    struct Msg {
        op: String,
        action: String,
        edge: Option<String>,
        /// left, top, width, height
        rect: Option<[i32; 4]>,
    }
    let m: Msg = serde_json::from_str(text).ok()?;
    if m.op != "window" {
        return None;
    }
    Some(match m.action.as_str() {
        "ready" => WindowCmd::Ready,
        "minimize" => WindowCmd::Minimize,
        "maximize" => WindowCmd::Maximize,
        "close" => WindowCmd::Close,
        "drag" => WindowCmd::Drag,
        // Three buttons are a few hundred pixels at most; anything else is not the page's buttons.
        "buttons" => WindowCmd::Buttons(match m.rect {
            None => None,
            Some([left, top, w, h]) if (1..=2000).contains(&w) && (1..=400).contains(&h) => {
                Some(Rect {
                    left,
                    top,
                    right: left + w,
                    bottom: top + h,
                })
            }
            Some(_) => return None,
        }),
        "resize" => WindowCmd::Resize(match m.edge.as_deref()? {
            "n" => Edge::North,
            "ne" => Edge::NorthEast,
            "nw" => Edge::NorthWest,
            _ => return None,
        }),
        _ => return None,
    })
}

/// The script that tells the window's page its frame (the caption is gone) and whether it is maximized.
fn window_event_script(frame: bool, maximized: bool) -> String {
    format!("window.dispatchEvent(new CustomEvent('agenthydra:window',{{detail:{{frame:{frame},maximized:{maximized}}}}}))")
}

/// The script that tells the window's page which of its window buttons the pointer is over and which is pressed (the
/// caption sink takes the pointer there, so the page's own hover never fires).
fn caption_event_script(
    hover: Option<win::CaptionButton>,
    pressed: Option<win::CaptionButton>,
) -> String {
    let name = |b: Option<win::CaptionButton>| match b {
        Some(win::CaptionButton::Minimize) => "\"minimize\"",
        Some(win::CaptionButton::Maximize) => "\"maximize\"",
        Some(win::CaptionButton::Close) => "\"close\"",
        None => "null",
    };
    format!(
        "window.dispatchEvent(new CustomEvent('agenthydra:caption',{{detail:{{hover:{},pressed:{}}}}}))",
        name(hover),
        name(pressed)
    )
}

/// Where a page tab's view may go: http and https except AgentHydra's own window, and about: and blob: pages.
fn page_url_allowed(url: &str, desk_origin: &str) -> bool {
    let u = url.to_ascii_lowercase();
    if u.starts_with("about:") || u.starts_with("blob:") {
        return true;
    }
    (u.starts_with("http://") || u.starts_with("https://"))
        && origin_of(&u) != desk_origin.to_ascii_lowercase()
}

/// A local page on this PC (file:///C:/...). Only the Desk opens one; a web page reaches one only as a link from a local page.
fn is_local_page(url: &str) -> bool {
    url.to_ascii_lowercase().starts_with("file:///")
}

/// Where a local page is remembered: lower case, with %XX escapes undone (WebView2 may escape a space in a path).
fn local_key(url: &str) -> String {
    let b = url.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = b
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match (b[i], hex) {
            (b'%', Some(v)) => {
                out.push(v);
                i += 3;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_ascii_lowercase()
}

/// The address the Desk may open in a page view: a local page, or what page_url_allowed allows.
fn desk_page_allowed(url: &str, desk_origin: &str) -> bool {
    is_local_page(url) || page_url_allowed(url, desk_origin)
}

/// What a page view has shown. A web page may reach a local page only when this view already showed it (its own
/// history, back and forward) or is on a local page itself (a link between local pages); it never brings in a new one.
#[derive(Default)]
struct PageState {
    on_file: bool,
    files: std::collections::HashSet<String>,
}

impl PageState {
    fn opened(&mut self, url: &str) {
        if is_local_page(url) {
            self.files.insert(local_key(url));
        }
    }

    fn shown(&mut self, url: &str) {
        self.on_file = is_local_page(url);
        self.opened(url);
    }

    fn allows(&self, url: &str, desk_origin: &str) -> bool {
        if is_local_page(url) {
            return self.on_file || self.files.contains(&local_key(url));
        }
        page_url_allowed(url, desk_origin)
    }
}

fn lock_state(state: &Mutex<PageState>) -> MutexGuard<'_, PageState> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a page tab's view tells the window's page (HostBrowserOut in native-browser.ts).
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum PageOut {
    Url {
        url: String,
        loading: bool,
    },
    Title {
        title: String,
        url: String,
    },
    /// Whether the view's document is playing sound, and whether the view is muted.
    Audio {
        playing: bool,
        muted: bool,
    },
}

/// The view's ICoreWebView2_8, or None when the WebView2 runtime is too old to have it.
fn webview8(
    view: &wry::WebView,
) -> Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8> {
    use windows::core::Interface;
    use wry::WebViewExtWindows;
    let core = unsafe { view.controller().CoreWebView2() }.ok()?;
    core.cast().ok()
}

/// Turns on WebView2's non-client region support for the main view: the page's `app-region: drag` areas drag the
/// window, and double-click and the right-click system menu work there too. It applies from the next navigation, so
/// it is called before the page loads. False on a runtime too old to have it.
fn enable_non_client_regions(view: &wry::WebView) -> bool {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings9;
    use windows::core::Interface;
    use wry::WebViewExtWindows;
    let Ok(core) = (unsafe { view.controller().CoreWebView2() }) else {
        return false;
    };
    let Ok(settings) = (unsafe { core.Settings() }) else {
        return false;
    };
    let Ok(s9) = settings.cast::<ICoreWebView2Settings9>() else {
        return false;
    };
    unsafe { s9.SetIsNonClientRegionSupportEnabled(true) }.is_ok()
}

/// A view's (playing, muted) as the runtime reports them now.
fn audio_state(
    wv: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8,
) -> Option<(bool, bool)> {
    let mut playing = windows::Win32::Foundation::FALSE;
    let mut muted = windows::Win32::Foundation::FALSE;
    unsafe {
        wv.IsDocumentPlayingAudio(&mut playing).ok()?;
        wv.IsMuted(&mut muted).ok()?;
    }
    Some((playing.as_bool(), muted.as_bool()))
}

/// Report the view's sound state to the window's page whenever it or the mute flag changes.
fn watch_audio(view: &wry::WebView, id: &str, proxy: &tao::event_loop::EventLoopProxy<Ev>) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
    use webview2_com::{IsDocumentPlayingAudioChangedEventHandler, IsMutedChangedEventHandler};
    use windows::core::Interface;
    let Some(wv) = webview8(view) else { return };
    let mut token = 0i64;
    let report = {
        let (proxy, id) = (proxy.clone(), id.to_string());
        move |wv: &ICoreWebView2_8| {
            if let Some((playing, muted)) = audio_state(wv) {
                let _ = proxy.send_event(Ev::Page(id.clone(), PageOut::Audio { playing, muted }));
            }
        }
    };
    let (a, b) = (report.clone(), report);
    let on_playing = IsDocumentPlayingAudioChangedEventHandler::create(Box::new(move |s, _| {
        if let Some(w) = s.and_then(|s| s.cast::<ICoreWebView2_8>().ok()) {
            a(&w);
        }
        Ok(())
    }));
    let on_muted = IsMutedChangedEventHandler::create(Box::new(move |s, _| {
        if let Some(w) = s.and_then(|s| s.cast::<ICoreWebView2_8>().ok()) {
            b(&w);
        }
        Ok(())
    }));
    unsafe {
        let _ = wv.add_IsDocumentPlayingAudioChanged(&on_playing, &mut token);
        let _ = wv.add_IsMutedChanged(&on_muted, &mut token);
    }
}

/// The script that hands `out` to the window's page as an `agenthydra:browser` event. JSON is a JavaScript literal.
fn page_event_script(id: &str, out: &PageOut) -> String {
    #[derive(Serialize)]
    struct Detail<'a> {
        id: &'a str,
        #[serde(flatten)]
        out: &'a PageOut,
    }
    let json = serde_json::to_string(&Detail { id, out }).unwrap_or_else(|_| "null".into());
    format!("window.dispatchEvent(new CustomEvent('agenthydra:browser',{{detail:{json}}}))")
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
    // A second window beside the person's own, for trying a build: its own throwaway WebView2 folder, no
    // single-instance hand-off, no saved placement. It stays open until closed, as a smoke run does not.
    let side = flag("--side-run");

    win::dpi_aware();
    let (monitors, primary) = win::monitors();
    let state_file = desk_home().join("window.json");
    let saved = std::fs::read_to_string(&state_file)
        .ok()
        .and_then(|t| parse_saved(&t));
    let (rect, maximized, why) = choose_placement(saved, &monitors, &primary);
    let udf = if smoke || side {
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

    if !smoke && !side && !win::single_instance(TITLE) {
        return;
    }
    if smoke || side {
        sweep_smoke_dirs(&udf);
    } else {
        migrate_local_storage(&udf);
    }
    run(url, udf, state_file, rect, maximized, smoke, side);
}

enum Ev {
    Loaded,
    /// The window's own page began loading a document: the page views it placed go with the page that made them.
    Reloading,
    Browser(BrowserCmd),
    Window(WindowCmd),
    /// A page view's address or title changed.
    Page(String, PageOut),
    /// A page view asked for a new window: the address opens in that view instead.
    OpenHere(String, String),
    /// The pointer over the caption sink (the page's window buttons).
    Sink(win::SinkEvent),
}

/// One page tab's browser view and the child window that holds it (win::page_host).
struct PageView {
    view: Option<wry::WebView>,
    holder: isize,
    shown: bool,
    state: Arc<Mutex<PageState>>,
}

impl PageView {
    fn view(&self) -> &wry::WebView {
        self.view.as_ref().expect("a page view lives until dropped")
    }

    fn open(&mut self, url: &str) {
        lock_state(&self.state).opened(url);
        let _ = self.view().load_url(url);
    }

    fn place(&mut self, rect: Option<Rect>) {
        use wry::dpi::{PhysicalPosition, PhysicalSize};
        win::place_page_host(self.holder, rect.as_ref());
        if let Some(r) = rect {
            let _ = self.view().set_bounds(wry::Rect {
                position: PhysicalPosition::new(0, 0).into(),
                size: PhysicalSize::new(r.w() as u32, r.h() as u32).into(),
            });
        }
        if rect.is_some() != self.shown {
            self.shown = rect.is_some();
            let _ = self.view().set_visible(self.shown);
        }
    }
}

impl Drop for PageView {
    fn drop(&mut self) {
        drop(self.view.take());
        win::destroy(self.holder);
    }
}

/// The child window's handle, for wry to build a view inside.
struct Holder(isize);

impl wry::raw_window_handle::HasWindowHandle for Holder {
    fn window_handle(
        &self,
    ) -> Result<wry::raw_window_handle::WindowHandle<'_>, wry::raw_window_handle::HandleError> {
        use wry::raw_window_handle::{
            HandleError, RawWindowHandle, Win32WindowHandle, WindowHandle,
        };
        let h = std::num::NonZeroIsize::new(self.0).ok_or(HandleError::Unavailable)?;
        Ok(unsafe { WindowHandle::borrow_raw(RawWindowHandle::Win32(Win32WindowHandle::new(h))) })
    }
}

fn build_page(
    ctx: &mut wry::WebContext,
    parent: isize,
    id: &str,
    url: &str,
    proxy: &tao::event_loop::EventLoopProxy<Ev>,
    desk_origin: &str,
) -> Option<PageView> {
    use wry::{NewWindowResponse, PageLoadEvent, WebViewBuilder};
    let holder = win::page_host(parent);
    if holder == 0 {
        return None;
    }
    let (nav_origin, win_origin) = (desk_origin.to_string(), desk_origin.to_string());
    let (load_proxy, title_proxy, win_proxy) = (proxy.clone(), proxy.clone(), proxy.clone());
    let (load_id, title_id, win_id) = (id.to_string(), id.to_string(), id.to_string());
    let state = Arc::new(Mutex::new(PageState::default()));
    lock_state(&state).opened(url);
    let (nav_state, win_state, load_state) = (state.clone(), state.clone(), state.clone());
    let built = WebViewBuilder::new_with_web_context(ctx)
        .with_url(url)
        .with_visible(false)
        .with_focused(false)
        .with_devtools(true)
        .with_navigation_handler(move |u| {
            if lock_state(&nav_state).allows(&u, &nav_origin) {
                return true;
            }
            if u.to_ascii_lowercase().starts_with("mailto:") {
                win::open_external(&u);
            }
            false
        })
        // Called off the UI thread on Windows: the view is reached through the event loop.
        .with_new_window_req_handler(move |u, _| {
            if lock_state(&win_state).allows(&u, &win_origin) {
                let _ = win_proxy.send_event(Ev::OpenHere(win_id.clone(), u));
            } else if u.to_ascii_lowercase().starts_with("mailto:") {
                win::open_external(&u);
            }
            NewWindowResponse::Deny
        })
        .with_on_page_load_handler(move |ev, u| {
            let loading = matches!(ev, PageLoadEvent::Started);
            if loading {
                lock_state(&load_state).shown(&u);
            }
            let _ =
                load_proxy.send_event(Ev::Page(load_id.clone(), PageOut::Url { url: u, loading }));
        })
        .with_document_title_changed_handler(move |title| {
            let out = PageOut::Title {
                title,
                url: String::new(),
            };
            let _ = title_proxy.send_event(Ev::Page(title_id.clone(), out));
        })
        .build_as_child(&Holder(holder));
    match built {
        Ok(view) => {
            watch_audio(&view, id, proxy);
            Some(PageView {
                view: Some(view),
                holder,
                shown: false,
                state,
            })
        }
        Err(_) => {
            win::destroy(holder);
            None
        }
    }
}

fn browser_cmd(
    cmd: BrowserCmd,
    pages: &mut std::collections::HashMap<String, PageView>,
    ctx: &mut wry::WebContext,
    parent: isize,
    proxy: &tao::event_loop::EventLoopProxy<Ev>,
    desk_origin: &str,
) {
    match cmd {
        BrowserCmd::Open { id, url, rect } => {
            if !desk_page_allowed(&url, desk_origin) {
                return;
            }
            if let Some(p) = pages.get_mut(&id) {
                p.open(&url);
                p.place(rect);
                return;
            }
            if pages.len() >= MAX_PAGES {
                return;
            }
            if let Some(mut p) = build_page(ctx, parent, &id, &url, proxy, desk_origin) {
                p.place(rect);
                pages.insert(id, p);
            }
        }
        BrowserCmd::Place { id, rect } => {
            if let Some(p) = pages.get_mut(&id) {
                p.place(rect);
            }
        }
        BrowserCmd::Back { id } => {
            if let Some(p) = pages.get(&id) {
                let _ = p.view().evaluate_script("history.back()");
            }
        }
        BrowserCmd::Forward { id } => {
            if let Some(p) = pages.get(&id) {
                let _ = p.view().evaluate_script("history.forward()");
            }
        }
        BrowserCmd::Reload { id } => {
            if let Some(p) = pages.get(&id) {
                let _ = p.view().reload();
            }
        }
        BrowserCmd::Close { id } => {
            pages.remove(&id);
        }
        BrowserCmd::Mute { id, muted } => {
            if let Some(wv) = pages.get(&id).and_then(|p| webview8(p.view())) {
                let _ = unsafe { wv.SetIsMuted(muted) };
            }
        }
    }
}

fn run(
    url: String,
    udf: PathBuf,
    state_file: PathBuf,
    rect: Rect,
    maximized: bool,
    smoke: bool,
    side: bool,
) {
    use tao::{event_loop::EventLoopBuilder, platform::windows::WindowExtWindows};

    let event_loop = EventLoopBuilder::<Ev>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = build_window(&event_loop, &rect, maximized);
    let hwnd = window.hwnd();
    let zoomed = window.is_maximized();
    let origin = origin_of(&url);
    let mut ctx = wry::WebContext::new(Some(udf.clone()));
    let (webview, regions) = build_webview(&mut ctx, &window, &url, &origin, &proxy, !side);

    if smoke {
        start_smoke_deadline();
    } else {
        window.set_visible(true);
        window.set_focus();
    }

    let mut host = Host {
        window,
        webview,
        hwnd,
        proxy,
        origin,
        udf,
        state_file,
        smoke,
        side,
        dirty: None,
        minimized: false,
        ready_done: false,
        regions,
        caption_gone: false,
        maximized: zoomed,
        sink: None,
        sink_tried: false,
        caption: (None, None),
        pages: std::collections::HashMap::new(),
        ctx,
    };
    event_loop.run(move |event, _, flow| host.handle(event, flow));
}

fn build_window(
    event_loop: &tao::event_loop::EventLoop<Ev>,
    rect: &Rect,
    maximized: bool,
) -> tao::window::Window {
    use tao::{
        dpi::{PhysicalPosition, PhysicalSize},
        platform::windows::{WindowBuilderExtWindows, WindowExtWindows},
        window::{Theme, WindowBuilder},
    };

    let window = WindowBuilder::new()
        .with_title(TITLE)
        .with_visible(false)
        .with_theme(Some(Theme::Dark))
        .with_position(PhysicalPosition::new(rect.left, rect.top))
        .with_inner_size(PhysicalSize::new(rect.w() as u32, rect.h() as u32))
        .with_undecorated_shadow(true)
        .build(event_loop)
        .expect("window");
    let hwnd = window.hwnd();
    win::set_outer_rect(hwnd, rect);
    win::title_bar(hwnd, BG, TEXT);
    win::set_icon(hwnd);
    if maximized {
        window.set_maximized(true);
    }
    window
}

fn build_webview(
    ctx: &mut wry::WebContext,
    window: &tao::window::Window,
    url: &str,
    origin: &str,
    proxy: &tao::event_loop::EventLoopProxy<Ev>,
    main: bool,
) -> (wry::WebView, bool) {
    use wry::{NewWindowResponse, WebViewBuilder};

    let nav_origin = origin.to_string();
    let win_origin = origin.to_string();
    let ipc_origin = origin.to_string();
    let load_proxy = proxy.clone();
    let ipc_proxy = proxy.clone();
    // The page's page tabs show their addresses in views of this window's own (native-browser.ts). frame: the main
    // window's page draws its own title bar (the window's frame), a side window keeps Windows' caption.
    let host = if main {
        "window.agentHydraHost=Object.freeze({browser:1,audio:1,frame:1});"
    } else {
        "window.agentHydraHost=Object.freeze({browser:1,audio:1});"
    };
    // The main view loads its page only once non-client regions are on: WebView2 applies that setting from the next
    // navigation, so turned on at the page's `ready` it would have waited for a reload before a drag worked.
    let builder = WebViewBuilder::new_with_web_context(ctx);
    let builder = if main { builder } else { builder.with_url(url) };
    let view = builder
        .with_background_color((BG.0, BG.1, BG.2, 255))
        .with_devtools(true)
        .with_initialization_script(host)
        .with_ipc_handler(move |req| {
            if origin_of(&req.uri().to_string()) != ipc_origin {
                return;
            }
            if let Some(cmd) = parse_window_cmd(req.body()) {
                let _ = ipc_proxy.send_event(Ev::Window(cmd));
            } else if let Some(cmd) = parse_browser_cmd(req.body()) {
                let _ = ipc_proxy.send_event(Ev::Browser(cmd));
            }
        })
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
            let _ = load_proxy.send_event(match ev {
                wry::PageLoadEvent::Started => Ev::Reloading,
                wry::PageLoadEvent::Finished => Ev::Loaded,
            });
        })
        .build(window)
        .expect("webview");
    let regions = main && enable_non_client_regions(&view);
    if main {
        let _ = view.load_url(url);
    }
    (view, regions)
}

fn start_smoke_deadline() {
    let started = Instant::now();
    std::thread::spawn(move || {
        while started.elapsed() < Duration::from_secs(20) {
            std::thread::sleep(Duration::from_millis(200));
        }
        std::process::exit(2);
    });
}

fn save_placement(state_file: &Path, window: &tao::window::Window) {
    use tao::platform::windows::WindowExtWindows;

    if let Some((outer, normal, max)) = win::read_placement(window.hwnd()) {
        save_atomic(
            state_file,
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
}

/// Everything the event loop owns. The WebContext stays alive for as long as the views made from it.
// Fields drop in this order: the views (webview, pages) first, then the WebContext they were made in, and the
// window that holds them last.
struct Host {
    webview: wry::WebView,
    hwnd: isize,
    proxy: tao::event_loop::EventLoopProxy<Ev>,
    origin: String,
    udf: PathBuf,
    state_file: PathBuf,
    smoke: bool,
    side: bool,
    dirty: Option<Instant>,
    minimized: bool,
    /// The page's first `ready` has been answered: the caption is taken off once, later ones only re-send the state.
    ready_done: bool,
    /// The main view's non-client regions are on, so the page's `app-region: drag` areas drag the window.
    regions: bool,
    /// Windows' caption is off (non-client regions on and caption_subclass in).
    caption_gone: bool,
    /// The main window's maximized state, as the page was last told it.
    maximized: bool,
    /// The see-through window over the page's window buttons (win::caption_sink), once the page has placed them.
    sink: Option<isize>,
    /// The sink was asked for once: Windows refused it, or it is there.
    sink_tried: bool,
    /// The button under the pointer and the one pressed, as the page was last told.
    caption: (Option<win::CaptionButton>, Option<win::CaptionButton>),
    pages: std::collections::HashMap<String, PageView>,
    ctx: wry::WebContext,
    window: tao::window::Window,
}

impl Host {
    fn handle(
        &mut self,
        event: tao::event::Event<'_, Ev>,
        flow: &mut tao::event_loop::ControlFlow,
    ) {
        use tao::{
            event::{Event, WindowEvent},
            event_loop::ControlFlow,
        };

        *flow = match self.dirty {
            Some(t) => ControlFlow::WaitUntil(t),
            None => ControlFlow::Wait,
        };
        match event {
            Event::UserEvent(ev) => self.user_event(ev, flow),
            Event::WindowEvent {
                event: WindowEvent::Moved(_) | WindowEvent::Resized(_),
                ..
            } if !self.smoke => self.moved_or_resized(),
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => self.close(flow),
            Event::NewEvents(_) | Event::MainEventsCleared => self.save_if_due(),
            _ => {}
        }
    }

    /// The title bar's X and the page's `close`: the placement is saved, then the window goes.
    fn close(&mut self, flow: &mut tao::event_loop::ControlFlow) {
        use tao::event_loop::ControlFlow;

        if !self.smoke && !self.side {
            save_placement(&self.state_file, &self.window);
        }
        // Gone from the screen at once: the exit then tears down the main WebView2 and one per
        // browser pane, which held the window up visibly for as long as that took.
        self.window.set_visible(false);
        *flow = ControlFlow::Exit;
    }

    /// The page's `ready`: on the first one, turn the caption off if WebView2 can drag from the page's regions.
    fn ready(&mut self) {
        if !self.ready_done {
            self.ready_done = true;
            self.caption_gone = self.regions && win::remove_caption(self.hwnd);
        }
        self.send_window_state();
    }

    fn send_window_state(&self) {
        let _ = self
            .webview
            .evaluate_script(&window_event_script(self.caption_gone, self.maximized));
    }

    fn window_cmd(&mut self, cmd: WindowCmd, flow: &mut tao::event_loop::ControlFlow) {
        use tao::window::ResizeDirection;

        match cmd {
            WindowCmd::Ready => self.ready(),
            WindowCmd::Minimize => self.window.set_minimized(true),
            WindowCmd::Maximize => self.window.set_maximized(!self.window.is_maximized()),
            WindowCmd::Close => self.close(flow),
            WindowCmd::Resize(edge) => {
                let dir = match edge {
                    Edge::North => ResizeDirection::North,
                    Edge::NorthEast => ResizeDirection::NorthEast,
                    Edge::NorthWest => ResizeDirection::NorthWest,
                };
                let _ = self.window.drag_resize_window(dir);
            }
            WindowCmd::Drag => {
                let _ = self.window.drag_window();
            }
            WindowCmd::Buttons(r) => self.place_sink(r),
        }
    }

    /// The sink goes over the page's buttons once Windows' caption is off (the page's buttons are the window's then),
    /// made the first time they are placed; None hides it.
    fn place_sink(&mut self, r: Option<Rect>) {
        let r = r.filter(|_| self.caption_gone);
        if r.is_some() && !self.sink_tried {
            self.sink_tried = true;
            let proxy = self.proxy.clone();
            self.sink = win::caption_sink(
                self.hwnd,
                Box::new(move |e| {
                    let _ = proxy.send_event(Ev::Sink(e));
                }),
            );
        }
        if let Some(h) = self.sink {
            win::place_sink(h, r.as_ref());
        }
    }

    fn sink_event(&mut self, e: win::SinkEvent, flow: &mut tao::event_loop::ControlFlow) {
        use win::{CaptionButton, SinkEvent};
        let (hover, pressed) = self.caption;
        self.caption = match e {
            SinkEvent::Hover(b) => (b, pressed),
            SinkEvent::Press(b) => (hover, b),
            SinkEvent::Click(b) => {
                let cmd = match b {
                    CaptionButton::Minimize => WindowCmd::Minimize,
                    CaptionButton::Maximize => WindowCmd::Maximize,
                    CaptionButton::Close => WindowCmd::Close,
                };
                return self.window_cmd(cmd, flow);
            }
        };
        let _ = self
            .webview
            .evaluate_script(&caption_event_script(self.caption.0, self.caption.1));
    }

    fn user_event(&mut self, ev: Ev, flow: &mut tao::event_loop::ControlFlow) {
        match ev {
            Ev::Loaded => {
                if self.smoke {
                    let _ = std::fs::remove_dir_all(&self.udf);
                    std::process::exit(0);
                }
            }
            Ev::Reloading => {
                self.pages.clear();
                // The next document places its own buttons, or has none to place.
                self.place_sink(None);
            }
            Ev::Sink(e) => self.sink_event(e, flow),
            // The window's frame belongs to the main window: a side window's page has no frame to answer for.
            Ev::Window(cmd) => {
                if !self.side {
                    self.window_cmd(cmd, flow);
                }
            }
            Ev::Browser(cmd) => browser_cmd(
                cmd,
                &mut self.pages,
                &mut self.ctx,
                self.hwnd,
                &self.proxy,
                &self.origin,
            ),
            Ev::Page(id, mut out) => {
                let Some(p) = self.pages.get(&id) else { return };
                if let PageOut::Title { url, .. } = &mut out {
                    *url = p.view().url().unwrap_or_default();
                }
                let _ = self.webview.evaluate_script(&page_event_script(&id, &out));
            }
            Ev::OpenHere(id, url) => {
                if let Some(p) = self.pages.get(&id) {
                    let _ = p.view().load_url(&url);
                }
            }
        }
    }

    fn moved_or_resized(&mut self) {
        use wry::{MemoryUsageLevel, WebViewExtWindows};

        if !self.side {
            self.dirty = Some(Instant::now() + Duration::from_millis(400));
            let maximized = self.window.is_maximized();
            if maximized != self.maximized {
                self.maximized = maximized;
                self.send_window_state();
            }
        }
        // wry skips SIZE_MINIMIZED, so the page would stay 'visible' while minimized.
        let min = self.window.is_minimized();
        if min == self.minimized {
            return;
        }
        self.minimized = min;
        if min {
            let _ = self.webview.set_visible(false);
            let _ = self.webview.set_memory_usage_level(MemoryUsageLevel::Low);
        } else {
            let _ = self.webview.set_visible(true);
            let _ = self
                .webview
                .set_memory_usage_level(MemoryUsageLevel::Normal);
        }
        for p in self.pages.values().filter(|p| p.shown) {
            let _ = p.view().set_visible(!min);
        }
    }

    fn save_if_due(&mut self) {
        if let Some(t) = self.dirty {
            if Instant::now() >= t {
                self.dirty = None;
                save_placement(&self.state_file, &self.window);
            }
        }
    }
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
    fn browser_messages_parse_and_bad_ones_are_dropped() {
        let open = r#"{"kind":"browser","op":"open","id":"page-1","url":"https://example.com/","rect":{"left":10,"top":20,"right":810,"bottom":620}}"#;
        assert_eq!(
            parse_browser_cmd(open),
            Some(BrowserCmd::Open {
                id: "page-1".into(),
                url: "https://example.com/".into(),
                rect: Some(Rect {
                    left: 10,
                    top: 20,
                    right: 810,
                    bottom: 620
                }),
            })
        );
        // A rect with no area is a hidden view; a missing one too.
        let flat = r#"{"kind":"browser","op":"place","id":"p","rect":{"left":10,"top":20,"right":10,"bottom":620}}"#;
        assert_eq!(
            parse_browser_cmd(flat),
            Some(BrowserCmd::Place {
                id: "p".into(),
                rect: None
            })
        );
        let hidden = r#"{"kind":"browser","op":"place","id":"p","rect":null}"#;
        assert_eq!(
            parse_browser_cmd(hidden),
            Some(BrowserCmd::Place {
                id: "p".into(),
                rect: None
            })
        );
        assert_eq!(
            parse_browser_cmd(r#"{"kind":"browser","op":"back","id":"p"}"#),
            Some(BrowserCmd::Back { id: "p".into() })
        );
        // Not a browser message, an unknown op, no id, an id too long: nothing.
        assert_eq!(
            parse_browser_cmd(r#"{"kind":"other","op":"close","id":"p"}"#),
            None
        );
        assert_eq!(
            parse_browser_cmd(r#"{"kind":"browser","op":"explode","id":"p"}"#),
            None
        );
        assert_eq!(
            parse_browser_cmd(r#"{"kind":"browser","op":"close","id":""}"#),
            None
        );
        let long = format!(
            r#"{{"kind":"browser","op":"close","id":"{}"}}"#,
            "x".repeat(65)
        );
        assert_eq!(parse_browser_cmd(&long), None);
        assert_eq!(parse_browser_cmd("not json"), None);
    }

    #[test]
    fn page_views_go_to_web_pages_only_never_the_window_itself() {
        let desk = "http://127.0.0.1:7798";
        assert!(page_url_allowed(
            "https://events.example.com/kiosk/x?eid=1",
            desk
        ));
        assert!(page_url_allowed("http://localhost:5173/", desk));
        assert!(page_url_allowed("HTTPS://Example.COM/", desk));
        assert!(page_url_allowed("about:blank", desk));
        assert!(page_url_allowed("blob:https://example.com/0b6c", desk));
        assert!(!page_url_allowed("http://127.0.0.1:7798/ah/", desk));
        assert!(!page_url_allowed("HTTP://127.0.0.1:7798", desk));
        assert!(!page_url_allowed("file:///C:/Windows/win.ini", desk));
        assert!(!page_url_allowed("javascript:alert(1)", desk));
        assert!(!page_url_allowed("ms-settings:privacy", desk));
        assert!(!page_url_allowed("mailto:owner@example.com", desk));
    }

    #[test]
    fn the_desk_may_open_a_local_page_but_a_web_page_may_not_bring_one_in() {
        let desk = "http://127.0.0.1:7798";
        let page = "file:///C:/Users/me/Project/tmp/review/main.card-share.html";
        assert!(desk_page_allowed(page, desk));
        assert!(desk_page_allowed("file:///C:/Windows/win.ini", desk));
        assert!(!desk_page_allowed("file://server/share/main.html", desk));
        assert!(!desk_page_allowed("http://127.0.0.1:7798/ah/", desk));
        assert!(!desk_page_allowed("javascript:alert(1)", desk));
        let mut web = PageState::default();
        web.shown("https://example.com/");
        assert!(!web.allows(page, desk));
        assert!(!web.allows("file:///C:/Windows/win.ini", desk));
        assert!(!web.allows("http://127.0.0.1:7798/ah/", desk));
        assert!(!web.allows("javascript:alert(1)", desk));
        assert!(!web.allows("ms-settings:privacy", desk));
        assert!(!web.allows("mailto:owner@example.com", desk));
        assert!(web.allows("https://example.com/next", desk));
        assert!(web.allows("about:blank", desk));
    }

    #[test]
    fn a_local_page_links_to_local_pages_and_back_returns_only_to_one_the_tab_showed() {
        let desk = "http://127.0.0.1:7798";
        let main = "file:///C:/Users/me/Project/tmp/review/main.html";
        let other = "file:///C:/Users/me/Project/tmp/review/other.html";
        let mut tab = PageState::default();
        tab.opened(main);
        tab.shown(main);
        assert!(tab.allows(other, desk));
        tab.shown(other);
        tab.shown("https://example.com/");
        assert!(tab.allows(main, desk));
        assert!(tab.allows(other, desk));
        assert!(!tab.allows("file:///C:/Users/me/Project/tmp/review/never-shown.html", desk));
        assert!(!tab.allows("file:///C:/Windows/win.ini", desk));
    }

    #[test]
    fn a_local_page_address_matches_however_webview2_escapes_it() {
        assert_eq!(
            local_key("file:///C:/Users/me/A%20Folder/Main.html"),
            "file:///c:/users/me/a folder/main.html"
        );
        assert_eq!(
            local_key("file:///C:/Users/me/A Folder/Main.html"),
            local_key("file:///C:/Users/me/A%20Folder/Main.html")
        );
    }

    #[test]
    fn page_events_reach_the_page_as_a_window_event() {
        let s = page_event_script(
            "page-1",
            &PageOut::Url {
                url: "https://example.com/a?b='c'</script>".into(),
                loading: true,
            },
        );
        assert_eq!(
            s,
            r#"window.dispatchEvent(new CustomEvent('agenthydra:browser',{detail:{"id":"page-1","type":"url","url":"https://example.com/a?b='c'</script>","loading":true}}))"#
        );
        let t = page_event_script(
            "p",
            &PageOut::Title {
                title: "A \"quoted\" title".into(),
                url: "https://example.com/".into(),
            },
        );
        assert!(t.contains(
            r#"{"id":"p","type":"title","title":"A \"quoted\" title","url":"https://example.com/"}"#
        ));
    }

    #[test]
    fn a_view_can_be_muted_and_reports_its_sound() {
        for muted in [true, false] {
            let text = format!(r#"{{"kind":"browser","op":"mute","id":"p","muted":{muted}}}"#);
            assert_eq!(
                parse_browser_cmd(&text),
                Some(BrowserCmd::Mute {
                    id: "p".into(),
                    muted
                })
            );
        }
        assert_eq!(
            parse_browser_cmd(r#"{"kind":"browser","op":"mute","id":"p"}"#),
            None
        );
        let a = page_event_script(
            "p",
            &PageOut::Audio {
                playing: true,
                muted: false,
            },
        );
        assert!(a.contains(r#"{"id":"p","type":"audio","playing":true,"muted":false}"#));
    }

    #[test]
    fn window_messages_parse_and_unknown_ones_are_ignored() {
        let op = |action: &str| format!(r#"{{"op":"window","action":"{action}"}}"#);
        assert_eq!(parse_window_cmd(&op("ready")), Some(WindowCmd::Ready));
        assert_eq!(parse_window_cmd(&op("minimize")), Some(WindowCmd::Minimize));
        assert_eq!(parse_window_cmd(&op("maximize")), Some(WindowCmd::Maximize));
        assert_eq!(parse_window_cmd(&op("close")), Some(WindowCmd::Close));
        assert_eq!(parse_window_cmd(&op("drag")), Some(WindowCmd::Drag));
        // Where the page's buttons are (left, top, width, height), none to hide the sink; nothing a few buttons cannot be.
        let at = Rect {
            left: 900,
            top: 6,
            right: 1107,
            bottom: 54,
        };
        assert_eq!(
            parse_window_cmd(r#"{"op":"window","action":"buttons","rect":[900,6,207,48]}"#),
            Some(WindowCmd::Buttons(Some(at)))
        );
        assert_eq!(
            parse_window_cmd(&op("buttons")),
            Some(WindowCmd::Buttons(None))
        );
        assert_eq!(
            parse_window_cmd(r#"{"op":"window","action":"buttons","rect":[0,0,0,48]}"#),
            None
        );
        for (edge, want) in [
            ("n", Edge::North),
            ("ne", Edge::NorthEast),
            ("nw", Edge::NorthWest),
        ] {
            let text = format!(r#"{{"op":"window","action":"resize","edge":"{edge}"}}"#);
            assert_eq!(parse_window_cmd(&text), Some(WindowCmd::Resize(want)));
        }
        // A resize needs a known edge; an unknown action is ignored; a browser message is not a window one.
        assert_eq!(
            parse_window_cmd(r#"{"op":"window","action":"resize"}"#),
            None
        );
        assert_eq!(
            parse_window_cmd(r#"{"op":"window","action":"resize","edge":"s"}"#),
            None
        );
        assert_eq!(parse_window_cmd(&op("explode")), None);
        assert_eq!(
            parse_window_cmd(r#"{"kind":"browser","op":"close","id":"p"}"#),
            None
        );
        assert_eq!(parse_window_cmd("not json"), None);
        // The browser parser still ignores the window's messages.
        assert_eq!(parse_browser_cmd(&op("close")), None);
    }

    #[test]
    fn window_state_reaches_the_page_as_a_window_event() {
        assert_eq!(
            window_event_script(true, false),
            "window.dispatchEvent(new CustomEvent('agenthydra:window',{detail:{frame:true,maximized:false}}))"
        );
        // The caption sink's pointer, which the page draws as its buttons' hover and press (host-window.ts).
        assert_eq!(
            caption_event_script(Some(win::CaptionButton::Maximize), None),
            "window.dispatchEvent(new CustomEvent('agenthydra:caption',{detail:{hover:\"maximize\",pressed:null}}))"
        );
    }

    #[test]
    fn the_sink_splits_into_the_three_buttons_left_to_right() {
        use win::CaptionButton::{Close, Maximize, Minimize};
        // 138 pixels as three 46-pixel buttons from x = 1000; a point past either end belongs to the end button.
        let at = |x| win::CaptionButton::at(x, 1000, 1138);
        assert_eq!([at(990), at(1000), at(1045)], [Minimize; 3]);
        assert_eq!([at(1046), at(1091)], [Maximize; 2]);
        assert_eq!([at(1092), at(1137), at(1200)], [Close; 3]);
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
