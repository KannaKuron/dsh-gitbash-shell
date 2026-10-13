import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mountPrivateExecutor } from '../src/inline-tools.js'

function createScope(parent) {
  let childCtx
  const fiber = parent.plugin((ctx) => { childCtx = ctx })
  return { fiber, get ctx() { return childCtx }, dispose: () => fiber.dispose() }
}

async function fixture(t) {
  const root = new Context()
  const disposers = []
  for (const [name, value] of Object.entries({
    shell: { kind: 'official-pwsh', execute: () => 'PowerShell' },
    subprocess: { kind: 'host-subprocess' },
    sandbox: { kind: 'host-sandbox' },
    sandboxPolicy: { defaultMode: 'danger-full-access' },
  })) disposers.push(root.provide(name, value))
  const owner = createScope(root)
  await owner.fiber
  t.after(async () => {
    await owner.dispose()
    for (const dispose of disposers.reverse()) await dispose()
  })
  return { root, ctx: owner.ctx }
}

class TestExecutor extends Service {
  static inject = ['subprocess', 'sandbox', 'sandboxPolicy']
  static Config = z.object({ timeoutMs: z.number().default(120000).volatile() })
  constructor(ctx, config) {
    super(ctx, 'shell')
    this.config = config
    this.dependencies = [ctx.subprocess.kind, ctx.sandbox.kind, ctx.sandboxPolicy.defaultMode]
  }
  resolve(request) { return { ...request, timeoutMs: this.config.timeoutMs.get() } }
  async execute() { return 'Git Bash' }
}

test('private executor: a plain child fiber reproduces the route-B service collision', async (t) => {
  const { ctx, root } = await fixture(t)
  const child = createScope(ctx)
  await child.fiber
  t.after(() => child.dispose())
  assert.equal(child.ctx[Context.isolate].shell, root[Context.isolate].shell)
  assert.throws(() => new Service(child.ctx, 'shell'), /service "shell" has been registered/)
})

test('private executor: class Config/inject work in an isolated shell scope and teardown preserves the host', async (t) => {
  const { ctx, root } = await fixture(t)
  const { executor, executorScope } = await mountPrivateExecutor(ctx, TestExecutor, createScope)
  t.after(() => executorScope.dispose())
  assert.notEqual(executorScope.ctx[Context.isolate].shell, root[Context.isolate].shell)
  assert.equal(executorScope.ctx[Context.isolate].subprocess, root[Context.isolate].subprocess)
  assert.deepEqual(executor.dependencies, ['host-subprocess', 'host-sandbox', 'danger-full-access'])
  assert.equal(executor.resolve({ command: 'pwd' }).timeoutMs, 120000)
  assert.equal(await executor.execute(), 'Git Bash')
  assert.equal(root.get('shell').execute(), 'PowerShell')
  assert.throws(() => executorScope.ctx.shell, /without inject/, 'get(shell), not .shell, is required here')
  await executorScope.dispose()
  assert.equal(executorScope.ctx.get('shell'), undefined)
  assert.equal(root.get('shell').execute(), 'PowerShell')
  assert.equal(root.get('subprocess').kind, 'host-subprocess')
})

test('private executor: a failed constructor is disposed and a subsequent mount can succeed', async (t) => {
  const { ctx, root } = await fixture(t)
  let failedScope
  class BrokenExecutor extends TestExecutor {
    constructor(ctx, config) {
      super(ctx, config)
      throw new Error('preview constructor failure')
    }
  }
  await assert.rejects(mountPrivateExecutor(ctx, BrokenExecutor, (parent) => {
    failedScope = createScope(parent)
    return failedScope
  }), /preview constructor failure/)
  assert.equal(failedScope.ctx.get('shell', false), undefined, 'partial service registration is released')
  assert.equal(root.get('shell').execute(), 'PowerShell')
  const mounted = await mountPrivateExecutor(ctx, TestExecutor, createScope)
  t.after(() => mounted.executorScope.dispose())
  assert.equal(await mounted.executor.execute(), 'Git Bash')
})

test('private executor: missing required services fail closed and dispose the pending scope', async (t) => {
  const { ctx, root } = await fixture(t)
  let pendingScope
  class PendingExecutor extends TestExecutor {
    static inject = [...TestExecutor.inject, 'missingPreviewService']
  }
  await assert.rejects(mountPrivateExecutor(ctx, PendingExecutor, (parent) => {
    pendingScope = createScope(parent)
    return pendingScope
  }), /executor instance did not expose resolve\(\)\/execute\(\)/)
  assert.equal(pendingScope.ctx.get('shell', false), undefined)
  assert.equal(root.get('shell').execute(), 'PowerShell')
})

test('private executor: an unsettled scope hits the deadline and is disposed', async (t) => {
  const { ctx, root } = await fixture(t)
  let disposed = false
  await assert.rejects(mountPrivateExecutor(ctx, TestExecutor, () => ({
    fiber: new Promise(() => {}),
    dispose: async () => { disposed = true },
  }), { timeoutMs: 25 }), /executor scope mount timed out/)
  assert.equal(disposed, true)
  assert.equal(root.get('shell').execute(), 'PowerShell')
})
