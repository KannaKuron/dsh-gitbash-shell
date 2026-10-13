// Actual installed Core/Cordis contracts, isolated Contexts, and memory-only
// subprocesses. No production profile, filesystem writes, or model requests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope as createAgentScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as shellEnv from '@deepseek-ai/dsh-shell-env'
import { mountInlineTools, mountPrivateExecutor } from '../src/inline-tools.js'
import { createBashToolModule } from '../src/bash-tool.js'
import { GitBashSandboxExecutor } from '../src/shell.js'

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
async function bounded(promise, label, timeoutMs = 3000) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`runtime preview timed out: ${label}`)), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}
function createScope(parent) {
  let ctx
  const fiber = parent.plugin(c => { ctx = c })
  return { fiber, get ctx() { return ctx }, dispose: () => fiber.dispose() }
}

async function fixture(t, { existingBash = false, pwshVisible = false, pauseModules = false, pauseAgentScope = false, failAgentMount = false, subprocessRuntime, workingDirectory = { ensure: async () => process.cwd() }, policyWorkspaceRoot = process.cwd(), sessionCwd, inactiveBashMount = false } = {}) {
  const root = new Context()
  const cleanups = []
  const logs = []
  const entered = deferred()
  const release = deferred()
  const activated = deferred()
  const failed = deferred()
  const agentScopes = []
  const official = { kind: 'official-pwsh' }
  const policy = { mode: 'danger-full-access', ...(policyWorkspaceRoot === null ? {} : { workspaceRoot: policyWorkspaceRoot }) }
  const readFrom = () => ({ text: 'runtime-preview-ok', nextOffset: 18, lossy: false })
  for (const [name, value] of Object.entries({
    shell: official,
    subprocess: subprocessRuntime ?? { spawn() { return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: { readFrom }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } }, terminate() {} } } },
    sandbox: {},
    sandboxPolicy: { defaultMode: policy.mode, resolve: request => request?.session?.header.policy ?? policy },
    ...(workingDirectory === null ? {} : { workingDirectory }),
    loader: { internal: { async import(name) {
      if (pauseModules && name === '@deepseek-ai/dsh-tools') { entered.resolve(); await release.promise }
      return import(name)
    } } },
  })) cleanups.push(root.provide(name, value))
  const mount = async module => {
    const fiber = root.plugin(module)
    cleanups.push(() => fiber.dispose())
    await fiber
    return fiber
  }
  for (const module of [SystemPrompt, ToolRuntime, shellEnv]) await mount(module)
  let agentParent
  await mount({ inject: ['tools'], apply(ctx) {
    agentParent = ctx
    for (const name of ['pwsh', ...(existingBash ? ['bash'] : [])]) {
      ctx.tools.register(defineTool({ name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: () => name }))
    }
  } })
  const agent = { id: 'runtime-preview-agent', session: { header: { ...(sessionCwd === undefined ? {} : { cwd: sessionCwd }) } } }
  const agentScope = createAgentScope(agentParent, agent)
  agent.ctx = agentScope.ctx
  cleanups.push(() => agentScope.dispose())
  const deps = {
    tools: ctx => ctx.get('tools'), agents: () => ({ list: () => [agent] }),
    pwshEnabled: () => pwshVisible,
    log(message) {
      logs.push(message)
      if (message.includes('own bash tool activated')) activated.resolve()
      if (message.includes('activation failed')) failed.resolve()
    },
    createScope(parent) {
      const scope = createScope(parent)
      if (parent === agent.ctx) {
        agentScopes.push(scope)
        if (pauseAgentScope) {
          const fiber = scope.fiber
          scope.fiber = Promise.resolve(fiber).then(async () => { entered.resolve(); await release.promise })
        }
        if (failAgentMount) {
          return { fiber: scope.fiber, get ctx() { return { get: name => scope.ctx.get(name), plugin() { throw new Error('isolated agent plugin mount failure') } } }, dispose: () => scope.dispose() }
        }
        if (inactiveBashMount) {
          return { fiber: scope.fiber, get ctx() { return {
            get: name => scope.ctx.get(name),
            plugin: module => scope.ctx.plugin({ ...module, inject: [...module.inject, 'missingBashService'] }),
          } }, dispose: () => scope.dispose() }
        }
      }
      return scope
    },
  }
  const patch = await mount(ctx => mountInlineTools(ctx, deps))
  const tools = root.get('tools')
  t.after(async () => {
    release.resolve()
    for (const cleanup of cleanups.reverse()) await cleanup()
  })
  return {
    root, agent, tools, patch, official, logs, entered, release, activated, failed, agentScopes, deps,
    names: () => tools.schemas(agent).map(schema => schema.name),
    set: value => { pwshVisible = value; root.emit('loader/volatile-update', [['pwshTool']]) },
    allowAgentMount: () => { failAgentMount = false },
    execute: (name, args = {}) => tools.execute({ agent, name, callId: `${name}-runtime-preview`, arguments: args, signal: new AbortController().signal }),
    remount: () => mount(ctx => mountInlineTools(ctx, deps)),
  }
}

