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

/** Now, moving every `periodMs` (1 s by default) while the calling component is mounted. */
export function useClock(periodMs = 1000): Readonly<Ref<number>> {
  let clock = clocks.get(periodMs)
  if (!clock) {
    clock = { now: ref(Date.now()), users: 0, timer: null }
    clocks.set(periodMs, clock)
  }
  const c = clock
  c.users++
  if (!c.timer) {
    c.now.value = Date.now()
    c.timer = setInterval(() => (c.now.value = Date.now()), periodMs)
  }
  onScopeDispose(() => {
    c.users--
    if (c.users === 0 && c.timer) {
      clearInterval(c.timer)
      c.timer = null
    }
  })
  return c.now
}
