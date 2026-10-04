// Which session's transcript is open, for the parts of it that fetch on their own: a subagent's run,
// opened inside the Agent step that started it (components/SubagentTranscript.vue). SessionsView
// provides it beside the transcript it renders, so a component deep in the turns needs no prop
// threaded through every layer above it.

import type { ComputedRef, InjectionKey } from 'vue'
import type { SessionSource } from '@/lib/api'

export interface OpenTranscript {
  id: string
  source: SessionSource
  locator?: string
  /** The open view shows reasoning, so a nested run should too. */
  thinking: boolean
}

export const OPEN_TRANSCRIPT: InjectionKey<ComputedRef<OpenTranscript | null>> =
  Symbol('open-transcript')
