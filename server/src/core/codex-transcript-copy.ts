/** Give a copied local transcript its own identity without changing model-visible history.
 * Keep paginated ordinals and item-completed events intact: downgrading history_mode makes
 * Codex silently drop the displayed items even though the model messages remain on disk. */
export function copyCodexTranscript(
  transcript: string,
  sourceId: string,
  destinationId: string,
): string {
  let foundMetadata = false
  const lines = transcript.split('\n').map((line) => {
    if (!line.trim()) return line
    const row = JSON.parse(line)
    if (row.type === 'session_meta') {
      if (foundMetadata || row.payload?.id !== sourceId)
        throw new Error('The transcript identity does not match the selected chat.')
      foundMetadata = true
      row.payload.id = destinationId
      row.payload.session_id = destinationId
      return JSON.stringify(row)
    }
    if (row.payload?.thread_id === sourceId) {
      row.payload.thread_id = destinationId
      return JSON.stringify(row)
    }
    return line
  })
  if (!foundMetadata) throw new Error('This chat has no readable transcript metadata.')
  return lines.join('\n')
}
