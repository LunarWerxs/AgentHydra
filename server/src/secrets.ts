// server/src/secrets.ts — the high-confidence secret patterns, in one place.
//
// These were written for the ChatGPT context pack (server/src/context-pack.ts), which uses them to
// DECIDE NOT TO SEND a file. Transcripts need the same judgement for the same reason — an exported
// session is something you hand to a person, and a session that once printed an API key still has
// it in the file — so the patterns live here and both callers share them. One list, one place to
// add to when a provider invents a new key format.
//
// WHAT THIS IS AND IS NOT. It is a guardrail, not a guarantee, and the context pack already says so
// in exactly those words. It matches formats that are unmistakable — a PEM header, an AWS access
// key id, provider tokens with fixed prefixes — and it will not find a password someone typed as
// prose, a key in a format nobody has published, or a secret split across two lines. High
// confidence is the deliberate trade: a scan that flagged every 32-character string would be
// ignored within a day, and an export that redacted a third of its own content would be useless.
//
// REDACTION KEEPS THE SHAPE, NOT THE VALUE. A hit becomes `sk-…[redacted 51 chars]`, so a reader
// can still tell WHICH key was in the transcript and match it against the one they need to rotate,
// without the export carrying the thing itself. Showing nothing would make the export honest and
// unusable; showing a prefix is what makes it actionable.

/** One recognisable secret format. `kind` is what the UI names it; it is never a guess. */
interface SecretPattern {
  kind: string
  /** Global, because a single message can carry several. Cloned per scan — see scanSecrets. */
  source: RegExp
  /** How much of a match may stay visible. Enough to identify, never enough to use. */
  keep: number
}

const PATTERNS: readonly SecretPattern[] = [
  { kind: 'private-key', source: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, keep: 0 },
  { kind: 'aws-access-key-id', source: /\bAKIA[0-9A-Z]{16}\b/g, keep: 4 },
  { kind: 'api-token', source: /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/g, keep: 3 },
  { kind: 'github-token', source: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, keep: 4 },
]

/** True when the text carries any of the formats above. The context pack's own gate. */
export function containsHighConfidenceSecret(text: string): boolean {
  // `test` on a /g regex advances lastIndex, so each call gets its own instance rather than a
  // shared one that would skip every other match.
  return PATTERNS.some((p) => new RegExp(p.source.source, 'g').test(text))
}

export interface SecretHit {
  kind: string
  /** The match with its tail replaced: identifies the key without carrying it. */
  redacted: string
  /** Where it was found, as an index into whatever unit the caller scanned. */
  at: number
}

function redact(kind: string, match: string, keep: number): string {
  if (keep === 0) return `[redacted ${kind}]`
  const head = match.slice(0, Math.min(keep, match.length))
  return `${head}…[redacted ${match.length - head.length} chars]`
}

/** Every recognisable secret in one string, redacted. Order follows position in the text. */
export function scanSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = []
  for (const p of PATTERNS) {
    const re = new RegExp(p.source.source, 'g')
    let m = re.exec(text)
    while (m) {
      hits.push({ kind: p.kind, redacted: redact(p.kind, m[0], p.keep), at: m.index })
      // A zero-length match cannot happen with these patterns, but a future one could, and the
      // loop must not spin on it.
      if (m.index === re.lastIndex) re.lastIndex++
      m = re.exec(text)
    }
  }
  return hits.sort((a, b) => a.at - b.at)
}

/**
 * Replace every recognisable secret in a string with its redacted form.
 *
 * Used by the transcript export, where dropping the surrounding message would lose the reason the
 * export exists. The context pack takes the other route and omits the whole file, which is right
 * for a file whose entire purpose might be to hold a key.
 */
export function redactSecrets(text: string): { text: string; redacted: number } {
  let out = text
  let count = 0
  for (const p of PATTERNS) {
    out = out.replace(new RegExp(p.source.source, 'g'), (match) => {
      count++
      return redact(p.kind, match, p.keep)
    })
  }
  return { text: out, redacted: count }
}
