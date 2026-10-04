import { useStorage } from '@vueuse/core'
import { parseStoredSelection } from '@/lib/session-scopes'

// A multi-select scope is the list of values that are TICKED (lib/session-scopes.ts); "all" is
// every value ticked and is the default, "none" is []. A stored value that is not a list of known
// values falls back to everything ticked — the old single-string form included.
export function storedSelection<T extends string>(key: string, universe: readonly T[]) {
  return useStorage<T[]>(key, [...universe], undefined, {
    serializer: {
      read: (raw) => {
        try {
          return parseStoredSelection(JSON.parse(raw), universe) ?? [...universe]
        } catch {
          return [...universe]
        }
      },
      write: (value) => JSON.stringify(value),
    },
  })
}
