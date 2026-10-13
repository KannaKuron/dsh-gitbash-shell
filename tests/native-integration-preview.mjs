// Independent installed-Core review. No production profile or OS confinement.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { createScope as createAgentScope } from '@deepseek-ai/dsh-scope'
import * as sandboxModule from '@deepseek-ai/dsh-sandbox'
import * as localBashModule from '@deepseek-ai/dsh-bash-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import { createNativeExecutor } from '../src/native-executor.js'
import { createNativeOutputAdapter } from '../src/native-output.js'

const evidence = process.env.DSH_NATIVE_REVIEW_EVIDENCE_DIR
assert.ok(evidence && path.isAbsolute(evidence), 'Explicit authorized review evidence directory required')
const directory = path.join(evidence, `independent-${randomUUID()}`)
fs.mkdirSync(directory, { recursive: true })
const observations = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const latch = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const request = (code = 'process.stdout.write("FIXED_REVIEW_SENTINEL")', patch = {}) => ({
  description: 'Independent fixed native review sentinel', executable: { kind: 'path', value: process.execPath },
  entrypoint: 'interpreter', argv: ['-e', code].map(value => ({ kind: 'literal', value })), ...patch,
})
function scope(parent) {
  let ctx
  const fiber = parent.plugin(value => { ctx = value })
  return { fiber, get ctx() { return ctx }, dispose: () => fiber.dispose() }
}
async function fixture(t, overrides = {}) {
  const root = new Context()
  let mode = 'danger-full-access', resolves = 0, artifactCalls = 0, denyAt = Infinity
  const agent = { id: randomUUID(), session: { header: { id: randomUUID() } } }
  const disposers = []
  const scopes = [], handles = []
  for (const [name, service] of Object.entries({
    shell: { fixedOfficial: true },
    sandboxPolicy: { resolve(input) { assert.equal(input.session, agent.session); resolves++; return mode ? { mode: resolves >= denyAt ? 'read-only' : mode, workspaceRoot: directory } : undefined } },
    workingDirectory: { ensure: async () => directory }, shellEnv: { collect: () => ({ DSH_REVIEW_SENTINEL: 'FIXED_NON_SECRET' }) },
  })) disposers.push(root.provide(name, service))
  const providerFiber = root.plugin(LocalSubprocessRuntime); await providerFiber
  disposers.push(() => providerFiber.dispose())
  root.get('subprocess').internals.spillDir = directory
  const entries = ['shell', 'subprocess'].map(name => root.reflect.store[root[Context.isolate][name]])
  const agentScope = createAgentScope(root, agent); agent.ctx = agentScope.ctx
  disposers.push(() => agentScope.dispose())
  const deps = {
    localBashModule, sandboxModule, translateMsysPath: value => value,
    createScope(parent) { const value = scope(parent); scopes.push(value); return value },
    outputOptions: { OutputCollector, drainTimeoutMs: 50, maxTotalBytes: 4 * 1024 * 1024, maxSpillBytes: 8192 },
    async createArtifactDirectory(...args) { artifactCalls++; return overrides.artifact ? overrides.artifact(...args) : directory },
    createNativeOutputAdapter(provider, options) {
      const adapter = createNativeOutputAdapter(provider, options)
      return { spawn(spec) { const handle = adapter.spawn(spec); handles.push(handle); return handle } }
    },
  }
  const executor = createNativeExecutor(agent.ctx, deps)
  const abort = new AbortController()
  const exec = { agent, signal: abort.signal }
  const run = async args => executor.execute(await executor.prepare(args, exec), exec)
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose() })
  return { executor, deps, exec, abort, run, agentScope, scopes, handles, setMode(value) { mode = value },
    get artifactCalls() { return artifactCalls }, get resolves() { return resolves }, denyOnResolve(number) { denyAt = number },
    preserved() { for (const [i, name] of ['shell', 'subprocess'].entries()) assert.equal(root.reflect.store[root[Context.isolate][name]], entries[i]) },
  }
}
async function ready(handle) {
  for (let i = 0; i < 200; i++) {
    if (handle?.collected.stdout.readFrom(0).text.includes('READY')) return
    await delay(10)
  }
  throw new Error('Fixed READY sentinel did not arrive')
}

test('review: prepared DTO is non-forgeable and executor-local', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  const prepared = await f.executor.prepare(request(), f.exec)
  await assert.rejects(f.executor.execute({ ...prepared }, f.exec), /must be prepared/)
  const another = createNativeExecutor(f.exec.agent.ctx, f.deps)
  await assert.rejects(another.execute(prepared, f.exec), /must be prepared/)
  assert.equal(f.scopes.length, 0); assert.equal(f.handles.length, 0); assert.equal(f.artifactCalls, 0)
  f.preserved()
})

test('review: all repeated policy gates including the real executeArgv spawn seam fail closed', { timeout: 15000 }, async t => {
  for (const gate of [2, 3, 4, 5, 6]) {
    await t.test(`policy resolve ${gate}`, async sub => {
      const f = await fixture(sub)
      const prepared = await f.executor.prepare(request(), f.exec)
      f.denyOnResolve(gate)
      const attempt = async () => { const proc = await f.executor.execute(prepared, f.exec); await proc.result() }
      await assert.rejects(attempt(), /no confined backend/)
      assert.equal(f.handles.length, 0)
      assert.ok(f.scopes.every(value => value.ctx.fiber.state === 4))
      f.preserved()
    })
  }
})

