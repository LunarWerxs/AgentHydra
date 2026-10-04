import { describe, expect, it } from 'bun:test'
import { accountLine, instanceColumns, withoutPlanSuffix } from './instance-table'

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

  it('shows the account once under the name', () => {
    expect(accountLine({ email: 'a@b.c' }, 'Work')).toEqual({ text: 'a', title: 'a@b.c' })
    expect(accountLine({ email: 'a@b.c' }, 'a@b.c')).toBeNull()
    expect(accountLine({}, 'a@b.c')).toBeNull()
  })

  it('keeps the plan out of a CLI name', () => {
    expect(withoutPlanSuffix('a@b.c (Pro)', 'Pro')).toBe('a@b.c')
    expect(withoutPlanSuffix('a@b.c (Pro)', null)).toBe('a@b.c (Pro)')
  })
})
