// Actual installed Core/Cordis contracts, isolated Contexts, and memory-only
// subprocesses. No production profile, filesystem writes, or model requests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as dialectHelpers from '../src/index.js'
import { Context } from '@deepseek-ai/cordis'
import { createScope as createAgentScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as shellEnv from '@deepseek-ai/dsh-shell-env'
import { applyToolRouting, mountInlineTools, mountPrivateExecutor } from '../src/inline-tools.js'
import { createBashToolModule } from '../src/bash-tool.js'
import { GitBashSandboxExecutor } from '../src/shell.js'
import { mountFastctx } from '../src/fastctx-bridge.js'

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

async function fixture(t, { existingBash = false, pwshVisible = false, pauseModules = false, pauseAgentScope = false, failAgentMount = false, subprocessRuntime, explicitTools = false, ptc = false, experimental = true, workingDirectory = { ensure: async () => process.cwd() }, sessionCwd, policyWorkspaceRoot = process.cwd() } = {}) {
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
    ...(ptc ? { ptcRuntime: { language: 'typescript', executionInstructions: 'Prompt-only fixture; never executes programs', resolve: spec => spec, run() { throw new Error('prompt routing fixture must not execute') } } } : {}),
    sandboxPolicy: { defaultMode: policy.mode, resolve: request => request?.session?.header.policy ?? policy },
    ...(workingDirectory === null ? {} : { workingDirectory }),
    loader: { internal: { async import(name) {
      if (pauseModules && name === '@deepseek-ai/dsh-tools') { entered.resolve(); await release.promise }
      return import(name)
    } } },
  })) cleanups.push(root.provide(name, value))
  const mount = async (module, config) => {
    const fiber = root.plugin(module, config)
    cleanups.push(() => fiber.dispose())
    await fiber
    return fiber
  }
  for (const module of [SystemPrompt, ToolRuntime, shellEnv]) await mount(module, module === ToolRuntime ? { mode: ptc ? 'ptc' : 'native' } : undefined)
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
    experimentalEnabled: () => experimental,
    ...(explicitTools ? {
      translatePath: value => dialectHelpers.translateMsysPath(value, { home: 'D:/compat-home', tmpDir: 'D:/compat-temp', gitRoot: 'C:/Program Files/Git' }),
      createArtifactDirectory() { throw new Error('registration/refusal fixture must not create artifacts') },
    } : {}),
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
    setExperimental: value => { experimental = value; root.emit('loader/volatile-update', [['experimentalNative']]) },
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

