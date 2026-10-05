import { describe, expect, it } from 'bun:test'
import type { SlashCommandInfo, TranscriptItem } from '@shared/protocol'
import {
  MAX_IMAGE_BYTES,
  appendDictation,
  applyMention,
  applySlashCommand,
  composerKeyAction,
  pendingRequest,
  shownSuggestion,
  filterMentions,
  mentionQuery,
  dataUrlToBase64,
  draftKey,
  draftSlot,
  filterSlashCommands,
  folderName,
  loadDraft,
  saveDraft,
  slashQuery,
  validateImage,
  type DraftStorage
} from '@/components/composer/logic'

const cmds: SlashCommandInfo[] = [
  { name: 'compact', description: 'Summarize the conversation' },
  { name: 'review', description: 'Review the diff' },
  { name: 'pr-review', description: 'Review a pull request' },
  { name: 'clear', description: 'Start over' },
  { name: 'cost', description: 'Show spend so far, a review of cost' }
]

describe('slash commands', () => {
  it('opens only for a leading /word with no space yet', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/rev')).toBe('rev')
    expect(slashQuery('/review the diff')).toBeNull()
    expect(slashQuery('hello /rev')).toBeNull()
    expect(slashQuery('')).toBeNull()
  })

  it('ranks name prefix, then name substring, then description', () => {
    expect(filterSlashCommands(cmds, 'pull').map((c) => c.name)).toEqual(['pr-review'])
    expect(filterSlashCommands(cmds, 'REVIEW').map((c) => c.name)).toEqual(['review', 'pr-review', 'cost'])
  })

  it('lists everything alphabetically for an empty query and nothing for a miss', () => {
    expect(filterSlashCommands(cmds, '').map((c) => c.name)).toEqual(['clear', 'compact', 'cost', 'pr-review', 'review'])
    expect(filterSlashCommands(cmds, 'zzz')).toEqual([])
  })

  it('picking a command leaves it ready for arguments', () => {
    expect(applySlashCommand(cmds[0])).toBe('/compact ')
  })
})

function memoryStorage(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k)
  }
}

describe('drafts', () => {
  it('keeps one draft per chat and one for the new-session box', () => {
    const s = memoryStorage()
    saveDraft(s, 'a', 'draft for a')
    saveDraft(s, null, 'new one')
    expect(loadDraft(s, 'a')).toBe('draft for a')
    expect(loadDraft(s, 'b')).toBe('')
    expect(loadDraft(s, null)).toBe('new one')
    expect(s.data.has(draftKey(null))).toBe(true)
  })

  it('a new session keeps one box per folder', () => {
    const s = memoryStorage()
    saveDraft(s, draftSlot(null, 'C:\\Work\\Hydra\\'), 'for hydra')
    saveDraft(s, draftSlot(null, 'C:/Work/Nexus'), 'for nexus')
    expect(loadDraft(s, draftSlot(null, 'c:/work/hydra'))).toBe('for hydra')
    expect(loadDraft(s, draftSlot(null, 'C:\\Work\\Nexus'))).toBe('for nexus')
    expect(draftSlot('chat-1', 'C:/Work/Nexus')).toBe('chat-1')
    expect(draftSlot(null, null)).toBeNull()
  })

  it('an emptied draft removes its key', () => {
    const s = memoryStorage()
    saveDraft(s, 'a', 'x')
    saveDraft(s, 'a', '   ')
    expect(s.data.size).toBe(0)
  })

  it('survives a storage that throws', () => {
    const broken: DraftStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('full')
      },
      removeItem: () => {}
    }
    expect(() => saveDraft(broken, 'a', 'x')).not.toThrow()
    expect(loadDraft(broken, 'a')).toBe('')
    expect(loadDraft(null, 'a')).toBe('')
  })
})

describe('images', () => {
  it('accepts an image at exactly 5 MB', () => {
    expect(validateImage({ name: 'a.png', type: 'image/png', size: MAX_IMAGE_BYTES })).toBeNull()
  })

  it('refuses an image over 5 MB with its size in the message', () => {
    const msg = validateImage({ name: 'big.jpg', type: 'image/jpeg', size: MAX_IMAGE_BYTES + 1 })
    expect(msg).toContain('big.jpg')
    expect(msg).toContain('5.0 MB')
    expect(msg).toContain('limited to 5 MB')
  })

  it('refuses a non-image', () => {
    expect(validateImage({ name: 'notes.pdf', type: 'application/pdf', size: 10 })).toContain('not an image')
  })

  it('strips the data URL prefix', () => {
    expect(dataUrlToBase64('data:image/png;base64,QUJD')).toBe('QUJD')
  })
})

describe('labels', () => {
  it('folder name handles both slash styles and a trailing slash', () => {
    expect(folderName('C:\\Users\\me\\desk\\')).toBe('desk')
    expect(folderName('/home/j/connections')).toBe('connections')
  })
})

