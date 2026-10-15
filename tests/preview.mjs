import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { createScope as createAgentScope } from '@deepseek-ai/dsh-scope'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as shellEnv from '@deepseek-ai/dsh-shell-env'
import * as toolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import { GitBashSandboxExecutor } from '../src/shell.js'
import { mountInlineTools } from '../src/inline-tools.js'

function createScope(parent) {
  let childCtx
  const fiber = parent.plugin((ctx) => { childCtx = ctx })
  return { fiber, get ctx() { return childCtx }, dispose: () => fiber.dispose() }
}

// This is a headless runtime preview, not a UI preview: actual installed Core
// services and real Win32 processes, with an isolated Context and temporary cwd.
// Policy/session wiring is fixture-owned; no production profile or model calls.
test('preview: real host registers and executes Git Bash without replacing PowerShell', { timeout: 30000 }, async (t) => {
  assert.equal(process.platform, 'win32', 'this preview requires Windows and Git for Windows')
  const cwd = mkdtempSync(join(tmpdir(), 'gitbash-preview-'))
  const root = new Context()
  const cleanups = []
  const logs = []
  let experimental = true
  const own = (dispose) => { cleanups.push(dispose); return dispose }
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
    rmSync(cwd, { recursive: true, force: true })
  })
  async function mount(module, config) {
    const fiber = root.plugin(module, config)
    own(() => fiber.dispose())
    await fiber
    return fiber
  }
  const policy = { mode: 'danger-full-access', workspaceRoot: cwd }
  own(root.provide('sandboxPolicy', { defaultMode: policy.mode, resolve: () => policy.mode === undefined ? undefined : policy }))
  own(root.provide('sandbox', { confine() { throw new Error('preview never requests confinement') } }))
  own(root.provide('workingDirectory', { ensure: async () => cwd }))
  own(root.provide('loader', { internal: { import: (name) => import(name) } }))
  await mount(SystemPrompt)
  await mount(LocalSubprocessRuntime)
  await mount(SandboxPwshExecutor)
  await mount(ToolRuntime)
  await mount(shellEnv)
  await mount(toolPwsh)
  const official = root.reflect.store[root[Context.isolate].shell]
  assert.ok(root.get('shell'), 'the actual official pwsh executor is active')
  const tools = root.get('tools')
  assert.ok(tools.schemas().some((schema) => schema.name === 'pwsh'))

  // Reproduce the original failure with the actual executor superclass chain.
  const plain = createScope(root)
  own(() => plain.dispose())
  await plain.fiber
  await assert.rejects(async () => {
    const fiber = plain.ctx.plugin(GitBashSandboxExecutor)
    await fiber
  }, /service "shell" has been registered at <SandboxPwshExecutor>/)
  await plain.dispose()

  let agentParent
  await mount({ inject: ['tools'], apply(ctx) { agentParent = ctx } })
  const agent = { session: { header: {} } }
  const agentScope = createAgentScope(agentParent, agent)
  agent.ctx = agentScope.ctx
  own(() => agentScope.dispose())
  assert.ok(tools.schemas(agent).some((schema) => schema.name === 'pwsh'))
  async function startPatch(pwshVisible) {
    let resolveReady
    let rejectReady
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    const timer = setTimeout(() => rejectReady(new Error('bash registration did not settle: ' + logs.join('\n'))), 15000)
    own(() => clearTimeout(timer))
    const patch = root.plugin((ctx) => mountInlineTools(ctx, {
      tools: (c) => c.get('tools'),
      agents: () => ({ list: () => [agent] }),
      createScope,
      pwshEnabled: () => pwshVisible,
      experimentalEnabled: () => experimental,
      log(message) {
        logs.push(message)
        if (message.includes('activation failed') || message.includes('hide failed')) rejectReady(new Error(message))
        if (message.includes('own bash tool activated')) resolveReady()
      },
    }))
    own(() => patch.dispose())
    await patch
    await ready
    clearTimeout(timer)
    return patch
  }
  const patch = await startPatch(true)
  t.diagnostic('own bash tool activated; checking the actual schema list')
  const names = tools.schemas(agent).map((schema) => schema.name)
  assert.ok(names.includes('bash'), 'bash reaches the actual host tool schema list')
  assert.ok(names.includes('pwsh'), 'the opt-in real PowerShell tool is preserved')
  assert.equal(root.reflect.store[root[Context.isolate].shell], official)
  assert.ok(!tools.schemas().some((schema) => schema.name === 'bash'), 'bash is per-agent, not global')

  const run = (name, command) => tools.execute({
    agent, name, callId: `preview-${name}-${Date.now()}`,
    arguments: { description: `Verify isolated ${name} execution`, command, workdir: cwd },
    signal: new AbortController().signal,
  })
  t.diagnostic('dispatching real bash through ToolRuntime')
  const bash = await run('bash', 'command -v bash; uname -s; printf "GITBASH_PREVIEW_OK\\n"')
  assert.equal(bash.isError, false, JSON.stringify(bash))
  const text = bash.content.map((block) => block.text ?? '').join('\n')
  assert.match(text, /MINGW(?:32|64)_NT-/)
  assert.match(text, /GITBASH_PREVIEW_OK/)
  assert.equal(bash.value.exitCode, 0)
  // Real Git Bash, fixture-owned policy only: OFF restores truthful legacy facts.
  for (const mode of ['read-only', 'workspace-write']) {
    policy.mode = mode
    const denied = await run('bash', 'printf "MUST_NOT_START\\n"')
    assert.equal(denied.isError, true)
    assert.match(denied.error.message, /command was not started/)
    experimental = false
    root.emit('loader/volatile-update', [['experimentalNative']])
    const legacy = await run('bash', 'printf "LEGACY_FIXED_SENTINEL\\n"')
    assert.equal(legacy.isError, false, JSON.stringify(legacy))
    assert.equal(legacy.value.sandbox.mode, mode)
    assert.equal(legacy.value.sandbox.enforcement, 'unconfined')
    assert.match(legacy.value.stdout.text, /LEGACY_FIXED_SENTINEL/)
    experimental = true
    root.emit('loader/volatile-update', [['experimentalNative']])
    assert.equal((await run('bash', 'printf "MUST_NOT_START\\n"')).isError, true)
  }
  policy.mode = undefined
  assert.equal((await run('bash', 'printf "MUST_NOT_START\\n"')).isError, true)
  policy.mode = 'danger-full-access'
  const pwsh = await run('pwsh', 'Write-Output "POWERSHELL_PREVIEW_OK"; Get-Process -Id $PID | Select-Object -ExpandProperty ProcessName')
  assert.equal(pwsh.isError, false, JSON.stringify(pwsh))
  assert.match(pwsh.content.map((block) => block.text ?? '').join('\n'), /POWERSHELL_PREVIEW_OK/)
  assert.equal(root.reflect.store[root[Context.isolate].shell], official)
  await patch.dispose()
  assert.ok(!tools.schemas(agent).some((schema) => schema.name === 'bash'), 'plugin disposal unregisters bash')
  assert.ok(tools.schemas(agent).some((schema) => schema.name === 'pwsh'))

  // Also verify the default OFF switch: bash is visible, pwsh is hidden, and
  // removing the inline patch restores the official tool without replacing it.
  const hiddenPatch = await startPatch(false)
  const defaultNames = tools.schemas(agent).map((schema) => schema.name)
  assert.ok(defaultNames.includes('bash'))
  assert.ok(!defaultNames.includes('pwsh'))
  const defaultBash = await run('bash', 'printf "DEFAULT_BASH_OK\\n"')
  assert.equal(defaultBash.isError, false, JSON.stringify(defaultBash))
  assert.equal(defaultBash.value.exitCode, 0)
  await hiddenPatch.dispose()
  assert.ok(tools.schemas(agent).some((schema) => schema.name === 'pwsh'))
  assert.ok(!tools.schemas(agent).some((schema) => schema.name === 'bash'))
  assert.equal(root.reflect.store[root[Context.isolate].shell], official)

  const requireHost = createRequire(join(process.env.DSH_PREVIEW_HOST_DIR, 'package.json'))
  const core = JSON.parse(readFileSync(requireHost.resolve('@deepseek-ai/dsh/package.json'), 'utf8'))
  console.log(JSON.stringify({ preview: 'passed', core: core.version, node: process.version, platform: process.platform,
    bashVisible: true, bashExitCode: bash.value.exitCode, pwshExecuted: true, defaultPwshHidden: true, officialShellPreserved: true, bashRemovedOnDispose: true }))
})
