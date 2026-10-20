import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { McpStdio, mountFastctx, OPS_PRESENCE_MARKERS } from '../src/fastctx-bridge.js'

test('FastCtx: spawn failure rejects initialization and clears the transport', async (t) => {
  const client = new McpStdio({ file: join(tmpdir(), `missing-fastctx-${randomUUID()}`), timeoutMs: 1000 })
  t.after(() => client.close())
  await assert.rejects(client.start(), (error) => error.code === 'ENOENT')
  assert.equal(client.isDead, true)
  assert.equal(client.pending.size, 0)
  assert.equal(client.child, undefined)
})

async function bridgeFixture(t, result, callbacks = {}) {
  const originals = Object.fromEntries(['start', 'listTools', 'callTool', 'close'].map((key) => [key, McpStdio.prototype[key]]))
  const definitions = new Map(), listeners = new Map(), cleanups = [], calls = [], instances = []
  McpStdio.prototype.start = async function () { instances.push(this); this.dead = false; return this }
  McpStdio.prototype.listTools = async function () {
    if (callbacks.listTools) return callbacks.listTools(this)
    return [{ name: 'inspect_local_file', inputSchema: { type: 'object', properties: {} } }]
  }
  McpStdio.prototype.callTool = async function (name, args) { calls.push({ name, args }); return result }
  McpStdio.prototype.close = async function () { this.dead = true; callbacks.onClose?.(this) }
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
    Object.assign(McpStdio.prototype, originals)
  })
  const registry = {
    schemas: () => callbacks.faceSchemas ? callbacks.faceSchemas() : [],
    register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) },
  }
  const ctx = { on(name, callback) { listeners.set(name, callback) }, effect(callback) { cleanups.push(callback()) } }
  function createRequireFrom() {
    const req = (name) => name === 'node:path' ? path : name === 'node:fs' ? { existsSync: () => true } : undefined
    req.resolve = () => 'C:/fixture/package.json'
    return req
  }
  mountFastctx(ctx, {
    platform: 'win32', enabled: () => true, createRequireFrom, tools: () => registry,
    msysToWin: (value) => value, echo: (value) => value, log: () => {}, ...callbacks,
  })
  const createAgent = () => listeners.get('agent/created')({ agent: {} })
  createAgent()
  if (callbacks.concurrentCreation) createAgent()
  if (!callbacks.pendingBootstrap) await new Promise(setImmediate)
  const definition = definitions.get(`gb_${callbacks.rawName || 'inspect_local_file'}`)
  if (!callbacks.pendingBootstrap) assert.ok(definition)
  return { definition, definitions, calls, instances, createAgent, dispose: () => Promise.all(cleanups.map((cleanup) => cleanup())) }
}

test('FastCtx: an MCP tool error throws rather than returning success content', async (t) => {
  const { definition } = await bridgeFixture(t, { isError: true, content: [{ type: 'text', text: 'fixture file not found' }] })
  await assert.rejects(definition.execute({ path: '/c/missing.txt' }, { agent: {} }), /gb_inspect_local_file failed: fixture file not found/)
})

test('FastCtx: execution context reaches both dialect callbacks', async (t) => {
  const execution = { agent: { session: { header: { origin: 'subagent' } } } }
  const received = []
  const { definition, calls } = await bridgeFixture(t, { content: [{ type: 'text', text: 'C:/fixture.txt' }] }, {
    msysToWin(value, exec) { received.push(exec); return value === '/c/fixture.txt' ? 'C:/fixture.txt' : value },
    echo(value, exec) { received.push(exec); return value.replace('C:/', '/c/') },
  })
  const value = await definition.execute({ path: '/c/fixture.txt' }, execution)
  assert.deepEqual(calls[0].args, { path: 'C:/fixture.txt' })
  assert.equal(value.content[0].text, '/c/fixture.txt')
  assert.deepEqual(received, [execution, execution])
})

test('FastCtx: concurrent agents share discovery and a lazy connection without orphaning it', async (t) => {
  const fixture = await bridgeFixture(t, { content: [{ type: 'text', text: 'fixture' }] }, { concurrentCreation: true })
  assert.equal(fixture.instances.length, 1, 'discovery is single-flight')
  await Promise.all([
    fixture.definition.execute({}, { agent: { id: 'a' } }),
    fixture.definition.execute({}, { agent: { id: 'b' } }),
  ])
  assert.equal(fixture.instances.length, 2, 'both callers share one lazy connection')
  await fixture.dispose()
  assert.ok(fixture.instances.every((client) => client.isDead))
  await assert.rejects(fixture.definition.execute({}, { agent: {} }), /bridge was stopped/)
})

test('FastCtx: preserves upstream #21 real-array glob patterns through execution', async (t) => {
  const { definition, calls } = await bridgeFixture(t, { content: [{ type: 'text', text: 'fixture' }] }, {
    rawName: 'glob',
    listTools: () => [{ name: 'glob', inputSchema: { type: 'object', properties: {} } }],
  })
  const patterns = ['**/*.txt', '!tests/**']
  await definition.execute({ pattern: patterns }, { agent: {} })
  assert.deepEqual(calls[0].args.pattern, patterns)
  await assert.rejects(definition.execute({ pattern: JSON.stringify(patterns) }, { agent: {} }), /array/i)
  assert.equal(calls.length, 1, 'a stringified array must fail before reaching MCP')
})

test('FastCtx: disposal cancels discovery and prevents late tool registration', async (t) => {
  let rejectDiscovery
  const gate = new Promise((_resolve, reject) => { rejectDiscovery = reject })
  const fixture = await bridgeFixture(t, {}, {
    pendingBootstrap: true,
    listTools: () => gate,
    onClose: () => rejectDiscovery(new Error('fixture discovery stopped')),
  })
  await new Promise(setImmediate)
  await fixture.dispose()
  assert.equal(fixture.definitions.size, 0)
  assert.ok(fixture.instances.every((client) => client.isDead))
  fixture.createAgent()
  await new Promise(setImmediate)
  assert.equal(fixture.instances.length, 1)
})

test('FastCtx: dsh-ops 0.4.0 progressive residents stand the bridge down in face 1', async (t) => {
  // T-Auto/dsh-ops #261: only the reader/result/SDK-loader trio is resident in
  // the first agent face; the classic markers arrive at the next step. Face 1
  // must already read as dsh-ops-owned.
  const { definitions, instances } = await bridgeFixture(t, { content: [] }, {
    pendingBootstrap: true,
    faceSchemas: () => [{ name: 'ops_read_files' }, { name: 'ops_result' }, { name: 'ops_load_sdk' }],
  })
  await new Promise(setImmediate)
  assert.equal(definitions.size, 0, 'the 0.4.0 progressive residents own the surface, so gb_* must not mount')
  assert.equal(instances.length, 0, 'the FastCtx payload must not even start')
})

test('FastCtx: the stand-down marker list covers the classic names and the 0.4.0 residents', () => {
  assert.deepEqual([...OPS_PRESENCE_MARKERS], [
    'ops_inspect_local_file',
    'ops_grep',
    'ops_bash',
    'ops_read_files',
    'ops_result',
    'ops_load_sdk',
  ])
})
