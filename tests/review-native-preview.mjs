// Actual selected Core + ToolRuntime + Jobs; ordinary Node producers only.
// Test scratch only: no installation, production profile, network or secrets.
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
import { createNativeToolModule, NATIVE_OUTPUT_SCHEMA } from '../src/native-tool.js'

assert.equal(process.versions.electron, undefined, 'Use ordinary Node, never an Electron producer')
const evidence = process.env.DSH_NATIVE_REVIEW_EVIDENCE_DIR
assert.ok(evidence && path.isAbsolute(evidence), 'Explicit caller-owned scratch directory required')
const directory = fs.mkdtempSync(path.join(evidence, 'native-review-'))
const observations = []
const typedPath = value => ({ kind: 'path', value })
const literal = value => ({ kind: 'literal', value })
const request = (code, patch = {}) => ({ description: 'Native review fixed Node sentinel',
  executable: typedPath(process.execPath), entrypoint: 'interpreter', argv: [literal('-e'), literal(code)], ...patch })
const msys = value => value.replaceAll('\\', '/').replace(/^([a-z]):/i, (_, drive) => `/${drive.toLowerCase()}`)
function createScope(owner) {
  let ctx
  const fiber = owner.plugin(value => { ctx = value })
  return { fiber, get ctx() { return ctx }, dispose: () => fiber.dispose() }
}
async function fixture(t) {
  const root = new Context(), disposers = [], reads = [], handles = []
  let agent
  const official = { original: true }
  for (const [name, value] of Object.entries({ shell: official,
    sandboxPolicy: { defaultMode: 'danger-full-access', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: directory }) },
    workingDirectory: { ensure: async () => directory }, agents: { get: id => agent?.id === id ? agent : undefined },
  })) disposers.push(root.provide(name, value))
  const mount = async (module, config) => {
    const fiber = root.plugin(module, config); disposers.push(() => fiber.dispose()); await fiber; return fiber
  }
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose() })
  for (const module of [LocalSubprocessRuntime, SystemPrompt, toolsModule.ToolRuntime, shellEnv]) await mount(module)
  const provider = root.get('subprocess')
  const rootProviders = ['shell', 'subprocess'].map(name => root.reflect.store[root[Context.isolate][name]])
  provider.internals.spillDir = directory
  agent = { id: randomUUID(), session: { header: { id: randomUUID(), cwd: directory } } }
  const owner = createAgentScope(root, agent); agent.ctx = owner.ctx; disposers.push(() => owner.dispose())
  await mount(LocalJobRegistry, { pumpPollMs: 5 })
  await mount({ inject: ['jobs'], apply(ctx) { ctx.jobs.attachController('native-review-controller') } })
  const jobs = root.get('jobs'), read = jobs.read.bind(jobs)
  jobs.read = (...args) => {
    const value = read(...args)
    reads.push({ lossy: value.lossy, gaps: value.chunks.some(chunk => chunk.gapBefore),
      chars: value.chunks.reduce((total, chunk) => total + chunk.text.length, 0), spillPaths: value.job.output.spillPaths ?? [] })
    return value
  }
  const module = createNativeToolModule({ toolsModule, sandboxModule, localBashModule, createScope,
    translateMsysPath: value => /^\/[a-z]\//i.test(value) ? `${value[1].toUpperCase()}:/${value.slice(3)}` : value,
    outputOptions: { OutputCollector, artifactDirectory: directory, drainTimeoutMs: 200 },
    createNativeOutputAdapter(provider, options) {
      const adapter = createNativeOutputAdapter(provider, options)
      return { spawn(spec) { const handle = adapter.spawn(spec); handles.push(handle); return handle } }
    },
  })
  const fiber = agent.ctx.plugin(module); await fiber; disposers.push(() => fiber.dispose())
  const run = args => root.get('tools').execute({ agent, name: 'gitbash_native', callId: randomUUID(),
    signal: new AbortController().signal, arguments: args })
  return { run, jobs, agent, reads, handles, preserved() {
    for (const [index, name] of ['shell', 'subprocess'].entries()) assert.equal(root.reflect.store[root[Context.isolate][name]], rootProviders[index])
  } }
}