describe('keys', () => {
  const idle = { empty: false, busy: false }
  it('Enter sends, Shift+Enter is a new line, IME composition is left alone', () => {
    expect(composerKeyAction({ key: 'Enter' }, idle)).toBe('send')
    expect(composerKeyAction({ key: 'Enter', shiftKey: true }, idle)).toBe('none')
    expect(composerKeyAction({ key: 'Enter', isComposing: true }, idle)).toBe('none')
    // The box is empty and the button shows Stop (the message just went out): Enter is not a Stop.
    expect(composerKeyAction({ key: 'Enter' }, { empty: true, busy: true, stop: true })).toBe('swallow')
  })
  it('Ctrl+Enter and Cmd+Enter queue; with Shift it is still a new line', () => {
    expect(composerKeyAction({ key: 'Enter', ctrlKey: true }, idle)).toBe('queue')
    expect(composerKeyAction({ key: 'Enter', metaKey: true }, { empty: false, busy: true })).toBe('queue')
    expect(composerKeyAction({ key: 'Enter', ctrlKey: true, shiftKey: true }, idle)).toBe('none')
    expect(composerKeyAction({ key: 'Enter', ctrlKey: true, isComposing: true }, idle)).toBe('none')
  })
  it('Esc interrupts only while a turn runs', () => {
    expect(composerKeyAction({ key: 'Escape' }, { empty: true, busy: true })).toBe('interrupt')
    expect(composerKeyAction({ key: 'Escape' }, { empty: true, busy: false })).toBe('none')
  })
  it('Up recalls only in an empty box; Ctrl+U attaches', () => {
    expect(composerKeyAction({ key: 'ArrowUp' }, { empty: true, busy: false })).toBe('recall')
    expect(composerKeyAction({ key: 'ArrowUp' }, idle)).toBe('none')
    expect(composerKeyAction({ key: 'u', ctrlKey: true }, idle)).toBe('attach')
  })
  it('Tab takes a shown suggestion only in an empty box', () => {
    expect(composerKeyAction({ key: 'Tab' }, { empty: true, busy: false, suggestion: true })).toBe('accept-suggestion')
    expect(composerKeyAction({ key: 'Tab' }, { empty: true, busy: false })).toBe('none')
    expect(composerKeyAction({ key: 'Tab' }, { empty: false, busy: false, suggestion: true })).toBe('none')
    expect(composerKeyAction({ key: 'Tab', shiftKey: true }, { empty: true, busy: false, suggestion: true })).toBe('none')
  })
})

describe('suggestion', () => {
  it('shows only in an empty box between turns, and never invents text', () => {
    expect(shownSuggestion('stay on plan logins', { empty: true, busy: false })).toBe('stay on plan logins')
    expect(shownSuggestion('stay on plan logins', { empty: false, busy: false })).toBe('')
    expect(shownSuggestion('stay on plan logins', { empty: true, busy: true })).toBe('')
    expect(shownSuggestion(null, { empty: true, busy: false })).toBe('')
    expect(shownSuggestion('   ', { empty: true, busy: false })).toBe('')
  })
})

describe('mentions', () => {
  it('finds the @word at the caret, not an email address', () => {
    expect(mentionQuery('look at @web/sr', 15)).toEqual({ start: 8, query: 'web/sr' })
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionQuery('mail jacob@example.com', 22)).toBeNull()
    expect(mentionQuery('@done and more', 14)).toBeNull()
  })
  it('ranks basename prefix before path substring', () => {
    const paths = ['web/src/App.vue', 'docs/app-notes.md', 'server/src/main.ts']
    expect(filterMentions(paths, 'app')).toEqual(['docs/app-notes.md', 'web/src/App.vue'])
    expect(filterMentions(paths, 'src/m')).toEqual(['server/src/main.ts'])
  })
  it('replaces the query with the path and puts the caret after it', () => {
    const m = mentionQuery('see @ap now', 7)!
    expect(applyMention('see @ap now', m, 'web/src/App.vue')).toEqual({ text: 'see @web/src/App.vue now', caret: 21 })
  })
})

describe('dictation', () => {
  it('joins dictated words with one space', () => {
    expect(appendDictation('', ' hello ')).toBe('hello')
    expect(appendDictation('fix', 'the test')).toBe('fix the test')
    expect(appendDictation('fix ', 'it')).toBe('fix it')
    expect(appendDictation('keep', '   ')).toBe('keep')
  })
})

describe('request dock', () => {
  const base = { chatId: 'c', ts: 1 }
  const perm = (id: string, state: 'pending' | 'allowed'): TranscriptItem =>
    ({ ...base, id, kind: 'permission', toolName: 'Bash', input: { command: 'ls' }, canAlwaysAllow: false, state }) as TranscriptItem
  const plan = (id: string, state: 'pending' | 'approved'): TranscriptItem => ({ ...base, id, kind: 'plan', plan: '# Plan', state }) as TranscriptItem
  const text: TranscriptItem = { ...base, id: 't', kind: 'assistant_text', text: 'hi' } as TranscriptItem
  it('shows the oldest open permission, question or plan request', () => {
    expect(pendingRequest([text, perm('a', 'allowed'), plan('p', 'pending'), perm('b', 'pending')])?.id).toBe('p')
  })
  it('shows nothing once every request is answered', () => {
    expect(pendingRequest([text, perm('a', 'allowed'), plan('p', 'approved')])).toBeNull()
    expect(pendingRequest([])).toBeNull()
  })
})
