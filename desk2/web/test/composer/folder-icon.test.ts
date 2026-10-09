import { describe, expect, it } from 'bun:test'
import { folderIcon } from '../../src/components/composer/folders'

const LOGO = '/api/projects/icon?key=example-project&v=1'
const projects = [
  { path: 'C:/Users/me/Desktop/example-project', icon: LOGO },
  { path: 'C:/Users/me/Desktop/plain-folder', icon: null }
]

describe('folder pill logo', () => {
  it('gives the logo of the project whose folder the pill shows', () => {
    expect(folderIcon(projects, 'C:/Users/me/Desktop/example-project')).toBe(LOGO)
  })

  it('gives null for a folder without a logo, so the folder glyph shows', () => {
    expect(folderIcon(projects, 'C:/Users/me/Desktop/plain-folder')).toBeNull()
    expect(folderIcon(projects, 'C:/Users/me/Desktop/not-a-project')).toBeNull()
    expect(folderIcon(projects, null)).toBeNull()
  })

  it('matches a folder whose path differs only by case and slashes', () => {
    expect(folderIcon(projects, 'c:\\users\\me\\desktop\\EXAMPLE-PROJECT\\')).toBe(LOGO)
  })
})
