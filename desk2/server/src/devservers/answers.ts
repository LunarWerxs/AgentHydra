// Prompt answers (ported from DevWebUI's prompt-answers.ts): expect / send rules typed into a server's stdin when its
// output shows a prompt. A managed server runs on pipes, not a terminal, so a program that reads stdin without checking
// for a terminal (a shell `read`, cmd's `set /p`, Python's input()) would wait forever. Only the server's own rules apply.
//
// Per run: rules go in file order and each fires at most once. Leading rules with no `expect` fire at spawn. On output
// the pending rules are walked in order: a match fires and is consumed; an `optional` rule that does not match is passed
// over; the walk stops at the first required rule that has not matched. A rule with no `expect` further down counts as
// an instant match when the walk reaches it. `once` is accepted and means what every rule already does.

import { stripAnsi } from './ansi'

export interface AnswerRule {
  /** Text (or a regex source with `isRegex`) to wait for in the output. Omit to send without waiting. */
  expect?: string
  /** What to type. Escapes \n \r \t \xHH \uHHHH \\ are decoded; a newline is added unless it ends in one. */
  send: string
  isRegex?: boolean
  optional?: boolean
  once?: boolean
}

const ESCAPE_RE = /\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|([nrt\\]))/g

export function decodeEscapes(text: string): string {
  return text.replace(ESCAPE_RE, (_m, hex, uni, ch) => {
    if (hex) return String.fromCharCode(Number.parseInt(hex, 16))
    if (uni) return String.fromCharCode(Number.parseInt(uni, 16))
    return ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : '\\'
  })
}

/** The bytes a rule types: its decoded `send` plus a newline unless it already ends in one. */
export function answerText(rule: AnswerRule): string {
  const decoded = decodeEscapes(rule.send)
  return /[\r\n]$/.test(decoded) ? decoded : `${decoded}\n`
}

/** The rules a .devwebui entry's `answers` holds, leaving out anything that is not a rule. */
export function readRules(raw: unknown): AnswerRule[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((r): r is AnswerRule => !!r && typeof r === 'object' && typeof (r as AnswerRule).send === 'string' && ((r as AnswerRule).expect === undefined || typeof (r as AnswerRule).expect === 'string'))
}

// Output kept for matching a prompt split across chunks.
const MAX_BUFFER = 4096

interface Armed {
  rule: AnswerRule
  re: RegExp | null
}

function arm(rule: AnswerRule): Armed {
  if (!rule.expect || !rule.isRegex) return { rule, re: null }
  try {
    return { rule, re: new RegExp(rule.expect, 'i') }
  } catch {
    // An invalid pattern can never match: fall back to a literal search rather than throw in the spawn path.
    return { rule: { ...rule, isRegex: false }, re: null }
  }
}

export class PromptAnswerer {
  private pending: Armed[]
  private buffer = ''

  constructor(rules: readonly AnswerRule[] | undefined) {
    this.pending = (rules ?? []).map(arm)
  }

  /** Answers to type the moment the server spawns: the leading rules with no `expect`. */
  start(): AnswerRule[] {
    const fired: AnswerRule[] = []
    while (this.pending.length && !this.pending[0]!.rule.expect) fired.push(this.pending.shift()!.rule)
    return fired
  }

  /** Feeds one chunk of output; answers the rules that fired, in order. */
  feed(chunk: string): AnswerRule[] {
    if (!this.pending.length) return []
    this.buffer = (this.buffer + stripAnsi(chunk)).slice(-MAX_BUFFER)
    const fired: AnswerRule[] = []
    for (let i = 0; i < this.pending.length; ) {
      const armed = this.pending[i]!
      const end = this.matchEnd(armed)
      if (end !== null) {
        fired.push(armed.rule)
        this.pending.splice(i, 1)
        // Output is dropped only up to the end of the answered prompt, so it never satisfies a later rule too.
        this.buffer = this.buffer.slice(end)
        continue
      }
      if (!armed.rule.optional) break
      i++
    }
    return fired
  }

  private matchEnd({ rule, re }: Armed): number | null {
    if (!rule.expect) return 0
    if (re) {
      const m = re.exec(this.buffer)
      return m ? m.index + m[0].length : null
    }
    const at = this.buffer.indexOf(rule.expect)
    return at < 0 ? null : at + rule.expect.length
  }
}
