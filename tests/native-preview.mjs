// Isolated actual installed Core, ToolRuntime, Jobs and controlled native Node.
// No profile, installation, real network/secret inspection or second runner.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { createScope as createAgentScope } from '@deepseek-ai/dsh-scope'
import * as toolsModule from '@deepseek-ai/dsh-tools'
import * as sandboxModule from '@deepseek-ai/dsh-sandbox'
import * as localBashModule from '@deepseek-ai/dsh-bash-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import { LocalJobRegistry } from '@deepseek-ai/dsh-jobs-local'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as shellEnv from '@deepseek-ai/dsh-shell-env'
import { createNativeOutputAdapter } from '../src/native-output.js'
import { createNativeExecutor } from '../src/native-executor.js'
import { createNativeToolModule, NATIVE_OUTPUT_FACTS_SCHEMA, NATIVE_OUTPUT_SCHEMA } from '../src/native-tool.js'

const EVIDENCE = process.env.DSH_NATIVE_EVIDENCE_DIR
if (!EVIDENCE || !path.isAbsolute(EVIDENCE)) throw new Error('Set DSH_NATIVE_EVIDENCE_DIR to an authorized absolute scratch directory')
const DIR = path.join(EVIDENCE, `preview-${randomUUID()}`)
fs.mkdirSync(DIR, { recursive: true })
const rows = []
const literal = value => ({ kind: 'literal', value })
const typedPath = value => ({ kind: 'path', value })
const request = (code, more = {}) => ({ description: 'Run controlled native Node sentinel', executable: typedPath(process.execPath), entrypoint: 'interpreter', argv: [literal('-e'), literal(code)], ...more })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function createScope(parent) {
  let ctx
  const fiber = parent.plugin(value => { ctx = value })
  return { fiber, get ctx() { return ctx }, dispose: () => fiber.dispose() }
}
async function fixture(t, { jobs = false, promote = false, controller = true, artifactFactory, ensure, missingDirectoryService = false, policyWorkspaceRoot = DIR } = {}) {
  const root = new Context()
  const disposers = []
  const spawned = []
  const scopes = []
  let mode = 'danger-full-access'
  let experimental = true
  let adapterConstructions = 0
  const policy = { defaultMode: 'danger-full-access', resolve: () => mode === undefined ? undefined : { mode, ...(policyWorkspaceRoot === null ? {} : { workspaceRoot: policyWorkspaceRoot }) } }
  const official = { name: 'official-preserved' }
  let agent
  for (const [name, value] of Object.entries({ shell: official, sandboxPolicy: policy,
    ...(missingDirectoryService ? {} : { workingDirectory: { ensure: ensure ?? (async () => DIR) } }), agents: { get: id => agent?.id === id ? agent : undefined } })) disposers.push(root.provide(name, value))
  const mount = async (module, config) => {
    const fiber = root.plugin(module, config)
    disposers.push(() => fiber.dispose())
    await fiber
    return fiber
  }
  for (const module of [LocalSubprocessRuntime, SystemPrompt, toolsModule.ToolRuntime, shellEnv]) await mount(module)
  const provider = root.get('subprocess')
  provider.internals.spillDir = DIR // documented test hook, isolated provider only
  const rootProvider = root.reflect.store[root[Context.isolate].subprocess]
  const rootShell = root.reflect.store[root[Context.isolate].shell]
  const agentId = `native-preview-${randomUUID()}`
  agent = { id: agentId, session: { header: { id: agentId, cwd: DIR } } }
  const agentScope = createAgentScope(root, agent)
  agent.ctx = agentScope.ctx
  disposers.push(() => agentScope.dispose())
  if (jobs) {
    await mount(LocalJobRegistry, { pumpPollMs: 5 })
    if (controller) await mount({ inject: ['jobs'], apply(ctx) { ctx.jobs.attachController('native-preview-controller') } })
  }
  const deps = { toolsModule, sandboxModule, localBashModule, experimentalEnabled: () => experimental,
    createScope(parent) { const scope = createScope(parent); scopes.push(scope); return scope },
    translateMsysPath: value => /^\/[a-z]\//i.test(value) ? `${value[1].toUpperCase()}:/${value.slice(3)}` : value,
    outputOptions: { OutputCollector, ...(artifactFactory ? {} : { artifactDirectory: DIR }), drainTimeoutMs: 200 },
    ...(artifactFactory ? { createArtifactDirectory: artifactFactory } : {}),
    createNativeOutputAdapter(provider, options) {
      adapterConstructions++
      const adapter = createNativeOutputAdapter(provider, options)
      return { spawn(spec) { const handle = adapter.spawn(spec); spawned.push({ spec, handle }); return handle } }
    },
  }
  const toolFiber = agent.ctx.plugin(createNativeToolModule(deps), { promoteOnTimeout: promote })
  await toolFiber
  disposers.push(() => toolFiber.dispose())
  const tools = root.get('tools')
  const run = (args, signal = new AbortController().signal) => tools.execute({ agent, name: 'gitbash_native', callId: randomUUID(), arguments: args, signal })
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose()
    assert.equal(root.reflect.store[root[Context.isolate].subprocess], undefined)
  })
  const directExecutor = createNativeExecutor({ get: key => root.get(key), workingDirectory: root.get('workingDirectory'), shellEnv: root.get('shellEnv') }, deps)
  const direct = async args => {
    const exec = { agent, signal: new AbortController().signal }
    return directExecutor.execute(await directExecutor.prepare(args, exec), exec)
  }
  return { root, agent, agentScope, toolFiber, spawned, scopes, run, direct,
    jobs: root.get('jobs'), setMode(value) { mode = value },
    setExperimental(value) { experimental = value; root.emit('loader/volatile-update', [['experimentalNative']]) },
    get adapterConstructions() { return adapterConstructions },
    preserved() { assert.equal(root.reflect.store[root[Context.isolate].subprocess], rootProvider); assert.equal(root.reflect.store[root[Context.isolate].shell], rootShell) },
  }
}

