import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { createNativeToolModule, renderNativeResult, NATIVE_OUTPUT_SCHEMA } from '../src/native-tool.js'
import { nativePath, parseNativeRequest } from '../src/native-executor.js'
import { processOutcome } from '../src/bash-render.js'

const typedPath = value => ({ kind: 'path', value })
const translate = value => value.startsWith('/c/') ? `C:/${value.slice(3)}` : value
const options = { platform: 'win32', translateMsysPath: translate, sessionCwd: 'C:/fixed' }
const request = patch => ({ description: 'Fixed native review sentinel', executable: typedPath('C:/fixed/producer.exe'), argv: [], ...patch })

// Actual repository Cordis lifecycle; controlled Jobs/executor seam, no OS spawn,
// artifacts, environment reads, profile changes or timers needed for promotion.
async function promotionFixture(t, { lossy = false, gapBefore = false, gapChannel = 'stdout', spillPaths = [], mode = 'danger-full-access', controller = true } = {}) {
  const root = new Context()
  const definitions = new Map()
  const disposers = []
  const counts = { admission: 0, reads: 0, workspace: 0, artifact: 0, spawn: 0 }
  let finish, hooks, started
  const ready = new Promise(resolve => { started = resolve })
  class Tools extends Service {
    constructor(ctx) { super(ctx, 'tools') }
    schemas() { return [...definitions.keys()].map(name => ({ name })) }
    register(definition) {
      return this.ctx.effect(() => {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      })
    }
  }
  class Local extends Service {
    static inject = ['subprocess']
    constructor(ctx) { super(ctx, 'shell') }
    resolve(spec) { return spec }
    async executeArgv() {
      const proc = { status: 'running', exitCode: null, signal: null,
        done: new Promise(resolve => { finish = () => { proc.status = 'completed'; proc.exitCode = 7; resolve() } }),
        result: async () => ({ exitCode: 7, signal: null, timedOut: false, aborted: false,
          stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }),
        kill() { finish(); return true }, readOutput() {},
      }
      started()
      return proc
    }
  }
  function createScope(owner) {
    let ctx
    const fiber = owner.plugin(value => { ctx = value })
    return { fiber, get ctx() { return ctx }, dispose: () => fiber.dispose() }
  }
  const chunks = [
    { channel: 'stdout', text: 'RETAINED_TAIL', ...(gapBefore && gapChannel === 'stdout' ? { gapBefore: true } : {}) },
    { channel: 'stderr', text: 'FIXED_STDERR', ...(gapBefore && gapChannel === 'stderr' ? { gapBefore: true } : {}) },
  ]
  const job = { output: { spillPaths } }
  const jobs = {
    start(spec) {
      counts.admission++
      if (!controller) throw new Error('no job controller')
      hooks = spec.run()
      return 'fixed-owned-job'
    },
    async wait() { await ready; await Promise.resolve(); return { status: 'running' } },
    read() { counts.reads++; return { chunks: counts.reads === 1 ? chunks : [], lossy, job } },
    kill() { hooks.cancel('fixed cleanup') },
  }
  for (const [name, service] of Object.entries({
    sandboxPolicy: { resolve: () => mode === undefined ? undefined : ({ mode }) },
    workingDirectory: { ensure: async () => { counts.workspace++; return 'C:/fixed' } },
    shellEnv: { collect: () => ({}) },
    subprocess: { spawn() { counts.spawn++; throw new Error('NO_OS_SPAWN') } }, jobs,
  })) disposers.push(root.provide(name, service))
  const toolsFiber = root.plugin(Tools); await toolsFiber
  disposers.push(() => toolsFiber.dispose())
  const native = root.plugin(createNativeToolModule({ platform: 'win32',
    toolsModule: { defineTool: value => value }, localBashModule: { LocalBashExecutor: Local }, createScope,
    createArtifactDirectory() { counts.artifact++; return 'C:/fixed-no-directory-created' },
    createNativeOutputAdapter: () => ({ spawn() { counts.spawn++; throw new Error('NO_OS_SPAWN') } }),
  }))
  await native
  await new Promise(resolve => setImmediate(resolve))
  disposers.push(() => native.dispose())
  t.after(async () => {
    finish?.()
    if (hooks) await hooks.done
    for (const dispose of disposers.reverse()) await dispose()
  })
  return { counts, jobs,
    run: () => definitions.get('gitbash_native').execute(request({ timeoutMs: 1000 }), {
      agent: { id: 'fixed-owner', ctx: root, session: {} }, signal: new AbortController().signal,
    }),
  }
}

