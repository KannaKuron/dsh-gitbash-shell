import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { rewriteCodePaths, translateGlobArguments, _internal } from '../src/index.js'
import { scanCommands } from '../src/toolchain.js'
import { defaultRunnerIo, probeToolchain, runToolJob } from '../src/tool-runner.js'
import { Context, Service } from '@deepseek-ai/cordis'
import { createBashToolModule } from '../src/bash-tool.js'

const latch = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('R01: ambiguous ASI slash leaves the whole program unchanged, including prior literals', () => {
  for (const declaration of ['let x', 'var x']) {
    for (const newline of ['\n', '\r\n', '\u2028', '\u2029', '/*\n*/']) {
      const code = `const p='/c/before'; ${declaration}${newline}/['/c/foo']/.test('C') && (x=true); return x ?? false`
      const rewritten = rewriteCodePaths(code, null)
      assert.equal(new Function(code)(), false)
      assert.equal(rewritten, code, `${declaration} followed by ${JSON.stringify(newline)}`)
      assert.equal(new Function(rewritten)(), false)
    }
  }
})

test('R01: ordinary literals, explicit regexes and same-line division keep their contracts', () => {
  const code = "const p='/c/file'; let n = 12 / 3; const r=/['/c/foo']/; return [p,n,r.test('C')]"
  const rewritten = rewriteCodePaths(code, null)
  assert.deepEqual(new Function(rewritten)(), ['C:/file', 4, false])
  const ambiguousDivision = "const p='/c/file'; let n = 12\n / 3; return [p,n]"
  assert.equal(rewriteCodePaths(ambiguousDivision, null), ambiguousDivision, 'uncertain newline division is a whole-program no-op')
})

test('R01: labeled ASI and template interpolation use the same conservative slash guard', () => {
  for (const code of [
    "const p='/c/file'; label: { break label\n/['/c/foo']/.test('C'); } return p",
    "const p='/c/file'; label: while(false) { continue label\n/['/c/foo']/.test('C'); } return p",
    "const p='/c/file'; const text=`${(()=>{let x\n/['/c/foo']/.test('C');return 'done'})()}`; return p",
  ]) {
    assert.equal(new Function(code)(), '/c/file')
    assert.equal(rewriteCodePaths(code, null), code)
  }
})

test('R02: whole-value TEMP echo only maps the actual root, never an embedded path fragment', () => {
  const env = { tmpDir: 'C:/Temp' }
  for (const [input, expected] of [
    ['C:/Temp', '/tmp'], ['c:/TEMP/file', '/tmp/file'], ['C:\\Temp\\space dir\\file', '/tmp/space dir/file'],
    ['C:/Temperature/file', '/c/Temperature/file'], ['D:/backup/c/Temp/result.txt', '/d/backup/c/Temp/result.txt'],
    ['C:/safe/c/Temp/x', '/c/safe/c/Temp/x'], ['backup/c/Temp/x', 'backup/c/Temp/x'],
    ['//server/share/c/Temp/x', '//server/share/c/Temp/x'],
  ]) {
    const value = { path: input, lines: [{ text: 'C:/Temp is file content, not metadata' }] }
    const echoed = _internal.rewriteResultPaths('read', value, env)
    assert.equal(echoed.path, expected, input)
    assert.equal(echoed.lines, value.lines)
  }
})

test('R03: directory brace expressions stay inside the glob, not the filesystem root', () => {
  for (const [pattern, expected] of [
    ['/c/project/{src,test}/*.js', { path: 'C:/project', pattern: '{src,test}/*.js' }],
    ['C:/project/{src,test}/**/*.{js,ts}', { path: 'C:/project', pattern: '{src,test}/**/*.{js,ts}' }],
    ['/tmp/{one,two}/file.txt', { path: 'D:/Temp', pattern: '{one,two}/file.txt' }],
    ['/c/project/*/src/*.js', { path: 'C:/project', pattern: '*/src/*.js' }],
    ['/c/project/readme.md', { path: 'C:/project', pattern: 'readme.md' }],
  ]) assert.deepEqual(translateGlobArguments({ pattern }, { tmpDir: 'D:/Temp' }), expected)
  const relative = { pattern: '{src,test}/*.js', path: '/c/project' }
  assert.equal(translateGlobArguments(relative, null), relative)
})