async function waitFor(check, label) {
  for (let i = 0; i < 300; i++) { if (check()) return; await delay(10) }
  throw new Error(`timed out waiting for ${label}`)
}

test('installed Core native: closed output schemas reject malformed facts and explicit degradation branches', () => {
  const facts = toolsModule.valueSchemaSpecToJsonSchema(NATIVE_OUTPUT_FACTS_SCHEMA)
  const validate = value => toolsModule.validateJsonSchemaValue(facts, value)
  assert.deepEqual(validate({ unavailable: true }), [])
  assert.deepEqual(validate({ projectionError: 'fixed projection sentinel', reliableText: false }), [])
  for (const value of [{}, { arbitrary: 'not allowed' }, { unavailable: false }, { unavailable: true, extra: 1 },
    { projectionError: 'fixed', reliableText: true }, { projectionError: 'fixed', reliableText: false, extra: 1 }]) {
    assert.ok(validate(value).length > 0, JSON.stringify(value))
  }
  const output = toolsModule.valueSchemaSpecToJsonSchema(NATIVE_OUTPUT_SCHEMA)
  const background = { kind: 'background', cwd: DIR, jobId: 'fixed-job', encoding: { stdoutEncoding: 'utf8', stderrEncoding: 'gbk', errors: 'strict' } }
  assert.deepEqual(toolsModule.validateJsonSchemaValue(output, background), [])
  assert.ok(toolsModule.validateJsonSchemaValue(output, { ...background, encoding: { ...background.encoding, extra: true } }).length > 0)
  rows.push({ name: 'closed schema validation', status: 'PASS' })
})

