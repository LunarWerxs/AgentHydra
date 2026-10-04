// The Diagnostics page's sections, in order (SPEC "Diagnostics"). One list, one entry per section: a feature
// adds its own with one line here (or registerDiagnosticsSection from its module). A section is a component
// that loads its own data through usePaneApi().diagnostics(name, params) and draws it.
import type { Component } from 'vue'
import FailuresSection from './FailuresSection.vue'

export interface DiagnosticsSection {
  id: string
  label: string
  component: Component
}

export const DIAGNOSTICS_SECTIONS: DiagnosticsSection[] = [{ id: 'failures', label: 'Failures', component: FailuresSection }]

/** Adds (or replaces, by id) a section. */
export function registerDiagnosticsSection(s: DiagnosticsSection): void {
  const at = DIAGNOSTICS_SECTIONS.findIndex((x) => x.id === s.id)
  if (at >= 0) DIAGNOSTICS_SECTIONS[at] = s
  else DIAGNOSTICS_SECTIONS.push(s)
}