test('runtime preview: experimental switch changes existing schemas and restricted Bash without restart', { timeout: 15000 }, async t => {
  for (const initial of [true, false]) {
    const f = await fixture(t, { explicitTools: true, experimental: initial })
    await bounded(f.activated.promise, 'experimental tools activation')
    f.agent.session.header.policy = { mode: 'workspace-write', workspaceRoot: process.cwd() }
    const args = { command: 'memory-only command', description: 'Verify live opt-out' }
    for (const enabled of [initial, !initial, initial, !initial]) {
      f.setExperimental(enabled)
      for (const name of ['gitbash_native', 'gitbash_to_native_path']) assert.equal(f.names().includes(name), enabled, JSON.stringify({ name, initial, enabled, logs: f.logs }))
      const result = await f.execute('bash', args)
      assert.equal(result.isError, enabled, JSON.stringify(result))
      if (enabled) {
        assert.equal(result.error.info.code, 'SANDBOX_UNAVAILABLE')
        assert.match(result.error.message, /Settings.*experimentalNative.*session access-mode/)
      } else {
        assert.equal(result.value.sandbox.enforcement, 'unconfined')
        assert.equal(result.value.sandbox.mode, 'workspace-write')
        assert.equal((await f.execute('gitbash_to_native_path', { msys_path: '/c/test' })).isError, true)
      }
      assert.equal(f.root.get('shell'), f.official)
    }
    await f.patch.dispose()
    assert.deepEqual(f.names(), ['pwsh'])
  }
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

test('runtime preview: actual ToolRuntime refuses unsafe foreground/background admission', { timeout: 10000 }, async t => {
  let spawns = 0
  const f = await fixture(t, { subprocessRuntime: { spawn() { spawns++; throw new Error('restricted fixture must not spawn') } } })
  await bounded(f.activated.promise, 'fail-closed bash activation')
  assert.match(f.tools.get('bash', f.agent).description, /MSYS2_ARG_CONV_EXCL/)
  assert.match(f.tools.get('bash', f.agent).description, /refused before/)
  for (const mode of ['read-only', 'workspace-write']) {
    f.agent.session.header.policy = { mode, workspaceRoot: process.cwd() }
    const value = await f.execute('bash', { command: 'memory-only command', description: 'Verify structured safe refusal' })
    assert.equal(value.isError, true, JSON.stringify(value))
    assert.equal(value.error.info.code, 'SANDBOX_UNAVAILABLE')
    assert.match(value.content[0].text, /not started/)
  }
  const admitted = []
  const off = f.root.provide('jobs', { start(spec) { admitted.push(spec); return 'must-not-be-admitted' } })
  try {
    await new Promise(resolve => setImmediate(resolve))
    for (const run_in_background of [false, true]) {
      const value = await f.execute('bash', { command: 'memory-only command', description: 'Reject unsafe job admission', run_in_background })
      assert.equal(value.isError, true, JSON.stringify(value))
      assert.equal(value.error.info.code, 'SANDBOX_UNAVAILABLE')
    }
    assert.equal(admitted.length, 0)
  } finally { await off() }
  assert.equal(spawns, 0)
  assert.equal(f.root.get('shell'), f.official)
})

test('runtime preview: actual promoted DTO renders sandbox notes from handle facts, not output text', { timeout: 10000 }, async t => {
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
    const spawned = deferred()
    const finished = deferred()
    const raw = 'promotion-raw-output'
    const readFrom = () => ({ text: raw, nextOffset: raw.length, lossy: false })
    const f = await fixture(t, { experimental: false, subprocessRuntime: { spawn() {
      spawned.resolve()
      return { done: finished.promise, collected: { stdout: { readFrom }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
        terminate() { finished.resolve({ exitCode: 1, signal: 'SIGTERM' }) } }
    } } })
    await bounded(f.activated.promise, `promotion activation: ${mode}`)
    f.agent.session.header.policy = { mode, workspaceRoot: process.cwd() }
    let hooks
    const off = f.root.provide('jobs', {
      start(spec) { hooks = spec.run(); return 'compatibility-promoted' },
      async wait(_id, timeoutMs) {
        assert.equal(timeoutMs, 5)
        await bounded(spawned.promise, 'promotion producer admission')
        await new Promise(resolve => setImmediate(resolve))
        return { status: 'running' }
      },
      read() { return { chunks: [{ channel: 'stdout', text: raw }], lossy: true, job: { output: { spillPaths: ['promotion-spill'] } } } },
    })
    try {
      await new Promise(resolve => setImmediate(resolve))
      const value = await f.execute('bash', { command: 'memory-only command', description: 'Verify promotion sandbox facts', timeoutMs: 5 })
      assert.equal(value.isError, false, JSON.stringify(value))
      assert.equal(value.value.kind, 'promoted')
      assert.equal(value.value.sandbox.mode, mode)
      assert.match(value.value.output, /promotion-raw-output[\s\S]*output was dropped[\s\S]*promotion-spill/)
      assert.doesNotMatch(value.value.output, /unconfined|NOT enforced/, 'the tool must not pre-render sandbox notes into output')
      const text = value.content[0].text
      assert.match(text, /moved to background job compatibility-promoted/)
      if (mode === 'danger-full-access') assert.doesNotMatch(text, /unconfined|NOT enforced/)
      else {
        assert.equal(value.value.sandbox.enforcement, 'unconfined')
        assert.match(text, /moved to background[\s\S]*unconfined.*NOT enforced/)
        assert.equal((text.match(/NOT enforced/g) ?? []).length, 1)
        assert.doesNotMatch(text, /escalation available/)
      }
      assert.equal(f.root.get('shell'), f.official)
    } finally {
      finished.resolve({ exitCode: 0, signal: null })
      if (hooks) await hooks.done
      await off()
    }
  }
})

test('runtime preview: direct resolved restricted execution refuses and full handle stays memoized', { timeout: 10000 }, async t => {
  const f = await fixture(t, { existingBash: true })
  const { executor, executorScope } = await mountPrivateExecutor(f.root, GitBashSandboxExecutor, createScope)
  t.after(() => executorScope.dispose())
  const spec = executor.resolve({ command: 'memory-only command', workdir: process.cwd(), sandboxPolicy: { mode: 'read-only', workspaceRoot: process.cwd() } })
  await assert.rejects(() => executor.execute(spec), error => error.code === 'SANDBOX_UNAVAILABLE')
  await assert.rejects(() => executor.execute({ ...spec, sandboxPolicy: undefined }), error => error.code === 'SANDBOX_UNAVAILABLE')
  const full = { ...spec, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: process.cwd() } }
  const handle = await executor.execute(full)
  assert.deepEqual(handle.sandbox, { mode: 'danger-full-access', denied: false })
  assert.equal(handle.result(), handle.result(), 'projection remains memoized')
  assert.deepEqual((await handle.result()).sandbox, handle.sandbox)
  assert.equal(f.root.get('shell'), f.official)
})

for (const ptc of [false, true]) test(`runtime preview: routing reaches the actual ${ptc ? 'PTC SDK' : 'native tool'} prompt and respects visibility`, { timeout: 10000 }, async t => {
  const f = await fixture(t, { explicitTools: true, ptc })
  await bounded(f.activated.promise, 'routing tools activation')
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  const start = source.indexOf("ctx.on('system-prompt/assemble',")
  const end = source.indexOf("      console.log(TAG + ' prompt-assembly path dialect active", start)
  assert.ok(start >= 0 && end > start)
  let dialect = { posixPaths: false, codePaths: false, subagentDialect: true }
  const hook = f.root.plugin(ctx => {
    new Function('ctx', 'liveSettings', 'dialectApplies', 'windowsToMsys', 'runCodeHintFor', 'applyToolRouting', source.slice(start, end))(
      ctx, { dialect: () => dialect, pwshTool: () => f.deps.pwshEnabled() }, dialectHelpers.dialectApplies, dialectHelpers.windowsToMsys, dialectHelpers.runCodeHintFor, applyToolRouting)
  })
  t.after(() => hook.dispose())
  await hook
  const assemble = () => f.root.get('systemPrompt').assemble({ scope: f.agent, agent: f.agent })
  const first = await assemble()
  const sdk = first.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
  if (ptc) {
    assert.deepEqual(first.tools.map(tool => tool.name), ['run_code'])
    assert.match(first.tools[0].description, /call only bindings actually offered/)
    assert.match(first.tools[0].description, /denial is a stop condition/)
    assert.match(sdk, /gitbash_native/)
    assert.match(sdk, /Choose this tool BEFORE execution/)
    assert.match(sdk, /gitbash_to_native_path/)
    assert.match(sdk, /runtime-built MSYS paths before direct native Node/)
    assert.doesNotMatch(sdk, /\bpwsh\b/, 'hidden tools must not be offered as SDK bindings')
  } else {
    const text = first.tools.find(tool => tool.name === 'bash').description
    assert.match(text, /gitbash_native before execution/)
    assert.match(text, /gitbash_to_native_path only/)
    assert.doesNotMatch(text, /\bpwsh\b|ALL commands|\/c\/Users/)
  }
  f.set(true)
  const shown = await assemble()
  if (ptc) assert.match(shown.sections.find(section => section.name === 'tools:sdk').text, /\bpwsh\b/)
  else assert.match(shown.tools.find(tool => tool.name === 'bash').description, /use the pwsh tool ONLY when/)
  f.set(false)
  dialect = { ...dialect, posixPaths: true, subagentDialect: false }
  f.agent.session.header.origin = 'subagent'
  const delegated = await assemble()
  const text = delegated.tools.find(tool => tool.name === (ptc ? 'run_code' : 'bash')).description
  assert.match(text, /denial is a stop condition/, 'routing is independent of delegated dialect switches')
  assert.doesNotMatch(text, /\/c\/Users/)
  assert.equal(f.root.get('shell'), f.official)
})

test('runtime preview: explicit tools activate in the real per-agent wiring and retire together', { timeout: 10000 }, async t => {
  let spawns = 0
  const f = await fixture(t, { explicitTools: true, subprocessRuntime: { spawn() { spawns++; throw new Error('this fixture must not spawn') } } })
  await bounded(f.activated.promise, 'explicit tools activation')
  assert.deepEqual(f.names().sort(), ['bash', 'gitbash_native', 'gitbash_to_native_path'])
  const translated = await f.execute('gitbash_to_native_path', { msys_path: '/d/项目/文件#1.txt' })
  assert.equal(translated.isError, false, JSON.stringify(translated))
  assert.deepEqual(translated.value, { native_path: 'D:/项目/文件#1.txt' })
  for (const mode of ['read-only', 'workspace-write']) {
    f.agent.session.header.policy = { mode, workspaceRoot: process.cwd() }
    const denied = await f.execute('gitbash_native', { description: 'Refuse unsupported policy', executable: { kind: 'path', value: 'C:/controlled.exe' }, argv: [] })
    assert.equal(denied.isError, true, JSON.stringify(denied))
    assert.equal(denied.error.info.code, 'SANDBOX_UNAVAILABLE')
  }
  assert.equal(spawns, 0)
  assert.equal(f.root.get('shell'), f.official)
  await f.patch.dispose()
  assert.deepEqual(f.names(), ['pwsh'], 'all own registrations and visibility masks retire together')
  const reactivated = deferred()
  const previousLog = f.deps.log
  f.deps.log = message => { previousLog(message); if (message.includes('own bash tool activated')) reactivated.resolve() }
  await f.remount()
  await bounded(reactivated.promise, 'explicit tools reload activation')
  assert.deepEqual(f.names().sort(), ['bash', 'gitbash_native', 'gitbash_to_native_path'], 'reload must not duplicate registrations')
  assert.equal(f.root.get('shell'), f.official)
})

// Review round 1 on PR #26 (v0.39.4 rebase): fastctxTools now defaults to OFF
// and the disabled bridge must neither spawn nor resolve the payload — while
// companion registration detection (knownNames/faceNames) on a face with no
// gb_* and no ops_* still mounts gitbash_native / gitbash_to_native_path, per
// design doc §10 semantics.
test('runtime preview: companions mount on the single-install face with fastctxTools OFF (v0.39.4 default)', { timeout: 10000 }, async t => {
  const f = await fixture(t, { explicitTools: true })
  await bounded(f.activated.promise, 'explicit tools activation')
  const bridge = f.root.plugin(ctx => mountFastctx(ctx, {
    platform: 'win32',
    enabled: () => false, // the v0.39.4 default read (valueOf(...) === true)
    tools: c => c.get('tools'),
    log: message => f.deps.log(message),
    createRequireFrom: () => { throw new Error('the disabled bridge must never resolve the payload') },
    msysToWin: () => { throw new Error('the disabled bridge never translates arguments') },
  }))
  t.after(() => bridge.dispose())
  await bridge
  f.root.emit('agent/created', { agent: f.agent })
  await new Promise(setImmediate)
  const names = f.names()
  assert.ok(!names.some((name) => name.startsWith('gb_')), 'no gb_* tools on a single-install face')
  assert.ok(!names.some((name) => name.startsWith('ops_')), 'no ops_* tools without dsh-ops')
  assert.deepEqual([...names].sort(), ['bash', 'gitbash_native', 'gitbash_to_native_path'],
    'companion registration detection is independent of the fastctxTools switch')
  assert.ok(f.logs.some(line => line.includes('FastCtx bridge disabled by the fastctxTools switch')))
})

// The real run_code transport captures rewritten source in a mock PTC runtime;
// it does NOT evaluate the program or claim real PTC-engine/filesystem coverage.
test('runtime preview: actual run_code transport receives Unicode/EOF fixes and preserves tagged data', async t => {
  const root = new Context()
  const cleanup = []
  const captured = []
  const env = { tmpDir: 'C:/compatibility-temp', home: 'C:/compatibility-home', gitRoot: 'C:/Program Files/Git' }
  let dialect = { posixPaths: true, codePaths: true, virtualMounts: true, subagentDialect: true }
  for (const [name, value] of Object.entries({
    workingDirectory: { ensure: async () => process.cwd() },
    ptcRuntime: { language: 'typescript', executionInstructions: 'Memory-only source capture', resolve: spec => spec,
      async run(spec) { captured.push(spec.program); return { logs: [], value: spec.program } } },
  })) cleanup.push(root.provide(name, value))
  const mount = async (module, config) => { const fiber = root.plugin(module, config); cleanup.push(() => fiber.dispose()); await fiber }
  t.after(async () => { for (const off of cleanup.reverse()) await off() })
  await mount(SystemPrompt)
  await mount(ToolRuntime, { mode: 'ptc' })
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  const start = source.indexOf("ctx.on('tools/execute',")
  const end = source.indexOf("      console.log(TAG + ' MSYS path translation active", start)
  assert.ok(start >= 0 && end > start)
  await mount(ctx => {
    new Function('ctx', 'liveSettings', 'dialectApplies', 'buildTranslateEnv', 'readConfiguredBashPath', 'translateDispatch', 'rewriteResultPaths', source.slice(start, end))(
      ctx, { dialect: () => dialect }, dialectHelpers.dialectApplies, () => env, () => '', dialectHelpers.translateDispatch, dialectHelpers.rewriteResultPaths)
  })
  const run = async code => {
    const args = { description: 'Capture compatible program without executing it', code }
    const value = await root.get('tools').execute({ name: 'run_code', callId: 'compat-code-' + captured.length, arguments: args, signal: new AbortController().signal })
    assert.equal(value.isError, false, JSON.stringify(value))
    assert.equal(args.code, code, 'caller source stays unchanged')
    return captured.at(-1)
  }
  const sourceOn = 'const p="/c/工作/文件#1.txt"; return [p, String.raw`/dev/null`]; // EOF'
  assert.equal(await run(sourceOn), dialectHelpers.programPrelude(env) + 'const p="C:/工作/文件#1.txt"; return [p, String.raw`/dev/null`]; // EOF')
  dialect = { ...dialect, codePaths: false }
  assert.equal(await run(sourceOn), sourceOn)
  dialect = { ...dialect, codePaths: true }
  const uncertain = "const p='/c/工作/a'; return (4+2) / 2"
  assert.equal(await run(uncertain), dialectHelpers.programPrelude(env) + uncertain)
})


test('runtime preview: old hosts without workingDirectory mount all companions and preserve policy-first cwd', { timeout: 10000 }, async t => {
  const spawns=[];
  const f=await fixture(t,{explicitTools:true,workingDirectory:null,sessionCwd:'D:/session-project',policyWorkspaceRoot:null,
    subprocessRuntime:{spawn(spec){spawns.push(spec);return {done:Promise.resolve({exitCode:0,signal:null}),collected:{stdout:{readFrom:()=>({text:'ok',nextOffset:2,lossy:false})},stderr:{readFrom:()=>({text:'',nextOffset:0,lossy:false})}},terminate(){}}}}});
  await bounded(f.activated.promise,'old-host companions');
  assert.deepEqual(f.names().sort(),['bash','gitbash_native','gitbash_to_native_path']);
  for(const [workdir,cwd] of [[undefined,'D:/session-project'],['scripts','D:/session-project/scripts'],['E:/explicit','E:/explicit']]){
    const response=await f.execute('bash',{command:'memory-only',description:'Verify old-host cwd',...(workdir===undefined?{}:{workdir})});
    assert.equal(response.isError,false,JSON.stringify(response));assert.equal(spawns.at(-1).cwd,cwd);
  }
  f.agent.session.header.policy={mode:'danger-full-access',workspaceRoot:'F:/policy-project'};
  const response=await f.execute('bash',{command:'memory-only',description:'Verify policy precedence',workdir:'scripts'});
  assert.equal(response.isError,false,JSON.stringify(response));assert.equal(spawns.at(-1).cwd,'F:/policy-project/scripts');
  f.setExperimental(false);assert.deepEqual(f.names(),['bash']);
  f.setExperimental(true);assert.deepEqual(f.names().sort(),['bash','gitbash_native','gitbash_to_native_path']);
  assert.equal(f.root.get('shell'),f.official);
});


function foreignCompanion(name, value) {
  return { inject: ['tools'], apply(ctx) {
    ctx.tools.register(defineTool({ name, description: 'Foreign companion owner', parameters: { msys_path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] }, execute: () => value }));
  } };
}