test('installed Core native: ToolRuntime exact argv, translated paths, root providers preserved', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const values = ['/all', '/c', '/c/SENTINEL', '', '"quoted"', 'tail\\', '中文😀', '&|<>^%FIXED%!fixed!']
  const msys = DIR.replace(/\\/g, '/').replace(/^([A-Z]):/i, (_, drive) => `/${drive.toLowerCase()}`) + '/typed sentinel.txt'
  const args = request('console.log(JSON.stringify(process.argv.slice(1)))')
  args.argv.push(literal('--'), ...values.map(literal), typedPath(msys))
  const response = await f.run(args)
  assert.equal(response.isError, false, JSON.stringify(response))
  assert.equal(response.value.exitCode, 0)
  assert.deepEqual(JSON.parse(response.value.stdout.text), [...values, path.win32.normalize(`${DIR}/typed sentinel.txt`)])
  assert.equal(f.spawned[0].spec.argv[0], path.win32.normalize(process.execPath))
  assert.equal(f.spawned[0].spec.cwd, path.win32.normalize(DIR))
  assert.equal(response.value.outputFacts.stdout.encoding, 'utf-8')
  assert.equal(response.value.status, 'completed')
  assert.equal(response.value.aborted, false)
  assert.equal(response.value.outputFacts.stdout.aborted, false)
  assert.equal(response.value.outputFacts.stdout.complete, true)
  const outputSchema = toolsModule.valueSchemaSpecToJsonSchema(NATIVE_OUTPUT_SCHEMA)
  for (const locate of [value => value.sandbox, value => value.outputFacts.budget, value => value.outputFacts.stdout,
    value => value.outputFacts.stdout.artifact, value => value.outputFacts.stdout.artifact.raw]) {
    const malformed = structuredClone(response.value)
    locate(malformed).undeclaredFact = 'fixed sentinel'
    assert.ok(toolsModule.validateJsonSchemaValue(outputSchema, malformed).length > 0)
  }
  const malformedBudget = structuredClone(response.value)
  malformedBudget.outputFacts.budget.artifactBytes = 'not-a-number'
  assert.ok(toolsModule.validateJsonSchemaValue(outputSchema, malformedBudget).length > 0)
  assert.ok(f.scopes.every(scope => scope.ctx.fiber.state === 4))
  f.preserved()
  rows.push({ name: t.name, status: 'PASS', producerExitCode: response.value.exitCode, outputFacts: response.value.outputFacts })
})

test('installed Core native: opt-out during artifact preparation refuses at final spawn, then re-enables', { timeout: 15000 }, async t => {
  let signalEntered
  const entered = new Promise(resolve => { signalEntered = resolve })
  let finish
  const artifact = new Promise(resolve => { finish = resolve })
  const f = await fixture(t, { artifactFactory: () => { signalEntered(); return artifact } })
  const pending = f.direct(request('console.log("MUST_NOT_RUN")'))
  await entered
  f.setExperimental(false)
  assert.ok(!f.root.get('tools').schemas(f.agent).some(tool => tool.name === 'gitbash_native'))
  finish(DIR)
  await assert.rejects(pending, /disabled by experimentalNative/)
  assert.equal(f.spawned.length, 0)
  assert.ok(f.scopes.every(scope => scope.ctx.fiber.state === 4))
  f.setExperimental(true)
  const response = await f.run(request('console.log("REENABLED")'))
  assert.equal(response.isError, false, JSON.stringify(response))
  assert.equal(response.value.stdout.text.trim(), 'REENABLED')
  assert.equal(f.spawned.length, 1)
  f.preserved()
})

test('installed Core native: typed path actually opens the fixed sentinel file', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const filename = path.join(DIR, 'typed path 中文.txt')
  fs.writeFileSync(filename, 'FIXED_TYPED_PATH_SENTINEL', 'utf8')
  const msys = filename.replace(/\\/g, '/').replace(/^([A-Z]):/i, (_, drive) => `/${drive.toLowerCase()}`)
  const args = request('console.log(require("node:fs").readFileSync(process.argv[1],"utf8"))')
  args.argv.push(literal('--'), typedPath(msys))
  const response = await f.run(args)
  assert.equal(response.isError, false, JSON.stringify(response))
  assert.equal(response.value.exitCode, 0)
  assert.equal(response.value.stdout.text.trim(), 'FIXED_TYPED_PATH_SENTINEL')
  rows.push({ name: t.name, status: 'PASS', producerExitCode: 0 })
})

