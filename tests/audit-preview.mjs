import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import * as shellEnv from '@deepseek-ai/dsh-shell-env'
import * as toolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import * as plugin from '../src/index.js'
import { registerExperimentalTool } from '../src/experimental-tools.js'
import { executeTool, nativeExecutor, ptcExecutor } from './host-runtime.mjs'

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'gitbash audit 中文 '))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  const root = new Context(), disposers = []
  const mount = async (mod, config, owner = root) => {
    const fiber = owner.plugin(mod, config); disposers.push(() => fiber.dispose()); await fiber; return fiber
  }
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
    rmSync(directory, { recursive: true, force: true })
  })
  const policy = { mode: 'danger-full-access', workspaceRoot: directory }
  for (const [name, value] of Object.entries({
    sandboxPolicy: { defaultMode: policy.mode, resolve: () => policy },
    sandbox: { confine() { throw Error('unexpected confinement') } },
    workingDirectory: { ensure: async () => directory },
    loader: { entries: () => [], internal: { import: name => import(name) } },
    agentPresets: { list: () => [] },
  })) disposers.push(root.provide(name, value))
  for (const mod of [SystemPrompt, ToolRuntime, nativeExecutor, LocalSubprocessRuntime, SandboxPwshExecutor, shellEnv, toolPwsh]) await mount(mod)
  const tools = root.get('tools')
  const originalShell = root.reflect.store[root[Context.isolate].shell]
  const agent = { id: 'audit-agent', session: { header: {} } }
  const scope = createScope(root, agent); agent.ctx = scope.ctx; disposers.push(() => scope.dispose())
  let signalReady
  const ready = new Promise(resolve => { signalReady = resolve })
  await mount(ctx => {
    ctx.on('tools/change', () => {
      if (tools.schemas(agent).some(tool => tool.name === 'gitbash_native')) signalReady()
    })
  })
  await mount(plugin, { variantPresets: false, adoptSidebar: false, autoTerminalShell: false, fastctxTools: false })
  root.emit('agent/created', { agent })
  let timer
  try { await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('companion activation timeout')), 8000) })]) }
  finally { clearTimeout(timer) }
  const run = (name, args, signal = new AbortController().signal) => executeTool(tools, { agent, name, callId: name, arguments: args, signal })
  return { root, tools, agent, mount, run, directory, originalShell, policy }
}

test('audit host: final native/PTC/complete-persona prompts carry owned routing and hidden tools stay hidden', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const assemble = () => f.root.get('systemPrompt').assemble({ agent: f.agent, scope: f.agent })
  let prompt = await assemble()
  let description = prompt.tools.find(tool => tool.name === 'bash').description
  assert.match(description, /gitbash_native before execution/)
  assert.match(description, /gitbash_to_native_path only/)
  assert.doesNotMatch(description, /use the pwsh tool ONLY/)
  await f.mount({ inject: ['systemPrompt'], apply(ctx) {
    ctx.systemPrompt.section({ name: 'audit:complete', order: 0, complete: true, text: 'COMPLETE PERSONA' })
  } }, undefined, f.agent.ctx)
  prompt = await assemble()
  assert.equal(prompt.sections.length, 1)
  assert.match(prompt.tools.find(tool => tool.name === 'bash').description, /gitbash_native before execution/)
  const off = f.agent.ctx.provide('ptcRuntime', { language: 'typescript', executionInstructions: 'test', resolve: s => s, run: async () => ({ logs: [], value: null }) })
  t.after(off)
  await f.mount(ptcExecutor, undefined, f.agent.ctx)
  prompt = await assemble()
  assert.deepEqual(prompt.tools.map(tool => tool.name), ['run_code'])
  // A complete persona intentionally suppresses ordinary sections, while the
  // tool definitions remain routed and PTC has its own official transport guidance.
  assert.match(f.tools.get('bash', f.agent).description, /gitbash_native before execution/)
})

test('audit host: full plugin preserves Python source before real interpreter dispatch', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const captured = []
  const off = f.agent.ctx.provide('ptcRuntime', {
    language: 'python', executionInstructions: 'Print program results.', resolve: s => s,
    async run(spec) {
      captured.push(spec.program)
      const child = spawnSync(process.env.DSH_PREVIEW_PYTHON ?? 'python', ['-c', spec.program], { cwd: f.directory, encoding: 'utf8', windowsHide: true })
      if (child.status !== 0) throw new Error(child.stderr || String(child.error))
      return { logs: [child.stdout.trim()], value: child.stdout.trim() }
    },
  })
  t.after(off)
  await f.mount(ptcExecutor, undefined, f.agent.ctx)
  const code = 'print("PYTHON_AUDIT_OK /c/data.txt")'
  const result = await f.run('run_code', { description: 'Check Python program preservation', code })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.deepEqual(captured, [code])
  assert.match(JSON.stringify(result), /PYTHON_AUDIT_OK/)
})

test('audit host: hidden ancestor ownership is preserved, with restoration after foreign disposal', async t => {
  const root = new Context(), cleanups = []
  t.after(async () => { for (const off of cleanups.reverse()) await off() })
  for (const mod of [SystemPrompt, ToolRuntime, nativeExecutor]) { const fiber = root.plugin(mod); await fiber; cleanups.push(() => fiber.dispose()) }
  let toolsContext
  const access = root.plugin({ inject: ['tools'], apply(ctx) { toolsContext = ctx } }); await access; cleanups.push(() => access.dispose())
  const parent = {}, child = {}
  const parentScope = createScope(toolsContext, parent); cleanups.push(() => parentScope.dispose())
  const childScope = createScope(parentScope.ctx, child, { parent }); cleanups.push(() => childScope.dispose())
  const definition = value => defineTool({ name: 'gitbash_to_native_path', description: value, parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, execute: () => value })
  const foreign = parentScope.ctx.tools.register(definition('FOREIGN'))
  cleanups.push(foreign)
  cleanups.push(childScope.ctx.tools.restrict({ deny: ['gitbash_to_native_path'] }))
  let refresh
  const owner = childScope.ctx.plugin(ctx => { refresh = registerExperimentalTool(ctx, () => definition('OWN'), () => true, { scope: child }) })
  await owner; cleanups.push(() => owner.dispose())
  assert.equal(root.get('tools').schemas(child).some(tool => tool.name === 'gitbash_to_native_path'), false)
  foreign(); refresh()
  assert.equal(root.get('tools').get('gitbash_to_native_path', child).description, 'OWN')
})