test('review: actual policy changes during artifact await cannot spawn', { timeout: 10000 }, async t => {
  const entered = latch(), release = latch()
  const f = await fixture(t, { artifact: async () => { entered.resolve(); await release.promise; return directory } })
  const running = f.run(request()); const rejected = assert.rejects(running, /no confined backend/)
  await entered.promise; f.setMode('read-only'); release.resolve(); await rejected
  assert.equal(f.handles.length, 0); assert.ok(f.scopes.every(value => value.ctx.fiber.state === 4)); f.preserved()
})

test('review: cancellation during artifact await rejects before native spawn', { timeout: 10000 }, async t => {
  const entered = latch(), release = latch()
  const f = await fixture(t, { artifact: async () => { entered.resolve(); await release.promise; return directory } })
  const running = f.run(request()); const rejected = assert.rejects(running, /FIXED_CANCEL/)
  await entered.promise; f.abort.abort(new Error('FIXED_CANCEL')); release.resolve(); await rejected
  assert.equal(f.handles.length, 0); assert.ok(f.scopes.every(value => value.ctx.fiber.state === 4)); f.preserved()
})

test('review regression: pending artifact owner cannot delay cancellation settlement', { timeout: 10000 }, async t => {
  const entered = latch(), release = latch()
  const f = await fixture(t, { artifact: async () => { entered.resolve(); await release.promise; return directory } })
  let settled = false
  const running = f.run(request('', { timeoutMs: 20 })).finally(() => { settled = true })
  const rejected = assert.rejects(running, /FIXED_CANCEL/)
  await entered.promise; f.abort.abort(new Error('FIXED_CANCEL')); await delay(120)
  observations.push({ name: t.name, settledWithin120msOfAbort: settled, scopesDisposed: f.scopes.every(value => value.ctx.fiber.state === 4), spawnCount: f.handles.length })
  const settledBeforeRelease = settled
  const disposedBeforeRelease = f.scopes.every(value => value.ctx.fiber.state === 4)
  release.resolve(); await rejected; assert.equal(f.handles.length, 0)
  assert.equal(settledBeforeRelease, true, 'cancel must settle without waiting for artifact callback')
  assert.equal(disposedBeforeRelease, true, 'pending callback must not retain operation scope')
})

test('review regression: preparation deadline includes pending artifact callback', { timeout: 10000 }, async t => {
  const entered = latch(), release = latch()
  const f = await fixture(t, { artifact: async () => { entered.resolve(); await release.promise; return directory } })
  let settled = false
  const running = f.run(request('', { timeoutMs: 80 })).finally(() => { settled = true })
  const rejected = assert.rejects(running, /preparation timed out/)
  await entered.promise; await delay(200)
  const settledBeforeRelease = settled
  const disposedBeforeRelease = f.scopes.every(value => value.ctx.fiber.state === 4)
  release.resolve(); await rejected
  assert.equal(settledBeforeRelease, true); assert.equal(disposedBeforeRelease, true); assert.equal(f.handles.length, 0)
})

function interrupted(result) {
  assert.equal(result.status, 'killed'); assert.equal(result.aborted, true)
  for (const facts of [result.outputFacts.stdout, result.outputFacts.stderr]) {
    assert.equal(facts.aborted, true); assert.equal(facts.complete, false)
    for (const artifact of Object.values(facts.artifact)) assert.equal(artifact.complete, false)
  }
  assert.equal(result.stdout.spillPath, undefined)
}

test('review regression: owner dispose completeness and process settlement', { timeout: 12000 }, async t => {
  const f = await fixture(t)
  const proc = await f.run(request('process.stdout.write("READY");setTimeout(()=>process.stdout.write("LATE"),5000)'))
  await ready(f.handles[0]); await f.agentScope.dispose()
  const result = await Promise.race([proc.result(), delay(2000).then(() => { throw new Error('result stalled after owner dispose') })])
  const facts = f.handles[0].outputFacts()
  interrupted(result)
  assert.doesNotMatch(result.stdout.text, /LATE/); assert.equal(await f.handles[0].waitForExit(AbortSignal.timeout(2000)), true)
  observations.push({ name: t.name, status: result.status, exitCode: result.exitCode, aborted: result.aborted, outputFacts: facts })
  f.preserved()
})

test('review regression: direct kill completeness and process settlement', { timeout: 12000 }, async t => {
  const f = await fixture(t)
  const proc = await f.run(request('process.stdout.write("READY");setTimeout(()=>process.stdout.write("LATE"),5000)'))
  await ready(f.handles[0]); assert.equal(proc.kill(), true)
  const result = await proc.result()
  interrupted(result)
  assert.doesNotMatch(result.stdout.text, /LATE/)
  observations.push({ name: t.name, status: result.status, exitCode: result.exitCode, aborted: result.aborted, outputFacts: result.outputFacts })
  f.preserved()
})

test('review regression: normal cleanup preserves complete artifacts for late readers', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  const proc = await f.run(request())
  const result = await proc.result()
  assert.equal(result.exitCode, 0); assert.equal(result.aborted, false); assert.equal(result.outputFacts.stdout.complete, true)
  await f.agentScope.dispose()
  assert.equal(f.handles[0].outputFacts().stdout.complete, true)
  const artifact = result.outputFacts.stdout.artifact.decoded
  assert.equal(artifact.complete, true); assert.equal(fs.readFileSync(artifact.path, 'utf8'), 'FIXED_REVIEW_SENTINEL')
})

test.after(() => {
  fs.writeFileSync(path.join(directory, 'observations.json'), JSON.stringify({ scope: 'Independent actual installed Core; asserted regression observations, not production E2E', observations }, null, 2) + '\n')
  console.log(`Independent review evidence: ${directory}`)
})