for (const gapBefore of [true, false]) test(`R04: Bash promotion also preserves source gap=${gapBefore} independently of lossy`, async t => {
  const root = new Context(), definitions = new Map(), cleanups = [], started = latch()
  let finish, hooks, reads = 0
  class Tools extends Service {
    constructor(ctx) { super(ctx, 'tools') }
    register(definition) { return this.ctx.effect(() => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) }) }
  }
  const proc = { status: 'running', exitCode: null, signal: null,
    done: new Promise(resolve => { finish = () => { proc.status = 'completed'; proc.exitCode = 0; resolve() } }),
    kill() { finish() }, result: async () => ({ exitCode: 0 }),
  }
  const jobs = {
    start(spec) { hooks = spec.run(); return 'fixed-bash-job' },
    async wait() { await started.promise; await Promise.resolve(); return { status: 'running' } },
    read() { reads++; return { chunks: [{ channel: 'stdout', text: 'RETAINED_TAIL', gapBefore }], lossy: false, job: { output: { spillPaths: [] } } } },
  }
  for (const [name, value] of Object.entries({ jobs,
    systemPrompt: { section() {}, getSectionOrder: () => 100 }, shellEnv: { collect: () => ({}) },
    workingDirectory: { ensure: async () => 'C:/fixed' },
  })) cleanups.push(root.provide(name, value))
  t.after(async () => { finish(); if (hooks) await hooks.done; for (const off of cleanups.reverse()) await off() })
  const tools = root.plugin(Tools); await tools; cleanups.push(() => tools.dispose())
  const module = root.plugin(createBashToolModule({ log() {}, executor: {
    resolve: request => ({ ...request, workdir: 'C:/fixed', timeoutMs: 100 }),
    execute: async () => { started.resolve(); return proc },
  } }))
  await module; cleanups.push(() => module.dispose()); await new Promise(resolve => setImmediate(resolve))
  const result = await definitions.get('bash').execute({ description: 'Check retained Bash output facts', command: 'CONTROLLED_NO_OS_SPAWN' }, { agent: { id: 'fixed-owner', session: { header: {} } }, signal: new AbortController().signal })
  assert.equal(result.kind, 'promoted')
  assert.equal(reads, 1)
  assert.equal(result.output.includes('some output was dropped'), gapBefore)
  assert.match(result.output, /^RETAINED_TAIL/)
})

const inventory = JSON.stringify({ Sources: [{ SourceDetails: { Name: 'winget' }, Packages: [
  { PackageIdentifier: 'BurntSushi.ripgrep.GNU', Version: '1.0.0' },
] }] })

function runnerFixture({ exportCode = 0, text = inventory } = {}) {
  const files = new Map(), calls = [], removed = [], exports = []
  const io = {
    pathDirs: () => [], readdir: () => [], tmpFile: name => path.join(tmpdir(), name),
    readFile(filename) { if (!files.has(filename)) throw new Error('ENOENT controlled inventory'); return files.get(filename) },
    remove(filename) { removed.push(filename); files.delete(filename) },
    async run(_file, argv) {
      calls.push(argv)
      if (argv[0] === '--version') return { code: 0, output: 'v1.29.0' }
      if (argv[0] === 'export') {
        const filename = argv[argv.indexOf('-o') + 1]
        exports.push(filename); files.set(filename, text)
        return { code: exportCode, output: 'controlled export' }
      }
      return { code: 0, output: argv[0] === 'list' ? 'BurntSushi.ripgrep.GNU 1.0.0 2.0.0' : '' }
    },
  }
  return { io, files, calls, removed, exports }
}