for (const layer of ['global', 'agent']) for (const name of ['gitbash_to_native_path', 'gitbash_native']) {
  test('runtime preview: live companion preserves foreign ' + layer + ' owner of ' + name, { timeout: 10000 }, async t => {
    const f = await fixture(t, { explicitTools: true, experimental: false });
    await bounded(f.activated.promise, 'companion scopes ready');
    const owner = layer === 'global' ? f.root : f.agent.ctx;
    const sentinel = 'FOREIGN_' + layer + '_' + name;
    const foreign = owner.plugin(foreignCompanion(name, sentinel));
    await foreign;
    t.after(() => foreign.dispose());
    for (const enabled of [true, false, true]) {
      assert.doesNotThrow(() => f.setExperimental(enabled));
      const response = await f.execute(name, { msys_path: '/c/sentinel' });
      assert.equal(response.isError, false, JSON.stringify(response));
      assert.equal(response.value, sentinel);
      assert.equal(f.tools.sdkSchemas(f.agent).find(tool => tool.name === name).output.type, 'string', 'SDK retains the foreign return contract');
      const other = name === 'gitbash_native' ? 'gitbash_to_native_path' : 'gitbash_native';
      assert.equal(f.names().includes(other), enabled, 'one collision cannot block the other companion');
    }
    assert.ok(f.logs.some(line => line.includes(name + ' registration skipped: an existing tool owns this name')));
    await foreign.dispose();
    f.setExperimental(false);
    f.setExperimental(true);
    const output = f.tools.sdkSchemas(f.agent).find(tool => tool.name === name).output;
    if (name === 'gitbash_to_native_path') assert.equal(output.type, 'object');
    else assert.ok(output.oneOf.every(branch => branch.type === 'object'), 'native union contract recovers after the owner leaves');
    await f.patch.dispose();
    assert.deepEqual(f.names(), ['pwsh']);
  });
}

