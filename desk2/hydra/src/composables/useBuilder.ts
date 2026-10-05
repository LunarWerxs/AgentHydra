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

// The dialog component is loaded on the first request, so `open` only turns true once it is
// mounted (its watch on `open` is not immediate and would miss an open that predates it).
const requested = ref(false)
let mounted = false
let pending = false

function show() {
  requested.value = true
  if (mounted) open.value = true
  else pending = true
}

/** App.vue calls this when the loaded builder mounts: delivers an open that arrived before it. */
function builderMounted() {
  mounted = true
  if (pending) {
    pending = false
    open.value = true
  }
}

export function useBuilder() {
  function openBuilder(p?: BuilderPrefill) {
    editItem.value = null
    prefill.value = p
    show()
  }
  function openEditor(item: QueueItem) {
    editItem.value = item
    show()
  }
  return { open, prefill, editItem, requested, builderMounted, openBuilder, openEditor }
}
