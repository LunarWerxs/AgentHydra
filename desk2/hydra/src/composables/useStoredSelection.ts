import { useStorage } from '@vueuse/core'
import { parseStoredSelection } from '@/lib/session-scopes'

// A multi-select scope is the list of values that are TICKED (lib/session-scopes.ts); "all" is
// every value ticked and is the default, "none" is []. A stored value that is not a list of known
// values falls back to `initial` (everything ticked unless the scope says otherwise) — the old
// single-string form included.
export function storedSelection<T extends string>(
  key: string,
  universe: readonly T[],
  initial: readonly T[] = universe,
) {
  return useStorage<T[]>(key, [...initial], undefined, {
    serializer: {
      read: (raw) => {
        try {
          return parseStoredSelection(JSON.parse(raw), universe) ?? [...initial]
        } catch {
          return [...initial]
        }
      },
      write: (value) => JSON.stringify(value),
    },
  })
}
