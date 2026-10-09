// A build swaps its dist folder in with two renames, so index.html can be missing for a moment. The window then gets
// the copy read last time instead of a 500, and the next request reads the new file.

export function indexReader(file: string): () => Promise<string | null> {
  let last: string | null = null
  return async () => {
    try {
      last = await Bun.file(file).text()
    } catch {
      // Missing while a build swaps its folder: the copy read last time still serves the window.
    }
    return last
  }
}
