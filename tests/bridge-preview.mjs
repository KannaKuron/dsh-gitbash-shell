import test from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { McpStdio, mountFastctx } from '../src/fastctx-bridge.js'

test('preview: MCP failures retain isError through the actual host ToolRuntime', async (t) => {
  const root = new Context()
  const fibers = []
  const originals = Object.fromEntries(['start', 'listTools', 'callTool', 'close'].map((key) => [key, McpStdio.prototype[key]]))
  t.after(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    Object.assign(McpStdio.prototype, originals)
  })
  for (const module of [SystemPrompt, ToolRuntime]) {
    const fiber = root.plugin(module)
    fibers.push(fiber)
    await fiber
  }
  McpStdio.prototype.start = async function () { this.dead = false; return this }
  McpStdio.prototype.listTools = async function () {
    return [{ name: 'inspect_local_file', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }]
  }
  McpStdio.prototype.callTool = async () => ({ isError: true, content: [{ type: 'text', text: 'fixture file not found' }] })
  McpStdio.prototype.close = async function () { this.dead = true }
  function createRequireFrom() {
    const req = (name) => name === 'node:path' ? path : name === 'node:fs' ? { existsSync: () => true } : undefined
    req.resolve = () => 'C:/fixture/package.json'
    return req
  }
  const patch = root.plugin((ctx) => mountFastctx(ctx, {
    platform: 'win32', enabled: () => true, createRequireFrom, tools: (owner) => owner.get('tools'),
    msysToWin: (value) => value, echo: (value) => value, log: () => {},
  }))
  fibers.push(patch)
  await patch
  const agent = { ctx: root, session: { header: {} } }
  root.emit('agent/created', { agent })
  await new Promise(setImmediate)
  const tools = root.get('tools')
  assert.ok(tools.schemas(agent).some((schema) => schema.name === 'gb_inspect_local_file'))
  const result = await tools.execute({ agent, name: 'gb_inspect_local_file', callId: 'preview-mcp-error', arguments: {}, signal: new AbortController().signal })
  assert.equal(result.isError, true)
  assert.match(result.error.message, /gb_inspect_local_file failed: fixture file not found/)
  assert.match(result.content[0].text, /fixture file not found/)
})
