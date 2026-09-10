import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  // minimal: no ptc twin (the built-in did not change across the rename), but
  // v0.12.0 adds its persona-split twin for dsh >= 0.1.3-alpha.2
  assert.ok(!existsSync(join(here, '..', 'assets', 'minimal-gitbash', 'agent.cordis.ptc.yml')))
  assert.ok(existsSync(join(here, '..', 'assets', 'minimal-gitbash', 'agent.cordis.ps.yml')))
})

test('pickComposition prefers the era twin and falls back to the base file', () => {
  assert.equal(_internal.pickComposition('ptc', 'text', ['agent.cordis.ptc.yml', 'agent.cordis.yml']), 'agent.cordis.ptc.yml')
  assert.equal(_internal.pickComposition('code', 'text', ['agent.cordis.ptc.yml', 'agent.cordis.yml']), 'agent.cordis.yml')
  // minimal case: no twin on disk → the base file serves both eras
  assert.equal(_internal.pickComposition('ptc', 'text', ['agent.cordis.yml']), 'agent.cordis.yml')
  assert.equal(_internal.pickComposition('code', 'text', []), 'agent.cordis.yml')
  // persona-split (v0.12.0): the .ptc.ps twin wins for era'd variants…
  assert.equal(_internal.pickComposition('ptc', 'split', ['agent.cordis.ptc.ps.yml', 'agent.cordis.ptc.yml', 'agent.cordis.yml']), 'agent.cordis.ptc.ps.yml')
  // …minimal's .ps twin serves the split form (it never had a ptc twin)…
  assert.equal(_internal.pickComposition('ptc', 'split', ['agent.cordis.ps.yml', 'agent.cordis.yml']), 'agent.cordis.ps.yml')
  // …and pre-split assets still resolve when the split twin is absent
  assert.equal(_internal.pickComposition('ptc', 'split', ['agent.cordis.ptc.yml', 'agent.cordis.yml']), 'agent.cordis.ptc.yml')
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
    // the persona-split twin (v0.12.0) writes the split-form persona and records it
    _internal.materialize({ target, presetId: 'code-gitbash', skillsSource: null, version: '0.12.0', base: 'ptc', persona: 'split' })
    const splitText = readFileSync(join(target, 'agent.cordis.yml'), 'utf8')
    assert.match(splitText, /mode: ptc/)
    assert.match(splitText, /suffix: Your working directory is \{\{cwd\}\}\./)
    assert.match(splitText, /prefix:/)
    const splitMarker = JSON.parse(readFileSync(join(target, '.plugin-managed.json'), 'utf8'))
    assert.equal(splitMarker.persona, 'split')
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

test('syncDecision refreshes when the persona form flips (0.1.3-alpha.2 split)', () => {
  const same = { state: 'unmodified', version: '0.12.0', sourceHashes: null, base: 'ptc' }
  assert.equal(_internal.syncDecision({ ...same, marker: { version: '0.12.0', base: 'ptc', persona: 'split', files: {} }, persona: 'split' }), 'idle')
  assert.equal(_internal.syncDecision({ ...same, marker: { version: '0.12.0', base: 'ptc', persona: 'text', files: {} }, persona: 'split' }), 'refresh')
  assert.equal(_internal.syncDecision({ ...same, marker: { version: '0.12.0', base: 'ptc', persona: 'split', files: {} }, persona: 'text' }), 'refresh')
  // a pre-0.12.0 marker has no persona field → treated as 'text': idle on a
  // pre-split host, one-time refresh after the host crosses the split
  assert.equal(_internal.syncDecision({ ...same, marker: { version: '0.12.0', base: 'ptc', files: {} }, persona: 'text' }), 'idle')
  assert.equal(_internal.syncDecision({ ...same, marker: { version: '0.12.0', base: 'ptc', files: {} }, persona: 'split' }), 'refresh')
})

test('persona-split twins carry the split keys; pre-split texts keep text', () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const read = (id, f) => readFileSync(join(here, '..', 'assets', id, f), 'utf8').replace(/\r\n/g, '\n')
  const personaRow = (text) => {
    const m = text.match(/- id: persona[\s\S]*?(?=\n- id: )/)
    assert.ok(m, 'persona row present')
    return m[0]
  }
  for (const id of ['standard-gitbash', 'code-gitbash', 'cordis-gitbash']) {
    const ps = personaRow(read(id, 'agent.cordis.ptc.ps.yml'))
    assert.match(ps, /prefix:/, id + ' ps twin carries the split prefix key')
    assert.match(ps, /suffix: Your working directory is /, id + ' ps twin carries the cwd suffix')
    assert.doesNotMatch(ps, /\btext:/, id + ' ps twin drops the retired text key')
    assert.doesNotMatch(personaRow(read(id, 'agent.cordis.ptc.yml')), /prefix:/, id + ' pre-split twin keeps the text key')
    assert.doesNotMatch(personaRow(read(id, 'agent.cordis.yml')), /prefix:/, id + ' code era keeps the text key')
  }
  const minimalPs = personaRow(read('minimal-gitbash', 'agent.cordis.ps.yml'))
  assert.match(minimalPs, /prefix: You are a helpful software engineer assistant\./)
  assert.match(minimalPs, /complete: true/, 'minimal keeps its complete-prompt policy')
  assert.match(minimalPs, /includeRuntimeContext: false/)
  assert.doesNotMatch(minimalPs, /\btext:/)
  assert.doesNotMatch(personaRow(read('minimal-gitbash', 'agent.cordis.yml')), /prefix:/)
})

test('persona era detection reads the shipped persona form, built-ins only', async () => {
  const { personaEraForText, detectPersonaEra } = _internal
  const newText = "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    suffix: Your working directory is {{cwd}}.\n    prefix: >-\n      You are a coding agent.\n"
  const oldText = "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: >-\n      You are a coding agent.\n"
  assert.equal(personaEraForText(newText), 'split')
  assert.equal(personaEraForText(oldText), 'text')
  assert.equal(personaEraForText('no persona row at all'), 'text')
  const split = mkdtempSync(join(tmpdir(), 'persona-era-'))
  const preSplit = mkdtempSync(join(tmpdir(), 'persona-era-'))
  try {
    writeFileSync(join(split, 'agent.cordis.yml'), newText)
    writeFileSync(join(preSplit, 'agent.cordis.yml'), oldText)
    // own variants on the roster are ignored — only built-in ids are probed
    const roster = { list: async () => [
      { id: 'standard-gitbash', path: join(preSplit, 'agent.cordis.yml') },
      { id: 'standard', path: join(split, 'agent.cordis.yml') },
    ] }
    assert.equal(await detectPersonaEra(roster), 'split')
    // a directory-shaped path resolves to its agent.cordis.yml
    assert.equal(await detectPersonaEra({ list: async () => [{ id: 'ptc', path: split }] }), 'split')
    // failures degrade conservatively to the pre-split form
    assert.equal(await detectPersonaEra({ list: async () => { throw new Error('boom') } }), 'text')
    assert.equal(await detectPersonaEra({ list: async () => [] }), 'text')
  } finally {
    rmSync(split, { recursive: true, force: true })
    rmSync(preSplit, { recursive: true, force: true })
  }
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
test('injectPresentRow: anchor splice, tail append, idempotent (dsh 0.1.5-alpha.2 sync)', () => {
  const inject = _internal.injectPresentRow
  const anchorText = [
    "- id: tool-presentation",
    "  name: '@deepseek-ai/dsh-agent-tool-presentation'",
    '  config:',
    '    mode: ptc',
    '',
    '# tail section',
    "- id: tool-cordis",
    "  name: '@deepseek-ai/dsh-tool-cordis'",
  ].join('\n')
  const spliced = inject(anchorText)
  const at = spliced.indexOf("  name: '@deepseek-ai/dsh-tool-present'")
  const presentation = spliced.indexOf('tool-presentation')
  const cordis = spliced.indexOf('tool-cordis')
  assert.ok(at !== -1 && at > presentation && at < cordis, 'present sits right after the presentation block')
  assert.equal(inject(spliced), spliced, 'already-injected text is untouched (idempotent)')
  const tailed = inject('- id: tool-web\n  name: web\n')
  assert.ok(tailed.endsWith("- id: present\n  name: '@deepseek-ai/dsh-tool-present'\n"), 'anchor-less texts gain the row at the tail')
  const noNewline = inject('- id: x')
  assert.ok(noNewline.includes('\n- id: present\n'), 'a missing trailing newline is repaired')
})

test('syncDecision refreshes when the host gains the present package (capability flip)', () => {
  const marker = { managedBy: 'dsh-gitbash-shell', version: '0.13.0', base: 'ptc', persona: 'split', present: false, files: {} }
  assert.equal(_internal.syncDecision({ state: 'unmodified', marker, version: '0.13.0', sourceHashes: null, base: 'ptc', persona: 'split', present: false }), 'idle')
  assert.equal(_internal.syncDecision({ state: 'unmodified', marker, version: '0.13.0', sourceHashes: null, base: 'ptc', persona: 'split', present: true }), 'refresh', 'host upgrade must re-materialize')
  const legacy = { managedBy: 'dsh-gitbash-shell', version: '0.13.0', base: 'ptc', persona: 'split', files: {} }
  assert.equal(_internal.syncDecision({ state: 'unmodified', marker: legacy, version: '0.13.0', sourceHashes: null, base: 'ptc', persona: 'split', present: false }), 'idle', 'markers without the field default to no-present')
})

test('materialize injects present only for .ptc. twins and only when the host resolves it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitbash-shell-present-'))
  try {
    const withRow = _internal.materialize({ target: join(dir, 'a'), presetId: 'code-gitbash', skillsSource: null, version: '0.13.0', base: 'ptc', persona: 'split', present: true })
    void withRow
    const text = readFileSync(join(dir, 'a', 'agent.cordis.yml'), 'utf8')
    assert.ok(text.includes("name: '@deepseek-ai/dsh-tool-present'"), 'ptc twin gains the row')
    assert.ok(text.indexOf('dsh-tool-present') > text.indexOf('tool-presentation'), 'row lands after presentation')
    const marker = JSON.parse(readFileSync(join(dir, 'a', '.plugin-managed.json'), 'utf8'))
    assert.equal(marker.present, true, 'marker records the capability')
    _internal.materialize({ target: join(dir, 'b'), presetId: 'code-gitbash', skillsSource: null, version: '0.13.0', base: 'ptc', persona: 'split', present: false })
    assert.ok(!readFileSync(join(dir, 'b', 'agent.cordis.yml'), 'utf8').includes('dsh-tool-present'), 'capability-less host gets no row')
    _internal.materialize({ target: join(dir, 'c'), presetId: 'minimal-gitbash', skillsSource: null, version: '0.13.0', base: 'ptc', persona: 'split', present: true })
    assert.ok(!readFileSync(join(dir, 'c', 'agent.cordis.yml'), 'utf8').includes('dsh-tool-present'), 'minimal never gains the row (single-tool preset)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('minimal twins are single-tool: no filesystem group, environment-dependent network line', () => {
  for (const file of ['agent.cordis.yml', 'agent.cordis.ps.yml']) {
    const text = readFileSync(join(fileURLToPath(new URL('../assets/minimal-gitbash/', import.meta.url)), file), 'utf8')
    assert.ok(!text.includes('str-replace-editor'), file + ': str_replace_editor must be gone')
    assert.ok(!text.includes('- id: filesystem'), file + ': the bare filesystem group must be gone')
    assert.ok(text.includes('Network access depends on the task environment'), file + ': bash description follows the one-shot shell contract')
    assert.ok(!text.includes('mirror of common linux and python packages'), file + ': the old fixed network lines are gone')
    assert.ok(text.includes('single-tool coding-agent composition'), file + ': banner is single-tool')
  }
  const preset = readFileSync(fileURLToPath(new URL('../assets/minimal-gitbash/preset.yml', import.meta.url)), 'utf8')
  assert.ok(preset.includes('单工具编码 Agent'), 'preset.yml描述 follows the official wording')
})

test('ptc-era assets stay present-row free (injection is a materialization concern)', () => {
  const assetsDir = fileURLToPath(new URL('../assets/', import.meta.url))
  for (const presetId of _internal.PRESET_IDS) {
    const dir = join(assetsDir, presetId)
    for (const file of readdirSync(dir)) {
      if (!file.includes('.ptc.')) continue
      const text = readFileSync(join(dir, file), 'utf8')
      assert.ok(!text.includes('dsh-tool-present'), presetId + '/' + file + ': the row must never be committed into an asset')
    }
  }
  // code-gitbash's ptc twin is ptc-derived and MUST offer the anchor splice.
  const codePtc = readFileSync(join(assetsDir, 'code-gitbash', 'agent.cordis.ptc.yml'), 'utf8')
  assert.ok(codePtc.includes("'@deepseek-ai/dsh-agent-tool-presentation'"), 'ptc-derived twin carries the presentation anchor')
})
