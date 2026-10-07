// web/src/composables/useQuickAddTarget.ts — which CLI instance Quick add signs in again, if any.
//
// "Log in" on a CLI row used to open a terminal to run /login by hand. It now points Quick add at that
// row's instance (owner, 2026-09-30): the row menu (CliInstanceRows) sets the target, and the box
// (CliQuickAdd) says whose login it is about to replace and hands the id to startQuickAdd. One
// module-level ref, so the two share it without a prop chain and it survives the box re-rendering.

import { readonly, ref } from 'vue'

export interface QuickAddTarget {
  id: string
  num: number
  name: string
  /** The account this instance last held, when known: CliQuickAdd puts it in the email box. */
  email?: string | null
}

const target = ref<QuickAddTarget | null>(null)

function setQuickAddTarget(next: QuickAddTarget): void {
  // A fresh object each time, so pointing at the same row twice still reads as a new request.
  target.value = { id: next.id, num: next.num, name: next.name, email: next.email ?? null }
}

function clearQuickAddTarget(): void {
  target.value = null
}

export function useQuickAddTarget() {
  return { target: readonly(target), setQuickAddTarget, clearQuickAddTarget }
}
