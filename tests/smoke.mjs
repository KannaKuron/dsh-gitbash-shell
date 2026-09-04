import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _internal } from '../src/index.js'

test('hashTree/classify roundtrip with marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitbash-shell-'))
  try {
    mkdirSync(join(dir, 'skills'))
    writeFileSync(join(dir, 'agent.cordis.yml'), 'a')
    writeFileSync(join(dir, 'skills', 'SKILL.md'), 's')
    const files = _internal.hashTree(dir)
    assert.ok(files['agent.cordis.yml'] !== undefined)
    assert.ok(files['skills/SKILL.md'] !== undefined)
    assert.equal(_internal.classify(dir), 'foreign')

    writeFileSync(join(dir, '.plugin-managed.json'), JSON.stringify({ managedBy: 'dsh-gitbash-shell', version: '0.1.0', files }))
    assert.equal(_internal.classify(dir), 'unmodified')

    writeFileSync(join(dir, 'agent.cordis.yml'), 'user edit')
    assert.equal(_internal.classify(dir), 'user-modified')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('syncDecision refreshes on version change only', () => {
  const marker = { version: '0.1.0', base: 'code', files: {} }
  assert.equal(_internal.syncDecision({ state: 'unmodified', marker, version: '0.1.0', sourceHashes: null }), 'idle')
  assert.equal(_internal.syncDecision({ state: 'unmodified', marker, version: '0.2.0', sourceHashes: null }), 'refresh')
  assert.equal(_internal.syncDecision({ state: 'absent', marker: null, version: '0.1.0', sourceHashes: null }), 'refresh')
})

test('asset layout matches PRESET_IDS', () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  for (const id of _internal.PRESET_IDS) {
    assert.ok(existsSync(join(here, '..', 'assets', id, 'agent.cordis.yml')), id + ' agent.cordis.yml')
    assert.ok(existsSync(join(here, '..', 'assets', id, 'preset.yml')), id + ' preset.yml')
  }
  assert.equal(_internal.PRESET_IDS.length, 4)
})

test('inspect registry shim tolerates duplicate registrations', () => {
  const providers = new Map()
  const reg = {
    providers,
    register(registration) {
      if (this.providers.has(registration.manifest.id)) throw new Error('Host Cordis inspect provider "' + registration.manifest.id + '" is already registered')
      this.providers.set(registration.manifest.id, registration)
      return () => { this.providers.delete(registration.manifest.id) }
    },
  }
  const first = _internal.installRegisterShim(reg)
  assert.equal(first.installed, true)
  const dup = reg.register({ manifest: { id: 'Service' } })
  reg.register({ manifest: { id: 'Service' } })
  assert.equal(providers.size, 1)
  assert.equal(typeof dup, 'function')
})
// ── built-in era split (dsh 0.1.2 renamed `code` → `ptc`, no alias) ────────

test('baseForRoster maps the built-in roster to the composition era', () => {
  assert.equal(_internal.baseForRoster(['standard', 'minimal', 'code', 'cordis']), 'code')
  assert.equal(_internal.baseForRoster(['standard', 'minimal', 'ptc', 'cordis']), 'ptc')
  assert.equal(_internal.baseForRoster(['code', 'ptc']), 'ptc') // newer wins if both exist
  assert.equal(_internal.baseForRoster(['standard']), 'code') // unknown roster → conservative
  assert.equal(_internal.baseForRoster([]), 'code')
})

