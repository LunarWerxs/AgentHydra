// The MCP elicitation form (SPEC "Prompts"): what each input holds while the owner fills it in, and the
// answer it makes. The server checks the answer again against the same fields.

import type { ElicitationField, ElicitationValue } from '@shared/protocol'

/** Per field name: the text of a text, number or choice input, a checkbox's state, a multichoice's picks. */
export type FormState = Record<string, string | boolean | string[]>

export function initialForm(fields: readonly ElicitationField[]): FormState {
  const form: FormState = {}
  for (const f of fields) {
    const d = f.default
    if (f.type === 'boolean') form[f.name] = d === true
    else if (f.type === 'multichoice') form[f.name] = Array.isArray(d) ? [...d] : []
    else form[f.name] = d === undefined || Array.isArray(d) ? '' : String(d)
  }
  return form
}

/** Picks or unpicks one option of a multichoice field. */
export function togglePick(picked: readonly string[], value: string): string[] {
  return picked.includes(value) ? picked.filter((v) => v !== value) : [...picked, value]
}

/** A number typed in plain decimal, as the server takes it ('0x10' and '1e3' are not). */
const DECIMAL = /^[-+]?(\d+\.?\d*|\.\d+)$/

/** Why a filled-in text or number input does not fit its field, in the server's words; null when it fits. */
export function problemOf(f: ElicitationField, text: string): string | null {
  if (f.type === 'number') {
    const n = DECIMAL.test(text.trim()) ? Number(text.trim()) : NaN
    if (!Number.isFinite(n)) return `${f.label} must be a number`
    if (f.integer && !Number.isInteger(n)) return `${f.label} must be a whole number`
    if (f.min !== undefined && n < f.min) return `${f.label} must be at least ${f.min}`
    if (f.max !== undefined && n > f.max) return `${f.label} must be at most ${f.max}`
    return null
  }
  const length = [...text].length
  if (f.minLength !== undefined && length < f.minLength) return `${f.label} must be at least ${f.minLength} characters`
  if (f.maxLength !== undefined && length > f.maxLength) return `${f.label} must be at most ${f.maxLength} characters`
  return null
}

/** The field's limits as a short line under its input ("A whole number, 1 to 10"); null when it has none. */
export function limitHint(f: ElicitationField): string | null {
  const parts: string[] = []
  if (f.type === 'number') {
    if (f.integer) parts.push('a whole number')
    const span = range(f.min, f.max, '')
    if (span) parts.push(span)
  } else if (f.type === 'text') {
    const span = range(f.minLength, f.maxLength, ' characters')
    if (span) parts.push(span)
  }
  const line = parts.join(', ')
  return line ? line[0]!.toUpperCase() + line.slice(1) : null
}

function range(lo: number | undefined, hi: number | undefined, unit: string): string | null {
  if (lo !== undefined && hi !== undefined) return `${lo} to ${hi}${unit}`
  if (lo !== undefined) return `at least ${lo}${unit}`
  if (hi !== undefined) return `at most ${hi}${unit}`
  return null
}

/** A choice with more options than this is a dropdown, not a column of buttons. */
export const LONG_CHOICE = 8

/** The page a url-mode request opens, when it is a web page: its host is what the owner must see. */
export function linkOf(url: string | undefined): { href: string; host: string; insecure: boolean } | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return { href: u.href, host: u.host, insecure: u.protocol === 'http:' }
  } catch {
    return null
  }
}

export interface FormAnswer {
  values: Record<string, ElicitationValue>
  /** Labels of required fields left empty. */
  missing: string[]
  /** What is wrong with each filled-in field that cannot be sent, one sentence each. */
  invalid: string[]
}

/** The values to send: empty inputs left out, numbers as numbers; Submit waits until nothing is missing or invalid. */
export function formAnswer(fields: readonly ElicitationField[], form: FormState): FormAnswer {
  const out: FormAnswer = { values: {}, missing: [], invalid: [] }
  for (const f of fields) {
    const v = form[f.name]
    let value: ElicitationValue | undefined
    if (f.type === 'boolean') value = v === true
    else if (Array.isArray(v)) value = v.length ? v : undefined
    else if (typeof v === 'string' && v.trim()) {
      const problem = f.type === 'number' || f.type === 'text' ? problemOf(f, v) : null
      if (problem) {
        out.invalid.push(problem)
        continue
      }
      value = f.type === 'number' ? Number(v.trim()) : v
    }
    if (value !== undefined) out.values[f.name] = value
    else if (f.required) out.missing.push(f.label)
  }
  return out
}
