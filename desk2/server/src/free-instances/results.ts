import type { FreeCommand, FreeMessage, FreeResult, FreeUsage } from '@shared/free-instances'
import type { RunOutput } from './runner'

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const str = (value: unknown, max = 1_000_000): string => typeof value === 'string' ? value.slice(0, max) : ''
const percent = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null

export function failure(code: string, message: string, chatId?: string): FreeResult {
  return { ok: false, error: { code, message, ...(chatId ? { chat_id: chatId } : {}) } }
}

function message(value: unknown): FreeMessage {
  const m = object(value)
  return {
    id: str(m.id, 100), role: str(m.role, 30), text: str(m.text),
    code_blocks: list(m.code_blocks).map(item => { const b = object(item); return { language: str(b.language, 40), code: str(b.code) } }),
    citations: list(m.citations).flatMap(item => {
      const c = object(item)
      try {
        const url = new URL(str(c.url, 4096))
        return ['http:', 'https:'].includes(url.protocol) ? [{ title: str(c.title, 500) || url.hostname, url: url.href }] : []
      } catch { return [] }
    }),
  }
}

/** Only the public fields needed by Desk cross this boundary; raw auth/network data never do. */
export function parseResult(command: FreeCommand, output: RunOutput): FreeResult {
  let r: Record<string, unknown>
  try { r = object(JSON.parse(output.stdout)) }
  catch { return failure('harness_failed', 'The harness did not return a result. Check the saved login and read the chat before sending again.') }
  if (r.ok !== true || output.code !== 0) {
    const e = object(r.error)
    return failure(str(e.code, 100) || 'harness_failed', str(e.message, 2000) || 'The operation failed. Read the chat before sending again.', str(e.chat_id, 100) || undefined)
  }
  if (command === 'auth' || command === 'login') return { ok: true, authenticated: r.authenticated === true, account_label: str(r.account_label, 100).trim() || null }
  if (command === 'chats') return { ok: true, chats: list(r.chats).map(item => {
    const c = object(item)
    return { chat_id: str(c.chat_id, 100), name: str(c.name, 200) || null, is_temporary: c.is_temporary === true ? true : c.is_temporary === false ? false : null,
      status: str(c.status, 100), created_at: str(c.created_at, 100), updated_at: str(c.updated_at, 100), server_conversation_id: str(c.server_conversation_id, 100) || undefined }
  }).filter(c => c.is_temporary !== false) }
  if (command === 'usage') {
    const usage: FreeUsage = { available: r.available === true, unlimited_text: r.available === true && r.unlimited_text === true,
      text_model: str(r.text_model, 100) || undefined, plan: str(r.plan, 20).trim() || null, is_snapshot: r.is_snapshot === true,
      observed_at: str(r.observed_at, 100) || null, note: str(r.note, 2000),
      windows: list(r.windows).map(item => { const w = object(item); return { id: str(w.id, 100), used_percent: percent(w.used_percent), remaining_percent: percent(w.remaining_percent), resets_at: str(w.resets_at, 100) || null, reset_passed: w.reset_passed === true } }) }
    return { ok: true, usage }
  }
  const chatId = str(r.chat_id, 100)
  if (r.is_temporary !== true) return failure('privacy_mismatch', 'This chat is not confirmed as private. Free instances only use Incognito or Temporary Chats.', chatId)
  const messages = Array.isArray(r.messages) ? r.messages.map(message) : undefined
  const response = typeof r.response === 'string' ? str(r.response) : undefined
  return {
    ok: true, chat_id: chatId, chat_name: str(r.chat_name, 200) || null, is_temporary: true, model: str(r.model, 100) || undefined,
    server_conversation_id: str(r.server_conversation_id, 100) || undefined,
    response, messages: messages ?? (response !== undefined ? [message({ ...r, text: response, role: 'assistant' })] : undefined),
    incomplete: r.incomplete === true || r.truncated === true,
    warnings: list(r.warnings).map(w => str(typeof w === 'string' ? w : object(w).message, 2000)).filter(Boolean),
  }
}
