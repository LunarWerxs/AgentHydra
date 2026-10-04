import { hostname } from 'node:os'

/** This machine's id, the way HSwarm names it (hswarm/vault.py machine_name). */
export function machineId(): string {
  return (
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63)
      .replace(/-+$/, '') || 'machine'
  )
}
