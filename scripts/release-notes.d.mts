// Types for release-notes.mjs, so tests and the pre-push hook's tests can import it under `tsc` (the
// same sibling-declaration shape as .githooks/check-public-push.d.mts).

/** The lowest version AgentHydra may release. */
export const MIN_RELEASE: string

/** -1, 0 or 1, comparing two x.y.z versions. */
export function compareVersions(a: string, b: string): -1 | 0 | 1

/** The lines under `## [<version>]` up to the next `## ` heading, or null. */
export function changelogSection(changelog: string, version: string): string | null

/** The section's written TL;DR bullets and the section without that block. */
export function splitTldr(section: string): { tldr: string[]; rest: string }

/** Why this version may not be released, or null when it may. */
export function refusal(changelog: string, version: string): string | null

/** Why the [Unreleased] section may not stay as it is (long, with no TL;DR), or null when it may. */
export function unreleasedRefusal(changelog: string): string | null

/** The release page body; throws with the refusal when the version may not be released. */
export function formatReleaseBody(changelog: string, version: string): string
