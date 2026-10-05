// The one order the sidebar keeps, one per window, read by both lists: the desk list (Sidebar.vue) and the
// cloud list (cloud/store.ts), so turning the chrome bar's cloud button on or off moves nothing (owner,
// 2026-10-04: "examine what happens when you enable and disable the cloud icon. For some reason they change
// order"). A saved order wins over activity (Jacob, 2026-10-04): sending a message reorders nothing, groups
// are dragged into the order wanted. Each list adds the keys it shows that the order lacks (logic.ts
// recordOrder: the desk list's at the top, the cloud list's own at the end) and never moves a saved one.
// This viewer's browser remembers it.
import { ref } from 'vue'
import type { SidebarOrder } from './logic'

const ORDER_KEY = 'hydra-desk.sidebar.order'
/** The rows remembered, the desk list's and the cloud list's together; the cloud's own, at the end, go first. */
const MAX_ROWS = 6000

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i])

function createOrder() {
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  function read(): SidebarOrder {
    try {
      const o = JSON.parse(storage?.getItem(ORDER_KEY) ?? 'null') as Partial<SidebarOrder> | null
      return { groups: strings(o?.groups), rows: strings(o?.rows) }
    } catch {
      return { groups: [], rows: [] }
    }
  }
  const order = ref<SidebarOrder>(read())
  /** Keeps `next` as the order (nothing happens when it is the same). */
  function save(next: SidebarOrder): void {
    if (same(next.groups, order.value.groups) && same(next.rows, order.value.rows)) return
    order.value = next
    try {
      storage?.setItem(ORDER_KEY, JSON.stringify({ groups: next.groups, rows: next.rows.slice(0, MAX_ROWS) }))
    } catch {
      // storage full or blocked: the order holds for this window only
    }
  }
  return { order, save }
}

let one: ReturnType<typeof createOrder> | null = null

/** The window's one sidebar order. */
export function useSidebarOrder(): ReturnType<typeof createOrder> {
  if (!one) one = createOrder()
  return one
}
