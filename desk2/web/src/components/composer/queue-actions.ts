// A queued message's actions, shared by the queue popover's rows and the tray's: every call goes to the
// server, which owns the queue, and a refusal is kept to show; an inline edit saves against the rev it was
// started from (Enter saves, Shift+Enter is a new line, Esc cancels the edit).
import { nextTick, ref } from 'vue'
import type { QueueItem } from '@shared/protocol'
import { useShellSource } from '@/components/shell/source'

export type QueueAct = (fn: () => Promise<unknown> | undefined) => Promise<boolean>

/** `listed`: whether an item is still shown, so a refused save reopens its edit only while it is there. */
export function useQueueActions(listed: (id: string) => boolean) {
  const source = useShellSource()
  const error = ref<string | null>(null)
  const act: QueueAct = async (fn) => {
    error.value = null
    try {
      await fn()
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  const editing = ref<string | null>(null)
  const draft = ref('')
  // The rev the draft was taken from: another window's edit meanwhile makes the save a refusal, not an overwrite.
  let editRev = 0
  let editor: HTMLTextAreaElement | null = null
  function setEditor(el: unknown) {
    editor = el instanceof HTMLTextAreaElement ? el : null
  }
  function startEdit(item: QueueItem) {
    editing.value = item.id
    editRev = item.rev
    draft.value = item.text
    nextTick(() => {
      editor?.focus()
      editor?.setSelectionRange(draft.value.length, draft.value.length)
    })
  }
  async function saveEdit(item: QueueItem) {
    const text = draft.value.trim()
    if (!text && !item.images?.length) return
    editing.value = null
    if (text === item.text.trim()) return
    // A refused save reopens the edit with the text kept, unless the item went out meanwhile.
    if (!(await act(() => source.queueEdit?.(item.id, { text, ifRev: editRev }))) && listed(item.id)) {
      startEdit(item)
      draft.value = text
    }
  }
  function onEditKey(e: KeyboardEvent, item: QueueItem) {
    if (e.isComposing) return
    if (e.key === 'Escape') {
      // Kept from a surrounding popover's own Esc: stopped here (and the popover refuses while editing).
      e.preventDefault()
      e.stopPropagation()
      editing.value = null
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      saveEdit(item)
    }
  }

  return { source, error, act, editing, draft, setEditor, startEdit, saveEdit, onEditKey }
}
