#!/usr/bin/env node
// scripts/consolidate-releases.mjs - rewrite GitHub release pages from CHANGELOG.md and fold
// patch releases into their minor's release (owner, 2026-10-06).
//
// Groups releases by minor line (x.y). In each line the release x.y.0 is KEPT (a line with no x.y.0
// keeps its lowest release); every other release in the line is a patch to FOLD. The release marked
// latest is never folded or deleted.
//
// A kept release with folded patches gets one body covering the whole line: the TL;DR is the kept
// version's bullets then each folded version's, duplicates removed; Read more holds each version's
// section, oldest first, each under its own `#### x.y.z` heading. Every other kept release gets
// formatReleaseBody's page (single version, no patches combined).
//
// Dry run by default: writes every new body to <out>/bodies/<tag>.md and <out>/plan.json
// ({ edit: [tags], fold: { <kept tag>: [patch tags] }, delete: [tags], missingSections: [versions] })
// and prints a short summary.
//
// `--apply` runs `gh release edit <tag> --notes-file <file>` for each edit and
// `gh release delete <tag> --yes` for each folded patch (NEVER --cleanup-tag: the git tags stay),
// and never changes which release is latest. `--out` defaults to a temp folder. `--repo` overridable.
//
// usage: node scripts/consolidate-releases.mjs [--apply] [--out <dir>] [--repo <repo>]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { formatReleaseBody, formatLineBody, compareVersions, changelogSection } from './release-notes.mjs'

const REPO = 'LunarWerxs/AgentHydra'

/** Fetch releases from GitHub. */
async function fetchReleases(repo) {
  const json = execSync(
    `gh release list --repo ${repo} --limit 500 --json tagName,isLatest,isDraft,isPrerelease`,
    { encoding: 'utf8' },
  )
  return JSON.parse(json)
}

/** Group versions by minor (x.y). */
function groupByMinor(versions) {
  const groups = new Map()
  for (const v of versions) {
    const parts = v.split(/[.-]/)
    const minor = `${parts[0]}.${parts[1]}`
    if (!groups.has(minor)) groups.set(minor, [])
    groups.get(minor).push(v)
  }
  return groups
}

/** Sort versions in a group and determine which to keep/fold. */
function classifyVersions(versions) {
  const sorted = [...versions].sort((a, b) => compareVersions(b, a))
  const kept = versions.find((v) => /\.0$/.test(v)) || sorted[sorted.length - 1]
  const patches = sorted.filter((v) => v !== kept).sort((a, b) => compareVersions(a, b))
  return { kept, patches }
}

/** Main consolidation logic. */
async function consolidate(options = {}) {
  const { apply = false, out = null, repo = REPO, history = false } = options

  const releases = await fetchReleases(repo)
  const changelog = readFileSync('CHANGELOG.md', 'utf8')

  const latestTag = releases.find((r) => r.isLatest)?.tagName?.replace(/^v/, '')
  const versions = releases
    .filter((r) => !r.isDraft)
    .map((r) => r.tagName.replace(/^v/, ''))

  const groups = groupByMinor(versions)
  const plan = { edit: [], fold: {}, delete: [], missingSections: [] }
  const bodies = {}

  // Process each minor version line
  for (const [minor, lineVersions] of groups) {
    const { kept, patches } = classifyVersions(lineVersions)

    // Never fold the latest
    const folded = patches.filter((v) => v !== latestTag)
    const deleted = patches.filter((v) => v === latestTag)

    if (folded.length > 0) {
      plan.fold[kept] = folded
      plan.edit.push(kept)

      // Build combined body for kept release
      try {
        const body = formatLineBody(changelog, kept, folded, { history })
        bodies[kept] = body
      } catch (err) {
        console.warn(`Warning: could not build body for ${kept}: ${err.message}`)
      }
    } else if (kept !== latestTag) {
      // Single release, not latest
      plan.edit.push(kept)
      try {
        const body = formatReleaseBody(changelog, kept, { history })
        bodies[kept] = body
      } catch (err) {
        console.warn(`Warning: could not build body for ${kept}: ${err.message}`)
      }
    }

    // Delete folded patches
    for (const v of folded) {
      plan.delete.push(v)
    }
  }

  // Find versions with no CHANGELOG section
  for (const v of versions) {
    if (!changelogSection(changelog, v)) {
      plan.missingSections.push(v)
    }
  }

  // Write dry-run output
  const outDir = out || (apply ? null : join(tmpdir(), `consolidate-${Date.now()}`))
  if (!apply && outDir) {
    mkdirSync(outDir, { recursive: true })
    mkdirSync(join(outDir, 'bodies'), { recursive: true })

    for (const [tag, body] of Object.entries(bodies)) {
      writeFileSync(join(outDir, 'bodies', `${tag}.md`), body)
    }
    writeFileSync(join(outDir, 'plan.json'), JSON.stringify(plan, null, 2))
  }

  return { plan, bodies, outDir, latestTag }
}

/** Apply the consolidation (edit and delete releases). */
async function apply(plan, bodies, repo) {
  for (const tag of plan.edit) {
    const body = bodies[tag]
    if (!body) {
      console.warn(`Skipping ${tag}: no body generated`)
      continue
    }
    // Write body to temp file
    const tmpFile = join(tmpdir(), `${tag}-body.md`)
    writeFileSync(tmpFile, body)
    try {
      execFileSync('gh', ['release', 'edit', `v${tag}`, '--notes-file', tmpFile, '--repo', repo])
      console.log(`✓ Edited v${tag}`)
    } catch (err) {
      console.error(`✗ Failed to edit v${tag}: ${err.message}`)
    }
  }

  for (const tag of plan.delete) {
    try {
      execFileSync('gh', ['release', 'delete', `v${tag}`, '--yes', '--repo', repo])
      console.log(`✓ Deleted v${tag}`)
    } catch (err) {
      console.error(`✗ Failed to delete v${tag}: ${err.message}`)
    }
  }
}

/** Print a summary of the plan. */
function summary(plan, outDir, apply) {
  const totalPatches = Object.values(plan.fold).reduce((sum, patches) => sum + patches.length, 0)
  console.log(
    `Plan: edit ${plan.edit.length} release(s), fold ${totalPatches} patch(es), delete ${plan.delete.length}`,
  )
  if (plan.missingSections.length > 0) {
    console.log(`Missing sections: ${plan.missingSections.join(', ')}`)
  }
  if (!apply && outDir) {
    console.log(`Plan written to: ${outDir}/plan.json`)
    console.log(`Bodies written to: ${outDir}/bodies/`)
  }
}

const invokedDirectly = process.argv[1] && /consolidate-releases\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))
if (invokedDirectly) {
  const args = process.argv.slice(2)
  const options = {
    apply: args.includes('--apply'),
    history: args.includes('--history'),
    out: (() => {
      const idx = args.indexOf('--out')
      return idx >= 0 ? args[idx + 1] : null
    })(),
    repo: (() => {
      const idx = args.indexOf('--repo')
      return idx >= 0 ? args[idx + 1] : REPO
    })(),
  }

  consolidate(options).then(({ plan, bodies, outDir, latestTag }) => {
    summary(plan, outDir, options.apply)
    if (options.apply) {
      apply(plan, bodies, options.repo).catch(err => {
        console.error(`Apply failed: ${err.message}`)
        process.exit(1)
      })
    }
  })
}

export { consolidate, apply, groupByMinor, classifyVersions }
