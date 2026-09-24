/** Native-only POC. This command never launches Claude or falls back to UI automation. */
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { connectClaudeInspector } from './inspector-client'
import { type NativeImportRequest, nativeImportProgram } from './native-import'
import { type NativeRequest, nativeProgram } from './native-program'
import { type NativeSettingsRequest, nativeSettingsProgram } from './native-settings'

export type ControlRequest = (
  | NativeRequest
  | (NativeImportRequest & { action: 'import' })
  | (NativeSettingsRequest & { action: 'settings' })
) & { port?: number }

export async function runNativeControl(request: ControlRequest) {
  const started = performance.now()
  // Validate and construct the fixed program before opening a debugger connection.
  const expression =
    request.action === 'import'
      ? nativeImportProgram(request)
      : request.action === 'settings'
        ? nativeSettingsProgram(request)
        : nativeProgram(request)
  let client: Awaited<ReturnType<typeof connectClaudeInspector>> | undefined
  let evaluating = false
  let connectedAt: number | undefined
  try {
    client = await connectClaudeInspector({
      pid: request.pid,
      profile: request.profileDir,
      port: request.port,
      connectTimeoutMs: 2_000,
      callTimeoutMs: 10_000,
    })
    connectedAt = performance.now()
    evaluating = true
    const result = await client.evaluate<Record<string, unknown>>(expression)
    return {
      transport: 'node-inspector',
      identity: client.identity,
      result,
      timingsMs: {
        connect: Math.round(connectedAt - started),
        operation: Math.round(performance.now() - connectedAt),
        total: Math.round(performance.now() - started),
      },
    }
  } catch (error) {
    return {
      transport: 'node-inspector',
      result: {
        ok: false,
        verified: false,
        // A lost response after sending a mutation is not permission to click a title.
        dispatch: evaluating && request.action !== 'inspect' ? 'unknown' : 'not-sent',
        error: error instanceof Error ? error.message : String(error),
      },
      timingsMs: { total: Math.round(performance.now() - started) },
    }
  } finally {
    client?.close()
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { request: { type: 'string' }, output: { type: 'string' } },
    strict: true,
  })
  if (!values.request)
    throw Error('Usage: bun native-control.ts --request <JSON> [--output <JSON>]')
  const request = JSON.parse(readFileSync(values.request, 'utf8')) as ControlRequest
  // Reserve the evidence file BEFORE dispatch, so a filename collision cannot hide a result.
  const output = values.output ? openSync(values.output, 'wx') : undefined
  try {
    const result = await runNativeControl(request)
    const serialized = `${JSON.stringify(result, null, 2)}\n`
    process.stdout.write(serialized)
    if (output !== undefined) writeFileSync(output, serialized)
    if (result.result.ok !== true) process.exitCode = 1
  } finally {
    if (output !== undefined) closeSync(output)
  }
}
