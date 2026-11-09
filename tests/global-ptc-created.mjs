/**
 * Global PTC first-step Bash race (regression guard for the 0.51.0 fix).
 *
 * THE HOST CONTRACT. `ctx.agents.create()` announces a new agent through the
 * SERIAL `agent/created` event: `@deepseek-ai/dsh-agent`'s `announce()` does
 * `await this.ctx.serial(entry.carrier, 'agent/created', …)`, so a listener
 * that RETURNS its promise makes agent creation itself wait. The global PTC
 * executor resolves its SDK tool set immediately after creation; while the
 * own-Git-Bash registration was in flight that first admission had no `bash`
 * and the tool appeared one step later (step 1 missing, step 2 present).
 *
 * WHAT IS REAL HERE. `mountInlineTools`, the real per-agent `reconcile`, the
 * real `startBash`/`provideBash` chain, the real `createBashToolModule` from
 * src/bash-tool.js, the real tools-registry read-back (`schemas(agent)`) and
 * the real `agent/disposed` teardown. THE ONLY STUB is the private executor
 * import (`./shell.js`, whose base class is `@deepseek-ai/dsh-bash-sandbox`):
 * that host peer is not installed in a unit-test checkout, so it is redirected
 * to a tiny data-URL module and the fake executor scope models an executor
 * mount that takes a few milliseconds — exactly the real cost that used to
 * lose the race. No production profile, no model request, no filesystem write.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const SHELL_STUB_URL = `data:text/javascript,${encodeURIComponent(
  'export class GitBashSandboxExecutor { static Config = {} }',
)}`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './shell.js' && typeof context.parentURL === 'string'
      && context.parentURL.endsWith('/src/inline-tools.js')) {
      return { url: SHELL_STUB_URL, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const resolvedThenable = () => ({
  then(resolve, reject) { return Promise.resolve().then(resolve, reject) },
})

/** Base host face before this plugin acts: the official win32 composition. */
const BASE_FACE = ['pwsh', 'read', 'edit']

function createRegistry() {
  const masks = new WeakMap()
  const registrations = new Map()
  const calls = new Map()
  return {
    restrict(agent, deny) {
      const mask = masks.get(agent) ?? new Set()
      for (const name of deny) mask.add(name)
      masks.set(agent, mask)
      return () => { for (const name of deny) mask.delete(name) }
    },
    register(agent, definition) {
      const name = definition?.name
      const list = registrations.get(agent) ?? []
      const entry = { name }
      list.push(entry)
      registrations.set(agent, list)
      const seen = calls.get(agent) ?? []
      seen.push(name)
      calls.set(agent, seen)
      let live = true
      return () => {
        if (!live) return
        live = false
        const index = list.indexOf(entry)
        if (index >= 0) list.splice(index, 1)
      }
    },
    schemas(agent) {
      const mask = masks.get(agent) ?? new Set()
      const names = [...BASE_FACE, ...(registrations.get(agent) ?? []).map((entry) => entry.name)]
      return [...new Set(names)].filter((name) => !mask.has(name)).map((name) => ({ name }))
    },
    registerCalls(agent, name) {
      return (calls.get(agent) ?? []).filter((entry) => entry === name).length
    },
    activeCount() {
      let total = 0
      for (const list of registrations.values()) total += list.length
      return total
    },
  }
}

/**
 * A faithful "serial" emission: DSH's `ctx.serial` awaits each listener in
 * order, so a listener that returns its promise delays the caller.
 */
