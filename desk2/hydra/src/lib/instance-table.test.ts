import { describe, expect, it } from 'bun:test'
import { instanceColumns, nameTooltipFor, withoutPlanSuffix } from './instance-table'
import { hswarmProviderColumns, hswarmKeyColumns, hswarmModelColumns, hswarmModelTypedColumns } from './hswarm-table'

const keys = (kind: 'desktop' | 'cli', usageMode: boolean) =>
  instanceColumns(kind, { usageMode }).map((c) => c.key)

describe('instance table column model', () => {
  it('draws one column set for both tables in usage mode', () => {
    expect(keys('cli', true)).toEqual(keys('desktop', true))
    expect(keys('desktop', true)).toEqual([
      'status',
      'name',
      'session',
      'weekly',
      'plan',
      'lastActive',
      'tokens',
      'actions',
    ])
  })

  it('gives the Free table the same quota and Tokens columns, without a plan', () => {
    expect(instanceColumns('free', { usageMode: true }).map((c) => c.key)).toEqual([
      'status',
      'name',
      'session',
      'weekly',
      'lastActive',
      'tokens',
      'actions',
    ])
  })

  it('leads the name hover with the address, then the folder', () => {
    const name = { full: 'Work', shown: 'Work', email: 'a@example.com', folder: '/x', copyHint: 'Copy' }
    expect(nameTooltipFor(name, false)).toEqual({
      label: 'a@example.com',
      description: '/x',
      detail: 'Copy',
    })
    // A cut name puts the full name in the detail; a row with no address leads with the name.
    expect(nameTooltipFor({ ...name, shown: 'Wo…' }, false).detail).toBe('Work')
    expect(nameTooltipFor({ ...name, email: null }, false)).toEqual({
      label: 'Work',
      description: '/x',
      detail: undefined,
    })
  })

  it('keeps the plan out of a CLI name', () => {
    expect(withoutPlanSuffix('a@b.c (Pro)', 'Pro')).toBe('a@b.c')
    expect(withoutPlanSuffix('a@b.c (Pro)', null)).toBe('a@b.c (Pro)')
  })
})

describe('hswarm table column model', () => {
  it('defines provider columns with state, name, counts, and enabled', () => {
    const keys = hswarmProviderColumns.map((c) => c.key)
    expect(keys).toEqual([
      'providerState',
      'providerName',
      'readyCount',
      'restingCount',
      'disabledCount',
      'keyCount',
      'enabled',
      'actions',
    ])
  })

  it('defines key columns with masked, fingerprint, priority, state, and actions', () => {
    const keys = hswarmKeyColumns.map((c) => c.key)
    expect(keys).toEqual(['keyMasked', 'keyFingerprint', 'keyPriority', 'keyState', 'actions'])
  })

  it('defines model columns with enabled, priority, name, provider, kind, price, and context', () => {
    const keys = hswarmModelColumns.map((c) => c.key)
    expect(keys).toEqual([
      'modelEnabled',
      'modelPriority',
      'modelName',
      'modelProvider',
      'modelKind',
      'modelPrice',
      'modelContext',
    ])
  })

  it('defines typed model columns with enabled, name, and provider', () => {
    const keys = hswarmModelTypedColumns.map((c) => c.key)
    expect(keys).toEqual(['modelEnabled', 'modelName', 'modelProvider'])
  })

  it('uses the shared InstanceColumn type for HSwarm columns', () => {
    // All HSwarm columns have required InstanceColumn properties
    hswarmProviderColumns.forEach((col) => {
      expect(col.label).toBeDefined()
      expect(col.skeleton).toBeDefined()
      expect(typeof col.key).toBe('string')
    })
  })
})
