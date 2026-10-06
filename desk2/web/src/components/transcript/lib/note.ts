// A note card (parts/NoteRow.vue) while it is closed: one line. An AgentHydra ping's group tallies summed
// ("1 done, 0 running, 0 waiting": server/src/climayte-ping.ts pingMessage writes one `Group <id>: ...` line
// per group), else the note's first line.

/** What every ping said before 2026-10-06, still in older transcripts: never shown. */
const NOBODY_TYPED = /^Automatic status note, nobody typed this\.\s*/

/** A note's text as the open card shows it. */
export const noteBody = (text: string): string => text.replace(NOBODY_TYPED, '')

const TALLY = /^Group [^:\n]+: (\d+) done, (\d+) failed(?:, (\d+) cancelled)?, (\d+) running, (\d+) waiting\.$/gm

/** The closed card's one line. Failed and cancelled are named only when there are any. */
export function noteSummary(text: string): string {
  const sum = [0, 0, 0, 0, 0]
  let groups = 0
  for (const m of text.matchAll(TALLY)) {
    groups++
    m.slice(1).forEach((n, i) => (sum[i] += Number(n ?? 0)))
  }
  if (!groups) return noteBody(text).split('\n', 1)[0].trim()
  const [done, failed, cancelled, running, waiting] = sum
  return [`${done} done`, failed ? `${failed} failed` : '', cancelled ? `${cancelled} cancelled` : '', `${running} running`, `${waiting} waiting`].filter(Boolean).join(', ')
}
