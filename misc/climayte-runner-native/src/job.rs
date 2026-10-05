//! The worker's job object: whatever the CLI leaves running ends with the runner, and one worker's
//! tree has a ceiling on how many processes it may have alive at once.
//!
//! Field note 43, 2026-10-01: w-8438217d finished and left `bun --bun vite ... --port 4289` running
//! under an sh wrapper. The runner puts ITSELF in a new job with KILL_ON_JOB_CLOSE before it starts
//! the CLI, so the CLI and everything it starts are in it. Bun's and Node's own job for child
//! processes allows silent breakaway, which is how a session's grandchildren outlived it; a
//! breakaway only climbs a chain of nested jobs as far as every job allows it, and this one allows
//! none, so nothing leaves. The runner holds the only handle and never closes it: when the runner
//! exits, the job closes and every process still in it ends. `leftovers` names them first.
//!
//! The ceiling (2026-10-03: a self-calling shell function started about 3,000 processes and froze
//! the desktop): past it Windows refuses to start another process in the job, so a runaway ends
//! there and the machine keeps going. Console hosts are not counted against it.

use std::ffi::c_void;
use std::ptr::{null, null_mut};

type Handle = *mut c_void;

const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION: i32 = 1;
const JOB_OBJECT_BASIC_PROCESS_ID_LIST: i32 = 3;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
const JOB_OBJECT_LIMIT_ACTIVE_PROCESS: u32 = 0x0008;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
/// Windows 8.1 and later: a process's command line, for PROCESS_QUERY_LIMITED_INFORMATION alone.
const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;
const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;
/// The most leftovers listed. A worker's ceiling is 400; a check has none, and past this many the
/// first 1024 are named (every one still ends with the job).
const MAX_LISTED: usize = 1024;
const ERROR_MORE_DATA: u32 = 234;
/// The command line in the exit file is capped, as it was when PowerShell read it.
const COMMAND_CHARS: usize = 200;

#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, len: u32) -> i32;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    fn QueryInformationJobObject(
        job: Handle,
        class: i32,
        info: *mut c_void,
        len: u32,
        returned: *mut u32,
    ) -> i32;
    fn GetCurrentProcess() -> Handle;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn QueryFullProcessImageNameW(
        process: Handle,
        flags: u32,
        name: *mut u16,
        size: *mut u32,
    ) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn GetLastError() -> u32;
}

// raw-dylib: no import library needed for ntdll.
#[link(name = "ntdll", kind = "raw-dylib")]
extern "system" {
    fn NtQueryInformationProcess(
        process: Handle,
        class: u32,
        info: *mut c_void,
        len: u32,
        returned: *mut u32,
    ) -> i32;
}

#[repr(C)]
#[derive(Default)]
struct BasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[repr(C)]
#[derive(Default)]
struct ExtendedLimitInformation {
    basic: BasicLimitInformation,
    io_counters: [u64; 6],
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[repr(C)]
#[derive(Default)]
struct BasicAccountingInformation {
    times: [i64; 4],
    total_page_fault_count: u32,
    total_processes: u32,
    active_processes: u32,
    total_terminated_processes: u32,
}

#[repr(C)]
struct BasicProcessIdList {
    number_of_assigned_processes: u32,
    number_of_process_ids_in_list: u32,
    process_id_list: [usize; MAX_LISTED],
}

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *const u16,
}

#[cfg(target_pointer_width = "64")]
const _: () = assert!(std::mem::size_of::<ExtendedLimitInformation>() == 144);
const _: () = assert!(std::mem::size_of::<BasicAccountingInformation>() == 48);

/// A process still in the job once the CLI has ended.
pub struct Leftover {
    pub pid: u32,
    /// Its executable's file name, `?` when it could not be read.
    pub name: String,
    pub command: Option<String>,
}

/// This process's job. The handle is never closed: this process's exit closes it, which is what
/// ends the leftovers.
pub struct Job(Handle);

