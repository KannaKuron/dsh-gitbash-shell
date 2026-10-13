import test from 'node:test'
import assert from 'node:assert/strict'
import { nativePath, parseNativeRequest, requireNativePolicy, createNativeExecutor } from '../src/native-executor.js'
import { nativeParameters, NATIVE_OUTPUT_SCHEMA } from '../src/native-tool.js'

const translateMsysPath = value => value.startsWith('/c/') ? `C:/${value.slice(3)}` : value === '/tmp' ? 'C:/Native Sentinel Temp' : value
const options = { translateMsysPath, platform: 'win32', sessionCwd: 'C:/Native Sentinel' }
const request = patch => ({ description: 'Inspect fixed sentinel arguments', executable: { kind: 'path', value: 'C:/Native Sentinel/producer.exe' }, argv: [], ...patch })

test('native typed argv: slash switches, empty, quotes, Unicode and meta stay literal', () => {
  const values = ['/all', '/c', '/c/FILE', '', '"quoted"', 'tail\\', '中文😀', '&|<>^%NAME%!x!', 'https://sentinel.invalid/a']
  const result = parseNativeRequest(request({ argv: values.map(value => ({ kind: 'literal', value })) }), options)
  assert.deepEqual(result.argv, values)
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.argv) && Object.isFrozen(result.output))
})

test('native typed path: translation is opt-in and Windows launch fields normalize', () => {
  const result = parseNativeRequest(request({ executable: { kind: 'path', value: '/c/Native Sentinel/producer.exe' },
    cwd: { kind: 'path', value: '/tmp' }, argv: [{ kind: 'path', value: '/c/Sentinel/file.txt' }, { kind: 'literal', value: '/c/Sentinel/file.txt' }] }), options)
  assert.equal(result.executable, 'C:\\Native Sentinel\\producer.exe')
  assert.equal(result.cwd, 'C:\\Native Sentinel Temp')
  assert.deepEqual(result.argv, ['C:\\Sentinel\\file.txt', '/c/Sentinel/file.txt'])
  assert.equal(nativePath({ kind: 'path', value: '//server/share/f.txt' }, translateMsysPath, 'win32'), '\\\\server\\share\\f.txt')
})

test('native input: unresolved paths and unsupported semantics fail closed', () => {
  for (const value of ['relative', '/unknown/mount', '~/file', '$HOME/file', '%TEMP%/file', 'C:relative', '\\rooted']) {
    assert.throws(() => nativePath({ kind: 'path', value }, translateMsysPath, 'win32'), /absolute|expansion/)
  }
  for (const key of ['env', 'shell', 'command', 'sandbox_permissions', 'justification', 'windowsVerbatimArguments']) {
    assert.throws(() => parseNativeRequest(request({ [key]: {} }), options), /unsupported field/)
  }
  assert.throws(() => parseNativeRequest(request({ argv: [{ kind: 'literal', value: 'x\0y' }] }), options), /NUL/)
  assert.throws(() => parseNativeRequest(request({ argv: [{ kind: 'guess', value: 'x' }] }), options), /kind/)
  assert.throws(() => parseNativeRequest(request({ executable: { kind: 'command', value: 'node' } }), options), /kind/)
})

test('native input: scripts rejected, interpreter requires explicit declaration', () => {
  for (const name of ['producer.cmd', 'producer.bat', 'script.ps1', 'script.js']) assert.throws(() => parseNativeRequest(request({ executable: { kind: 'path', value: `C:/${name}` }, entrypoint: 'interpreter' }), options), /only native/)
  for (const name of ['cmd', 'node', 'python3', 'pwsh', 'bash']) {
    const args = request({ executable: { kind: 'path', value: `C:/${name}.exe` } })
    assert.throws(() => parseNativeRequest(args, options), /explicit entrypoint/)
    assert.equal(parseNativeRequest({ ...args, entrypoint: 'interpreter' }, options).entrypoint, 'interpreter')
  }
})

test('native input: encoding and timeout are explicit bounded semantics', () => {
  for (const timeoutMs of [0, -1, NaN, Infinity]) assert.throws(() => parseNativeRequest(request({ timeoutMs }), options), /positive/)
  assert.equal(parseNativeRequest(request({ timeoutMs: 1000000 }), options).timeoutMs, 600000)
  assert.throws(() => parseNativeRequest(request({ timeoutMs: 10, run_in_background: true }), options), /not supported/)
  assert.throws(() => parseNativeRequest(request({ stdoutEncoding: 'auto' }), options), /encoding/)
  assert.throws(() => parseNativeRequest(request({ errors: 'guess' }), options), /errors/)
})