test('installed Core native: each actual standing policy fails before adapter/scope/spawn', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  for (const mode of ['read-only', 'workspace-write', undefined]) {
    f.setMode(mode)
    const response = await f.run(request('console.log("MUST_NOT_RUN")'))
    assert.equal(response.isError, true)
    assert.match(JSON.stringify(response.error), /SANDBOX_UNAVAILABLE/)
  }
  assert.equal(f.spawned.length, 0)
  assert.equal(f.scopes.length, 0)
  assert.equal(f.adapterConstructions, 0)
  f.preserved()
  rows.push({ name: t.name, status: 'PASS', spawnCount: 0, adapterCount: 0 })
})

test('installed Core native: independent encoding and strict error preserve real producer exit', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const response = await f.run(request('process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4]));process.stderr.write("UTF8:中文😀")', { stdoutEncoding: 'gbk', errors: 'strict' }))
  assert.equal(response.isError, false, JSON.stringify(response))
  assert.equal(response.value.stdout.text, '中文')
  assert.equal(response.value.stderr.text, 'UTF8:中文😀')
  const invalid = await f.run(request('process.stdout.write(Buffer.from([0xff]));process.exitCode=7', { errors: 'strict' }))
  assert.equal(invalid.isError, false, JSON.stringify(invalid))
  assert.equal(invalid.value.exitCode, 7)
  assert.ok(invalid.value.outputFacts.stdout.decodeError)
  f.preserved()
  rows.push({ name: t.name, status: 'PASS', invalidProducerExitCode: 7, outputFacts: invalid.value.outputFacts })
})

test('installed Core native: concurrent encodings do not cross calls and raw preserves bytes', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const calls = await Promise.all([
    f.run(request('setTimeout(()=>process.stdout.write(Buffer.from([0xd6,0xd0])),70)', { stdoutEncoding: 'gbk', errors: 'strict' })),
    f.run(request('setTimeout(()=>process.stdout.write("UTF8:😀"),20)', { errors: 'strict' })),
  ])
  for (const response of calls) assert.equal(response.isError, false, JSON.stringify(response))
  assert.equal(calls[0].value.stdout.text, '中')
  assert.equal(calls[1].value.stdout.text, 'UTF8:😀')
  const raw = await f.run(request('process.stdout.write(Buffer.from([0xff,0x00,0xd6,0xd0]))', { stdoutEncoding: 'raw' }))
  assert.equal(raw.isError, false, JSON.stringify(raw))
  assert.equal(raw.value.stdout.text, '')
  assert.equal(raw.value.outputFacts.stdout.reliableText, false)
  assert.deepEqual(fs.readFileSync(raw.value.outputFacts.stdout.artifact.raw.path), Buffer.from([0xff, 0x00, 0xd6, 0xd0]))
  rows.push({ name: t.name, status: 'PASS', rawProducerExitCode: raw.value.exitCode })
})

test('installed Core native: malformed input and pre-cancelled calls cannot spawn', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const malformed = [
    request('console.log("MUST_NOT_RUN")', { env: { FIXED: 'SENTINEL' } }),
    request('console.log("MUST_NOT_RUN")', { entrypoint: 'native' }),
    request('console.log("MUST_NOT_RUN")', { executable: typedPath(path.join(DIR, 'script.cmd')) }),
    request('console.log("MUST_NOT_RUN")', { stdoutEncoding: 'auto' }),
    request('console.log("MUST_NOT_RUN")', { cwd: typedPath('/unmapped/sentinel') }),
  ]
  for (const args of malformed) assert.equal((await f.run(args)).isError, true)
  const aborted = new AbortController()
  aborted.abort(new Error('fixed pre-cancel sentinel'))
  assert.equal((await f.run(request('console.log("MUST_NOT_RUN")'), aborted.signal)).isError, true)
  assert.equal(f.spawned.length, 0)
  assert.equal(f.scopes.length, 0)
  assert.equal(f.adapterConstructions, 0)
  rows.push({ name: t.name, status: 'PASS', spawnCount: 0 })
})

