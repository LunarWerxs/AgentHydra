//! The Win32 surface this host needs, declared inline.
//!
//! Deliberately no `windows`/`windows-sys` crate: the whole API used here is about two dozen
//! functions and four structs, and declaring them costs less than adding a crate graph the kit
//! would then have to vendor, audit and keep building offline.
#![allow(non_snake_case, non_camel_case_types)]

use std::ffi::c_void;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::ptr::null_mut;

pub type HANDLE = *mut c_void;
pub type HWND = *mut c_void;
pub type HICON = *mut c_void;
pub type HMENU = *mut c_void;
pub type HINSTANCE = *mut c_void;
pub type LRESULT = isize;
pub type WPARAM = usize;
pub type LPARAM = isize;

pub const WM_DESTROY: u32 = 0x0002;
pub const WM_TIMER: u32 = 0x0113;
pub const WM_COMMAND: u32 = 0x0111;
pub const WM_RBUTTONUP: u32 = 0x0205;
pub const WM_LBUTTONDBLCLK: u32 = 0x0203;
/// Tray icon callback.
pub const WM_APP_TRAY: u32 = 0x0400 + 1;
/// A background worker finished; wParam carries its outcome.
pub const WM_APP_WORKER_DONE: u32 = 0x0400 + 2;

pub const NIM_ADD: u32 = 0;
pub const NIM_MODIFY: u32 = 1;
pub const NIM_DELETE: u32 = 2;
pub const NIF_MESSAGE: u32 = 0x01;
pub const NIF_ICON: u32 = 0x02;
pub const NIF_TIP: u32 = 0x04;
pub const NIF_INFO: u32 = 0x10;

pub const NIIF_INFO: u32 = 0x01;
pub const NIIF_WARNING: u32 = 0x02;
pub const NIIF_ERROR: u32 = 0x03;

pub const MF_STRING: u32 = 0x0000;
pub const MF_SEPARATOR: u32 = 0x0800;
pub const MF_GRAYED: u32 = 0x0001;
pub const TPM_RIGHTBUTTON: u32 = 0x0002;

pub const IMAGE_ICON: u32 = 1;
pub const LR_LOADFROMFILE: u32 = 0x0010;
pub const LR_DEFAULTSIZE: u32 = 0x0040;

pub const MB_OK: u32 = 0x0000;
pub const MB_ICONWARNING: u32 = 0x0030;
pub const MB_ICONERROR: u32 = 0x0010;

pub const ERROR_ALREADY_EXISTS: u32 = 183;

#[repr(C)]
pub struct NOTIFYICONDATAW {
    pub cbSize: u32,
    pub hWnd: HWND,
    pub uID: u32,
    pub uFlags: u32,
    pub uCallbackMessage: u32,
    pub hIcon: HICON,
    pub szTip: [u16; 128],
    pub dwState: u32,
    pub dwStateMask: u32,
    pub szInfo: [u16; 256],
    pub uVersion: u32,
    pub szInfoTitle: [u16; 64],
    pub dwInfoFlags: u32,
    pub guidItem: [u8; 16],
    pub hBalloonIcon: HICON,
}

#[repr(C)]
pub struct WNDCLASSW {
    pub style: u32,
    pub lpfnWndProc: Option<unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT>,
    pub cbClsExtra: i32,
    pub cbWndExtra: i32,
    pub hInstance: HINSTANCE,
    pub hIcon: HICON,
    pub hCursor: *mut c_void,
    pub hbrBackground: *mut c_void,
    pub lpszMenuName: *const u16,
    pub lpszClassName: *const u16,
}

#[repr(C)]
pub struct MSG {
    pub hwnd: HWND,
    pub message: u32,
    pub wParam: WPARAM,
    pub lParam: LPARAM,
    pub time: u32,
    pub pt: POINT,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct POINT {
    pub x: i32,
    pub y: i32,
}

#[link(name = "kernel32")]
extern "system" {
    pub fn CreateMutexW(attrs: *mut c_void, initial_owner: i32, name: *const u16) -> HANDLE;
    pub fn ReleaseMutex(h: HANDLE) -> i32;
    pub fn GetLastError() -> u32;
    pub fn GetModuleHandleW(name: *const u16) -> HINSTANCE;
    pub fn CloseHandle(h: HANDLE) -> i32;
}

#[link(name = "user32")]
extern "system" {
    pub fn RegisterClassW(c: *const WNDCLASSW) -> u16;
    pub fn CreateWindowExW(
        ex: u32,
        class: *const u16,
        name: *const u16,
        style: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        parent: HWND,
        menu: HMENU,
        inst: HINSTANCE,
        param: *mut c_void,
    ) -> HWND;
    pub fn DestroyWindow(h: HWND) -> i32;
    pub fn DefWindowProcW(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT;
    pub fn GetMessageW(msg: *mut MSG, h: HWND, min: u32, max: u32) -> i32;
    pub fn TranslateMessage(msg: *const MSG) -> i32;
    pub fn DispatchMessageW(msg: *const MSG) -> LRESULT;
    pub fn PostQuitMessage(code: i32);
    pub fn PostMessageW(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> i32;
    pub fn SetTimer(h: HWND, id: usize, ms: u32, proc_: *mut c_void) -> usize;
    pub fn KillTimer(h: HWND, id: usize) -> i32;
    pub fn CreatePopupMenu() -> HMENU;
    pub fn AppendMenuW(menu: HMENU, flags: u32, id: usize, item: *const u16) -> i32;
    pub fn DestroyMenu(menu: HMENU) -> i32;
    pub fn TrackPopupMenu(
        menu: HMENU,
        flags: u32,
        x: i32,
        y: i32,
        reserved: i32,
        hwnd: HWND,
        rect: *const c_void,
    ) -> i32;
    pub fn GetCursorPos(p: *mut POINT) -> i32;
    pub fn SetForegroundWindow(h: HWND) -> i32;
    pub fn LoadImageW(
        inst: HINSTANCE,
        name: *const u16,
        kind: u32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> HICON;
    pub fn MessageBoxW(h: HWND, text: *const u16, caption: *const u16, kind: u32) -> i32;
}

#[link(name = "shell32")]
extern "system" {
    pub fn Shell_NotifyIconW(msg: u32, data: *mut NOTIFYICONDATAW) -> i32;
    pub fn ShellExecuteW(
        hwnd: HWND,
        verb: *const u16,
        file: *const u16,
        params: *const u16,
        dir: *const u16,
        show: i32,
    ) -> HINSTANCE;
}

/// A NUL-terminated UTF-16 buffer, which is what every W-suffixed Win32 entry point wants.
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Copy a string into a fixed-size UTF-16 field, always leaving it NUL-terminated.
pub fn fill(dst: &mut [u16], src: &str) {
    dst.fill(0);
    let cap = dst.len().saturating_sub(1);
    for (slot, ch) in dst.iter_mut().zip(src.encode_utf16()).take(cap) {
        *slot = ch;
    }
}

/// Open a URL (or file) with the shell's default handler.
pub fn shell_open(target: &str) {
    let verb = wide("open");
    let file = wide(target);
    unsafe {
        ShellExecuteW(
            null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            null_mut(),
            null_mut(),
            1,
        );
    }
}

/// Launch a specific executable with arguments, detached and windowless.
pub fn shell_open_with(exe: &Path, args: &[String]) {
    let _ = Command::new(exe)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn();
}

pub fn message_box(caption: &str, text: &str, kind: u32) {
    let c = wide(caption);
    let t = wide(text);
    unsafe {
        MessageBoxW(null_mut(), t.as_ptr(), c.as_ptr(), MB_OK | kind);
    }
}
