// What the SDK asks the user, as transcript items (SPEC "Prompts"). Pure: the line each "Always allow"
// suggestion would save, an MCP elicitation as an item (its requested JSON schema flattened into form
// fields), and the window's answer to that form checked and coerced before it goes back to the server.

import type { ElicitationRequest, PermissionMode as SdkPermissionMode, PermissionUpdate, PermissionUpdateDestination } from '@anthropic-ai/claude-agent-sdk'
import { join } from 'node:path'
import type { ElicitationField, ElicitationValue, ImageRef, TranscriptItem } from '@shared/protocol'
import { MEDIA_ROUTE, type MediaCache } from '../media/cache'

/**
 * The answers of a question with its pictures saved into the media cache: each adds a line
 * `[Image: source: <absolute path>]` to its answer (the form Claude Code uses, so the model opens it with
 * Read). The bytes never go into the text. A picture that is not a PNG, JPEG, GIF or WebP is refused.
 */
export function answersWithPictures(answers: Record<string, string>, images: Record<string, ImageRef[]> | undefined, media: MediaCache | null): Record<string, string> {
  if (!images) return answers
  const out = { ...answers }
  for (const [question, list] of Object.entries(images)) {
    if (!(question in out)) continue
    const lines: string[] = []
    for (const img of list) {
      const ref = img.dataBase64 ? media?.putBase64(img.dataBase64, img.name) : null
      if (!ref?.url) throw new QuestionPictureError(`${img.name ?? 'A picture'} cannot be saved: a picture must be a PNG, JPEG, GIF or WebP`)
      lines.push(`[Image: source: ${join(media!.dir, ref.url.slice(MEDIA_ROUTE.length))}]`)
    }
    if (lines.length) out[question] = [out[question], ...lines].filter(Boolean).join('\n')
  }
  return out
}

/** A picture in an answer that cannot be saved: the answer is refused and the question stays open. */
export class QuestionPictureError extends Error {}

export type ElicitationItem = Extract<TranscriptItem, { kind: 'elicitation' }>

/** An answer the form's fields refuse: the route answers 400 with the reason and the request stays open. */
export class ElicitationAnswerError extends Error {}

const WHERE: Record<PermissionUpdateDestination, string> = {
  userSettings: 'in your user settings',
  projectSettings: 'in this project, shared',
  localSettings: 'in this project',
  session: 'for this session',
  cliArg: 'for this session',
}

const MODE_LABEL: Record<SdkPermissionMode, string> = {
  default: 'Manual',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  bypassPermissions: 'Bypass',
  dontAsk: "Don't ask",
  auto: 'Auto',
}

/** One suggestion as the card shows it under "Always allow": the rule and where it is kept. */
export function ruleLine(s: PermissionUpdate): string {
  const where = WHERE[s.destination] ?? s.destination
  switch (s.type) {
    case 'addRules':
    case 'replaceRules': {
      const rules = s.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(', ')
      return `${s.behavior === 'allow' ? '' : `${s.behavior === 'deny' ? 'Deny' : 'Ask'} `}${rules} ${where}`
    }
    case 'removeRules':
      return `Remove ${s.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(', ')} ${where}`
    case 'setMode':
      return `${MODE_LABEL[s.mode] ?? s.mode} mode ${where}`
    case 'addDirectories':
      return `Access to ${s.directories.join(', ')} ${where}`
    case 'removeDirectories':
      return `No access to ${s.directories.join(', ')} ${where}`
  }
}

/** The pending item for an MCP server's elicitation. A url other than http(s) is dropped: the window never links it. */
export function elicitationItem(id: string, ts: number, request: ElicitationRequest): ElicitationItem {
  const mode = request.mode === 'url' ? 'url' : 'form'
  const item: ElicitationItem = { kind: 'elicitation', id, ts, serverName: request.serverName, message: request.message, mode, state: 'pending' }
  const title = str(request.title)
  const description = str(request.description)
  if (title) item.title = title
  if (description) item.description = description
  if (mode === 'url') {
    if (request.url && isWebUrl(request.url)) item.url = request.url
  } else item.fields = fieldsFromSchema(request.requestedSchema)
  return item
}

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** A number typed in plain decimal ('0x10' and '1e3' are not, though Number() takes both). */
const DECIMAL = /^[-+]?(\d+\.?\d*|\.\d+)$/

/**
 * The requested schema's properties as form fields, in the schema's order: string -> text, number and
 * integer -> number, boolean, enum / oneOf -> choice, an array of enum -> multichoice; anything else is a
 * text field. Titles, descriptions, defaults, the required list and the limits an answer must keep
 * (integer, minimum / maximum, minLength / maxLength) are kept.
 */
export function fieldsFromSchema(schema: Json | undefined): ElicitationField[] {
  const props = schema && isObject(schema.properties) ? schema.properties : {}
  const required = new Set(schema && Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === 'string') : [])
  return Object.entries(props).map(([name, raw]) => fieldFrom(name, isObject(raw) ? raw : {}, required.has(name)))
}

