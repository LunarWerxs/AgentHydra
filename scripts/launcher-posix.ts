import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The Linux and macOS launcher (`agenthydra` at the top of a release bundle). Its source is
 * launcher/posix/agenthydra, with the release version left as a placeholder the packager fills.
 */
const SOURCE = join(import.meta.dir, '..', 'launcher', 'posix', 'agenthydra')
const PLACEHOLDER = '@VERSION@'

/** Writes the launcher with `version` baked in and mode 0755. */
export function writePosixLauncher({
  outfile,
  version,
}: {
  outfile: string
  version: string
}): void {
  // The version lands inside single quotes in a shell script, so only a plain version string may pass.
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    throw new Error(
      `launcher version must be a plain version string, got ${JSON.stringify(version)}`,
    )
  }
  const text = readFileSync(SOURCE, 'utf8')
  if (!text.includes(PLACEHOLDER)) throw new Error(`${SOURCE} has no ${PLACEHOLDER} to fill`)
  mkdirSync(dirname(outfile), { recursive: true })
  writeFileSync(outfile, text.replace(PLACEHOLDER, version))
  chmodSync(outfile, 0o755)
}
