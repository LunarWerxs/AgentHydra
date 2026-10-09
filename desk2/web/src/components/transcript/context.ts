// State a TranscriptView shares with every row it renders (rows unmount when windowed out, so
// open/closed state lives here, not in the rows).
import { computed, inject, provide, reactive, ref, type ComputedRef, type InjectionKey, type Ref } from 'vue'
import type { TranscriptItem } from '@shared/protocol'
import type { RedesignState } from './lib/redesign'

export interface TranscriptCtx {
  chatId: Ref<string>
  readOnly: Ref<boolean>
  /** The chat's folder, to shorten paths in headers. */
  cwd: Ref<string | null>
  children: ComputedRef<Map<string, TranscriptItem[]>>
  /** The chat's items, for counting what an undo takes out (MessageActions asks first when it takes out more than one message). */
  items?: ComputedRef<TranscriptItem[]>
  /** Profile -> id of its newest browser call in this transcript: only that Browser card previews live. */
  newestBrowser?: ComputedRef<Map<string, string>>
  /** ReDesign picks and the person's replies, for the ReDesign cards. */
  redesign?: ComputedRef<RedesignState>
  /** Background tasks the chat dispatched that still run, and the id of its latest result line (the only one they hold back). */
  background?: Ref<{ count: number; resultId: string | null }>
  isOpen(key: string, fallback?: boolean): boolean
  toggle(key: string, fallback?: boolean): void
  /** Opens it whatever it was (the working line's ">" opening the step it names). */
  show(key: string): void
}

const KEY: InjectionKey<TranscriptCtx> = Symbol('transcript')

export function provideTranscript(ctx: Omit<TranscriptCtx, 'isOpen' | 'toggle' | 'show'>, initiallyOpen: string[] = []) {
  const open = reactive(new Map<string, boolean>(initiallyOpen.map((k) => [k, true])))
  const full: TranscriptCtx = {
    ...ctx,
    isOpen: (key, fallback = false) => open.get(key) ?? fallback,
    toggle: (key, fallback = false) => open.set(key, !(open.get(key) ?? fallback)),
    show: (key) => open.set(key, true),
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
    show: (key) => open.set(key, true),
  }
}