test('variant assets carry era twins where the built-in changed; minimal serves both', () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  // Normalize CRLF: Windows checkouts (core.autocrlf) carry \r\n while the
  // committed assets are LF; line-sensitive assertions below must pass on both.
  const read = (id, f) => readFileSync(join(here, '..', 'assets', id, f), 'utf8').replace(/\r\n/g, '\n')
  for (const id of ['standard-gitbash', 'code-gitbash', 'cordis-gitbash']) {
    const old_ = read(id, 'agent.cordis.yml')
    const ptc = read(id, 'agent.cordis.ptc.yml')
    // era split: the ptc-era twin has the new rows, the base file does not
    assert.match(ptc, /command-goal/, id + ' twin lost command-goal')
    assert.doesNotMatch(old_, /command-goal/, id + ' base must stay on the old era')
    // both eras keep the Git Bash swap
    assert.match(old_, /disabled: false/)
    assert.match(ptc, /disabled: false/)
    assert.doesNotMatch(old_, /disabled: !!js process\.platform === 'win32'/)
    assert.doesNotMatch(ptc, /disabled: !!js process\.platform === 'win32'/)
  }
  // the code variant additionally splits on the mode value
  assert.match(read('code-gitbash', 'agent.cordis.yml'), /mode: code/)
  assert.doesNotMatch(read('code-gitbash', 'agent.cordis.yml'), /mode: ptc/)
  assert.match(read('code-gitbash', 'agent.cordis.ptc.yml'), /mode: ptc/)
  assert.doesNotMatch(read('code-gitbash', 'agent.cordis.ptc.yml'), /mode: code/)
  // dsh 0.1.2-alpha.4 disabled `workflow` in the built-in `ptc` preset (run_code
  // stays the only model-authored orchestration surface; the engine row keeps
  // `ralph` alive): the code variant's ptc-era twin carries the disabled row,
  // its code-era text keeps the 0.1.1 shape (row enabled), and the
  // standard/cordis variants never disable it (their built-ins did not).
  const workflowRow = /- id: tool-workflow\n\s+name: '@deepseek-ai\/dsh-tool-workflow'\n(?:\s+#[^\n]*\n)*\s+disabled: true/
  assert.match(read('code-gitbash', 'agent.cordis.ptc.yml'), workflowRow, 'code-gitbash ptc era lost the alpha.4 workflow disable')
  assert.doesNotMatch(read('code-gitbash', 'agent.cordis.yml'), workflowRow, 'code era must keep workflow enabled (0.1.1 text)')
  for (const id of ['standard-gitbash', 'cordis-gitbash']) {
    assert.doesNotMatch(read(id, 'agent.cordis.yml'), workflowRow, id + ' must keep workflow enabled')
    assert.doesNotMatch(read(id, 'agent.cordis.ptc.yml'), workflowRow, id + ' ptc era must keep workflow enabled')
  }
  // minimal: no twin, and the built-in did not change across the rename
  assert.ok(!existsSync(join(here, '..', 'assets', 'minimal-gitbash', 'agent.cordis.ptc.yml')))
})

test('pickComposition prefers the era twin and falls back to the base file', () => {
  assert.equal(_internal.pickComposition('ptc', ['agent.cordis.ptc.yml', 'agent.cordis.yml']), 'agent.cordis.ptc.yml')
  assert.equal(_internal.pickComposition('code', ['agent.cordis.ptc.yml', 'agent.cordis.yml']), 'agent.cordis.yml')
  // minimal case: no twin on disk → the base file serves both eras
  assert.equal(_internal.pickComposition('ptc', ['agent.cordis.yml']), 'agent.cordis.yml')
  assert.equal(_internal.pickComposition('code', []), 'agent.cordis.yml')
})

test('detectBase reads the roster; a failing roster falls back to the code era', async () => {
  assert.equal(await _internal.detectBase({ list: async () => [{ id: 'standard' }, { id: 'ptc' }, { id: 'cordis' }] }), 'ptc')
  assert.equal(await _internal.detectBase({ list: async () => [{ id: 'standard' }, { id: 'code' }] }), 'code')
  assert.equal(await _internal.detectBase({ list: async () => { throw new Error('boom') } }), 'code')
})

