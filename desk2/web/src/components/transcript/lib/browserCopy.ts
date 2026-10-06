// The Browser card's "copy the calls": a run of browser calls as plain text, for pasting into a chat or a bug report.
import type { TranscriptItem } from '@shared/protocol'

type ToolItem = Extract<TranscriptItem, { kind: 'tool_use' }>

export const COPY_RESULT_MAX = 2000
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** A result's text without picture data (a base64 run or a data: address is '[image]') and clipped to `max`; one '[image]' per attached picture. */
export function resultText(result: ToolItem['result'], max = COPY_RESULT_MAX): string {
  let text = (result?.text ?? '')
    .replace(/data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+/gi, '[image]')
    .replace(/[A-Za-z0-9+/]{200,}={0,2}/g, '[image]')
    .trim()
  if (text.length > max) text = `${text.slice(0, max)}… (${text.length - max} more characters)`
  const pictures = (result?.images ?? []).map(() => '[image]')
  // A result whose text only stands for its pictures ("[image]") is said once, by the pictures.
  if (pictures.length && /^(\[image\]\s*)+$/.test(text)) text = ''
  return [text, ...pictures].filter(Boolean).join('\n')
}

/** Per call: the tool name (browser_navigate), its params as JSON, then its result; calls are separated by a blank line. */
export function browserCallsText(calls: readonly ToolItem[]): string {
  return calls
    .map((c) => {
      const params = c.input.params && typeof c.input.params === 'object' ? c.input.params : {}
      const lines = [str(c.input.tool_name) || c.name, JSON.stringify(params, null, 2)]
      const result = resultText(c.result)
      lines.push(result ? `Result: ${result}` : c.status === 'running' ? 'Result: (running)' : 'Result: (none)')
      return lines.join('\n')
    })
    .join('\n\n')
}