test('installed Core native: credential scrub with fixed sentinel, no host environment copy', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const old = process.env.NATIVE_PREVIEW_SECRET
  process.env.NATIVE_PREVIEW_SECRET = 'FIXED_NON_SECRET_SENTINEL'
  try {
    const response = await f.run(request('console.log(process.env.NATIVE_PREVIEW_SECRET===undefined?"SCRUBBED":"LEAK")'))
    assert.equal(response.isError, false, JSON.stringify(response))
    assert.equal(response.value.stdout.text.trim(), 'SCRUBBED')
    assert.ok(Object.keys(f.spawned[0].spec.env).every(key => /^(DSH_|NO_COLOR$|TERM$|PAGER$|GIT_PAGER$)/.test(key)))
  } finally { if (old === undefined) delete process.env.NATIVE_PREVIEW_SECRET; else process.env.NATIVE_PREVIEW_SECRET = old }
  rows.push({ name: t.name, status: 'PASS' })
})

test('installed Core native: foreground timeout kills managed producer and releases own scope', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const response = await f.run(request('console.log("READY");setTimeout(()=>console.log("LATE"),3000)', { timeoutMs: 400 }))
  assert.equal(response.isError, false, JSON.stringify(response))
  assert.equal(response.value.timedOut, true)
  assert.doesNotMatch(response.value.stdout.text, /LATE/)
  assert.equal(await f.spawned[0].handle.waitForExit(AbortSignal.timeout(3000)), true)
  assert.ok(f.scopes.every(scope => scope.ctx.fiber.state === 4))
  f.preserved()
  rows.push({ name: t.name, status: 'PASS', producerExitCode: response.value.exitCode, timedOut: true })
})

test('installed Core native: caller cancellation terminates range without late sentinel', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const abort = new AbortController()
  const running = f.run(request('console.log("READY");setTimeout(()=>console.log("LATE"),3000)'), abort.signal)
  await waitFor(() => f.spawned[0]?.handle.collected.stdout.readFrom(0).text.includes('READY'), 'READY')
  abort.abort(new Error('fixed preview cancellation'))
  const response = await running
  assert.equal(await f.spawned[0].handle.waitForExit(AbortSignal.timeout(3000)), true)
  assert.doesNotMatch(f.spawned[0].handle.collected.stdout.readFrom(0).text, /LATE/)
  if (!response.isError) assert.equal(response.value.aborted, true)
  f.preserved()
  rows.push({ name: t.name, status: 'PASS', toolIsError: response.isError })
})

test('installed Core native: direct kill and owner disposal mark cancellation before producer settlement', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const first = await f.direct(request('console.log("READY");setTimeout(()=>console.log("LATE"),3000)'))
  await waitFor(() => first.observed.stdout.readFrom(0).text.includes('READY'), 'direct kill READY')
  assert.equal(first.kill(), true)
  const killed = await first.result()
  assert.equal(killed.status, 'killed')
  assert.equal(killed.aborted, true)
  assert.equal(killed.outputFacts.stdout.aborted, true)
  assert.equal(killed.outputFacts.stdout.complete, false)
  const second = await f.direct(request('console.log("READY");setTimeout(()=>console.log("LATE"),3000)'))
  await waitFor(() => second.observed.stdout.readFrom(0).text.includes('READY'), 'owner dispose READY')
  await f.agentScope.dispose()
  const disposed = await second.result()
  assert.equal(disposed.status, 'killed')
  assert.equal(disposed.aborted, true)
  assert.equal(disposed.outputFacts.stdout.aborted, true)
  assert.equal(disposed.outputFacts.stdout.complete, false)
  for (const result of [killed, disposed]) assert.doesNotMatch(result.stdout.text, /LATE/)
  for (const { handle } of f.spawned) assert.equal(await handle.waitForExit(AbortSignal.timeout(3000)), true)
  rows.push({ name: t.name, status: 'PASS', kill: { status: killed.status, aborted: killed.aborted, complete: killed.outputFacts.stdout.complete }, ownerDispose: { status: disposed.status, aborted: disposed.aborted, complete: disposed.outputFacts.stdout.complete } })
})

