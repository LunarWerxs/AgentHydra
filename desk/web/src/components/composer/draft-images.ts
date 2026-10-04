// The pictures attached in a box and not yet sent, per draft slot (logic.ts draftSlot): kept in memory for
// the switch between chats and workspaces, and in IndexedDB so they come back after the window reloads.
// Pictures are too big for localStorage, which holds the text.

export interface DraftImage {
  id: string
  name: string
  mediaType: string
  dataBase64: string
  url: string // data: URL for the thumbnail
}

type Stored = Omit<DraftImage, 'url'>

const DB_NAME = 'hydra-desk-drafts'
const STORE = 'images'
const memory = new Map<string, DraftImage[]>()

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null) // blocked storage: pictures live in memory only
    }
  })
}

const db = open()

/** Settles once the stored pictures are in memory; a slot set before then keeps what was set. */
export const draftImagesReady: Promise<void> = db.then(
  (d) =>
    new Promise<void>((resolve) => {
      if (!d) return resolve()
      try {
        const req = d.transaction(STORE, 'readonly').objectStore(STORE).openCursor()
        req.onsuccess = () => {
          const cur = req.result
          if (!cur) return resolve()
          const slot = String(cur.key)
          if (!memory.has(slot)) {
            const list = (cur.value as Stored[]).map((i) => ({ ...i, url: `data:${i.mediaType};base64,${i.dataBase64}` }))
            memory.set(slot, list)
          }
          cur.continue()
        }
        req.onerror = () => resolve()
      } catch {
        resolve()
      }
    })
)

export function draftImages(slot: string | null): DraftImage[] {
  return [...(memory.get(slot ?? 'new') ?? [])]
}

export function saveDraftImages(slot: string | null, images: readonly DraftImage[]): void {
  const key = slot ?? 'new'
  if (images.length) memory.set(key, [...images])
  else memory.delete(key)
  void db.then((d) => {
    if (!d) return
    try {
      const store = d.transaction(STORE, 'readwrite').objectStore(STORE)
      if (images.length) store.put(images.map(({ url: _url, ...rest }) => rest), key)
      else store.delete(key)
    } catch {
      // Full or blocked: the pictures stay in memory for this window.
    }
  })
}