test('native policy: missing/RO/WW rejected using actual public error constructor shape', () => {
  class SandboxUnavailableError extends Error { constructor(mode, detail) { super(detail); this.mode = mode } }
  for (const mode of [undefined, 'read-only', 'workspace-write', 'unknown']) {
    let request
    const ctx = { get: () => mode ? { defaultMode: 'danger-full-access', resolve(value) { request = value; return { mode } } } : undefined }
    assert.throws(() => requireNativePolicy(ctx, { agent: { session: 'session-sentinel' } }, { SandboxUnavailableError }), SandboxUnavailableError)
    if (mode) assert.deepEqual(request, { session: 'session-sentinel' })
  }
  assert.equal(requireNativePolicy({ get: () => ({ resolve: () => ({ mode: 'danger-full-access' }) }) }, {}).mode, 'danger-full-access')
})

test('native policy: all denied paths precede workspace, scope, adapter and spawn', async () => {
  for (const mode of [undefined, 'read-only', 'workspace-write']) {
    const reached = []
    const ctx = { get: () => mode ? { resolve: () => ({ mode }) } : undefined,
      workingDirectory: { ensure() { reached.push('workspace') } }, shellEnv: { collect() { reached.push('env') } } }
    const executor = createNativeExecutor(ctx, { localBashModule: { LocalBashExecutor: class {} },
      createScope() { reached.push('scope') }, createNativeOutputAdapter() { reached.push('adapter') }, translateMsysPath })
    await assert.rejects(executor.prepare(request(), { agent: {} }), /refuses/)
    await assert.rejects(executor.execute({}, {}), /refuses/)
    assert.deepEqual(reached, [])
  }
})

test('native cancellation: cancellation during workspace preparation cannot hand off a job', async () => {
  const abort = new AbortController()
  let envCollected = false
  const ctx = { get: () => ({ resolve: () => ({ mode: 'danger-full-access' }) }),
    workingDirectory: { async ensure() { abort.abort(new Error('fixed preparation cancel')); return 'C:/Native Sentinel' } },
    shellEnv: { collect() { envCollected = true; return {} } } }
  const executor = createNativeExecutor(ctx, { localBashModule: { LocalBashExecutor: class {} },
    createScope() { throw new Error('MUST_NOT_CREATE_SCOPE') }, createNativeOutputAdapter() { throw new Error('MUST_NOT_CREATE_ADAPTER') }, translateMsysPath })
  await assert.rejects(executor.prepare(request({ run_in_background: true }), { agent: {}, signal: abort.signal }), /fixed preparation cancel/)
  assert.equal(envCollected, false)
})

test('native preparation: a non-settling scope mount is bounded and disposed before artifacts', async () => {
  let disposed = false
  let artifactCreated = false
  const owner = { isolate() { return this } }
  const ctx = {
    get: key => key === 'sandboxPolicy' ? { resolve: () => ({ mode: 'danger-full-access' }) } : { spawn() { throw new Error('MUST_NOT_SPAWN') } },
    workingDirectory: { ensure: async () => 'C:/Native Sentinel' }, shellEnv: { collect: () => ({}) },
  }
  const executor = createNativeExecutor(ctx, { platform: 'win32', localBashModule: { LocalBashExecutor: class {} },
    createScope: () => ({ fiber: new Promise(() => {}), dispose: async () => { disposed = true } }),
    createNativeOutputAdapter() { artifactCreated = true; throw new Error('MUST_NOT_CREATE_ADAPTER') }, translateMsysPath })
  const exec = { agent: { ctx: owner }, signal: new AbortController().signal }
  const prepared = await executor.prepare(request({ timeoutMs: 30 }), exec)
  await assert.rejects(executor.execute(prepared, exec), /preparation timed out/)
  assert.equal(disposed, true)
  assert.equal(artifactCreated, false)
})

test('native output schema: every object has explicit closed properties', () => {
  const inspect = node => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false)
      assert.ok(node.properties && Object.keys(node.properties).length > 0)
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(inspect)
      else inspect(value)
    }
  }
  inspect(NATIVE_OUTPUT_SCHEMA)
})

test('native schema authoring: implicit property-map, required markers and capability-gated Jobs', () => {
  const parameters = nativeParameters()
  assert.equal(parameters.type, undefined)
  assert.equal(parameters.executable.required, true)
  assert.equal(parameters.argv.required, true)
  assert.equal(parameters.argv.items.properties.value.required, true)
  assert.equal(parameters.run_in_background, undefined)
  assert.equal(nativeParameters({ background: true }).run_in_background.type, 'boolean')
})
