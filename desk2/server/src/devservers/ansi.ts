// Colour and cursor escapes a dev server prints; the log pane shows plain text.

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}
