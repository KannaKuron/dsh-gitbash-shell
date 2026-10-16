import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import { createScope as createAgentScope } from '@deepseek-ai/dsh-scope'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as shellEnv from '@deepseek-ai/dsh-shell-env'
import * as toolBash from '@deepseek-ai/dsh-tool-bash'
import * as toolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import { pluginsFor } from '../src/compositions.js'
import { mountInlineTools } from '../src/inline-tools.js'
import { _internal as x } from '../src/index.js'

function createScope(parent) {
  let childCtx
  const fiber = parent.plugin((ctx) => { childCtx = ctx })
  return { fiber, get ctx() { return childCtx }, dispose: () => fiber.dispose() }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))

// Actual Core services, not a production profile. Each variant's real shell
// rows mount into a fresh Context, then ToolRuntime dispatches the inline bash.
for (const kind of ['standard', 'ptc', 'cordis']) {
  test(`host preview: ${kind} variant executes private Git Bash while root PowerShell survives`, { timeout: 30000 }, async (t) => {
    assert.equal(process.platform, 'win32')
    const root = new Context(), cleanups = [], logs = []
    const own = (off) => { cleanups.push(off); return off }
    t.after(async () => { for (const off of cleanups.reverse()) await off() })
    async function mount(module, config) {
      const fiber = root.plugin(module, config)
      own(() => fiber.dispose()); await fiber
      return fiber
    }
    const cwd = process.cwd(), policy = { mode: 'danger-full-access', workspaceRoot: cwd }
    for (const [key, value] of Object.entries({
      sandboxPolicy: { defaultMode: policy.mode, resolve: () => policy },
      sandbox: { confine() { throw new Error('preview only uses full access') } },
      workingDirectory: { ensure: async () => cwd },
      loader: { internal: { import: (name) => import(name) } },
    })) own(root.provide(key, value))
    for (const module of [SystemPrompt, LocalSubprocessRuntime, SandboxPwshExecutor, ToolRuntime, shellEnv]) await mount(module)
    const official = root.reflect.store[root[Context.isolate].shell]
    const rows = pluginsFor({ kind, gitBash: true, hostExtras: { timeContext: true, toolSchedule: true, pluginMarket: true, compaction: true } })
    for (const row of rows.filter((row) => ['tool-bash', 'tool-pwsh'].includes(row.id) && row.disabled !== true)) {
      await mount(row.id === 'tool-bash' ? toolBash : toolPwsh)
    }
    const tools = root.get('tools')
    assert.deepEqual(tools.schemas().map((schema) => schema.name), ['pwsh'])
    let agentParent
    await mount({ inject: ['tools'], apply(ctx) { agentParent = ctx } })
    const agent = { session: { header: {} } }, agentScope = createAgentScope(agentParent, agent)
    agent.ctx = agentScope.ctx; own(() => agentScope.dispose())
    let ready, failed
    const settled = new Promise((resolve, reject) => { ready = resolve; failed = reject })
    const timer = setTimeout(() => failed(new Error('inline patch did not settle: ' + logs.join('\n'))), 15000)
    own(() => clearTimeout(timer))
    const patch = await mount((ctx) => mountInlineTools(ctx, {
      tools: (c) => c.get('tools'), agents: () => ({ list: () => [agent] }), createScope,
      pwshEnabled: () => true,
      log(message) {
        logs.push(message)
        if (message.includes('activation failed')) failed(new Error(message))
        if (message.includes('own bash tool activated')) ready()
      },
    }))
    await settled; clearTimeout(timer)
    const result = await tools.execute({
      agent, name: 'bash', callId: `variant-${kind}`, signal: new AbortController().signal,
      arguments: { description: 'Verify private variant executor', command: 'uname -s; printf "VARIANT_GITBASH_OK\\n"', workdir: cwd },
    })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(result.value.exitCode, 0)
    const text = result.content.map((block) => block.text ?? '').join('\n')
    assert.match(text, /MINGW(?:32|64)_NT-/)
    assert.match(text, /VARIANT_GITBASH_OK/)
    assert.equal(root.reflect.store[root[Context.isolate].shell], official)
    await patch.dispose()
    assert.ok(!tools.schemas(agent).some((schema) => schema.name === 'bash'))
    assert.ok(tools.schemas(agent).some((schema) => schema.name === 'pwsh'))
    assert.equal(root.reflect.store[root[Context.isolate].shell], official)
  })
}

test('host preview: real Core registry waits for activation then retires a registration during owner dispose', { timeout: 10000 }, async (t) => {
  const root = new Context(), cleanups = []
  t.after(async () => { for (const off of cleanups.reverse()) await off() })
  cleanups.push(root.provide('loader', { await: async () => {} }))
  cleanups.push(root.provide('sessionProjections', { register: () => () => {} }))
  const registryFiber = root.plugin(AgentPresetRegistry, { default: 'standard' })
  cleanups.push(() => registryFiber.dispose()); await registryFiber
  const registry = root.get('agentPresets')
  // Only activation is controlled: register()/unregister() are the installed
  // Core implementations. No Loader tree, filesystem or profile is mounted.
  let release, entered
  const activation = new Promise((resolve) => { release = resolve })
  const starting = new Promise((resolve) => { entered = resolve })
  registry.activate = async () => { entered(); await activation }
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const body = src.slice(src.indexOf('async function runDeclarativeEra('), src.indexOf('\nexport async function apply('))
  const run = new Function('cleanupLegacyTrees', 'resolveSkillsDir', 'probeHostExtras', 'effectivePresetIds', 'registerVariant', 'migrateVariantDefault', 'TAG', 'PEER_CAPABILITY', 'peerFact', 'PEER_PYTHON_FIELD', 'peerBackend', 'pythonBackendActive', 'PEER_PYTHON_BACKEND_FIELD', body + '\nreturn runDeclarativeEra')(
    () => {}, async () => undefined, async () => ({}), x.effectivePresetIds,
    (ctx, id) => ctx.agentPresets.register({ id, plugins: [] }), async () => true,
    '[host-preview]', x.PEER_CAPABILITY, x.peerFact, x.PEER_PYTHON_FIELD, x.peerBackend, x.pythonBackendActive, x.PEER_PYTHON_BACKEND_FIELD,
  )
  let ctx, variants = false
  const owner = root.plugin({ inject: ['agentPresets'], apply(value) { ctx = value } })
  cleanups.push(() => owner.dispose()); await owner
  await run(ctx, ['standard-gitbash'], () => false, () => ({ ok: false }), () => variants)
  variants = true; ctx.emit('loader/volatile-update', [['variantPresets']]); await starting
  assert.equal(registry.definitions.has('standard-gitbash'), true)
  let disposed = false
  const done = owner.dispose().then(() => { disposed = true })
  await tick(); assert.equal(disposed, false)
  release(); await done
  assert.equal(registry.definitions.has('standard-gitbash'), false)
  const unregister = await registry.register({ id: 'standard-gitbash', plugins: [] })
  await unregister()
  assert.equal(registry.definitions.size, 0, 'same id is reusable after awaited cleanup')
})