for (const large of [true, false]) test(`R04 real Core: ${large ? '1MiB gap' : 'lossless'} promotion reports consumed loss correctly`, { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const code = `${large ? 'process.stdout.write("A".repeat(1024*1024));' : ''}process.stdout.write("PROMOTION_FIXED_TAIL");setTimeout(()=>{},5000)`
  const response = await f.run(request(code, { timeoutMs: 1200 }))
  assert.equal(response.isError, false, JSON.stringify(response))
  assert.equal(response.value.kind, 'promoted')
  // Always stop the admitted producer before a later assertion could fail.
  f.jobs.kill(response.value.jobId, f.agent.id, 'fixed regression cleanup')
  const outcome = await f.jobs.wait(response.value.jobId, 5000, f.agent.id)
  assert.equal(outcome.status, 'killed')
  assert.equal(f.handles.length, 1, 'metadata rendering must not repeat a producer')
  assert.equal(await f.handles[0].waitForExit(AbortSignal.timeout(3000)), true)
  const first = f.reads[0]
  assert.ok(first)
  const text = response.content.map(part => part.text ?? '').join('\n')
  observations.push({ name: t.name, read: first, outputChars: response.value.output.length,
    warning: /some output was dropped/.test(text), producerCount: f.handles.length, outcome: outcome.status })
  assert.match(response.value.output, /PROMOTION_FIXED_TAIL/)
  if (large) {
    assert.equal(first.lossy, false, 'actual Core ring gap must be tested separately from source lossy')
    assert.equal(first.gaps, true)
    assert.ok(first.chars < 1024 * 1024, 'the ring retained only a bounded tail')
    assert.ok(/some output was dropped from memory; full output:/.test(response.value.output), 'consumed ring gap must be visible in promotion output')
    for (const spillPath of first.spillPaths) assert.ok(response.value.output.includes(spillPath))
    if (!first.spillPaths.length) assert.match(response.value.output, /full output: \(unavailable\)/)
  } else {
    assert.equal(first.lossy, false); assert.equal(first.gaps, false)
    assert.doesNotMatch(text, /some output was dropped/)
  }
  assert.deepEqual(toolsModule.validateJsonSchemaValue(toolsModule.valueSchemaSpecToJsonSchema(NATIVE_OUTPUT_SCHEMA), response.value), [])
  f.preserved()
})

test('R10 real Core: percent/dollar/home literals survive native and MSYS argv/cwd paths', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const cwd = path.join(directory, '%fixed% $literal ~literal')
  fs.mkdirSync(cwd)
  const filename = path.join(cwd, '%fixed%.txt')
  fs.writeFileSync(filename, 'PERCENT_FIXED_SENTINEL', 'utf8')
  for (const convert of [value => value, msys]) {
    const args = request('console.log(JSON.stringify({cwd:process.cwd(),text:require("node:fs").readFileSync(process.argv[1],"utf8")}))', { cwd: typedPath(convert(cwd)) })
    args.argv.push(literal('--'), typedPath(convert(filename)))
    const response = await f.run(args)
    assert.equal(response.isError, false, JSON.stringify(response))
    assert.equal(response.value.kind, 'foreground')
    assert.equal(response.value.exitCode, 0)
    assert.deepEqual(JSON.parse(response.value.stdout.text), { cwd: path.win32.normalize(cwd), text: 'PERCENT_FIXED_SENTINEL' })
  }
  assert.equal(f.handles.length, 2)
  f.preserved()
  observations.push({ name: t.name, nativeAndMsysPaths: true, producerCount: f.handles.length })
})

test.after(() => {
  fs.writeFileSync(path.join(directory, 'observations.json'), JSON.stringify({ scope: 'Actual selected Core; ordinary Node producers; no production changes', observations }, null, 2) + '\n')
  console.log(`Native review preview evidence: ${directory}`)
})