test('installed Core native: artifact preparation deadline returns before a late callback and never spawns', { timeout: 15000 }, async t => {
  let finish
  let preparationSignal
  const late = new Promise(resolve => { finish = resolve })
  const f = await fixture(t, { artifactFactory: async (_request, exec) => { preparationSignal = exec.signal; return late } })
  const startedAt = Date.now()
  const response = await f.run(request('console.log("MUST_NOT_RUN")', { timeoutMs: 120 }))
  assert.equal(response.isError, true)
  assert.match(JSON.stringify(response), /preparation timed out/)
  assert.ok(Date.now() - startedAt < 1500)
  assert.equal(preparationSignal.aborted, true)
  assert.equal(f.spawned.length, 0)
  assert.ok(f.scopes.every(scope => scope.ctx.fiber.state === 4))
  finish(DIR)
  await delay(50)
  assert.equal(f.spawned.length, 0, 'late callback cannot resume the cancelled execution')
  assert.ok(fs.statSync(DIR).isDirectory(), 'late directory remains with its trusted retention owner')
  rows.push({ name: t.name, status: 'PASS', spawnCount: 0 })
})

test('installed Core native: workspace preparation deadline is bounded before execution scope', { timeout: 15000 }, async t => {
  const f = await fixture(t, { ensure: () => new Promise(() => {}) })
  const startedAt = Date.now()
  const response = await f.run(request('console.log("MUST_NOT_RUN")', { timeoutMs: 60 }))
  assert.equal(response.isError, true)
  assert.match(JSON.stringify(response), /preparation timed out/)
  assert.ok(Date.now() - startedAt < 1500)
  assert.equal(f.spawned.length, 0)
  assert.equal(f.scopes.length, 0)
  rows.push({ name: t.name, status: 'PASS', spawnCount: 0 })
})

test('installed Core native: Jobs background, consuming reads and final encoding facts', { timeout: 15000 }, async t => {
  const f = await fixture(t, { jobs: true })
  const response = await f.run(request('console.log("READY");setTimeout(()=>console.log("LATE"),350)', { run_in_background: true }))
  assert.equal(response.isError, false, JSON.stringify(response))
  assert.equal(response.value.kind, 'background')
  const id = response.value.jobId
  await waitFor(() => f.spawned.length > 0, 'job spawn')
  assert.notEqual(f.scopes[0].ctx.fiber.state, 4, 'background handoff does not dispose execution scope')
  const first = f.jobs.read(id, f.agent.id)
  const view = await f.jobs.wait(id, 5000, f.agent.id)
  assert.equal(view.status, 'completed')
  const second = f.jobs.read(id, f.agent.id)
  const text = [...first.chunks, ...second.chunks].map(chunk => chunk.text).join('')
  assert.match(text, /READY/)
  assert.match(text, /LATE/)
  assert.match(text, /native output facts/)
  assert.equal(f.jobs.read(id, f.agent.id).chunks.length, 0)
  assert.throws(() => f.jobs.read(id, 'another-owner'), /another session/)
  f.preserved()
  rows.push({ name: t.name, status: 'PASS', jobId: id, statusAfterWait: view.status })
})

test('installed Core native: promotion continues; tool fiber reload does not kill handed-off job', { timeout: 15000 }, async t => {
  const f = await fixture(t, { jobs: true, promote: true })
  const response = await f.run(request('console.log("READY");setTimeout(()=>console.log("AFTER_PROMOTION"),900)', { timeoutMs: 350 }))
  assert.equal(response.isError, false, JSON.stringify(response))
  assert.equal(response.value.kind, 'promoted')
  await f.toolFiber.dispose()
  const view = await f.jobs.wait(response.value.jobId, 5000, f.agent.id)
  assert.equal(view.status, 'completed')
  assert.match(f.jobs.read(response.value.jobId, f.agent.id).chunks.map(chunk => chunk.text).join(''), /AFTER_PROMOTION/)
  f.preserved()
  rows.push({ name: t.name, status: 'PASS', jobId: response.value.jobId })
})

test('installed Core native: Jobs controller admission refusal never spawns', { timeout: 15000 }, async t => {
  const f = await fixture(t, { jobs: true, controller: false })
  const response = await f.run(request('console.log("MUST_NOT_RUN")', { run_in_background: true }))
  assert.equal(response.isError, true)
  assert.match(JSON.stringify(response), /no job controller/)
  assert.equal(f.spawned.length, 0)
  rows.push({ name: t.name, status: 'PASS', spawnCount: 0 })
})