test('materialize writes the ptc-era text and records the era in the marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitbash-shell-'))
  const target = join(dir, 'code-gitbash')
  try {
    _internal.materialize({ target, presetId: 'code-gitbash', skillsSource: null, version: '0.6.0', base: 'ptc' })
    const written = readFileSync(join(target, 'agent.cordis.yml'), 'utf8')
    assert.match(written, /mode: ptc/)
    assert.doesNotMatch(written, /mode: code/)
    assert.match(written, /disabled: false/)
    const marker = JSON.parse(readFileSync(join(target, '.plugin-managed.json'), 'utf8'))
    assert.equal(marker.base, 'ptc')
    assert.equal(_internal.classify(target), 'unmodified')
    // the code era still writes the historical text
    _internal.materialize({ target, presetId: 'code-gitbash', skillsSource: null, version: '0.6.0', base: 'code' })
    assert.match(readFileSync(join(target, 'agent.cordis.yml'), 'utf8'), /mode: code/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('syncDecision refreshes when the detected built-in era flips', () => {
  const marker = { version: '0.6.0', base: 'code', files: {} }
  assert.equal(_internal.syncDecision({ state: 'unmodified', marker, version: '0.6.0', sourceHashes: null, base: 'ptc' }), 'refresh')
  assert.equal(_internal.syncDecision({ state: 'unmodified', marker, version: '0.6.0', sourceHashes: null, base: 'code' }), 'idle')
  // a pre-0.6.0 marker has no base at all → refresh (one-time re-materialization)
  assert.equal(_internal.syncDecision({ state: 'unmodified', marker: { version: '0.6.0', files: {} }, version: '0.6.0', sourceHashes: null, base: 'code' }), 'refresh')
})


test('msys path translation helpers', async () => {
  const { _internal } = await import('../src/index.js')
  const { translateMsysPath, translatePathArguments } = _internal
  assert.equal(translateMsysPath('/c/Users/kanna'), 'C:/Users/kanna')
  assert.equal(translateMsysPath('/e/project/x'), 'E:/project/x')
  assert.equal(translateMsysPath('/c/'), 'C:/')
  // non-MSYS shapes pass through unchanged
  assert.equal(translateMsysPath('C:/Users'), 'C:/Users')
  assert.equal(translateMsysPath('C:\\Users'), 'C:\\Users')
  assert.equal(translateMsysPath('AGENTS.md'), 'AGENTS.md')
  assert.equal(translateMsysPath('/home/u'), '/home/u')
  // argument rewriting: PURE — a NEW object when any path field changes,
  // the ORIGINAL reference otherwise; the frozen input is never touched
  // (0.10.2: the registry deep-freezes exec.arguments, the wrapper replaces
  // the exec.arguments property instead)
  const args = { file_path: '/c/a/b.txt', command: 'ls /c/a', workdir: '/e/p', pattern: '*.ts' }
  const out = translatePathArguments(args)
  assert.notEqual(out, args, 'a changed result must be a new object')
  assert.equal(out.file_path, 'C:/a/b.txt')
  assert.equal(out.workdir, 'E:/p')
  assert.equal(out.command, 'ls /c/a', 'bash command stays MSYS-native')
  assert.equal(out.pattern, '*.ts')
  assert.equal(args.file_path, '/c/a/b.txt', 'the original (frozen) input is untouched')
  assert.deepEqual(translatePathArguments(args), out, 'deterministic translation (value equality; fresh reference each call)')
  const none = { command: 'pwd' }
  assert.equal(translatePathArguments(none), none, 'unchanged input returns the same reference')
  assert.equal(translatePathArguments(null), null)
  const empty = {}
  assert.equal(translatePathArguments(empty), empty, 'empty object returns the same reference')
  const frozen = Object.freeze({ file_path: '/c/x/y.txt' })
  const thawed = translatePathArguments(frozen)
  assert.equal(thawed.file_path, 'C:/x/y.txt', 'a deep-frozen input still translates into the new object')
})

test('client half is a ModuleLoader bundle with baseline requires only', () => {
  const text = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(text, /window\.__ModuleLoader__\.load\(/)
  assert.match(text, /return module\.exports/, 'factory must return its exports (0.10.1 guard: without it the module materializes undefined and the loader rejects the plugin)')
  assert.match(text, /slots\.inject\("settings\.plugin\.item", function \(\) \{[\s\S]*return slots\.register\(/, 'two-stage slot registration: slots.inject(hole, cb) whose body calls slots.register — direct options/component args never register (0.10.3 lesson)')
  assert.match(text, /id: "dsh-gitbash-shell"/)
  const requires = [...text.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])
  const baseline = new Set(['react', '@deepseek-ai/dsh-client-ui-primitives'])
  for (const specifier of requires) {
    assert.ok(baseline.has(specifier), 'non-baseline require: ' + specifier)
  }
  assert.ok(requires.length > 0)
  assert.doesNotMatch(text, /(^|\n)\s*import\s/)
  assert.doesNotMatch(text, /(^|\n)\s*export\s/)
  assert.doesNotMatch(text, /=> </, 'JSX arrow syntax is forbidden')
  new Function(text)
})

test('client dictionaries stay key-aligned', () => {
  const text = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const zhBlock = text.slice(text.indexOf('var zh = {'), text.indexOf('var en = {'))
  const enBlock = text.slice(text.indexOf('var en = {'), text.indexOf('// ── styles'))
  const keysOf = (block) => new Set([...block.matchAll(/"([a-zA-Z][^"]*)":/g)].map((m) => m[1]))
  const zhKeys = keysOf(zhBlock)
  const enKeys = keysOf(enBlock)
  assert.ok(zhKeys.size > 0)
  assert.deepEqual([...enKeys].sort(), [...zhKeys].sort(), 'zh/en dictionaries must be key-aligned')
})

test('host gates the path dialect behind the posixPaths setting', async () => {
  const text = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(text, /SETTINGS_NAMESPACE = 'gitbash-shell'/)
  assert.match(text, /posixPaths: Schema\.boolean\(\)\.default\(true\)/)
  assert.match(text, /readPosixPaths\(ctx\)/, 'wrapper must read the gate per dispatch')
  assert.match(text, /pctx\.get\('settings'\)/, 'directive closure must read settings via ctx.get')
  const { _internal } = await import('../src/index.js')
  assert.equal(_internal.readPosixPaths({ get: () => undefined }), false)
  assert.equal(_internal.readPosixPaths(undefined), false)
  assert.equal(_internal.readPosixPaths({ get: () => ({ get: () => ({ posixPaths: true }) }) }), true)
})

test('shellEnv fact DSH_PATH_DIALECT rides the official registry, gated live', () => {
  const text = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  // registered through the official dsh-shell-env registry at service-ready
  // timing — never by mutating the process environment
  assert.match(text, /ctx\.inject\(\['shellEnv'\], \(envCtx\) => \{/)
  assert.match(text, /shellEnv\.register\(\{/)
  assert.match(text, /DSH_PATH_DIALECT/)
  // the resolver reads the live switch per execution: flipping the setting
  // empties the variable with no re-registration
  assert.match(text, /resolve\(\) \{\s*return readPosixPaths\(envCtx\) \? \{ \[PATH_DIALECT_KEY\]: PATH_DIALECT_VALUE \} : \{\}/)
  // effect-scoped and reversible: the disposer rides the plugin fiber
  assert.match(text, /envCtx\.effect\(\(\) => unregister/)
})

test('windowsToMsys rewrites Windows absolute paths to MSYS roots', async () => {
  const { _internal } = await import('../src/index.js')
  const w = _internal.windowsToMsys
  const BS = String.fromCharCode(92) // backslash, assembled to survive any transport layer
  const q = (s) => String.fromCharCode(34) + s + String.fromCharCode(34)
  assert.equal(w('C:' + BS + 'Users' + BS + 'kanna' + BS + 'sandbox'), '/c/Users/kanna/sandbox')
  assert.equal(w('C:/Users/kanna'), '/c/Users/kanna')
  assert.equal(w('E:' + BS + 'project' + BS + 'deepseek-harness'), '/e/project/deepseek-harness')
  assert.equal(w('see C:' + BS + 'Users' + BS + 'kanna, then stop'), 'see /c/Users/kanna, then stop')
  assert.equal(w('root (C:' + BS + 'Users' + BS + 'kanna) done'), 'root (/c/Users/kanna) done')
  assert.equal(w(q('C:' + BS + 'Program Files' + BS + 'Git')), q('/c/Program Files/Git'))
  assert.equal(w('https://x.dev/a and file://C:/x stay'), 'https://x.dev/a and file://C:/x stay')
  assert.equal(w('/c/already/posix stays'), '/c/already/posix stays')
  assert.equal(w('no paths here'), 'no paths here')
})

test('rewriteResultPaths rewrites result metadata, never content', async () => {
  const { _internal } = await import('../src/index.js')
  const rr = _internal.rewriteResultPaths
  const BS = String.fromCharCode(92)
  const rd = rr('read', { path: 'C:' + BS + 'Users' + BS + 'x' + BS + 'f.txt', lines: [{ n: 1, text: 'see C:' + BS + 'Users in content' }] })
  assert.equal(rd.path, '/c/Users/x/f.txt')
  assert.equal(rd.lines[0].text, 'see C:' + BS + 'Users in content', 'file content is never rewritten')
  const gl = rr('glob', { paths: ['a' + BS + 'b' + BS + 'c.txt'] })
  assert.equal(gl.paths[0], 'a/b/c.txt')
  const gp = rr('grep', { matches: [{ path: 'd' + BS + 's' + BS + 'i.js', line: 'C:' + BS + 'x stays' }] })
  assert.equal(gp.matches[0].path, 'd/s/i.js')
  assert.equal(gp.matches[0].line, 'C:' + BS + 'x stays', 'match text is never rewritten')
  const bash = { stdout: 'x' }
  assert.equal(rr('bash', bash), bash, 'non-path tools pass through untouched')
  const already = { path: '/c/already.txt' }
  assert.equal(rr('read', already), already, 'an unchanged value returns the same reference')
})