impl Job {
    /// Puts this process in a new kill-on-close job, holding at most `max_processes` live processes
    /// (the runner counts as one) when given. None when Windows refuses: the CLI then runs as it did
    /// before jobs, and what it leaves is left.
    pub fn contain(max_processes: Option<u32>) -> Option<Job> {
        // SAFETY: plain Win32 calls on a struct laid out as the API declares it; the job handle is
        // owned here and closed on failure.
        unsafe {
            let job = CreateJobObjectW(null(), null());
            if job.is_null() {
                return None;
            }
            let mut info = ExtendedLimitInformation::default();
            info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Some(n) = max_processes {
                info.basic.limit_flags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
                info.basic.active_process_limit = n;
            }
            let ok = SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                (&info as *const ExtendedLimitInformation).cast(),
                std::mem::size_of::<ExtendedLimitInformation>() as u32,
            ) != 0
                && AssignProcessToJobObject(job, GetCurrentProcess()) != 0;
            if !ok {
                CloseHandle(job);
                return None;
            }
            Some(Job(job))
        }
    }

    /// How many processes the job has alive right now, the runner and console hosts included.
    pub fn active(&self) -> Option<u32> {
        let mut info = BasicAccountingInformation::default();
        // SAFETY: the buffer is the struct the class answers with, and its size is passed.
        let ok = unsafe {
            QueryInformationJobObject(
                self.0,
                JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
                (&mut info as *mut BasicAccountingInformation).cast(),
                std::mem::size_of::<BasicAccountingInformation>() as u32,
                null_mut(),
            )
        };
        (ok != 0).then_some(info.active_processes)
    }

    /// Every process in the job except `except` (the runner itself), with its name and command line.
    pub fn leftovers(&self, except: u32) -> Vec<Leftover> {
        let mut list = Box::new(BasicProcessIdList {
            number_of_assigned_processes: 0,
            number_of_process_ids_in_list: 0,
            process_id_list: [0; MAX_LISTED],
        });
        // SAFETY: the buffer is the struct the class answers with, and its size is passed.
        let ok = unsafe {
            QueryInformationJobObject(
                self.0,
                JOB_OBJECT_BASIC_PROCESS_ID_LIST,
                (&mut *list as *mut BasicProcessIdList).cast(),
                std::mem::size_of::<BasicProcessIdList>() as u32,
                null_mut(),
            )
        };
        // ERROR_MORE_DATA: more processes than the list holds; it is filled as far as it goes.
        // SAFETY: reads this thread's last error, set by the call just made.
        if ok == 0 && unsafe { GetLastError() } != ERROR_MORE_DATA {
            return Vec::new();
        }
        let listed = (list.number_of_process_ids_in_list as usize).min(MAX_LISTED);
        list.process_id_list[..listed]
            .iter()
            .map(|&pid| pid as u32)
            .filter(|&pid| pid != except)
            .map(describe)
            .collect()
    }
}

fn describe(pid: u32) -> Leftover {
    // SAFETY: the handle is checked, used for two queries into owned buffers, then closed.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return Leftover {
                pid,
                name: "?".into(),
                command: None,
            };
        }
        let name = image_name(h).unwrap_or_else(|| "?".into());
        let command = command_line(h);
        CloseHandle(h);
        Leftover { pid, name, command }
    }
}

unsafe fn image_name(h: Handle) -> Option<String> {
    let mut buf = [0u16; 1024];
    let mut size = buf.len() as u32;
    if QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size) == 0 {
        return None;
    }
    let path = String::from_utf16_lossy(&buf[..size as usize]);
    let name = path.rsplit(['\\', '/']).next().unwrap_or_default();
    Some(if name.is_empty() {
        path.clone()
    } else {
        name.to_string()
    })
}

/// The command line, trimmed and capped: "bun.exe" alone does not say it was a vite dev server.
unsafe fn command_line(h: Handle) -> Option<String> {
    let mut words = 8 * 1024; // 64 KB, 8-byte aligned for the UNICODE_STRING at its start
    for _ in 0..2 {
        let mut buf = vec![0u64; words];
        let mut returned = 0u32;
        let status = NtQueryInformationProcess(
            h,
            PROCESS_COMMAND_LINE_INFORMATION,
            buf.as_mut_ptr().cast(),
            (buf.len() * 8) as u32,
            &mut returned,
        );
        if status == STATUS_INFO_LENGTH_MISMATCH && returned as usize > buf.len() * 8 {
            words = (returned as usize).div_ceil(8);
            continue;
        }
        if status < 0 {
            return None;
        }
        // The answer is a UNICODE_STRING whose buffer points into `buf`, just after it.
        let us = &*(buf.as_ptr() as *const UnicodeString);
        if us.buffer.is_null() || us.length == 0 {
            return None;
        }
        let units = std::slice::from_raw_parts(us.buffer, us.length as usize / 2);
        let text = String::from_utf16_lossy(units);
        let trimmed = text.trim();
        return (!trimmed.is_empty()).then(|| trimmed.chars().take(COMMAND_CHARS).collect());
    }
    None
}