test('R05: overlapping status and auto upgrade own different export files and retain the installed build', async () => {
  const f = runnerFixture(), a = latch(), b = latch(), startedA = latch(), startedB = latch()
  const run = f.io.run
  let exports = 0
  f.io.run = async (...args) => {
    const result = await run(...args)
    if (args[1][0] === 'export') {
      if (++exports === 1) { startedA.resolve(); await a.promise }
      else { startedB.resolve(); await b.promise }
    }
    return result
  }
  const status = probeToolchain(f.io)
  await startedA.promise
  const job = runToolJob(f.io, { action: 'auto', ids: ['rg'] })
  await startedB.promise
  a.resolve(); assert.equal((await status).tools.find(row => row.id === 'rg').state, 'managed')
  b.resolve()
  const result = await job
  assert.notEqual(f.exports[0], f.exports[1], 'each invocation owns its output path')
  assert.equal(result.results[0].action, 'upgrade')
  assert.equal(result.results[0].wingetId, 'BurntSushi.ripgrep.GNU')
  assert.ok(f.calls.some(argv => argv[0] === 'upgrade' && argv.includes('BurntSushi.ripgrep.GNU')))
  assert.ok(!f.calls.some(argv => argv[0] === 'install'))
  assert.deepEqual(new Set(f.removed), new Set(f.exports))
})

for (const fault of [
  { name: 'nonzero export with stale-looking valid JSON', exportCode: 1 },
  { name: 'invalid JSON', text: '{broken' },
  { name: 'missing Sources', text: '{}' },
  { name: 'malformed source', text: '{"Sources":[{}]}' },
]) {
  test(`R05: ${fault.name} never becomes an empty inventory install`, async () => {
    const f = runnerFixture(fault)
    const job = await runToolJob(f.io, { action: 'auto', ids: ['rg', 'make'] })
    assert.equal(job.finished, true)
    assert.equal(job.done, 2)
    assert.equal(job.results.length, 2)
    assert.ok(job.results.every(result => !result.ok && /inventory/i.test(result.detail)))
    assert.ok(!f.calls.some(argv => ['install', 'upgrade'].includes(argv[0])))
    assert.deepEqual(f.removed, f.exports)
    await assert.rejects(probeToolchain(f.io), /inventory/i, 'the settings card must not advertise an authoritative missing state')
  })
}

test('R05: a valid empty inventory still permits the explicitly requested catalog install', async () => {
  const f = runnerFixture({ text: '{"Sources":[]}' })
  const job = await runToolJob(f.io, { action: 'auto', ids: ['make'] })
  assert.equal(job.results[0].ok, true)
  assert.equal(job.results[0].action, 'install')
  assert.ok(f.calls.some(argv => argv[0] === 'install' && argv.includes('ezwinports.make')))
})

test('R08: real directory entries cannot masquerade as extensionless or .exe commands', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'gitbash-review-commands-'))
  t.after(() => {
    assert.equal(path.dirname(root), tmpdir())
    assert.ok(path.basename(root).startsWith('gitbash-review-commands-'))
    rmSync(root, { recursive: true, force: true })
  })
  mkdirSync(path.join(root, 'make')); mkdirSync(path.join(root, 'jq.exe'))
  writeFileSync(path.join(root, 'fzf'), 'controlled file')
  writeFileSync(path.join(root, 'just.1'), 'manual')
  writeFileSync(path.join(root, 'just.exe'), 'controlled file')
  const io = { ...defaultRunnerIo(), pathDirs: () => [root] }
  const hits = scanCommands(io)
  assert.equal(hits.has('make'), false)
  assert.equal(hits.has('jq'), false)
  assert.ok(hits.get('fzf')?.endsWith('\\fzf'))
  assert.ok(hits.get('just')?.endsWith('\\just.exe'))
})

test('R08: executable symlinks are checked by target type and broken links/directories are skipped', () => {
  const link = name => ({ name, isFile: () => false, isSymbolicLink: () => true })
  const io = {
    pathDirs: () => ['C:/tools'], readdir: () => [link('make.exe'), link('jq.exe'), link('fzf')],
    isFile: filename => filename.endsWith('\\make.exe'),
  }
  const hits = scanCommands(io)
  assert.deepEqual([...hits.keys()], ['make'])
})
