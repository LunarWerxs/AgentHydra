import { ref, watch } from 'vue'

// Module-scope singletons: the header buttons toggle these, the composer's "view queue"
// toast opens the queue, and App.vue renders both panels. Only one push panel may be
// open at a time — they dock to the same right edge and their content insets would add.
const settingsOpen = ref(false)
const queueOpen = ref(false)

// One-shot deep link into the settings panel (the header's update dot): set by openSettingsTab(),
// consumed (and cleared) by SettingsView so the panel lands on the requested section whether it
// was already open or is mounting fresh.
const settingsRequestedTab = ref<string | null>(null)

// The run queue's automation settings (AutomationSettings.vue, in the one dialog App.vue mounts):
// the scheduler and the auto-resume monitor, opened from the queue drawer and the header chip.
const automationOpen = ref(false)

watch(settingsOpen, (open) => {
  if (open) queueOpen.value = false
})
watch(queueOpen, (open) => {
  if (open) settingsOpen.value = false
})

function openSettingsTab(tab: string) {
  settingsRequestedTab.value = tab
  settingsOpen.value = true
}

function openAutomation() {
  automationOpen.value = true
}

export function usePanels() {
  return {
    settingsOpen,
    queueOpen,
    settingsRequestedTab,
    openSettingsTab,
    automationOpen,
    openAutomation,
  }
}
