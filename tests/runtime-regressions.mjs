import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { mountInlineTools } from '../src/inline-tools.js'
import { createBashToolModule } from '../src/bash-tool.js'

function inlineFixture({ visible = false, names = ['bash', 'pwsh'], externalDeny = [] } = {}) {
  const listeners = new Map()
  const effects = []
  const masks = new Set([new Set(externalDeny)])
  const agent = { ctx: { tools: { restrict({ deny }) {
    const mask = new Set(deny)
    masks.add(mask)
    return () => masks.delete(mask)
  } } } }
  const registry = { schemas: () => names.filter(name => [...masks].every(mask => !mask.has(name))).map(name => ({ name })) }
  const ctx = {
    on(name, callback) { listeners.set(name, callback) },
    effect(callback) { effects.push(callback()) },
  }
  let enabled = visible
  const logs = []
  mountInlineTools(ctx, {
    tools: () => registry, agents: () => ({ list: () => [agent] }),
    pwshEnabled: () => enabled, log: message => logs.push(message),
    createScope() { throw new Error('an existing bash must not mount an executor') },
  })
  return {
    agent, logs,
    names: () => registry.schemas(agent).map(schema => schema.name),
    set: value => { enabled = value; listeners.get('loader/volatile-update')([['pwshTool']]) },
    gate: () => listeners.get('tools/pre-execute')({ agent, name: 'pwsh' }, () => ({ kind: 'allow' })),
    dispose: async () => { for (const effect of effects.reverse()) await effect() },
  }
}

test('runtime: a live agent follows both pwsh switch directions, including repeated flips', async () => {
  const f = inlineFixture()
  try {
    assert.deepEqual(f.names(), ['bash'])
    assert.equal(f.gate().kind, 'deny')
    f.set(true)
    assert.deepEqual(f.names(), ['bash', 'pwsh'])
    assert.equal(f.gate().kind, 'allow')
    f.set(false)
    assert.deepEqual(f.names(), ['bash'])
    assert.equal(f.gate().kind, 'deny')
    f.set(false)
    f.set(true)
    assert.deepEqual(f.names(), ['bash', 'pwsh'])
    assert.deepEqual(f.logs, [])
  } finally { await f.dispose() }
  assert.deepEqual(f.names(), ['bash', 'pwsh'])
})

test('runtime: pwsh switch/disposal never undo another owner\'s restriction', async () => {
  const f = inlineFixture({ externalDeny: ['pwsh'] })
  try {
    f.set(true)
    assert.deepEqual(f.names(), ['bash'])
    f.set(false)
    assert.deepEqual(f.names(), ['bash'])
  } finally { await f.dispose() }
  assert.deepEqual(f.names(), ['bash'])
})

async function toolFixture(t, { jobs, executor, sandboxModule } = {}) {
  const root = new Context()
  const cleanups = []
  const definitions = new Map()
  class FakeTools extends Service {
    constructor(ctx) { super(ctx, 'tools') }
    register(definition) {
      return this.ctx.effect(() => {
        assert.ok(!definitions.has(definition.name), 'one effective bash registration')
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      })
    }
  }
  for (const [name, value] of Object.entries({
    systemPrompt: { section() {}, getSectionOrder: () => 100 },
    shellEnv: { collect: () => ({ DSH_TEST: 'runtime-regression' }) },
    workingDirectory: { ensure: async () => 'D:/workspace' },
    sandboxPolicy: { resolve: request => ({ mode: request.session?.header.mode ?? 'danger-full-access', workspaceRoot: request.session?.header.cwd ?? 'D:/workspace' }) },
  })) cleanups.push(root.provide(name, value))
  const registryFiber = root.plugin(FakeTools)
  cleanups.push(() => registryFiber.dispose())
  await registryFiber
  let removeJobs
  if (jobs !== undefined) { removeJobs = root.provide('jobs', jobs); cleanups.push(removeJobs) }
  const requests = []
  const fallbackExecutor = {
    sandboxMode: undefined,
    resolve: request => { requests.push(request); return { ...request, workdir: request.workdir ?? 'D:/workspace', timeoutMs: 10 } },
    execute: async spec => ({ result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
      stdout: { text: 'ok', truncated: false }, stderr: { text: '', truncated: false },
      ...(spec.sandboxPolicy ? { sandbox: { mode: spec.sandboxPolicy.mode, denied: false } } : {}),
    }) }),
  }
  const module = createBashToolModule({ executor: executor ?? fallbackExecutor, sandboxModule, log() {} })
  let toolCtx
  const apply = module.apply
  module.apply = (ctx, config) => { toolCtx = ctx; return apply(ctx, config) }
  const fiber = root.plugin(module)
  cleanups.push(() => fiber.dispose())
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup() })
  await fiber
  return { root, fiber, definitions, requests, removeJobs, ctx: toolCtx }
}

function assertJsonSchema(node) {
  assert.equal(typeof node, 'object')
  if (node.required !== undefined) {
    assert.ok(Array.isArray(node.required), 'JSON-schema required is an array, never a spec boolean')
    assert.ok(node.required.every(key => Object.hasOwn(node.properties, key)))
  }
  for (const value of Object.values(node.properties ?? {})) assertJsonSchema(value)
  for (const key of ['oneOf', 'anyOf', 'allOf']) for (const value of node[key] ?? []) assertJsonSchema(value)
  if (node.items !== undefined) assertJsonSchema(node.items)
}