for (const [label, metadata] of [
  ['lossy', { lossy: true, spillPaths: ['C:/fixed/raw.bin', 'C:/fixed/decoded.log'] }],
  ['gap without lossy', { lossy: false, gapBefore: true, spillPaths: ['C:/fixed/gap.log'] }],
  ['stderr gap without lossy', { lossy: false, gapBefore: true, gapChannel: 'stderr' }],
  ['loss without spill', { lossy: true }],
]) test(`R04: promotion retains consumed ${label} metadata`, async t => {
  const f = await promotionFixture(t, metadata)
  const value = await f.run()
  assert.equal(value.kind, 'promoted')
  assert.match(value.output, /^RETAINED_TAIL\n\[stderr\]\nFIXED_STDERR/)
  assert.match(value.output, /some output was dropped from memory; full output:/)
  for (const spillPath of metadata.spillPaths ?? []) assert.ok(value.output.includes(spillPath))
  if (!metadata.spillPaths?.length) assert.match(value.output, /full output: \(unavailable\)/)
  assert.ok(renderNativeResult(value).includes(value.output))
  assert.equal(f.counts.reads, 1, 'promotion consumes the registry read exactly once')
  assert.deepEqual(f.jobs.read().chunks, [], 'later reads cannot recover consumed loss metadata')
  assert.equal(f.counts.spawn, 0)
  assert.equal(f.counts.admission, 1)
  const schema = NATIVE_OUTPUT_SCHEMA.oneOf.find(branch => branch.properties.kind.enum?.includes('promoted'))
  assert.equal(schema.additionalProperties, false)
  assert.ok(Object.keys(value).every(key => Object.hasOwn(schema.properties, key)), 'do not widen the closed DTO')
})

test('R04: lossless promotion does not warn even when spill paths exist', async t => {
  const f = await promotionFixture(t, { spillPaths: ['C:/fixed/not-a-loss.log'] })
  const value = await f.run()
  assert.equal(value.output, 'RETAINED_TAIL\n[stderr]\nFIXED_STDERR')
  assert.doesNotMatch(renderNativeResult(value), /dropped|not-a-loss/)
})

for (const mode of ['read-only', 'workspace-write', 'unknown']) test(`R04: ${mode} policy still refuses before admission`, async t => {
  const f = await promotionFixture(t, { mode })
  await assert.rejects(f.run(), /refuses/)
  assert.deepEqual(f.counts, { admission: 0, reads: 0, workspace: 0, artifact: 0, spawn: 0 })
})
test('R04: controller admission refusal cannot start an executor', async t => {
  const f = await promotionFixture(t, { controller: false })
  await assert.rejects(f.run(), /no job controller/)
  assert.equal(f.counts.admission, 1)
  assert.equal(f.counts.artifact, 0)
  assert.equal(f.counts.spawn, 0)
})

for (const [exitCode, detail] of [[null, 'exit code: null'], [undefined, 'exit code: unknown'], [7, 'exit code: 7'], [0, 'exit code: 0']]) {
  test(`R09: completed job preserves exit fact ${String(exitCode)}`, () => {
    assert.deepEqual(processOutcome({ status: 'completed', exitCode }), { status: 'completed', detail })
  })
}
test('R09: killed job keeps interruption terminology even with exit zero', () => {
  assert.deepEqual(processOutcome({ status: 'killed', signal: 'SIGTERM', exitCode: 0 }), { status: 'killed', detail: 'signal: SIGTERM' })
  assert.deepEqual(processOutcome({ status: 'killed', signal: null, exitCode: null }), { status: 'killed', detail: 'killed before exit' })
})

for (const prefix of ['C:/fixed/%fixed%', 'C:\\fixed\\%fixed%', '//server/share/%fixed%', '/c/fixed/%fixed%']) {
  for (const field of ['executable', 'argv', 'cwd']) test(`R10: absolute percent literal in ${field}: ${prefix}`, () => {
    const patch = field === 'executable' ? { executable: typedPath(`${prefix}/producer.exe`) }
      : field === 'argv' ? { argv: [typedPath(`${prefix}/input.txt`), { kind: 'literal', value: '%fixed%' }] }
      : { cwd: typedPath(prefix) }
    const result = parseNativeRequest(request(patch), options)
    assert.ok((field === 'argv' ? result.argv[0] : result[field]).includes('%fixed%'))
    if (field === 'argv') assert.equal(result.argv[1], '%fixed%')
  })
}
test('R10: absolute internal dollar/home characters are data, including default cwd', () => {
  const result = parseNativeRequest(request({ executable: typedPath('C:/$fixed/~/producer.exe'),
    argv: [typedPath('/c/$fixed/~/input.txt')] }), { ...options, sessionCwd: 'C:/%fixed%/$literal/~literal' })
  assert.equal(result.executable, 'C:\\$fixed\\~\\producer.exe')
  assert.equal(result.argv[0], 'C:\\$fixed\\~\\input.txt')
  assert.equal(result.cwd, 'C:\\%fixed%\\$literal\\~literal')
})
test('R10: percent literals introduced by a resolved MSYS mount stay literal', () => {
  assert.equal(nativePath(typedPath('/tmp/input.txt'), value => value === '/tmp/input.txt' ? 'C:/%fixed%/input.txt' : value, 'win32'), 'C:\\%fixed%\\input.txt')
})
for (const value of ['%TEMP%/input.txt', '$HOME/input.txt', '${TEMP}/input.txt', '~/input.txt', 'relative/%fixed%/input.txt', 'C:relative/%fixed%', '/unknown/%fixed%']) {
  test(`R10: unresolved or variable-prefixed paths remain refused: ${value}`, () => {
    assert.throws(() => nativePath(typedPath(value), translate, 'win32'), /absolute|expansion/)
  })
}
test('R10: variable prefixes never reach an expanding translator', () => {
  let translations = 0
  for (const value of ['%TEMP%/input.txt', '$HOME/input.txt', '~/input.txt']) {
    assert.throws(() => nativePath(typedPath(value), () => { translations++; return 'C:/expanded/input.txt' }, 'win32'), /expansion/)
  }
  assert.equal(translations, 0)
})