function fieldFrom(name: string, s: Json, required: boolean): ElicitationField {
  const field: ElicitationField = { name, label: str(s.title) ?? name, type: 'text', required }
  const description = str(s.description)
  if (description) field.description = description
  const choices = choicesOf(s)
  const itemChoices = s.type === 'array' && isObject(s.items) ? choicesOf(s.items) : null
  if (choices) {
    field.type = 'choice'
    field.options = choices.options
    if (choices.numeric) field.numeric = true
  } else if (itemChoices) {
    field.type = 'multichoice'
    field.options = itemChoices.options
  } else if (s.type === 'number' || s.type === 'integer') {
    field.type = 'number'
    if (s.type === 'integer') field.integer = true
    const [min, max] = [num(s.minimum), num(s.maximum)]
    if (min !== undefined) field.min = min
    if (max !== undefined) field.max = max
  } else if (s.type === 'boolean') field.type = 'boolean'
  else {
    const [minLength, maxLength] = [num(s.minLength), num(s.maxLength)]
    if (minLength !== undefined) field.minLength = minLength
    if (maxLength !== undefined) field.maxLength = maxLength
  }
  if (s.default !== undefined) {
    try {
      const value = coerce(field, s.default)
      if (value !== undefined) field.default = value
    } catch {
      // a default the field cannot hold is not offered
    }
  }
  return field
}

/**
 * enum (labels from enumNames when given) or oneOf / anyOf of { const, title }; null when neither. The
 * options hold the values as text; numeric says they were all numbers, so the answer goes back as one.
 */
function choicesOf(s: Json): { options: { value: string; label: string }[]; numeric: boolean } | null {
  let values: unknown[]
  let labels: unknown[]
  if (Array.isArray(s.enum)) {
    values = s.enum
    labels = Array.isArray(s.enumNames) ? s.enumNames : []
  } else {
    const list = Array.isArray(s.oneOf) ? s.oneOf : Array.isArray(s.anyOf) ? s.anyOf : null
    if (!list || !list.every((o) => isObject(o) && o.const !== undefined)) return null
    values = (list as Json[]).map((o) => o.const)
    labels = (list as Json[]).map((o) => o.title)
  }
  const options = values.map((v, i) => ({ value: String(v), label: str(labels[i]) ?? String(v) }))
  return { options, numeric: values.length > 0 && values.every((v) => typeof v === 'number') }
}

/**
 * The values to send back: each field's value coerced to its type ("3" -> 3, "true" -> true), fields the
 * form does not have dropped, a required one missing or a value the field cannot hold refused.
 */
export function checkAnswer(fields: ElicitationField[], values: Record<string, unknown> | undefined): Record<string, ElicitationValue> {
  const out: Record<string, ElicitationValue> = {}
  for (const f of fields) {
    const value = coerce(f, values?.[f.name])
    if (value !== undefined) out[f.name] = value
    else if (f.required) throw new ElicitationAnswerError(`${f.label} is required`)
  }
  return out
}

/** undefined = no value (absent, null, blank text, nothing picked). */
function coerce(f: ElicitationField, v: unknown): ElicitationValue | undefined {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0)) return undefined
  const allowed = new Set(f.options?.map((o) => o.value))
  switch (f.type) {
    case 'text':
      return coerceText(f, v)
    case 'number':
      return coerceNumber(f, v)
    case 'boolean':
      if (typeof v === 'boolean') return v
      if (v === 'true' || v === 'false') return v === 'true'
      throw new ElicitationAnswerError(`${f.label} must be true or false`)
    case 'choice': {
      const s = typeof v === 'string' || typeof v === 'number' ? String(v) : null
      if (s === null || !allowed.has(s)) throw new ElicitationAnswerError(`${f.label} must be one of ${[...allowed].join(', ')}`)
      return f.numeric ? Number(s) : s
    }
    case 'multichoice':
      return coerceMulti(f, v, allowed)
  }
}

function coerceText(f: ElicitationField, v: unknown): string {
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new ElicitationAnswerError(`${f.label} must be text`)
  const s = String(v)
  // Counted as JSON Schema counts: in characters, not UTF-16 units.
  const length = [...s].length
  if (f.minLength !== undefined && length < f.minLength) throw new ElicitationAnswerError(`${f.label} must be at least ${f.minLength} characters`)
  if (f.maxLength !== undefined && length > f.maxLength) throw new ElicitationAnswerError(`${f.label} must be at most ${f.maxLength} characters`)
  return s
}

function coerceNumber(f: ElicitationField, v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && DECIMAL.test(v.trim()) ? Number(v.trim()) : NaN
  if (!Number.isFinite(n)) throw new ElicitationAnswerError(`${f.label} must be a number`)
  if (f.integer && !Number.isInteger(n)) throw new ElicitationAnswerError(`${f.label} must be a whole number`)
  if (f.min !== undefined && n < f.min) throw new ElicitationAnswerError(`${f.label} must be at least ${f.min}`)
  if (f.max !== undefined && n > f.max) throw new ElicitationAnswerError(`${f.label} must be at most ${f.max}`)
  return n
}

function coerceMulti(f: ElicitationField, v: unknown, allowed: Set<string>): string[] {
  const list = Array.isArray(v) ? v : [v]
  const picked = list.map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : null))
  if (picked.some((x) => x === null || !allowed.has(x))) throw new ElicitationAnswerError(`${f.label} takes only ${[...allowed].join(', ')}`)
  return [...new Set(picked as string[])]
}
