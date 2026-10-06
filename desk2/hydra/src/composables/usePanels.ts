import { ref } from 'vue'

// Module-scope singletons: the header button toggles the queue drawer, the composer's "view queue"
// toast opens it, and App.vue renders it. Settings are Desk's (its Settings dialog, since 2026-10-06).
const queueOpen = ref(false)

// The run queue's automation settings (AutomationSettings.vue, in the one dialog App.vue mounts):
// the scheduler and the auto-resume monitor, opened from the queue drawer and the header chip.
const automationOpen = ref(false)

function openAutomation() {
  automationOpen.value = true
}

export function usePanels() {
  return {
    queueOpen,
    automationOpen,
    openAutomation,
  }
}