test('runtime preview: live pwsh schema and dispatch follow both switch directions', { timeout: 10000 }, async t => {
  const f = await fixture(t, { existingBash: true })
  assert.deepEqual(f.names(), ['bash'])
  f.set(true)
  assert.ok(f.names().includes('pwsh'))
  assert.equal((await f.execute('pwsh')).value, 'pwsh')
  f.set(false)
  assert.ok(!f.names().includes('pwsh'))
  assert.equal((await f.execute('pwsh')).isError, true)
  f.set(true)
  assert.equal((await f.execute('pwsh')).isError, false)
  assert.equal(f.root.get('shell'), f.official)
  await f.patch.dispose()
  assert.ok(f.names().includes('pwsh'))
})

test('runtime preview: plugin disposal cancels a delayed host import and cannot leave a ghost bash', { timeout: 10000 }, async t => {
  const f = await fixture(t, { pauseModules: true })
  await bounded(f.entered.promise, 'host module import entered')
  await bounded(f.patch.dispose(), 'plugin disposal with the loader still blocked')
  assert.deepEqual(f.names(), ['pwsh'])
  f.release.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.names(), ['pwsh'])
  assert.ok(!f.logs.some(message => message.includes('own bash tool activated')))
  const replacement = await f.remount()
  await bounded(f.activated.promise, 'replacement bash activation')
  const result = await f.execute('bash', { command: 'memory-only command', description: 'Verify replacement bash tool' })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(result.value.exitCode, 0)
  assert.equal(f.root.get('shell'), f.official)
  await replacement.dispose()
  assert.deepEqual(f.names(), ['pwsh'])
})

test('runtime preview: disposal owns and joins a scope whose agent mount is still pending', { timeout: 10000 }, async t => {
  const f = await fixture(t, { pauseAgentScope: true })
  await bounded(f.entered.promise, 'per-agent scope entered')
  assert.equal(f.agentScopes.length, 1)
  f.set(true)
  f.set(false)
  assert.equal(f.agentScopes.length, 1, 'volatile updates do not duplicate an in-flight mount')
  await bounded(f.patch.dispose(), 'disposal during scope mount')
  f.release.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.names(), ['pwsh'])
  assert.equal(f.agentScopes[0].ctx.fiber.state, 4, 'agent-owned scope is disposed')
})

test('runtime preview: agent disposal cancels its delayed mount while preserving the plugin executor', { timeout: 10000 }, async t => {
  const f = await fixture(t, { pauseAgentScope: true })
  await bounded(f.entered.promise, 'agent mount entered')
  await bounded(f.root.parallel('agent/disposed', { agent: f.agent }), 'agent disposal listener')
  f.release.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.names(), ['pwsh'])
  assert.equal(f.agentScopes[0].ctx.fiber.state, 4)
  assert.equal(f.root.get('shell'), f.official)
})

test('runtime preview: a failed per-agent plugin mount releases its scope and can retry', { timeout: 10000 }, async t => {
  const f = await fixture(t, { failAgentMount: true })
  await bounded(f.failed.promise, 'agent mount failure')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.agentScopes[0].ctx.fiber.state, 4)
  assert.ok(!f.names().includes('bash'))
  f.allowAgentMount()
  f.set(true)
  await bounded(f.activated.promise, 'retried agent mount')
  assert.equal(f.agentScopes.length, 2)
  assert.ok(f.names().includes('bash'))
})

