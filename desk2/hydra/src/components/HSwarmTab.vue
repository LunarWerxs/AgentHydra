<script setup lang="ts">
// The HSwarm tab: the pages of lib/hswarm-pages.ts, one shown at a time (CliMayte, HSwarm's own tree).
// Each page stays built behind the others, so what it holds (and its warm data) survives a switch.
// In Desk the tab's one sidebar is made here: an entry per page, and under the entry of the page on
// screen that page's own rows; its header (title, buttons, search, footer) is that page's.
import { type Component, defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SidebarModel, SidebarRow } from '@desk/shared/hydra-embed'
import { useDeskSidebarHost } from '@/lib/desk-embed'
import { HSWARM_PAGES, hswarmPage, PAGE_KEY_PREFIX, showHSwarmPage } from '@/lib/hswarm-pages'

const CliMayteView = defineAsyncComponent(() => import('@/components/CliMayteView.vue'))
const RoutingView = defineAsyncComponent(() => import('@/components/RoutingView.vue'))
const HSwarmView = defineAsyncComponent(() => import('@/components/HSwarmView.vue'))

const PAGE_COMPONENTS: Record<string, Component> = {
  climayte: CliMayteView,
  routing: RoutingView,
  hswarm: HSwarmView,
}

const { t } = useI18n()

// A page is mounted the first time it is shown, then kept.
const seen = new Set<string>()
function mounted(id: string): boolean {
  if (hswarmPage.value === id) seen.add(id)
  return seen.has(id)
}

function entryRow(id: string, labelKey: string, icon: (typeof HSWARM_PAGES)[number]['icon']): SidebarRow {
  const on = hswarmPage.value === id
  return { key: PAGE_KEY_PREFIX + id, label: t(labelKey), icon, branch: on ? 'open' : 'closed' }
}

useDeskSidebarHost(
  (parts) => {
    const model = parts.get(hswarmPage.value)?.()
    if (!model) return null
    // Entries in order; the page on screen puts its own sections right after its entry.
    const sections: SidebarModel['sections'] = []
    for (const p of HSWARM_PAGES) {
      sections.push({ key: PAGE_KEY_PREFIX + p.id, rows: [entryRow(p.id, p.labelKey, p.icon)] })
      if (p.id === hswarmPage.value) sections.push(...model.sections)
    }
    return { ...model, sections }
  },
  (_view, e) => {
    if (e.action !== 'select' || !e.key.startsWith(PAGE_KEY_PREFIX)) return false
    showHSwarmPage(e.key.slice(PAGE_KEY_PREFIX.length))
    return true
  },
)
</script>

<template>
  <div class="h-full min-h-0">
    <template v-for="p in HSWARM_PAGES" :key="p.id">
      <div v-if="mounted(p.id)" v-show="hswarmPage === p.id" class="h-full min-h-0">
        <component :is="PAGE_COMPONENTS[p.id]" class="h-full" />
      </div>
    </template>
  </div>
</template>