test('runtime preview: native Jobs reload preserves a foreign owner without blocking its scope', { timeout: 10000 }, async t => {
  const f = await fixture(t, { explicitTools: true, experimental: false });
  await bounded(f.activated.promise, 'companion scopes ready');
  const foreign = f.agent.ctx.plugin(foreignCompanion('gitbash_native', 'FOREIGN_JOBS_OWNER'));
  await foreign;
  t.after(() => foreign.dispose());
  assert.doesNotThrow(() => f.setExperimental(true));
  for (let i = 0; i < 2; i++) {
    const removeJobs = f.root.provide('jobs', {});
    await new Promise(setImmediate);
    assert.equal((await f.execute('gitbash_native', { msys_path: '/c/sentinel' })).value, 'FOREIGN_JOBS_OWNER');
    await removeJobs();
    assert.equal((await f.execute('gitbash_native', { msys_path: '/c/sentinel' })).value, 'FOREIGN_JOBS_OWNER');
    assert.ok(f.names().includes('gitbash_to_native_path'));
  }
  await foreign.dispose();
  const removeJobs = f.root.provide('jobs', {});
  await new Promise(setImmediate);
  try {
    assert.ok(f.tools.sdkSchemas(f.agent).find(tool => tool.name === 'gitbash_native').output.oneOf.every(branch => branch.type === 'object'));
    assert.ok(f.tools.get('gitbash_native', f.agent).parameters.properties.run_in_background);
  } finally { await removeJobs(); }
  assert.equal(f.tools.get('gitbash_native', f.agent).parameters.properties.run_in_background, undefined);
});


