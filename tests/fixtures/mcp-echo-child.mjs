// A stdio MCP server for tests: answers initialize with its pid, echoes every other request's params with its pid,
// and exits when asked to call the tool "die".
process.stdin.setEncoding('utf8')
let buf = ''
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)
process.stdin.on('data', (chunk) => {
  buf += chunk
  for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.id === undefined) continue
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1', pid: process.pid } } })
    } else if (msg.method === 'tools/call' && msg.params?.name === 'die') {
      process.exit(3)
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: { pid: process.pid, method: msg.method, params: msg.params ?? null } })
    }
  }
})
