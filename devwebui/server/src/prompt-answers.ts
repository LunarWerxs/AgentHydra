// Prompt answers: user-written expect/send rules that reply to a managed process's
// interactive prompts on its stdin. WHY: managed children run on pipes, not a TTY, so
// a program that still reads stdin without a TTY check (a shell `read`, cmd's
// `set /p`, Python's input(), a custom setup script) would otherwise wait forever
// with nobody at a terminal to type the answer. Tools that check for a TTY (npx,
// most CLI prompt libraries) skip their prompts on a pipe, so there is deliberately
// no built-in table of "common prompts": only the process's own rules apply.
//
// The idea (an ordered rule list watched against session output) follows the
// login-script processor in Eugeny/tabby (MIT); this is a fresh implementation.
//
// Semantics, per spawn of a process:
//   - Rules run in file order. A rule fires at most once, then is consumed.
//   - Leading rules with no `expect` fire as soon as the process spawns, before
//     any output is seen.
//   - On output, the pending rules are walked in order: a match fires and is
//     consumed; an `optional` rule that does not match is passed over (it stays
//     armed); the walk stops at the first required rule that has not matched.
//   - A rule with no `expect` further down the chain counts as an instant match
//     when the walk reaches it: it is sent right after the rule before it fires,
//     or, when only optional rules stand before it, on the first output.
// Pure and I/O-free: the caller feeds output text in and writes what comes back.
import { stripAnsi } from "./errors";

export interface AnswerRule {
  /** Text (or a regex source when `isRegex`) to wait for in the output. Omit to send without waiting. */
  expect?: string;
  /** What to type. Escapes \n \r \t \xHH \uHHHH \\ are decoded; a newline is added unless it ends in one. */
  send: string;
  isRegex?: boolean;
  /** An optional rule that has not matched does not hold back the rules after it. */
  optional?: boolean;
}

const ESCAPE_RE = /\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|([nrt\\]))/g;

/** Decode the escapes a JSON author cannot type literally into a control character. */
export function decodeEscapes(text: string): string {
  return text.replace(ESCAPE_RE, (_m, hex, uni, ch) => {
    if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
    if (uni) return String.fromCharCode(Number.parseInt(uni, 16));
    return ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : "\\";
  });
}

/** The bytes a rule types: its decoded `send` plus a newline unless it already ends in one. */
export function answerText(rule: AnswerRule): string {
  const decoded = decodeEscapes(rule.send);
  return /[\r\n]$/.test(decoded) ? decoded : `${decoded}\n`;
}

// Output kept for matching a prompt split across chunks; a prompt is one short line or two.
const MAX_BUFFER = 4096;

interface Armed {
  rule: AnswerRule;
  re: RegExp | null;
}

function arm(rule: AnswerRule): Armed {
  if (!rule.expect || !rule.isRegex) return { rule, re: null };
  try {
    return { rule, re: new RegExp(rule.expect, "i") };
  } catch {
    // An invalid pattern can never match; fall back to a literal search so the rule
    // still means something rather than throwing inside the spawn path.
    return { rule: { ...rule, isRegex: false }, re: null };
  }
}

export class PromptAnswerer {
  private pending: Armed[];
  private buffer = "";

  constructor(rules: readonly AnswerRule[] | undefined) {
    this.pending = (rules ?? []).map(arm);
  }

  /** The rules still waiting to fire (for tests and diagnostics). */
  get remaining(): number {
    return this.pending.length;
  }

  /** Answers to type the moment the process spawns: the leading rules with no `expect`. */
  start(): AnswerRule[] {
    const fired: AnswerRule[] = [];
    while (this.pending.length && !this.pending[0].rule.expect)
      fired.push((this.pending.shift() as Armed).rule);
    return fired;
  }

  /** Feed one chunk of process output; returns the rules that fired, in order. */
  feed(chunk: string): AnswerRule[] {
    if (!this.pending.length) return [];
    this.buffer = (this.buffer + stripAnsi(chunk)).slice(-MAX_BUFFER);
    const fired: AnswerRule[] = [];
    for (let i = 0; i < this.pending.length; ) {
      const armed = this.pending[i];
      const end = this.matchEnd(armed);
      if (end !== null) {
        fired.push(armed.rule);
        this.pending.splice(i, 1);
        // Drop output only up to the end of the answered prompt: it must never satisfy a
        // later rule too, but a second prompt in the same chunk still has to be seen.
        this.buffer = this.buffer.slice(end);
        continue;
      }
      if (!armed.rule.optional) break;
      i++;
    }
    return fired;
  }

  /** Where the rule's prompt ends in the buffer (0 for a rule with no `expect`), or null. */
  private matchEnd({ rule, re }: Armed): number | null {
    if (!rule.expect) return 0;
    if (re) {
      const m = re.exec(this.buffer);
      return m ? m.index + m[0].length : null;
    }
    const at = this.buffer.indexOf(rule.expect);
    return at < 0 ? null : at + rule.expect.length;
  }
}
