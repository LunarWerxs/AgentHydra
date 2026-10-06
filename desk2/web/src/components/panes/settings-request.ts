// A section another part of Desk asks the Settings dialog to open on: a table's gear in the AgentHydra pane
// asks for its Instances page, the sidebar's gear for Updates while an AgentHydra update is waiting, and a
// Connections sign-in coming back for Connections. SettingsView takes it and clears it. Its own small
// file, so the shell that asks does not load the dialog's rows.
import { ref } from 'vue'
import type { SettingsSection } from './settings'

export const requestedSection = ref<SettingsSection | null>(null)