test('runtime preview: actual ToolRuntime accepts and executes the recursive plain fallback', { timeout: 10000 }, async t => {
  const f = await fixture(t, { existingBash: true, pwshVisible: true })
  await f.patch.dispose()
  const child = createScope(f.agent.ctx)
  t.after(() => child.dispose())
  await child.fiber
  const requests = []
  const executor = {
    sandboxMode: 'danger-full-access',
    resolve: request => { requests.push(request); return { ...request, workdir: process.cwd(), timeoutMs: 100 } },
    execute: async spec => ({ result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
      stdout: { text: 'plain-fallback-ok', truncated: false }, stderr: { text: '', truncated: false }, sandbox: { mode: spec.sandboxPolicy.mode, denied: false },
    }) }),
  }
  const module = createBashToolModule({ executor, log() {} })
  await child.ctx.plugin(module)
  f.agent.session.header.policy = { mode: 'read-only', workspaceRoot: 'D:/child-workspace' }
  const result = await f.execute('bash', { command: 'memory-only command', description: 'Verify plain fallback execution' })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(result.value.stdout.text, 'plain-fallback-ok')
  assert.deepEqual(requests[0].sandboxPolicy, f.agent.session.header.policy)
  assert.equal(result.value.sandbox.mode, 'read-only')
  const escalation = await f.execute('bash', { command: 'memory-only command', description: 'Reject missing approval helper', sandbox_permissions: 'danger-full-access', justification: 'Request broader access.' })
  assert.equal(escalation.isError, true)
  assert.match(escalation.error.message, /no sandbox helper/)
})

test('runtime preview: jobs unload/reload swaps between job-backed and foreground registrations', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  await bounded(f.activated.promise, 'own bash activation')
  assert.equal(f.tools.get('bash', f.agent).parameters.properties.run_in_background, undefined)
  const removeJobs = f.root.provide('jobs', {})
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(f.tools.get('bash', f.agent).parameters.properties.run_in_background)
  } finally { await removeJobs() }
  assert.ok(f.names().includes('bash'))
  assert.equal(f.tools.get('bash', f.agent).parameters.properties.run_in_background, undefined)
  const result = await f.execute('bash', { command: 'memory-only command', description: 'Verify foreground after jobs unload' })
  assert.equal(result.isError, false, JSON.stringify(result))
})

test('runtime preview: private execution retains deadlines, background no-expiry, cancellation, and provider failures', { timeout: 10000 }, async t => {
  let rejectSpawn = false
  const readFrom = () => ({ text: '', nextOffset: 0, lossy: false })
  const runtime = { spawn(spec) {
    if (rejectSpawn) throw new Error('isolated provider failure')
    const closed = deferred()
    const stop = () => closed.resolve({ exitCode: null, signal: 'SIGTERM' })
    spec.signal?.addEventListener('abort', stop, { once: true })
    if (spec.signal?.aborted) stop()
    return { done: closed.promise, collected: { stdout: { readFrom }, stderr: { readFrom } }, terminate: stop }
  } }
  const f = await fixture(t, { existingBash: true, subprocessRuntime: runtime })
  const { executor, executorScope } = await mountPrivateExecutor(f.root, GitBashSandboxExecutor, createScope)
  t.after(() => executorScope.dispose())
  const spec = executor.resolve({ command: 'memory-only command', workdir: process.cwd(), timeoutMs: 20 })
  const foreground = await executor.execute(spec)
  assert.equal(foreground.result(), foreground.result(), 'result projection remains memoized')
  const timedOut = await bounded(foreground.result(), 'foreground timeout')
  assert.equal(timedOut.timedOut, true)
  assert.equal(timedOut.aborted, false)
  const background = await executor.execute({ ...spec, onExpiry: 'none' })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(background.status, 'running')
  background.kill()
  assert.equal((await background.result()).timedOut, false)
  const controller = new AbortController()
  const cancelled = await executor.execute({ ...spec, onExpiry: 'none', signal: controller.signal })
  controller.abort(new Error('caller cancellation'))
  assert.equal((await cancelled.result()).aborted, true)
  rejectSpawn = true
  const failed = await executor.execute(spec)
  await failed.done
  await assert.rejects(failed.result(), /isolated provider failure/)
  assert.equal(f.root.get('shell'), f.official)
})