function createFixture({ mountDelayMs = 50 } = {}) {
  const listeners = new Map()
  const effects = []
  const logs = []
  const registry = createRegistry()
  const agentByCtx = new WeakMap()
  const scopesByAgent = new WeakMap()
  const executorScopes = []
  const hostModules = {
    '@deepseek-ai/dsh-tools': { defineTool: (options) => ({ ...options }) },
    '@deepseek-ai/dsh-sandbox': {},
    '@deepseek-ai/dsh-llm': {},
  }
  const rootCtx = {
    baseUrl: 'file:///fixture/',
    on(name, callback) {
      const list = listeners.get(name) ?? []
      list.push(callback)
      listeners.set(name, list)
      return () => {}
    },
    effect(callback) { effects.push(callback()) },
    isolate(name) { return { isolated: name } },
    loader: { internal: { async import(name) { return hostModules[name] ?? {} } } },
  }

  const createScope = (parent) => {
    if (parent?.isolated === 'shell') {
      let instance
      const scope = {
        disposed: 0,
        // Models the real executor-mount cost (module import + class plugin
        // mount) that the created-time race used to hide behind.
        fiber: new Promise((resolve) => setTimeout(resolve, mountDelayMs)),
        ctx: {
          loader: { internal: { async import() { return {} } } },
          plugin() {
            instance = {
              bashPath: 'C:/fixture/Git/bin/bash.exe',
              sandboxMode: undefined,
              resolve: (request) => request,
              execute: async () => { throw new Error('fixture executor must not execute') },
            }
            return resolvedThenable()
          },
          get(name) { return name === 'shell' ? instance : undefined },
        },
        async dispose() { scope.disposed += 1 },
      }
      executorScopes.push(scope)
      return scope
    }
    const agent = agentByCtx.get(parent)
    if (!agent) throw new Error('unknown scope owner (createScope must receive an agent ctx)')
    const state = { disposed: 0 }
    const registrations = []
    const facadeTools = {
      register(definition) {
        const dispose = registry.register(agent, definition)
        registrations.push(dispose)
        return dispose
      },
      schemas: (who) => registry.schemas(who),
      definitions: () => [],
      executable: () => undefined,
    }
    const scopeCtx = {
      get(name) { return name === 'tools' ? facadeTools : undefined },
      inject() { /* no jobs service in this fixture */ },
      systemPrompt: { section() {}, getSectionOrder() { return 100 } },
      tools: facadeTools,
    }
    const scope = {
      ctx: scopeCtx,
      fiber: Promise.resolve(),
      state,
      async dispose() {
        state.disposed += 1
        for (const dispose of registrations.splice(0)) dispose()
      },
    }
    // cordis' `ctx.plugin(mod)` starts a fiber asynchronously; provideBash
    // awaits it, then reads the registry back. Run apply synchronously and
    // expose the same thenable/dispose shape.
    scopeCtx.plugin = (impl) => {
      impl.apply(scopeCtx, {})
      return {
        then(resolve, reject) { return Promise.resolve().then(resolve, reject) },
        async dispose() { await scope.dispose() },
      }
    }
    scopesByAgent.set(agent, scope)
    return scope
  }

  // Import AFTER the resolve hook is installed, so the stubbed executor module
  // is the one provideBash's dynamic import() sees.
  const mounting = import('../src/inline-tools.js').then(({ mountInlineTools }) => {
    mountInlineTools(rootCtx, {
      tools: () => registry,
      agents: () => ({ list: () => [] }),
      createScope,
      pwshEnabled: () => false,
      experimentalEnabled: () => true,
      log: (message) => logs.push(message),
    })
    return { mountInlineTools }
  })

  const createAgent = (id) => {
    const agent = { id, ctx: undefined }
    agent.ctx = {
      tools: { restrict: ({ deny }) => registry.restrict(agent, deny) },
      get: () => undefined,
    }
    agentByCtx.set(agent.ctx, agent)
    return agent
  }

  const emitCreated = async (agent) => {
    const returned = []
    for (const callback of listeners.get('agent/created') ?? []) returned.push(await callback({ agent }))
    return returned
  }
  const emitDisposed = async (agent) => {
    for (const callback of listeners.get('agent/disposed') ?? []) await callback({ agent })
  }
  const preExecute = (agent, name = 'bash') => {
    const callback = (listeners.get('tools/pre-execute') ?? [])[0]
    return callback?.({ agent, name }, () => ({ kind: 'allow' }))
  }

  return {
    ready: mounting,
    registry,
    logs,
    effects,
    executorScopes,
    createAgent,
    emitCreated,
    emitDisposed,
    preExecute,
    scopeOf: (agent) => scopesByAgent.get(agent),
  }
}

test('global PTC first step: agent/created waits for the own Bash registration', async () => {
  const fixture = createFixture()
  await fixture.ready
  const agent = fixture.createAgent('agent-created-waits')

  // The serial `agent/created` emission: its completion is what
  // `ctx.agents.create()` awaits before the caller can resolve the SDK.
  await fixture.emitCreated(agent)

  const names = fixture.registry.schemas(agent).map((schema) => schema.name)
  assert.ok(
    names.includes('bash'),
    `admission after agent/created lacks bash (face: [${names.join(', ')}]); `
      + 'the created listener resolved before the own Bash registration',
  )
  assert.equal(fixture.registry.registerCalls(agent, 'bash'), 1, 'exactly one own bash registration')
})

test('global PTC: no duplicate registration on later reconciles, and dispose leaks nothing', async () => {
  const fixture = createFixture()
  await fixture.ready
  const agent = fixture.createAgent('agent-dispose')
  await fixture.emitCreated(agent)
  assert.ok(fixture.registry.schemas(agent).some((schema) => schema.name === 'bash'))

  // The lazy pre-execute re-reconcile must not mount a second bash tool while
  // the agent-owned scope already exists.
  fixture.preExecute(agent)
  assert.equal(fixture.registry.registerCalls(agent, 'bash'), 1, 'no duplicate registration')

  await fixture.emitDisposed(agent)
  assert.equal(fixture.scopeOf(agent)?.state.disposed, 1, 'the agent-owned scope is disposed once')
  assert.equal(
    fixture.registry.schemas(agent).some((schema) => schema.name === 'bash'),
    false,
    'the own bash registration is withdrawn with the agent',
  )
  assert.equal(fixture.registry.activeCount(), 0, 'no registration outlives its agent')

  // A later agent proves the five-step path is still live and that no pending
  // task from the disposed agent muddied the state.
  const second = fixture.createAgent('agent-after-dispose')
  await fixture.emitCreated(second)
  assert.equal(fixture.registry.registerCalls(second, 'bash'), 1)
  assert.equal(fixture.registry.activeCount(), 1)
  await fixture.emitDisposed(second)
  assert.equal(fixture.registry.activeCount(), 0)

  // Plugin-level ownership: the shared private executor scope goes away too.
  for (const effect of fixture.effects.reverse()) await effect()
  assert.equal(fixture.executorScopes[0]?.disposed, 1, 'the private executor scope is released on plugin dispose')
})