test('installed Core native: job_kill and owner disposal terminate only owned ranges', { timeout: 20000 }, async t => {
  const f = await fixture(t, { jobs: true })
  const first = await f.run(request('console.log("READY");setTimeout(()=>console.log("LATE"),5000)', { run_in_background: true }))
  assert.equal(first.isError, false, JSON.stringify(first))
  await waitFor(() => f.spawned[0]?.handle.collected.stdout.readFrom(0).text.includes('READY'), 'first READY')
  f.jobs.kill(first.value.jobId, f.agent.id, 'fixed preview job_kill')
  const killed = await f.jobs.wait(first.value.jobId, 5000, f.agent.id)
  assert.equal(killed.status, 'killed')
  const second = await f.run(request('console.log("READY");setTimeout(()=>console.log("LATE"),5000)', { run_in_background: true }))
  assert.equal(second.isError, false, JSON.stringify(second))
  await waitFor(() => f.spawned[1]?.handle.collected.stdout.readFrom(0).text.includes('READY'), 'second READY')
  await f.agentScope.dispose()
  for (const { handle } of f.spawned) {
    assert.equal(await handle.waitForExit(AbortSignal.timeout(3000)), true)
    assert.doesNotMatch(handle.collected.stdout.readFrom(0).text, /LATE/)
  }
  f.preserved()
  rows.push({ name: t.name, status: 'PASS', killStatus: killed.status })
})

process.on('exit', code => {
  fs.writeFileSync(path.join(DIR, 'results.json'), JSON.stringify({ exitCode: code, node: process.version, core: 'installed host via --import loader', rows }, null, 2))
  console.log(`Native preview evidence: ${DIR}`)
})


test('installed Core native: missing directory service uses policy root then header for a real producer', {timeout:15000}, async t=>{
  for(const policyWorkspaceRoot of [DIR,null]){
    const f=await fixture(t,{missingDirectoryService:true,policyWorkspaceRoot});
    const response=await f.run(request('console.log(process.cwd())'));
    assert.equal(response.isError,false,JSON.stringify(response));
    assert.equal(response.value.stdout.text.trim(),path.win32.normalize(DIR));
    assert.equal(f.spawned.length,1);f.preserved();
  }
});


test('installed Core native: cmd literal /c reaches the interpreter without MSYS conversion', {timeout:15000}, async t=>{
  const f=await fixture(t);
  const executable=path.join(process.env.SystemRoot??'C:/Windows','System32','cmd.exe');
  const response=await f.run({description:'Fixed cmd interpreter sentinel',executable:typedPath(executable),entrypoint:'interpreter',argv:['/d','/s','/c','echo CMD_FIXED_SENTINEL'].map(literal)});
  assert.equal(response.isError,false,JSON.stringify(response));assert.equal(response.value.exitCode,0);
  assert.equal(response.value.stdout.text.trim(),'CMD_FIXED_SENTINEL');
  assert.ok(f.spawned[0].spec.argv.includes('/c'));f.preserved();
});

test('installed Core native: Windows PowerShell encoded command declares UTF16 output explicitly', {timeout:15000}, async t=>{
  const f=await fixture(t);
  const executable=path.join(process.env.SystemRoot??'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const code='[Console]::OutputEncoding = [System.Text.Encoding]::Unicode; [Console]::Write("PS_FIXED_中文_SENTINEL")';
  const encoded=Buffer.from(code,'utf16le').toString('base64');
  const response=await f.run({description:'Fixed PowerShell interpreter sentinel',executable:typedPath(executable),entrypoint:'interpreter',argv:['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded].map(literal),stdoutEncoding:'utf16le'});
  assert.equal(response.isError,false,JSON.stringify(response));assert.equal(response.value.exitCode,0);
  assert.equal(response.value.stdout.text,'PS_FIXED_中文_SENTINEL');f.preserved();
});