test('runtime preview: missing workingDirectory still mounts Bash and resolves the old session cwd seam', { timeout: 10000 }, async t => {
  const spawned = [];
  const f = await fixture(t, { workingDirectory: null, policyWorkspaceRoot: null, sessionCwd: 'D:/session-project',
    subprocessRuntime: { spawn(spec) { spawned.push(spec); return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: { readFrom: () => ({ text: 'ok', nextOffset: 2, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } }, terminate() {} }; } } });
  await bounded(f.activated.promise, 'Bash on an old host');
  assert.ok(f.names().includes('bash'));
  for (const [workdir, expected] of [[undefined, 'D:/session-project'], ['scripts', 'D:/session-project/scripts'], ['E:/explicit', 'E:/explicit']]) {
    const response = await f.execute('bash', { command: 'memory-only command', description: 'Verify old host cwd', ...(workdir === undefined ? {} : { workdir }) });
    assert.equal(response.isError, false, JSON.stringify(response));
    assert.equal(spawned.at(-1).cwd, expected);
    assert.equal(response.value.cwd, expected);
  }
  f.agent.session.header.policy = { mode: 'danger-full-access', workspaceRoot: 'F:/policy-project' };
  const response = await f.execute('bash', { command: 'memory-only command', description: 'Verify policy precedence', workdir: 'scripts' });
  assert.equal(response.isError, false, JSON.stringify(response));
  assert.equal(spawned.at(-1).cwd, 'F:/policy-project/scripts');
  let background;
  const removeJobs = f.root.provide('jobs', { start(definition) {
    background = definition.run();
    return 'issue27-background';
  } });
  try {
    await new Promise(setImmediate);
    const response = await f.execute('bash', { command: 'memory-only command', description: 'Verify old host background cwd', workdir: 'scripts', run_in_background: true });
    assert.equal(response.isError, false, JSON.stringify(response));
    assert.equal(response.value.kind, 'background');
    assert.equal(response.value.cwd, 'F:/policy-project/scripts');
    await bounded(background.done, 'old host background execution');
    assert.equal(spawned.at(-1).cwd, 'F:/policy-project/scripts');
  } finally { await removeJobs(); }
  assert.equal(f.root.get('shell'), f.official);
  await f.patch.dispose();
  assert.deepEqual(f.names(), ['pwsh']);
});

test('runtime preview: inactive Bash fiber reports failure and disposes instead of logging success', { timeout: 10000 }, async t => {
  const f = await fixture(t, { inactiveBashMount: true });
  await bounded(f.failed.promise, 'inactive module failure');
  await new Promise(setImmediate);
  assert.ok(!f.names().includes('bash'));
  assert.ok(!f.logs.some(line => line.includes('own bash tool activated')));
  assert.ok(f.logs.some(line => line.includes('bash tool did not register')));
  assert.ok(f.agentScopes.every(scope => scope.ctx.fiber.state === 4));
  assert.equal(f.root.get('shell'), f.official);
});


test('runtime preview: modern directory changes stay live and validation failures never spawn', { timeout: 10000 }, async t => {
  let directory = 'E:/current-project', reject = false, calls = 0, spawns = 0;
  const f = await fixture(t, { sessionCwd: 'D:/original-project', workingDirectory: {
    async ensure(agent, signal) { calls++; assert.equal(agent, f.agent); assert.ok(signal instanceof AbortSignal); if (reject) throw new Error('current directory validation failed'); return directory; },
  }, subprocessRuntime: { spawn(spec) { spawns++; assert.equal(spec.cwd, directory); return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: { readFrom: () => ({ text: 'ok', nextOffset: 2, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } }, terminate() {} }; } } });
  await bounded(f.activated.promise, 'modern Bash activation');
  for (directory of ['E:/current-project', 'F:/changed-project']) {
    const response = await f.execute('bash', { command: 'memory-only command', description: 'Verify current directory' });
    assert.equal(response.isError, false, JSON.stringify(response));
    assert.equal(response.value.cwd, directory);
  }
  reject = true;
  const response = await f.execute('bash', { command: 'memory-only command', description: 'Preserve provider refusal' });
  assert.equal(response.isError, true);
  assert.match(response.error.message, /current directory validation failed/);
  assert.equal(calls, 3);
  assert.equal(spawns, 2);
  assert.equal(f.root.get('shell'), f.official);
});
