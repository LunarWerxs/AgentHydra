// The mark a working chat shows (the Working row under a turn, the line over an outside session's composer):
// one per window, picked in Settings -> General -> Appearance and remembered like the session header's
// choices (session-header/state.ts). Owner, 2026-10-08: an orange animation in place of the blinking dot,
// "a few options" to compare.
import { ref, watch } from 'vue'

export type WorkingMarkVariant = 'square' | 'orbit' | 'spark' | 'breathe'

/** The options in the order Settings shows them; the first is the default. */
export const WORKING_MARKS: { id: WorkingMarkVariant; label: string }[] = [
  { id: 'square', label: 'Square' },
  { id: 'orbit', label: 'Orbit' },
  { id: 'spark', label: 'Spark' },
  { id: 'breathe', label: 'Breathe' }
]

const storage = typeof localStorage === 'undefined' ? null : localStorage
const KEY = 'hydra-desk.working-mark'

function read(): WorkingMarkVariant {
  try {
    const saved = storage?.getItem(KEY)
    return WORKING_MARKS.find((m) => m.id === saved)?.id ?? WORKING_MARKS[0].id
  } catch {
    return WORKING_MARKS[0].id
  }
}

export const workingMark = ref<WorkingMarkVariant>(read())
watch(workingMark, (v) => storage?.setItem(KEY, v))
