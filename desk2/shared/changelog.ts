// GET /api/changelog: the newest sections of the CHANGELOG this running copy ships with, for the window's
// What's new pop-up after an update.

export interface ChangelogEntry {
  headline: string
  /** Plain text; empty for a plain bullet with no headline of its own. */
  detail: string
}

/** version null is the Unreleased section. */
export interface ChangelogSection {
  version: string | null
  date: string | null
  entries: ChangelogEntry[]
}

export interface ChangelogAnswer {
  sections: ChangelogSection[]
}
