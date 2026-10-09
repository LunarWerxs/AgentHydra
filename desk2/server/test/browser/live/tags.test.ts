// The tag file: a tag names one browser profile on this PC, found case-insensitively, and a damaged file is reported, never overwritten.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  adoptConnectionsTags,
  browserLiveFindTag,
  browserLiveProfileDir,
  browserTagsPath,
  readLiveTags,
  writeLiveTags,
} from '../../../src/browser/live/tags'
import { tempDir } from '../../git/helpers'

let file: string
let saved: string | undefined

beforeEach(() => {
  saved = process.env.CONNECTIONS_BROWSER_TAGS
  file = join(tempDir('live-tags-'), 'browser-tags.json')
  process.env.CONNECTIONS_BROWSER_TAGS = file
})

afterEach(() => {
  if (saved === undefined) delete process.env.CONNECTIONS_BROWSER_TAGS
  else process.env.CONNECTIONS_BROWSER_TAGS = saved
})

describe('browser_live tags', () => {
  test('the tag file is read back as it was written', () => {
    expect(browserTagsPath()).toBe(file)
    expect(readLiveTags()).toEqual({ tags: [] })
    writeLiveTags([{ tag: 'work', browser: 'Chrome', profileDir: 'Default', profileName: 'Example Owner' }])
    expect(existsSync(file)).toBe(true)
    expect(readLiveTags().tags).toEqual([{ tag: 'work', browser: 'Chrome', profileDir: 'Default', profileName: 'Example Owner' }])
  })

  test('a damaged tag file is reported and left unchanged', () => {
    writeFileSync(file, '{ not json')
    const out = readLiveTags()
    expect(out.tags).toEqual([])
    expect(out.error).toContain('no tag was changed')
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
  })

  test('a tag is found regardless of case and surrounding spaces', () => {
    const tags = [{ tag: 'Work' }, { tag: 'example-owner' }]
    expect(browserLiveFindTag(tags, '  WORK ')).toEqual({ tag: 'Work' })
    expect(browserLiveFindTag(tags, 'missing')).toBeNull()
    expect(browserLiveFindTag(tags, '')).toBeNull()
  })

  test("Connections' tag file is copied once, never over a tag file of Desk's own", () => {
    const legacy = join(tempDir('live-tags-legacy-'), 'browser-tags.json')
    writeFileSync(legacy, JSON.stringify({ version: 1, tags: [{ tag: 'work', browser: 'Chrome', profileDir: 'Default' }] }))
    expect(adoptConnectionsTags(file, legacy)).toBe(true)
    expect(readLiveTags().tags.map((t) => t.tag)).toEqual(['work'])
    writeLiveTags([])
    expect(adoptConnectionsTags(file, legacy)).toBe(false)
    expect(readLiveTags().tags).toEqual([])
  })

  test('the profile folder is read from the relaunch command', () => {
    expect(browserLiveProfileDir('"C:\\Chrome\\chrome.exe" --profile-directory="Profile 2"')).toBe('Profile 2')
    expect(browserLiveProfileDir('chrome.exe --profile-directory=Default')).toBe('Default')
    expect(browserLiveProfileDir('chrome.exe')).toBe('')
  })
})
