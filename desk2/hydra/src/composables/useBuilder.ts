import { ref } from 'vue'
import type { QueueItem } from '@/lib/api'

export interface BuilderPrefill {
  session_id?: string
  title?: string
  cwd?: string
  new_chat?: boolean
}

const open = ref(false)
const prefill = ref<BuilderPrefill | undefined>(undefined)
// When set, the builder dialog edits this existing queue item (PATCH) instead of creating.
const editItem = ref<QueueItem | null>(null)

export function useBuilder() {
  function openBuilder(p?: BuilderPrefill) {
    editItem.value = null
    prefill.value = p
    open.value = true
  }
  function openEditor(item: QueueItem) {
    editItem.value = item
    open.value = true
  }
  return { open, prefill, editItem, openBuilder, openEditor }
}
