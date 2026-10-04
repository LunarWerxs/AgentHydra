import { describe, expect, it } from 'bun:test'
import { folderRows } from '../../src/components/composer/folders'

describe('folder menu rows', () => {
  it('show names only; folders sharing a name get as much parent path as tells them apart', () => {
    const rows = folderRows(
      [
        'C:\\Users\\jacob\\Desktop\\Project\\Agent Hydra\\desk\\web',
        'D:\\NEWProjects\\Connections',
        'D:\\NEWProjects\\web',
        'C:\\a\\x\\api',
        'D:\\b\\x\\api'
      ],
      null
    )
    expect(rows.map((r) => [r.name, r.hint])).toEqual([
      ['web', 'desk'],
      ['Connections', null],
      ['web', 'NEWProjects'],
      ['api', 'a\\x'],
      ['api', 'b\\x']
    ])
  })

  it('check the current folder however its path is spelled', () => {
    const rows = folderRows(['D:\\NEWProjects\\Connections', 'D:\\NEWProjects\\IronWerx'], 'd:/newprojects/connections/')
    expect(rows.map((r) => r.current)).toEqual([true, false])
  })
})
