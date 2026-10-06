import { describe, expect, test } from 'bun:test'
import { noteBody, noteSummary } from '../../src/components/transcript/lib/note'

// A ping as AgentHydra writes it (server/src/climayte-ping.ts pingMessage; docs/CLIMAYTE.md "The message"),
// after desk2's noteOf has cut its `[from] Not from the user.` prefix.
const ping = (...tallies: string[]) => ['Ping 3-4, 2 updates since 09:00:', '• w-1a2b3c4d "Docs": done on #84, check passed.', ...tallies, 'Next: climayte_status {group:"g-a", report:true}, then climayte_verdict.'].join('\n')

describe('a closed note card', () => {
  test("sums a ping's group tallies, naming failed and cancelled only when there are any", () => {
    expect(noteSummary(ping('Group g-a: 1 done, 0 failed, 0 running, 0 waiting.'))).toBe('1 done, 0 running, 0 waiting')
    expect(noteSummary(ping('Group g-a: 1 done, 1 failed, 0 running, 0 waiting.', 'Group g-b: 1 done, 0 failed, 1 cancelled, 1 running, 1 waiting.'))).toBe('2 done, 1 failed, 1 cancelled, 1 running, 1 waiting')
  })

  test('a note with no tally shows its first line, and never the sentence older pings opened with', () => {
    const old = 'Automatic status note, nobody typed this. The check did not pass.\nFix it and report again.'
    expect(noteSummary(old)).toBe('The check did not pass.')
    expect(noteBody(old)).toBe('The check did not pass.\nFix it and report again.')
  })
})
