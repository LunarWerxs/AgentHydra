// The one order the sidebar keeps, one per window, read by both lists: the desk list (Sidebar.vue) and the
// cloud list (cloud/store.ts), so turning the chrome bar's cloud button on or off moves nothing (owner,
// 2026-10-04: "examine what happens when you enable and disable the cloud icon. For some reason they change
// order"). A saved order wins over activity (Jacob, 2026-10-04): sending a message reorders nothing, groups
// are dragged into the order wanted. Each list adds the keys it shows that the order lacks (logic.ts
// recordOrder: the desk list's at the top, the cloud list's own at the end) and never moves a saved one,
// but for one the cloud list added: the first time the desk list shows it, it is new there and goes to the
// top (SidebarOrder.cloud). This viewer's browser remembers it.
import { ref } from 'vue'
import type { SidebarOrder } from './logic'

const ORDER_KEY = 'hydra-desk.sidebar.order'
/** The rows remembered, the desk list's and the cloud list's together; the cloud's own, at the end, go first. */
const MAX_ROWS = 6000
/** The groups remembered: keys are only ever added, so the oldest (last) go once there are this many. */
const MAX_GROUPS = 1000
/** How long a changed order waits before it is written, so a burst of changes writes once. */
const PERSIST_MS = 1000

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i])

function createOrder() {
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  function read(): SidebarOrder {
    try {
      const o = JSON.parse(storage?.getItem(ORDER_KEY) ?? 'null') as Partial<SidebarOrder> | null
      return { groups: strings(o?.groups), rows: strings(o?.rows), cloud: strings(o?.cloud) }
    } catch {
      return { groups: [], rows: [], cloud: [] }
    }
  }
  const order = ref<SidebarOrder>(read())
  /** Keeps `next` as the order (nothing happens when it is the same). */
  function save(next: SidebarOrder): void {
    const cloud = next.cloud ?? []
    if (same(next.groups, order.value.groups) && same(next.rows, order.value.rows) && same(cloud, order.value.cloud ?? [])) return
    order.value = next
    // The memory is current at once; the disk follows once the order settles.
    if (timer) clearTimeout(timer)
    timer = setTimeout(persist, PERSIST_MS)
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  function persist(): void {
    timer = null
    try {
      // The cloud list's marks are added at the end, so its trim keeps the end.
      const next = order.value
      const kept = { groups: next.groups.slice(0, MAX_GROUPS), rows: next.rows.slice(0, MAX_ROWS), cloud: (next.cloud ?? []).slice(-MAX_ROWS) }
      storage?.setItem(ORDER_KEY, JSON.stringify(kept))
    } catch {
      // storage full or blocked: the order holds for this window only
    }
  }
  // A window closed inside the wait still keeps its order.
  if (typeof window !== 'undefined') window.addEventListener('pagehide', () => timer && (clearTimeout(timer), persist()), { once: true })
  return { order, save }
}

let one: ReturnType<typeof createOrder> | null = null

/** The window's one sidebar order. */
export function useSidebarOrder(): ReturnType<typeof createOrder> {
  if (!one) one = createOrder()
  return one
}
