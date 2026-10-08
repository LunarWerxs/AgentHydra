// A port nothing listens on right now, from the OS (bind to port 0, read it, let go). Two e2e runs from two sessions
// at once each get their own, where a fixed default collided ("port 7819 is already in use", 2026-10-07).

export function freePort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const { port } = probe
  probe.stop(true)
  return port
}

/** E2E_PORT-style override when set, else a free port. */
export function portFrom(value: string | undefined): number {
  return Number(value) || freePort()
}
