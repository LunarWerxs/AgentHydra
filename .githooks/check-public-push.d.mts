// Types for check-public-push.mjs, so tests/githooks/ can import its parsers under `tsc` (the
// same sibling-declaration shape the kit uses for instance-pointer.mjs).
export interface Visibility {
  verdict: 'public' | 'private' | 'unknown'
  reason: string
}

export interface PushRef {
  localRef: string
  localSha: string
  remoteRef: string
  remoteSha: string
  isDelete: boolean
}

/** owner/repo from any URL shape git accepts for GitHub, or null for anything else. */
export function parseGithubSlug(url: string): { owner: string; repo: string } | null

/** Fail-closed: anything that is not provably private answers 'public' or 'unknown'. */
export function lookupVisibility(
  url: string,
  env?: Record<string, string | undefined>,
): Promise<Visibility>

/** The refs git is about to push, from the pre-push hook's stdin. */
export function parseRefLines(text: string): PushRef[]

/** Open sections of the work queue; a missing file is an empty queue. */
export function openTodoSections(todoPath: string): string[]
