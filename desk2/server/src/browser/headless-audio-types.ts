/** A Chrome process as WMI reports it: pid, parent pid, and its full command line. */
export interface ProcRow {
  pid: number
  ppid: number
  cmd: string
}

/** One Windows audio session from the helper: its process id and loudest peak, and whether it is muted. */
export interface AudioRow {
  pid: number
  peak: number
  muted: boolean
}

/** A Chrome profile whose audio service is running: its folder, its browser pid, its audio service pids, and the loudest peak. */
export interface ProfileSound {
  dir: string
  browserPid: number
  sessionPids: number[]
  peak: number
}

/** What a probe reads from one page: how many playing elements have sound, how many running AudioContexts it has. */
export interface PageSound {
  audible: number
  contexts: number
}
