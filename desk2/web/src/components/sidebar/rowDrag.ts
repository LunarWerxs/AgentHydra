// Dragging a row to another place in its own group, in the desk list and the cloud list alike: both save
// into the one order (order.ts), so the new place shows in both. A drop only lands inside the group the
// row came from (Pinned rows among Pinned); the line shows where it will land (2 px, the accent).
import { ref } from 'vue'
import { moveInOrder, rowDropBefore } from './logic'
import { useSidebarOrder } from './order'

export function useRowDrag() {
  const { order, save } = useSidebarOrder()
  const dragging = ref<{ key: string; group: string } | null>(null)
  const over = ref<{ key: string; after: boolean } | null>(null)

  function start(ev: DragEvent, group: string, key: string) {
    dragging.value = { key, group }
    ev.dataTransfer?.setData('text/plain', key)
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move'
    ev.stopPropagation()
  }
  function lowerHalf(ev: DragEvent): boolean {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect()
    return ev.clientY > r.top + r.height / 2
  }
  function onOver(ev: DragEvent, group: string, key: string) {
    const d = dragging.value
    if (!d || d.group !== group) return
    ev.preventDefault()
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
    const after = lowerHalf(ev)
    if (over.value?.key !== key || over.value.after !== after) over.value = { key, after }
  }
  function drop(ev: DragEvent, group: string, keys: readonly string[], key: string) {
    const d = dragging.value
    if (!d || d.group !== group) return
    ev.preventDefault()
    const after = lowerHalf(ev)
    dragging.value = over.value = null
    const before = rowDropBefore(keys, d.key, key, after)
    if (before !== undefined) save({ ...order.value, rows: moveInOrder(order.value.rows, d.key, before) })
  }
  function end() {
    dragging.value = over.value = null
  }
  /** The classes of the row's drop line: on its top edge when it lands above it, the bottom when below. */
  function line(key: string): string {
    const o = over.value
    if (!o || o.key !== key || dragging.value?.key === key) return ''
    return o.after ? 'shadow-[inset_0_-2px_0_var(--accent)]' : 'shadow-[inset_0_2px_0_var(--accent)]'
  }
  return { start, onOver, drop, end, line, dragging }
}
