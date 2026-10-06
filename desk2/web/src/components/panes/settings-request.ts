// A section another part of Desk asks the Settings dialog to open on (the AgentHydra pane's gear asks
// for Updates while an update is waiting). SettingsView takes it and clears it. Its own small file, so
// the shell that asks does not load the dialog's rows.
import { ref } from 'vue'
import type { SettingsSection } from './settings'

export const requestedSection = ref<SettingsSection | null>(null)
