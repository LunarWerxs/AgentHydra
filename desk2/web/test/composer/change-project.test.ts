import { describe, expect, it } from 'bun:test'
import { joinDrafts, movedChat, projectRows } from '../../src/components/composer/change-project'

describe('Change project', () => {
  it('offers every recent folder but the one the message is in, in any spelling of it', () => {
    const rows = projectRows(['C:\\Users\\me\\Projects\\Shop', 'C:\\Users\\me\\Projects\\Blog', 'D:\\Work\\Blog'], 'c:/users/me/projects/shop/')
    expect(rows.map((r) => r.path)).toEqual(['C:\\Users\\me\\Projects\\Blog', 'D:\\Work\\Blog'])
    expect(rows.map((r) => r.hint)).toEqual(['Projects', 'Work'])
    expect(rows.every((r) => !r.current)).toBe(true)
    expect(projectRows(['C:\\a', 'C:\\b'], null).map((r) => r.path)).toEqual(['C:\\a', 'C:\\b'])
  })

  it('sends a moved message as a new chat with the same text, pictures and settings; the account is picked again', () => {
    const from = { model: 'opus', effort: 'high' as const, permissionMode: 'acceptEdits' as const, delegateToCliMayte: true }
    const images = [{ mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=', name: 'shot.png' }]
    expect(movedChat(from, 'C:\\Users\\me\\Projects\\Blog', { text: 'Fix the header', images })).toEqual({
      cwd: 'C:\\Users\\me\\Projects\\Blog',
      prompt: 'Fix the header',
      images,
      model: 'opus',
      effort: 'high',
      permissionMode: 'acceptEdits',
      delegateToCliMayte: true
    })
    // No pictures: no images field. An outside session has no chat settings to carry.
    expect(movedChat(null, 'C:\\b', { text: 'Hi', images: [] })).toEqual({ cwd: 'C:\\b', prompt: 'Hi' })
  })

  it('puts a moved draft below what already waits in the other folder, never over it', () => {
    expect(joinDrafts('', 'Moved text')).toBe('Moved text')
    expect(joinDrafts('  \n', 'Moved text')).toBe('Moved text')
    expect(joinDrafts('Already here\n', 'Moved text')).toBe('Already here\n\nMoved text')
  })
})
