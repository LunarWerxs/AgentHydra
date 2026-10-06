import { describe, expect, it } from 'bun:test'
import type { SidebarModel } from '@shared/hydra-embed'
import { pickHydraSidebar, resolvePaneView } from '@/components/hydra/api'

const tree = (view: string): SidebarModel => ({ view, title: 'Tree', sections: [{ key: 'a', rows: [{ key: 'r', label: 'Row' }] }] })

describe('what the sidebar draws when AgentHydra opens', () => {
  it('draws the kept tree of the remembered tab at once, marked stale', () => {
    const kept = tree('hswarm')
    expect(pickHydraSidebar(null, false, true, 'hswarm', () => kept)).toEqual({ model: kept, stale: true })
  })

  it('draws an empty tree of the tab (never the cloud list) when none is kept', () => {
    const r = pickHydraSidebar(null, false, true, 'hswarm', () => null)
    expect(r?.stale).toBe(true)
    expect(r?.model.view).toBe('hswarm')
    expect(r?.model.sections).toEqual([])
  })

  it('keeps the cloud list for a tab without a sidebar of its own', () => {
    expect(pickHydraSidebar(null, false, true, 'instances', () => tree('instances'))).toBeNull()
    expect(pickHydraSidebar(null, false, true, null, () => null)).toBeNull()
  })

  it('follows the pane once it has spoken: live tree, or the cloud list for null', () => {
    const live = tree('hswarm')
    expect(pickHydraSidebar(live, true, true, 'hswarm', () => tree('hswarm'))).toEqual({ model: live, stale: false })
    expect(pickHydraSidebar(null, true, true, 'hswarm', () => tree('hswarm'))).toBeNull()
  })

  it('draws the cloud list while no frame is attached', () => {
    expect(pickHydraSidebar(null, false, false, 'hswarm', () => tree('hswarm'))).toBeNull()
  })
})

describe('the tab the pane will open on', () => {
  it('maps a renamed stored value, so climayte is still HSwarm', () => {
    expect(resolvePaneView(null, 'climayte')).toBe('hswarm')
    expect(resolvePaneView(null, 'instances')).toBe('desktop')
  })

  it('takes sessionStorage over the durable value', () => {
    expect(resolvePaneView('hswarm', 'instances-home')).toBe('hswarm')
    expect(resolvePaneView(null, 'hswarm')).toBe('hswarm')
    expect(resolvePaneView(null, null)).toBeNull()
  })
})
