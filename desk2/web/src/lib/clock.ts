// The window's shared clocks: one timer per period however many places show a moving time, and only while
// one of them is mounted. A component reads `.value` only where its time really moves (a working chat's
// elapsed time, a running task's), so a tick redraws those few things and never a whole list around them.
import { onScopeDispose, ref, type Ref } from 'vue'

interface Clock {
  now: Ref<number>
  users: number
  timer: ReturnType<typeof setInterval> | null
}

const clocks = new Map<number, Clock>()
const hidden = () => typeof document !== 'undefined' && document.hidden

function run(c: Clock, periodMs: number) {
  if (c.timer || c.users === 0 || hidden()) return
  c.now.value = Date.now()
  c.timer = setInterval(() => (c.now.value = Date.now()), periodMs)
}
function halt(c: Clock) {
  if (c.timer) clearInterval(c.timer)
  c.timer = null
}

// A hidden window stops every clock, and showing it again ticks them at once.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    for (const [periodMs, c] of clocks) {
      if (document.hidden) halt(c)
      else run(c, periodMs)
    }
  })
}

/** Now, moving every `periodMs` (1 s by default) while the calling component is mounted and the window is in sight. */
export function useClock(periodMs = 1000): Readonly<Ref<number>> {
  let clock = clocks.get(periodMs)
  if (!clock) {
    clock = { now: ref(Date.now()), users: 0, timer: null }
    clocks.set(periodMs, clock)
  }
  const c = clock
  c.users++
  run(c, periodMs)
  onScopeDispose(() => {
    c.users--
    if (c.users === 0) halt(c)
  })
  return c.now
}