test('runtime: plain fallback recursively compiles required flags without weakening nested outputs', async t => {
  const f = await toolFixture(t)
  const definition = f.definitions.get('bash')
  assertJsonSchema(definition.parameters)
  assertJsonSchema(definition.output.schema)
  assert.deepEqual(definition.parameters.required, ['description', 'command'])
  const foreground = definition.output.schema.oneOf[2]
  assert.ok(foreground.required.includes('stdout'))
  assert.ok(foreground.required.includes('stderr'))
  assert.deepEqual(foreground.properties.stdout.required, ['text', 'truncated'])
  assert.deepEqual(foreground.properties.stderr.required, ['text', 'truncated'])
  assert.deepEqual(foreground.properties.sandbox.required, ['mode', 'denied'])
  assert.deepEqual(foreground.properties.exitCode.oneOf, [{ type: 'integer' }, { type: 'null' }])
  const value = await definition.execute({ command: 'echo ok', description: 'Check fallback result' }, { signal: new AbortController().signal })
  assert.equal(value.kind, 'foreground')
  assert.equal(value.stdout.text, 'ok')
  assert.deepEqual(definition.output.render({}, value), [{ type: 'text', text: 'ok' }])
  await assert.rejects(() => definition.execute({ command: '', description: 'Check invalid command' }, {}), /invalid command/)
})

test('runtime: actual Cordis jobs unload restores foreground bash and reload does not duplicate it', async t => {
  const f = await toolFixture(t, { jobs: {} })
  assert.ok(f.definitions.get('bash').parameters.properties.run_in_background)
  assert.equal(f.ctx.fiber.state, 2)
  await f.removeJobs()
  assert.ok(f.definitions.has('bash'), 'foreground-only bash survives jobs unload')
  assert.equal(f.definitions.get('bash').parameters.properties.run_in_background, undefined)
  const removeAgain = f.root.provide('jobs', {})
  try {
    // Await the injecting child fiber's scheduled activation without an unbounded poll.
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(f.definitions.get('bash').parameters.properties.run_in_background)
  } finally { await removeAgain() }
  assert.equal(f.definitions.size, 1)
  assert.equal(f.definitions.get('bash').parameters.properties.run_in_background, undefined)
})

test('runtime: missing approval helper still passes the agent\'s standing mode and workspace root', async t => {
  const requests = []
  const executor = {
    sandboxMode: 'danger-full-access',
    resolve(request) { requests.push(request); return { ...request, timeoutMs: 10 } },
    async execute(spec) { return { result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 10,
      stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, sandbox: { mode: spec.sandboxPolicy.mode, denied: false },
    }) } },
  }
  const f = await toolFixture(t, { executor })
  const definition = f.definitions.get('bash')
  assert.equal(definition.parameters.properties.sandbox_permissions, undefined)
  const agent = { session: { header: { mode: 'read-only', cwd: 'D:/child-workspace' } } }
  const exec = { agent, signal: new AbortController().signal }
  const value = await definition.execute({ command: 'echo ok', description: 'Keep child standing policy' }, exec)
  assert.deepEqual(requests[0].sandboxPolicy, { mode: 'read-only', workspaceRoot: 'D:/child-workspace' })
  assert.equal(value.sandbox.mode, 'read-only')
  await assert.rejects(() => definition.execute({ command: 'echo ok', description: 'Reject unavailable escalation', sandbox_permissions: 'danger-full-access', justification: 'Need broader mode.' }, exec), /no sandbox helper/)
})

test('runtime: background admission exposes its planned unconfined route before any spawn', async t => {
  const admitted = []
  const executor = {
    sandboxMode: 'danger-full-access',
    resolve: request => ({ ...request, timeoutMs: 10 }),
    gitBashRoute: spec => ({ mode: spec.sandboxPolicy.mode, unconfined: spec.sandboxPolicy.mode !== 'danger-full-access' }),
    execute() { throw new Error('admission fixture must not spawn') },
  }
  const f = await toolFixture(t, { executor, jobs: { start(spec) { admitted.push(spec); return 'admitted-job' } } })
  const definition = f.definitions.get('bash')
  assertJsonSchema(definition.output.schema)
  const schema = definition.output.schema.oneOf[0]
  assert.deepEqual(schema.properties.sandbox.required, ['mode', 'denied'])
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
    const agent = { session: { header: { mode, cwd: 'D:/child-workspace' } } }
    const value = await definition.execute({ command: 'memory-only command', description: 'Verify background planned route', run_in_background: true }, { agent, signal: new AbortController().signal })
    assert.equal(value.kind, 'background')
    assert.equal(value.sandbox.mode, mode)
    const text = definition.output.render({}, value)[0].text
    assert.match(text, /started background job admitted-job/)
    if (mode === 'danger-full-access') assert.doesNotMatch(text, /unconfined/)
    else assert.match(text, /unconfined.*NOT enforced/)
  }
  assert.equal(admitted.length, 3)
})
