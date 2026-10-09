// Runs one browser tool by name. The tools themselves are in registry.ts; none of them launches a Chrome.

import { TOOL_DEFS, ToolInputError } from './registry'
import type { CallResult, ToolCaller, ToolInfo } from './contract'
import { etsyRefusal, etsyWebsiteHostIn } from './etsy'
import { observeProfile } from '../observations'

export function toolInfos(): ToolInfo[] {
  return TOOL_DEFS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
}

export async function callTool(name: string, params: Record<string, unknown> = {}, caller: ToolCaller = {}): Promise<CallResult> {
  const def = TOOL_DEFS.find((d) => d.name === name)
  if (!def) return { ok: false, status: 404, error: `no browser tool named ${name}` }
  const etsy = etsyWebsiteHostIn(params)
  if (etsy) return { ok: false, status: 403, error: etsyRefusal(etsy) }
  try {
    const reply = await def.run(params, caller)
    if (typeof params.profile === 'string') await observeProfile(params.profile, caller.cwd, reply)
    return typeof reply === 'string' ? { ok: true, text: reply } : { ok: true, ...reply }
  } catch (err) {
    if (err instanceof ToolInputError) return { ok: false, status: 400, error: err.message }
    return { ok: false, status: 500, error: err instanceof Error ? err.message : String(err) }
  }
}
