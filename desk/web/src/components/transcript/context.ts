// State a TranscriptView shares with every row it renders (rows unmount when windowed out, so
// open/closed state lives here, not in the rows).
import { computed, inject, onScopeDispose, provide, reactive, ref, type ComputedRef, type InjectionKey, type Ref } from 'vue'
import type { TranscriptItem } from '@shared/protocol'

export interface TranscriptCtx {
  chatId: Ref<string>
  readOnly: Ref<boolean>
  /** The chat's folder, to shorten paths in headers. */
  cwd: Ref<string | null>
  children: ComputedRef<Map<string, TranscriptItem[]>>
  /** Background tasks the chat dispatched that still run, and the id of its latest result line (the only one they hold back). */
  background?: Ref<{ count: number; resultId: string | null }>
  isOpen(key: string, fallback?: boolean): boolean
  toggle(key: string, fallback?: boolean): void
}

const KEY: InjectionKey<TranscriptCtx> = Symbol('transcript')

export function provideTranscript(ctx: Omit<TranscriptCtx, 'isOpen' | 'toggle'>, initiallyOpen: string[] = []) {
  const open = reactive(new Map<string, boolean>(initiallyOpen.map((k) => [k, true])))
  const full: TranscriptCtx = {
    ...ctx,
    isOpen: (key, fallback = false) => open.get(key) ?? fallback,
    toggle: (key, fallback = false) => open.set(key, !(open.get(key) ?? fallback)),
  }
  provide(KEY, full)
  return full
}

export function useTranscript(): TranscriptCtx {
  const ctx = inject(KEY, null)
  if (ctx) return ctx
  // A row rendered on its own (tests, gallery): a private, empty context.
  const open = reactive(new Map<string, boolean>())
  return {
    chatId: ref(''),
    readOnly: ref(true),
    cwd: ref(null),
    children: computed(() => new Map()),
    isOpen: (key, fallback = false) => open.get(key) ?? fallback,
    toggle: (key, fallback = false) => open.set(key, !(open.get(key) ?? fallback)),
  }
}

// One shared 1 s clock for every elapsed counter on screen.
const now = ref(Date.now())
let users = 0
let timer: ReturnType<typeof setInterval> | null = null

export function useClock(): Ref<number> {
  users++
  if (!timer) {
    now.value = Date.now()
    timer = setInterval(() => (now.value = Date.now()), 1000)
  }
  onScopeDispose(() => {
    users--
    if (users === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  })
  return now
}
