// The instant parity renders are frozen at. Importing it only reads it: the freeze itself is in
// freeze-clock.ts, which ParityPage alone loads, because the Gallery reaches these fixtures from the real
// window's bundle too, where a frozen Date.now made every elapsed counter read 0s.
export const PARITY_NOW = Date.UTC(2026, 9, 3, 17, 0, 0)
