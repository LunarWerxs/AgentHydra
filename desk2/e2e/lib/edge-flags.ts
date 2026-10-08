// What every headless Edge an e2e starts is told besides its own switches: a fresh profile stays a stranger. On
// 2026-10-08 one signed itself into the PC's account, synced a browser extension, and that extension opened a
// claude.ai sign-in tab in front of the page under test; a hidden page gets no animation frames, so the scroll
// check waited on one for twelve minutes.
export const QUIET_EDGE = ['--disable-sync', '--disable-extensions', '--disable-component-extensions-with-background-pages', '--no-default-browser-check']