test('runtime preview: an initially hidden foreign tool retains ownership through companion mounting', { timeout: 10000 }, async t => {
  const f = await fixture(t, { explicitTools: true, pauseModules: true });
  await bounded(f.entered.promise, 'pause before companion mounting');
  const foreign = f.root.plugin(foreignCompanion('gitbash_to_native_path', 'HIDDEN_FOREIGN_OWNER'));
  await foreign;
  t.after(() => foreign.dispose());
  const lift = f.agent.ctx.tools.restrict({ deny: ['gitbash_to_native_path'] });
  t.after(lift);
  f.release.resolve();
  await bounded(f.activated.promise, 'companion scopes with a hidden foreign owner');
  assert.ok(!f.names().includes('gitbash_to_native_path'), 'own registration must not bypass another owner’s visibility mask');
  assert.ok(f.names().includes('gitbash_native'));
  lift();
  assert.equal((await f.execute('gitbash_to_native_path', { msys_path: '/c/sentinel' })).value, 'HIDDEN_FOREIGN_OWNER');
  await foreign.dispose();
  f.setExperimental(false);
  f.setExperimental(true);
  assert.deepEqual((await f.execute('gitbash_to_native_path', { msys_path: '/c/sentinel' })).value, { native_path: 'C:/sentinel' });
});
