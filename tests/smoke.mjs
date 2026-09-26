import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _internal } from '../src/index.js'
import {
  TOOLCHAIN, WINGET_SOURCE, classifyToolState, classifyWingetResult, installArgv,
  isActionable, isNoMatchExit, parseExportJson, scanCommands, toolById, upgradeArgv,
} from '../src/toolchain.js'
import { fenceToolRequest, runToolJob } from '../src/tool-runner.js'

/* Bindings for the shell.js eval harnesses below: those strip every `import`
   line, so the shared bash resolver arrives as explicit stubs. The stub keeps
   the real contract that matters to the executor — a CONFIGURED path resolves
   to itself (never to some other shell), an empty one does not resolve. */
const resolveBashStub = ({ configured }) => configured === ''
  ? { ok: false, path: '', root: '', gitExe: '', source: '', tried: [], rejected: [], configured: '' }
  : { ok: true, path: configured, root: configured.replace(/\/bin\/bash\.exe$/, ''), gitExe: '', source: 'configured', tried: [], rejected: [], configured }
const effectiveBashStub = (own, settings) => (typeof own === 'string' && own.trim() !== '' ? own.trim() : (typeof settings === 'string' ? settings.trim() : ''))
const settingsBashStub = () => ''
const bashReportStub = (resolution) => (resolution.ok ? 'resolved: ' + resolution.path : 'unresolved (stub)')

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

test('msys virtual mounts, glob split, present nesting, temp echo (v0.17.0)', async () => {
  const { _internal } = await import('../src/index.js')
  const { translateMsysPath, translatePathArguments, translateGlobArguments, rewriteResultPaths } = _internal
  const BS = String.fromCharCode(92)
  const NUL = BS + BS + '.' + BS + 'NUL'
  const env = { tmpDir: 'C:/Users/u/AppData/Local/Temp', home: 'C:/Users/u', gitRoot: 'C:/Program Files/Git' }
  // ~ expands to home exactly like bash ($HOME), ~user stays untouched
  assert.equal(translateMsysPath('~', env), 'C:/Users/u')
  assert.equal(translateMsysPath('~/.gitconfig', env), 'C:/Users/u/.gitconfig')
  assert.equal(translateMsysPath('~other/x', env), '~other/x')
  // /tmp is the user TEMP dir (usertemp mount), segment-bounded
  assert.equal(translateMsysPath('/tmp', env), env.tmpDir)
  assert.equal(translateMsysPath('/tmp/a b.txt', env), env.tmpDir + '/a b.txt')
  assert.equal(translateMsysPath('/tmpfoo', env), '/tmpfoo')
  assert.equal(translateMsysPath('/tmpx/y', env), '/tmpx/y')
  assert.equal(translateMsysPath('/Tmp/x', env), '/Tmp/x', 'mount names are case-sensitive like the msys table')
  // /dev/null is the Windows NUL device — never a bare 'NUL' string (which
  // libuv would create as a REAL FILE in cwd) and never a recycle bin
  assert.equal(translateMsysPath('/dev/null', env), NUL)
  // /usr & friends live under the Git root; /bin maps to usr/bin (mount table)
  assert.equal(translateMsysPath('/usr', env), 'C:/Program Files/Git/usr')
  assert.equal(translateMsysPath('/usr/bin/bash.exe', env), 'C:/Program Files/Git/usr/bin/bash.exe')
  assert.equal(translateMsysPath('/bin/sh', env), 'C:/Program Files/Git/usr/bin/sh')
  assert.equal(translateMsysPath('/etc/profile', env), 'C:/Program Files/Git/etc/profile')
  assert.equal(translateMsysPath('/home/u', env), 'C:/Program Files/Git/home/u', '/home is the GIT mount, matching bash — the shorthand ~ is the user home')
  // bare drive roots
  assert.equal(translateMsysPath('/c', env), 'C:/')
  assert.equal(translateMsysPath('/E', env), 'E:/')
  // without an env only drive roots translate (backwards compatibility)
  assert.equal(translateMsysPath('/tmp/x'), '/tmp/x')
  assert.equal(translateMsysPath('/usr/bin'), '/usr/bin')
  assert.equal(translateMsysPath('~/.gitconfig'), '~/.gitconfig')
  // a missing gitRoot fact leaves /usr untranslated (defensive no-op)
  const noGit = { tmpDir: env.tmpDir, home: env.home }
  assert.equal(translateMsysPath('/usr/bin/rg', noGit), '/usr/bin/rg')

  // present's nested files[].path rides along, frozen input safe
  const pa = translatePathArguments({ files: [{ path: '/c/a/b.txt', description: 'd' }, { path: 'plain.md' }] }, env)
  assert.equal(pa.files[0].path, 'C:/a/b.txt')
  assert.equal(pa.files[1].path, 'plain.md')
  const frozenFiles = Object.freeze({ files: Object.freeze([{ path: '/tmp/t.png' }]) })
  assert.equal(translatePathArguments(frozenFiles, env).files[0].path, env.tmpDir + '/t.png')
  const plain = translatePathArguments({ command: 'ls /c/a' }, env)
  assert.equal(plain.command, 'ls /c/a', 'bash command stays MSYS-native')

  // glob: an absolute pattern splits into { path, pattern }; relative stays
  const tg = translateGlobArguments
  assert.deepEqual(tg({ pattern: '/c/Users/x/*.md' }, env), { pattern: '*.md', path: 'C:/Users/x' })
  assert.deepEqual(tg({ pattern: '/c/a/*/b/*.md' }, env), { pattern: '*/b/*.md', path: 'C:/a' })
  assert.deepEqual(tg({ pattern: '/tmp/t/*.log' }, env), { pattern: '*.log', path: env.tmpDir + '/t' })
  assert.deepEqual(tg({ pattern: '/c/Users/x/readme.md' }, env), { pattern: 'readme.md', path: 'C:/Users/x' }, 'no wildcard: dir + basename')
  assert.deepEqual(tg({ pattern: 'C:/Users/x/*.md' }, env), { pattern: '*.md', path: 'C:/Users/x' }, 'Windows-form patterns split too')
  assert.deepEqual(tg({ pattern: 'C:' + BS + 'Users' + BS + 'x' + BS + '*.md' }, env), { pattern: '*.md', path: 'C:/Users/x' })
  assert.deepEqual(tg({ pattern: '/c/a/*.md', path: '/e/p' }, env), { pattern: '*.md', path: 'C:/a' }, 'an absolute pattern supersedes an existing path')
  const rel = { pattern: '*.ts' }
  assert.equal(tg(rel, env), rel, 'relative patterns return the same reference')
  const bare = { pattern: '/c' }
  assert.equal(tg(bare, env), bare, 'a bare drive root is not a pattern split')

  // result echo: TEMP paths come back as /tmp (that IS what /tmp means)
  const rr = rewriteResultPaths
  assert.equal(rr('read', { path: 'C:/Users/u/AppData/Local/Temp/x.txt' }, env).path, '/tmp/x.txt')
  assert.equal(rr('read', { path: 'c:/users/u/appdata/local/temp/x' }, env).path, '/tmp/x', 'case-insensitive prefix')
  assert.equal(rr('read', { path: 'C:' + BS + 'Users' + BS + 'u' + BS + 'AppData' + BS + 'Local' + BS + 'Temp' + BS + 'y.png' }, env).path, '/tmp/y.png')
  assert.equal(rr('read', { path: 'C:/Users/u/x/f.txt' }, env).path, '/c/Users/u/x/f.txt', 'non-TEMP paths keep the drive-root dialect')
  const pv = rr('present', { turn: 1, files: [{ path: 'C:/Users/u/AppData/Local/Temp/o.png', description: 'd' }] }, env)
  assert.equal(pv.files[0].path, '/tmp/o.png')
  assert.equal(rr('present', { turn: 1, files: [{ path: 'C:/x/o.png' }] }).files[0].path, '/c/x/o.png', 'present echoes MSYS without an env too')
  assert.equal(rr('read', { path: 'C:/Users/u/AppData/Local/Temp/x.txt' }).path, '/c/Users/u/AppData/Local/Temp/x.txt', 'no env: no temp substitution (backwards compatible)')
})

test('error-content dialect: path diagnostics translated, data never (v0.17.1)', async () => {
  const { _internal } = await import('../src/index.js')
  const { rewriteErrorContent, rewriteResultPaths, ERROR_CONTENT_TOOLS } = _internal
  const BS = String.fromCharCode(92)
  // a harness path diagnostic comes back in the MSYS dialect
  const ec = rewriteErrorContent([{ type: 'text', text: 'Error: cannot read ' + String.fromCharCode(34) + 'C:' + BS + 'Users' + BS + 'x' + BS + 'f.txt' + String.fromCharCode(34) + ': not found' }])
  assert.equal(ec[0].text, 'Error: cannot read ' + String.fromCharCode(34) + '/c/Users/x/f.txt' + String.fromCharCode(34) + ': not found')
  // non-drive-letter diagnostics stay verbatim; a NUL-device EINVAL gains
  // the v0.18.0 guidance block APPENDED (original text untouched)
  const keep = [{ type: 'text', text: 'EINVAL: invalid argument, realpath ' + BS + BS + '.' + BS + 'NUL' }]
  const guidedOld = rewriteErrorContent(keep)
  assert.equal(guidedOld[0].text, keep[0].text, 'device-path diagnostic text stays verbatim')
  assert.equal(guidedOld.length, 2, 'plus the appended NUL guidance block (v0.18.0)')
  const urlKeep = [{ type: 'text', text: 'see https://x.dev/a and file://C:/y stay' }]
  assert.equal(rewriteErrorContent(urlKeep), urlKeep, 'URLs never match and keep the exact reference')
  // bash is NOT on the error-translation list: failed command output is data
  assert.equal(ERROR_CONTENT_TOOLS.has('bash'), false)
  assert.equal(ERROR_CONTENT_TOOLS.has('read'), true)
  // the red line: file CONTENT in successful results is never rewritten
  const rd = rewriteResultPaths('read', { path: 'C:' + BS + 'x' + BS + 'f.txt', lines: [{ n: 1, text: 'content mentions C:' + BS + 'Users' + BS + 'kanna inside' }] })

test('leading variable shorthands + NUL guidance (v0.18.0)', async () => {
  const { _internal } = await import('../src/index.js')
  const { translateMsysPath, rewriteErrorContent } = _internal
  const D = String.fromCharCode(36)
  const env = { tmpDir: 'C:/Users/u/AppData/Local/Temp', home: 'C:/Users/u', gitRoot: 'C:/Program Files/Git' }
  assert.equal(translateMsysPath(D + 'HOME/.gitconfig', env), 'C:/Users/u/.gitconfig')
  assert.equal(translateMsysPath(D + '{TMPDIR}/x', env), env.tmpDir + '/x')
  assert.equal(translateMsysPath(D + 'TMP', env), env.tmpDir)
  assert.equal(translateMsysPath(D + 'OTHER/x', env), D + 'OTHER/x', 'unknown variables stay verbatim')
  assert.equal(translateMsysPath(D + 'HOMEX', env), D + 'HOMEX', 'NAMEX false positives stay verbatim')
  assert.equal(translateMsysPath(D + 'HOMEfoo/x', env), D + 'HOMEfoo/x')
  assert.equal(translateMsysPath(D + 'HOME/x', undefined), D + 'HOME/x', 'no env: no expansion (backwards compatible)')
  const BS = String.fromCharCode(92)
  const guided = rewriteErrorContent([{ type: 'text', text: 'EINVAL: invalid argument, realpath ' + BS + BS + '.' + BS + BS + 'NUL' }])
  assert.equal(guided.length, 2, 'a NUL-device error gains one guidance block')
  assert.match(guided[1].text, /^hint: \/dev\/null is the NUL device/)
  assert.equal(guided[0].text.includes('EINVAL'), true, 'the original diagnostic stays verbatim')
  const plain = rewriteErrorContent([{ type: 'text', text: 'Error: cannot read X: not found' }])
  assert.equal(plain.length, 1, 'ordinary errors gain no guidance')
})

test('glob patterns may open with a variable shorthand (v0.18.1)', async () => {
  const { _internal } = await import('../src/index.js')
  const D = String.fromCharCode(36)
  const env = { tmpDir: 'C:/Users/u/AppData/Local/Temp', home: 'C:/Users/u', gitRoot: 'C:/Program Files/Git' }
  const tg = _internal.translateGlobArguments
  assert.deepEqual(tg({ pattern: D + 'HOME/sandbox/*.md' }, env), { pattern: '*.md', path: 'C:/Users/u/sandbox' })
  assert.deepEqual(tg({ pattern: D + '{TMPDIR}/t/*.log' }, env), { pattern: '*.log', path: env.tmpDir + '/t' })
  const rel = { pattern: '*.ts' }
  assert.equal(tg(rel, env), rel, 'relative patterns still return the same reference')
})
  assert.equal(rd.lines[0].text, 'content mentions C:' + BS + 'Users' + BS + 'kanna inside')
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

test('every shipped dictionary carries the same key set as zh', () => {
  // A locale block is preceded by a /* locale: <tag> */ marker, so the blocks
  // can be sliced without parsing the file. Equality matters because a key
  // missing from a third language falls back to English at lookup time — a
  // silent half-translated card, which is exactly what this catches.
  const text = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const keysOf = (segment) => [...segment.matchAll(/^\s*"([^"]+)":\s*"/gm)].map((match) => match[1]).sort()

  const zhKeys = keysOf(text.slice(text.indexOf('var zh = {'), text.indexOf('var en = {')))
  assert.ok(zhKeys.length >= 9, 'the zh dictionary looks truncated: ' + zhKeys.length)
  assert.deepEqual(
    keysOf(text.slice(text.indexOf('var en = {'), text.indexOf('var LOCALES = {'))),
    zhKeys,
    'en must stay key-aligned with zh',
  )

  const table = text.slice(text.indexOf('var LOCALES = {'), text.indexOf('// ── locale resolution'))
  const parts = table.split('/* locale: ')
  assert.ok(parts.length - 1 >= 19, 'expected at least nineteen third-language dictionaries, saw ' + (parts.length - 1))
  const shipped = new Set()
  for (let index = 1; index < parts.length; index += 1) {
    const tag = parts[index].slice(0, parts[index].indexOf(' */'))
    shipped.add(tag)
    assert.deepEqual(keysOf(parts[index]), zhKeys, 'dictionary ' + tag + ' does not match the zh key set')
  }
  for (const tag of ['ar', 'de', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'sv', 'th', 'tr', 'vi', 'zh-hk', 'zh-mo', 'zh-tw']) {
    assert.ok(shipped.has(tag), 'missing shipped locale: ' + tag)
  }
})

test('client dictionaries resolve live, never from a captured table', () => {
  const text = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(text, /function dictionaryFor\(active\)/, 'locale tags must resolve through dictionaryFor')
  assert.match(text, /function translatorOf\(ctx\)/, 'the live lookup must exist')
  assert.match(text, /var t = translatorOf\(ctx\)/, 'the card copy must come from the live lookup')
  assert.match(text, /locale\.subscribe\(/, 'the card must repaint on a live language switch')
  assert.match(text, /ctx\.locale\.register\(NS, Object\.assign\(\{ zh: zh, en: en \}, LOCALES\)\)/, 'every shipped dictionary must ride ctx.locale.register')
  assert.doesNotMatch(text, /var \w+ = dictionaryFor\(/, 'the dictionary must not be captured once at activation')

  // Drive the real bundle: apply() against a fake cordis ctx, then render the
  // registered card once per active locale. A switch must change the strings on
  // the SAME registration (no re-apply), which is what "live" means here.
  const react = {
    createElement: (type, props, ...children) => ({
      type,
      props: props === null || props === undefined ? {} : props,
      children: children.filter((child) => child !== null && child !== undefined && child !== false),
    }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: (effect) => effect(),
    Component: class Component { constructor(props) { this.props = props; this.state = {} } },
  }
  let bundle = null
  const navigatorStub = { language: 'en-US' }
  new Function('window', 'navigator', text)({ __ModuleLoader__: { load: (value) => { bundle = value } } }, navigatorStub)
  assert.equal(bundle.id, 'dsh-gitbash-shell')

  const dictionaries = new Map()
  const subscribers = []
  const locale = {
    register: (ns, dicts) => { dictionaries.set(ns, dicts); return () => {} },
    getSnapshot: () => ({ active: activeLocale }),
    subscribe: (fn) => { subscribers.push(fn); return () => {} },
  }
  let activeLocale = 'en'
  let registration = null
  const scope = { getSnapshot: () => ({ status: 'ready', value: { posixPaths: true } }), set: async () => {} }
  const ctx = {
    get: (name) => (name === 'locale' ? locale : undefined),
    settingsScope: { bind: () => scope },
    // the era-split acquisition: the OLD-era optional inject fires at once
    inject: (names, cb) => { if (names.includes('settingsScope')) cb({ settingsScope: ctx.settingsScope }) },
    slots: {
      inject: (hole, callback) => { callback() },
      register: (options, component) => { registration = { options, component }; return () => {} },
    },
    locale,
    effect: (body) => body(),
  }
  bundle.factory((specifier) => (specifier === 'react' ? react : {})).apply(ctx)

  const shipped = dictionaries.get('gitbashShell')
  assert.equal(Object.keys(shipped).length, 21, 'zh + en + 19 third languages must ride the registry')
  assert.equal(shipped.ja['title'], 'Git Bash パス方言')

  const render = () => {
    const props = Object.assign({}, registration.options.inject())
    const wrapper = registration.component(props)          // CardWithLocale -> LocaleLive element
    const live = wrapper.type(wrapper.props)               // LocaleLive render (subscribes on mount)
    const card = live.children[0]
    const strings = []
    const walk = (node) => {
      if (typeof node === 'string') { strings.push(node); return }
      if (node === null || typeof node !== 'object') return
      for (const child of node.children || []) walk(child)
    }
    walk(card.type(card.props))
    return strings
  }

  activeLocale = 'ja'
  assert.ok(render().includes('Git Bash パス方言'), 'ja must answer from its own dictionary')
  activeLocale = 'de'
  assert.ok(render().includes('Git-Bash-Pfaddialekt'), 'a switch must repaint without re-applying the plugin')
  activeLocale = 'zh-Hant-TW'
  assert.ok(render().includes('Git Bash 路徑方言'), 'a bare zh-Hant-* tag falls back to the HK copy')
  activeLocale = 'pt-BR'
  assert.ok(render().includes('Dialeto de caminhos do Git Bash'), 'a regional tag resolves through its primary subtag')
  activeLocale = ''
  navigatorStub.language = 'fr'
  assert.ok(render().includes('Dialecte de chemins Git Bash'), 'an empty preference falls back to the browser language')
  activeLocale = ''
  navigatorStub.language = 'xx-YY'
  assert.ok(render().includes('Git Bash path dialect'), 'an unsupported language shows English, never a raw key')
  assert.ok(subscribers.length >= 1 && subscribers.every((fn) => typeof fn === 'function'), 'the card subscribes to the locale service for the repaint')
})

test('client dual settings seat across dsh generations (0.1.6-alpha.2+)', () => {
  const text = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(text, /slots\.inject\("settings\.plugin\.item"/)
  assert.match(text, /slots\.inject\("plugins\.bundle\.config"/)
  assert.match(text, /key: "dsh-gitbash-shell"/, 'the Plugins-page seat is keyed by the PACKAGE name')
  assert.match(text, /props\.view === "page"/, 'the page view drops the collapsible shell')
})

test('sidebar adoption is switchable, default on, and never clobbers manual picks', async () => {
  const text = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(text, /adoptSidebar: Schema\.boolean\(\)\.default\(true\)/)
  assert.match(text, /readAdoptSidebar/, 'host reads the switch through the settings service')
  // OFF restores only while the current value is still ours
  assert.match(text, /if \(!desired && adopted && current === bashPath\)/)
  const { _internal } = await import('../src/index.js')
  assert.equal(_internal.readAdoptSidebar({ get: () => undefined }), true)
  assert.equal(_internal.readAdoptSidebar({ get: () => ({ get: () => ({ adoptSidebar: false }) }) }), false)
})

test('plugin-manager row injection mirrors the official per-preset shape (0.1.6-alpha.2)', async () => {
  const { _internal } = await import('../src/index.js')
  const base = "\n- id: present\n  name: '@deepseek-ai/dsh-tool-present'\n- id: tool-cordis\n"
  const on = _internal.injectPluginManagerRow(base, { enabled: true })
  assert.match(on, /tool-plugin-manager\n  name: '@deepseek-ai\/dsh-plugin-manager\/tools'\n/)
  assert.ok(!on.includes('disabled: true'), 'enabled form carries no disabled flag')
  assert.ok(on.indexOf('tool-plugin-manager') > on.indexOf("- id: present"), 'anchored after the present row')
  const off = _internal.injectPluginManagerRow(base, { enabled: false })
  assert.match(off, /tool-plugin-manager\n  name: '@deepseek-ai\/dsh-plugin-manager\/tools'\n  disabled: true\n/)
  // idempotent on both shapes
  assert.equal(_internal.injectPluginManagerRow(on, { enabled: false }), on)
  // tail fallback when no present row exists
  const tail = _internal.injectPluginManagerRow("\n- id: tool-cordis\n", { enabled: true })
  assert.match(tail, /tool-cordis\n- id: tool-plugin-manager/)
})

test('plugin-manager row never committed into assets; ps cordis twin carries the alpha.2 persona', () => {
  for (const presetId of ['code-gitbash', 'standard-gitbash', 'cordis-gitbash', 'minimal-gitbash']) {
    const dir = new URL(`../assets/${presetId}/`, import.meta.url)
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
      const text = readFileSync(new URL(file, dir), 'utf8')
      assert.ok(!text.includes("'@deepseek-ai/dsh-plugin-manager/tools'"), `${presetId}/${file} must not hard-code the plugin-manager row`)
    }
  }
  const ps = readFileSync(new URL('../assets/cordis-gitbash/agent.cordis.ptc.ps.yml', import.meta.url), 'utf8')
  assert.match(ps, /Use plugin_manager for persistent bundle installation/)
  assert.match(ps, /Load `editing-cordis-compositions` for file discovery/)
  // text-era ptc twin stays the pre-alpha.2 snapshot (self-consistent on its hosts)
  const text = readFileSync(new URL('../assets/cordis-gitbash/agent.cordis.ptc.yml', import.meta.url), 'utf8')
  assert.ok(!text.includes('Use plugin_manager for persistent bundle installation'), 'text-era twin keeps the old persona')
})

test('syncDecision refreshes when the pluginManager capability flips', async () => {
  const { syncDecision } = _internal
  const marker = { version: '1', base: 'ptc', persona: 'split', present: true, pluginManager: true, rows: 'x', files: {} }
  const same = { state: 'unmodified', marker, version: '1', sourceHashes: null, base: 'ptc', persona: 'split', present: true, pluginManager: true, rows: 'x' }
  assert.equal(syncDecision(same), 'idle')
  const flipped = { state: 'unmodified', marker, version: '1', sourceHashes: null, base: 'ptc', persona: 'split', present: true, pluginManager: false, rows: 'x' }
  assert.equal(syncDecision(flipped), 'refresh')
})

test('host gates the path dialect behind the posixPaths setting', async () => {
  const text = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(text, /SETTINGS_NAMESPACE = 'gitbash-shell'/)
  assert.match(text, /posixPaths: Schema\.boolean\(\)\.default\(true\)/)
  // dsh 0.1.7: the wrapper and the directive closure read the era-aware
  // live reader (Config refs on new hosts — re-read per dispatch/assembly;
  // the registered namespace through the OLD helpers on old hosts).
  assert.match(text, /const dialect = liveSettings\.dialect\(\)/, 'wrapper must read the gate per dispatch')
  assert.match(text, /liveSettings\.dialect\(\)/, 'directive closure must read the live dialect')
  // v0.27.0: the same live dialect object also carries the delegated-agent gate
  assert.match(text, /dialect\.posixPaths && dialectApplies\(dialect, exec && exec\.agent\)/,
    'the dispatch face asks the per-agent gate with THIS execution\'s agent')
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
  // the resolver reads the live switch per execution: flipping the setting
  // empties the variable with no re-registration
  // dsh 0.1.7: the resolver reads the era-aware live reader (Config refs on
  // new hosts, the registered namespace on old ones) — still per execution.
  assert.match(text, /resolve\(execution\) \{/, 'the resolver receives the execution')
  assert.match(text, /dialectApplies\(dialect, execution && execution\.agent\)/,
    'the DSH_PATH_DIALECT fact is withheld from a delegated agent the user excluded')
  // REGRESSION GUARD (v0.21.0 → v0.21.1): the registry accepts DSH_* facts
  // ONLY. A contributor declaring any other key throws, and the whole
  // contribution — DSH_PATH_DIALECT included — is lost. Non-DSH parity facts
  // belong to the executor's env layer (src/shell.js).
  const declared = /variables: \{([^}]*)\}/.exec(text)
  assert.ok(declared !== null, 'the contributor must declare its variables')
  // Literal keys must be DSH_*; computed keys are allowed only for constants
  // whose own literal value is asserted to start with DSH_.
  for (const key of declared[1].matchAll(/'([A-Za-z0-9_]+)':/g)) {
    assert.match(key[1], /^DSH_/, 'a non-DSH key in the shell-env registry kills the contribution: ' + key[1])
  }
  for (const key of declared[1].matchAll(/\[([A-Za-z0-9_]+)\]/g)) {
    assert.equal(key[1], 'PATH_DIALECT_KEY', 'unexpected computed key in the shell-env declaration: ' + key[1])
  }
  assert.match(text, /const PATH_DIALECT_KEY = 'DSH_/, 'the computed key must itself be a DSH_* fact')
  assert.doesNotMatch(declared[1], /GIT_CONFIG/, 'git config belongs to the executor, not to the DSH_* registry')
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

test('windowsToMsys keeps JSON-escaped Windows paths canonical (v0.26.0, issue #10)', async () => {
  const { _internal } = await import('../src/index.js')
  const w = _internal.windowsToMsys
  const BS = String.fromCharCode(92)
  const q = (s) => String.fromCharCode(34) + s + String.fromCharCode(34)
  // The host renders its sandbox:policy context line as
  // `JSON.stringify(policy.workspaceRoot)`, so the prompt carries DOUBLED
  // backslashes. A single-separator atom at the drive colon left the second
  // one in `rest` and the separator normalization promoted it to a leading
  // slash: "/d//dsh/工作".
  const escaped = 'D:' + BS + BS + 'dsh' + BS + BS + '工作'
  assert.equal(w(escaped), '/d/dsh/工作', 'the bare branch costs no extra slash')
  assert.equal(w(q(escaped)), q('/d/dsh/工作'), 'the quoted branch agrees')
  assert.equal(w(JSON.stringify('D:' + BS + 'dsh' + BS + '工作')), q('/d/dsh/工作'), 'exactly what JSON.stringify emits')
  assert.equal(w('D://dsh//工作'), '/d/dsh/工作', 'doubled forward slashes collapse the same way')
  assert.equal(w('C:' + BS + BS + 'Program Files' + BS + BS + 'Git'), '/c/Program Files/Git', 'spaced directories keep working')
  // Negative faces: single separators (the pre-existing behavior) stay
  // byte-for-byte, and non-drive forms are never touched.
  assert.equal(w('C:' + BS + 'Users' + BS + 'kanna'), '/c/Users/kanna')
  assert.equal(w(q('C:' + BS + 'Program Files' + BS + 'Git')), q('/c/Program Files/Git'))
  assert.equal(w('https://x.dev/a and file://C:/x stay'), 'https://x.dev/a and file://C:/x stay')
  assert.equal(w(BS + BS + 'server' + BS + 'share stays'), BS + BS + 'server' + BS + 'share stays', 'a UNC path has no drive colon')
  assert.equal(w('/d/dsh/工作 stays'), '/d/dsh/工作 stays')
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
  // v0.23.0 (issue #3): a whole-value field goes through pathEcho, so the
  // prose rewriter can no longer leave a spaced directory half-translated
  const spaced = rr('read', { path: 'C:' + BS + 'Users' + BS + 'u' + BS + 'my dir' + BS + 'f.txt' })
  assert.equal(spaced.path, '/c/Users/u/my dir/f.txt')
  assert.equal(rr('grep', { matches: [{ path: 'my dir' + BS + 's.js', line: 'x' }] }).matches[0].path, 'my dir/s.js')
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
test('detectPresentSupport reads the shipped composition text, never throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'present-probe-'))
  try {
    const file = join(dir, 'agent.cordis.yml')
    const probe = (path) => _internal.detectPresentSupport({ list: async () => [{ id: 'ptc', path }] })
    writeFileSync(file, "  name: '@deepseek-ai/dsh-tool-present'\n")
    assert.equal(await probe(dir), true, 'directory path is resolved to agent.cordis.yml')
    assert.equal(await probe(file), true, 'a direct .yml path is read as-is')
    writeFileSync(file, "  name: '@deepseek-ai/dsh-tool-cordis'\n")
    assert.equal(await probe(dir), false, 'shipped composition without the row → no injection')
    assert.equal(await _internal.detectPresentSupport({ list: async () => [{ id: 'minimal', path: dir }] }), false, 'minimal is never probed')
    assert.equal(await _internal.detectPresentSupport({ list: async () => { throw new Error('boom') } }), false, 'probe failure degrades to false')
    assert.equal(await _internal.detectPresentSupport({ list: async () => null }), false, 'non-array roster degrades to false')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('present support is the OR of the shipped-composition probe and package resolution', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(src, /await detectPresentSupport\(ctx\.agentPresets\)\) \|\| \(await hostHasToolPresent\(\)\)/,
    'both signals must be wired; the roster text is authoritative on CLI installs')
})
test('manifest and package versions stay in sync', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const manifest = JSON.parse(readFileSync(new URL('../dsh.plugin.json', import.meta.url), 'utf8'))
  assert.equal(pkg.version, manifest.version, 'dsh.plugin.json must track package.json (npm version script)')
  assert.equal(manifest.id, 'dsh-external/dsh-gitbash-shell')
  assert.equal(pkg.scripts.version !== undefined, true, 'the version script must exist so bumps stay in sync')
})

test('executor: the base class\'s Config fields stay volatile (issue #6)', () => {
  // dsh 0.1.7-alpha.1 (`feat(settings): project volatile Config through
  // profile-backed forms`, #4587) made `LocalBashExecutor.Config` declare
  // exactly these six fields `.volatile()` and read every one of them through
  // `.get()`
  // (packages/shell/bash-local/src/index.ts:100-107 + assertServiceableBashConfig).
  // `SandboxBashExecutor` — our parent — declares no Config of its own and
  // inherits that one verbatim, so THIS redeclaration is the executor's
  // contract: plain values here throw `config.timeoutMs.get is not a function`
  // on the first shell call and take the whole ctx.shell down (issue #6,
  // 0.24.2). Re-check this list whenever the host's bash-local Config changes.
  const baseLiveFields = ['cwd', 'timeoutMs', 'maxTimeoutMs', 'maxOutputBytes', 'maxSpillBytes', 'graceMs']

  const src = readFileSync('src/shell.js', 'utf8')
  const stripped = src.replace(/^import .*$/gm, '').replace(/^export default /gm, '').replace(/^export /gm, '')
  const scope = new Function('DEFAULT_GIT_BASH', 'SandboxBashExecutor', 'z', 'process',
    stripped + '\nreturn { gitBashShellConfig, Config, GitBashSandboxExecutor }')
  class FakeBase {}

  /** A recording schemastery stand-in: `supportsVolatile` picks the host era. */
  const recorder = (supportsVolatile) => {
    const nodes = []
    const node = () => {
      const n = { marked: 0 }
      n.default = () => n
      if (supportsVolatile) n.volatile = () => { n.marked += 1; return n }
      nodes.push(n)
      return n
    }
    const z = { string: node, number: node, array: node, object: (fields) => fields }
    return { z, nodes }
  }

  // 1) 0.1.7+ host (its schemastery HAS volatile): every inherited field must
  //    come out as a Volatile ref — exactly once — while our own bashPath knob
  //    stays plain (the base neither declares nor `.get()`s it, and
  //    `get bashPath()` reads it directly).
  const withVolatile = recorder(true)
  const liveFields = scope('C:/Program Files/Git/bin/bash.exe', FakeBase, withVolatile.z, process).gitBashShellConfig(withVolatile.z)
  assert.deepEqual(Object.keys(liveFields).sort(), [...baseLiveFields, 'bashPath'].sort(),
    'the executor Config must declare exactly the inherited fields plus bashPath')
  for (const key of baseLiveFields) {
    assert.equal(liveFields[key].marked, 1, key + ' must be marked volatile exactly once (issue #6)')
  }
  assert.equal(liveFields.bashPath.marked, 0, 'bashPath is our own knob and must stay a plain value')

  // 2) <=0.1.6 host (schemastery without volatile, base class reads plain
  //    values): the probe must NOT invent markers, or the old base class would
  //    receive objects it never calls `.get()` on.
  const withoutVolatile = recorder(false)
  const plainFields = scope('C:/Program Files/Git/bin/bash.exe', FakeBase, withoutVolatile.z, process).gitBashShellConfig(withoutVolatile.z)
  for (const key of [...baseLiveFields, 'bashPath']) {
    assert.equal(plainFields[key].marked, 0, key + ' must stay plain where volatile() does not exist')
  }

  // 3) The shipping Config is built through that same probe.
  assert.match(src, /export const Config = gitBashShellConfig\(z\)/)
  assert.match(src, /typeof schema\.volatile === 'function' \? schema\.volatile\(\) : schema/)
})

test('executor: Windows confined calls run unconfined and say so (issue #1)', async () => {
  const src = readFileSync('src/shell.js', 'utf8')
  const stripped = src.replace(/^import .*$/gm, '').replace(/^export default /gm, '').replace(/^export /gm, '')
  const scope = new Function('DEFAULT_GIT_BASH', 'resolveGitBashCached', 'effectiveConfiguredBashPath', 'settingsBashPath', 'bashResolutionReport', 'SandboxBashExecutor', 'z', 'process', stripped + '\nreturn { GitBashSandboxExecutor }')
  class FakeBase {
    constructor() { this.calls = [] }
    async run(spec) { this.calls.push(['super.run', spec]); return { via: 'super.run' } }
    start(spec) { this.calls.push(['super.start', spec]); return { via: 'super.start' } }
    async runArgv(spec, argv) { this.calls.push(['runArgv', argv]); return { exitCode: 0, stdout: {}, stderr: {} } }
    startArgv(spec, argv) { this.calls.push(['startArgv', argv]); return { started: true } }
  }
  const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain })
  const make = (platform) => {
    const mod = scope('C:/Program Files/Git/bin/bash.exe', resolveBashStub, effectiveBashStub, settingsBashStub, bashReportStub, FakeBase, chain, { platform })
    const ex = Object.create(mod.GitBashSandboxExecutor.prototype)
    ex.config = { bashPath: 'X:/git/bin/bash.exe' }
    ex.calls = []
    return ex
  }
  const spec = { command: 'echo hi', sandboxPolicy: { mode: 'workspace-write' } }
  const byKind = (ex, kind) => ex.calls.filter((c) => c[0] === kind)

  const logs = []
  const origLog = console.log
  console.log = (...a) => logs.push(a.join(' '))
  try {
    // Windows confined: unconfined argv path, honest label, sandbox stack untouched.
    const ex = make('win32')
    const r = await ex.run(spec)
    assert.equal(byKind(ex, 'runArgv').length, 1)
    assert.deepEqual(byKind(ex, 'runArgv')[0][1], ['X:/git/bin/bash.exe', '-c', 'echo hi'])
    assert.deepEqual(r.sandbox, { mode: 'workspace-write', denied: false, enforcement: 'unconfined' })
    assert.equal(byKind(ex, 'super.run').length, 0)
    const p = ex.start(spec)
    assert.deepEqual(p.sandbox, { mode: 'workspace-write', denied: false, enforcement: 'unconfined' })
    assert.equal(byKind(ex, 'super.start').length, 0)
    // One-time notice: the second confined call logs nothing more.
    await ex.run(spec)
    assert.equal(logs.length, 1)
    assert.ok(logs[0].includes('UNCONFINED'))
    // danger-full-access keeps its exact label (no enforcement key).
    const exFull = make('win32')
    const rFull = await exFull.run({ command: 'x', sandboxPolicy: { mode: 'danger-full-access' } })
    assert.deepEqual(rFull.sandbox, { mode: 'danger-full-access', denied: false })
    // Non-Windows confined keeps the shipped sandboxed path.
    const exLinux = make('linux')
    await exLinux.run(spec)
    assert.equal(byKind(exLinux, 'super.run').length, 1)
    assert.equal(byKind(exLinux, 'runArgv').length, 0)
    exLinux.start(spec)
    assert.equal(byKind(exLinux, 'super.start').length, 1)
    // No policy: fully inherited.
    const exNone = make('win32')
    await exNone.run({ command: 'x' })
    assert.equal(byKind(exNone, 'super.run').length, 1)
  } finally {
    console.log = origLog
  }
})

test('row forms: host spelling is read, aligned to, and idempotent (0.1.6 rename)', () => {
  const { rowFormOf, rowFormsOf, alignEngineRow, alignRalphRow } = _internal
  const OLD = "    - id: workflow-worker-thread\n      name: '@deepseek-ai/dsh-workflow-worker-thread'\n      config:\n        provider: spawn\n"
  const NEW = "    - id: workflow-ptc\n      name: '@deepseek-ai/dsh-workflow-ptc'\n      disabled: true\n      config:\n        provider: spawn\n"
  const RALPH_OFF = "    - id: tool-ralph\n      name: '@deepseek-ai/dsh-tool-ralph'\n      disabled: true\n      config:\n        maxRounds: 64\n"
  const RALPH_ON = "    - id: tool-ralph\n      name: '@deepseek-ai/dsh-tool-ralph'\n      config:\n        maxRounds: 64\n"

  assert.equal(rowFormOf(OLD, 'workflow-worker-thread').disabled, false)
  assert.equal(rowFormOf(NEW, 'workflow-ptc').disabled, true)
  assert.equal(rowFormOf(OLD, 'workflow-ptc'), undefined, 'an absent row reads as undefined')
  assert.equal(rowFormOf(RALPH_OFF, 'tool-ralph').disabled, true)
  assert.equal(rowFormOf(RALPH_ON, 'tool-ralph').disabled, false)
  // A later row's disabled must never leak into the engine row's own block.
  const stacked = OLD + RALPH_OFF
  assert.equal(rowFormOf(stacked, 'workflow-worker-thread').disabled, false)
  assert.equal(rowFormsOf(stacked).ralph.disabled, true)
  assert.equal(rowFormsOf(RALPH_ON).engine, undefined, 'no engine row at all')

  // Aligning to the NEW host rewrites id + package and copies the host states.
  const host = { engine: rowFormOf(NEW, 'workflow-ptc'), ralph: rowFormOf(RALPH_OFF, 'tool-ralph') }
  const aligned = alignRalphRow(alignEngineRow(OLD + RALPH_ON, host.engine), host.ralph)
  assert.ok(aligned.includes('- id: workflow-ptc'), 'engine id takes the host spelling')
  assert.ok(aligned.includes("name: '@deepseek-ai/dsh-workflow-ptc'"), 'engine package follows the id')
  assert.ok(!aligned.includes('workflow-worker-thread'), 'the deleted package name is gone')
  assert.equal(rowFormOf(aligned, 'workflow-ptc').disabled, true, 'the host disabled state is copied')
  assert.equal(rowFormOf(aligned, 'tool-ralph').disabled, true, 'ralph follows the host default')
  assert.equal(alignRalphRow(alignEngineRow(aligned, host.engine), host.ralph), aligned, 'alignment is idempotent')

  // Aligning to an OLD host is a no-op for the committed spelling...
  const oldHost = { engine: rowFormOf(OLD, 'workflow-worker-thread'), ralph: rowFormOf(RALPH_ON, 'tool-ralph') }
  assert.equal(alignRalphRow(alignEngineRow(OLD + RALPH_ON, oldHost.engine), oldHost.ralph), OLD + RALPH_ON)
  // ...and rewrites a new-spelling asset back for it.
  const back = alignRalphRow(alignEngineRow(NEW + RALPH_OFF, oldHost.engine), oldHost.ralph)
  assert.ok(back.includes('- id: workflow-worker-thread'))
  assert.ok(!back.includes('- id: workflow-ptc'))
  assert.equal(rowFormOf(back, 'tool-ralph').disabled, false, 'ralph is re-enabled to match the old host')

  // A composition without the rows (minimal) is returned untouched.
  const minimal = "    - id: tool-bash\n      name: '@deepseek-ai/dsh-tool-bash'\n"
  assert.equal(alignEngineRow(minimal, host.engine), minimal)
  assert.equal(alignRalphRow(minimal, host.ralph), minimal)
})

test('materialize aligns the engine row to the host and records it in the marker', () => {
  const { rowFormOf } = _internal
  const dir = mkdtempSync(join(tmpdir(), 'gitbash-shell-rows-'))
  try {
    const ptcHost = { engine: { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', disabled: true }, ralph: { disabled: true } }
    _internal.materialize({ target: join(dir, 'a'), presetId: 'code-gitbash', skillsSource: null, version: '0.14.0', base: 'ptc', persona: 'split', rows: { ptc: ptcHost } })
    const text = readFileSync(join(dir, 'a', 'agent.cordis.yml'), 'utf8')
    assert.ok(text.includes('- id: workflow-ptc'), 'the engine row takes the host spelling')
    assert.ok(!text.includes('workflow-worker-thread'), 'no trace of the deleted package')
    assert.equal(rowFormOf(text, 'tool-ralph').disabled, true, 'ralph follows the host default')
    const marker = JSON.parse(readFileSync(join(dir, 'a', '.plugin-managed.json'), 'utf8'))
    assert.equal(marker.rows, 'workflow-ptc:off:off', 'the marker records the aligned form')

    // No probe (roster unavailable): the committed spelling is written as-is.
    _internal.materialize({ target: join(dir, 'b'), presetId: 'code-gitbash', skillsSource: null, version: '0.14.0', base: 'ptc', persona: 'split' })
    assert.ok(readFileSync(join(dir, 'b', 'agent.cordis.yml'), 'utf8').includes('- id: workflow-worker-thread'), 'no probe leaves the frozen text alone')
    assert.equal(JSON.parse(readFileSync(join(dir, 'b', '.plugin-managed.json'), 'utf8')).rows, '', 'no probe records an empty form')

    // standard mirrors the standard preset, whose engine row stays live.
    const stdHost = { engine: { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', disabled: false }, ralph: { disabled: true } }
    _internal.materialize({ target: join(dir, 'c'), presetId: 'standard-gitbash', skillsSource: null, version: '0.14.0', base: 'ptc', persona: 'split', rows: { standard: stdHost } })
    const std = readFileSync(join(dir, 'c', 'agent.cordis.yml'), 'utf8')
    assert.equal(rowFormOf(std, 'workflow-ptc').disabled, false, 'standard keeps the engine live')

    // minimal has no engine row and is untouched either way.
    _internal.materialize({ target: join(dir, 'd'), presetId: 'minimal-gitbash', skillsSource: null, version: '0.14.0', base: 'ptc', persona: 'split', rows: { ptc: ptcHost } })
    assert.ok(!readFileSync(join(dir, 'd', 'agent.cordis.yml'), 'utf8').includes('workflow-'), 'minimal carries no engine row')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('syncDecision refreshes when the host row form flips (0.1.6 rename)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitbash-shell-rowsync-'))
  try {
    const target = join(dir, 'a')
    _internal.materialize({ target, presetId: 'code-gitbash', skillsSource: null, version: '0.14.0', base: 'ptc', persona: 'split' })
    const marker = JSON.parse(readFileSync(join(target, '.plugin-managed.json'), 'utf8'))
    const state = _internal.classify(target)
    assert.equal(state, 'unmodified')
    assert.equal(_internal.syncDecision({ state, marker, version: '0.14.0', sourceHashes: null, base: 'ptc', persona: 'split', present: false, rows: '' }), 'idle')
    assert.equal(_internal.syncDecision({ state, marker, version: '0.14.0', sourceHashes: null, base: 'ptc', persona: 'split', present: false, rows: 'workflow-ptc:off:off' }), 'refresh', 'a host rename re-materializes')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('assets keep the pre-rename engine spelling; alignment is a materialization concern', () => {
  const assetsDir = fileURLToPath(new URL('../assets/', import.meta.url))
  for (const presetId of _internal.PRESET_IDS) {
    const dir = join(assetsDir, presetId)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.yml') || file === 'preset.yml') continue
      const text = readFileSync(join(dir, file), 'utf8')
      assert.ok(!text.includes("'@deepseek-ai/dsh-workflow-ptc'"), presetId + '/' + file + ': the new package name must never be committed (hosts before 0.1.6 ship only the old one)')
      if (presetId === 'minimal-gitbash') continue
      assert.ok(text.includes("'@deepseek-ai/dsh-workflow-worker-thread'"), presetId + '/' + file + ': the engine row keeps the era-neutral committed spelling')
    }
  }
})

test('executor: runArgv envelope and start contract span both dsh eras (0.1.6)', async () => {
  const src = readFileSync('src/shell.js', 'utf8')
  const stripped = src.replace(/^import .*$/gm, '').replace(/^export default /gm, '').replace(/^export /gm, '')
  const scope = new Function('DEFAULT_GIT_BASH', 'resolveGitBashCached', 'effectiveConfiguredBashPath', 'settingsBashPath', 'bashResolutionReport', 'SandboxBashExecutor', 'z', 'process', stripped + '\nreturn { GitBashSandboxExecutor }')
  const RESULT = { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000, stdout: { text: 'hi', truncated: false }, stderr: { text: '', truncated: false } }
  const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain })
  const build = (Base, platform) => {
    const mod = scope('C:/Program Files/Git/bin/bash.exe', resolveBashStub, effectiveBashStub, settingsBashStub, bashReportStub, Base, chain, { platform })
    const ex = Object.create(mod.GitBashSandboxExecutor.prototype)
    ex.config = { bashPath: 'X:/git/bin/bash.exe' }
    ex.calls = []
    ex.runArgvReturns = RESULT
    return ex
  }
  // Pre-0.1.6 base: synchronous start, runArgv resolves to the bare result.
  class SyncBase {
    async run() { return { via: 'super.run' } }
    start() { this.calls.push(['super.start']); return { via: 'super.start' } }
    async runArgv() { return this.runArgvReturns }
    startArgv() { this.calls.push(['startArgv']); return { started: true } }
  }
  // 0.1.6 base: async start, runArgv resolves to the envelope.
  class AsyncBase extends SyncBase {
    async start() { this.calls.push(['super.start']); return { via: 'super.start' } }
  }

  const spec = { command: 'echo hi', sandboxPolicy: { mode: 'workspace-write' } }
  const logs = []
  const origLog = console.log
  console.log = (...a) => logs.push(a.join(' '))
  try {
    const legacy = build(SyncBase, 'win32')
    const rLegacy = await legacy.run(spec)
    assert.equal(rLegacy.stdout.text, 'hi', 'a bare ShellRunResult reaches the caller unchanged')
    assert.equal(rLegacy.sandbox.enforcement, 'unconfined')

    const modern = build(AsyncBase, 'win32')
    modern.runArgvReturns = { result: RESULT, spawnRequested: true }
    const rModern = await modern.run(spec)
    assert.equal(rModern.stdout.text, 'hi', 'the { result, spawnRequested } envelope is unwrapped')
    assert.equal(rModern.exitCode, 0)
    assert.equal(rModern.result, undefined, 'no wrapper leaks into the result the host reads')
    assert.equal(rModern.sandbox.enforcement, 'unconfined')

    const cancelled = build(AsyncBase, 'win32')
    cancelled.runArgvReturns = { result: { ...RESULT, exitCode: null, aborted: true }, spawnRequested: false }
    const rCancelled = await cancelled.run(spec)
    assert.deepEqual(rCancelled.sandbox, { mode: 'workspace-write', denied: false }, 'no spawn means nothing to label as unconfined')

    const syncProc = build(SyncBase, 'win32').start(spec)
    assert.equal(typeof syncProc.then, 'undefined', 'a synchronous host gets the handle itself')
    const asyncProc = build(AsyncBase, 'win32').start(spec)
    assert.equal(typeof asyncProc.then, 'function', 'an async host gets a thenable')
    assert.equal((await asyncProc).sandbox.enforcement, 'unconfined', 'awaiting yields the labelled handle')

    const forwarded = []
    const owner = build(AsyncBase, 'linux')
    owner.ctx = { sandbox: { confine: (argv, policy, signal) => { forwarded.push([argv, policy, signal]); return { argv } } } }
    const signal = { aborted: false }
    owner.confine('echo hi', { mode: 'read-only' }, signal)
    assert.equal(forwarded.length, 1)
    assert.deepEqual(forwarded[0][0], ['X:/git/bin/bash.exe', '-c', 'echo hi'])
    assert.equal(forwarded[0][2], signal, 'the host deadline reaches the sandbox provider')
  } finally {
    console.log = origLog
  }
})

test('executor: dsh 0.1.7 execute() keeps both Git Bash substitutions (issue #6 follow-up)', async () => {
  // 0.1.7 replaced the executor surface: `run`/`start` are gone, the runtime
  // calls `execute(spec): Promise<ShellExecution>` and background work is an
  // `onExpiry: 'none'` execution. Without an `execute` override the shipped
  // full-access branch spawns the bare `bash` name and a Windows confined call
  // goes back through the restricted-token runner MSYS2 cannot start under
  // (issue #1) — i.e. the plugin's whole reason to exist would be inert even
  // after the Config fix.
  const src = readFileSync('src/shell.js', 'utf8')
  const stripped = src.replace(/^import .*$/gm, '').replace(/^export default /gm, '').replace(/^export /gm, '')
  const scope = new Function('DEFAULT_GIT_BASH', 'resolveGitBashCached', 'effectiveConfiguredBashPath', 'settingsBashPath', 'bashResolutionReport', 'SandboxBashExecutor', 'z', 'process', stripped + '\nreturn { GitBashSandboxExecutor }')
  const RESULT = { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000, stdout: { text: 'hi', truncated: false }, stderr: { text: '', truncated: false } }
  const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain })

  /** 0.1.7-era base: execute/executeArgv, no run/start. */
  class NewBase {
    async execute(spec) { this.calls.push(['super.execute', spec]); return { via: 'super.execute', result: async () => RESULT } }
    async executeArgv(spec, argv, onStarted) {
      this.calls.push(['executeArgv', argv, spec])
      const ex = { status: 'running', result: async () => RESULT }
      if (onStarted !== undefined) onStarted(ex)
      return ex
    }
  }
  /** <=0.1.6-era base: no `execute` at all. */
  class OldBase {
    async run(spec) { this.calls.push(['super.run', spec]); return { via: 'super.run' } }
    async runArgv(spec, argv) { this.calls.push(['runArgv', argv]); return RESULT }
  }
  const build = (Base, platform) => {
    const mod = scope('C:/Program Files/Git/bin/bash.exe', resolveBashStub, effectiveBashStub, settingsBashStub, bashReportStub, Base, chain, { platform })
    const ex = Object.create(mod.GitBashSandboxExecutor.prototype)
    ex.config = { bashPath: 'X:/git/bin/bash.exe' }
    ex.calls = []
    return ex
  }
  const GIT_BASH_ARGV = ['X:/git/bin/bash.exe', '-c', 'echo hi']
  const full = { command: 'echo hi', sandboxPolicy: { mode: 'danger-full-access' } }
  const confined = { command: 'echo hi', sandboxPolicy: { mode: 'workspace-write' } }
  const kindOf = (ex, kind) => ex.calls.filter((c) => c[0] === kind)

  const logs = []
  const origLog = console.log
  console.log = (...a) => logs.push(a.join(' '))
  try {
    // Full access on Windows: our argv, labelled like the parent's branch.
    const fullEx = build(NewBase, 'win32')
    const fullHandle = await fullEx.execute(full)
    assert.equal(kindOf(fullEx, 'super.execute').length, 0, 'full access must not reach the bare-bash branch')
    const fullArgs = kindOf(fullEx, 'executeArgv')
    assert.equal(fullArgs.length, 1)
    assert.deepEqual(fullArgs[0][1], GIT_BASH_ARGV, 'the Git Bash argv replaces the shipped bare `bash`')
    assert.deepEqual((await fullHandle.result()).sandbox, { mode: 'danger-full-access', denied: false })

    // Windows confined: unconfined argv + the honest label (issue #1), and the
    // restricted-token provider is never consulted.
    const confinedEx = build(NewBase, 'win32')
    confinedEx.ctx = { sandbox: { confine: () => { throw new Error('confine must not run on win32') } } }
    const confinedHandle = await confinedEx.execute(confined)
    assert.equal(kindOf(confinedEx, 'super.execute').length, 0)
    assert.deepEqual(kindOf(confinedEx, 'executeArgv')[0][1], GIT_BASH_ARGV)
    assert.deepEqual((await confinedHandle.result()).sandbox,
      { mode: 'workspace-write', denied: false, enforcement: 'unconfined' })
    assert.ok(logs.some((line) => line.includes('UNCONFINED')), 'the one-time notice still fires')

    // Non-Windows confined: inherit the parent unchanged (its confine path
    // already runs Git Bash through the subclass override).
    const linuxEx = build(NewBase, 'linux')
    const linuxHandle = await linuxEx.execute(confined)
    assert.equal(kindOf(linuxEx, 'executeArgv').length, 0, 'the confined Linux path stays with the parent')
    assert.equal(kindOf(linuxEx, 'super.execute').length, 1)
    assert.equal(linuxHandle.via, 'super.execute')

    // The parity env is still merged into the spec the spawn sees.
    const parityEx = build(NewBase, 'win32')
    parityEx.ctx = { get: () => ({ get: () => ({ posixPaths: true }) }) }
    await parityEx.execute(full)
    assert.equal(kindOf(parityEx, 'executeArgv')[0][2].dshEnv.GIT_CONFIG_VALUE_0, 'input')

    // The result projection is memoized in place, like the parent's.
    const memoEx = build(NewBase, 'win32')
    const memoHandle = await memoEx.execute(full)
    assert.equal(memoHandle.result(), memoHandle.result(), 'one decorated promise per handle')

    // Old-era host (no `execute`): our override hands the call to `run`.
    const oldEx = build(OldBase, 'win32')
    const oldResult = await oldEx.execute(confined)
    assert.equal(kindOf(oldEx, 'runArgv')[0][1][0], 'X:/git/bin/bash.exe')
    assert.equal(oldResult.sandbox.enforcement, 'unconfined')
  } finally {
    console.log = origLog
  }
})

test('live settings readers span the 0.1.7 settings-service change (issue #6 follow-up)', async () => {
  // dsh 0.1.7 kept the `settings` service but removed the namespace API: it now
  // exposes describe()/update() and NO get(ns) (packages/settings/settings/src/index.ts).
  // Every reader that still called get(ns) silently degraded on the new host —
  // the executor's Linux-parity env (GIT_CONFIG_* autocrlf=input) and the
  // better-sidebar terminal adoption both stopped happening with no error.
  const src = readFileSync('src/shell.js', 'utf8')
  const stripped = src.replace(/^import .*$/gm, '').replace(/^export default /gm, '').replace(/^export /gm, '')
  const scope = new Function('DEFAULT_GIT_BASH', 'resolveGitBashCached', 'effectiveConfiguredBashPath', 'settingsBashPath', 'bashResolutionReport', 'SandboxBashExecutor', 'z', 'process', stripped + '\nreturn { GitBashSandboxExecutor }')
  const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain })
  const build = (settings) => {
    const ex = Object.create(scope('C:/Program Files/Git/bin/bash.exe', resolveBashStub, effectiveBashStub, settingsBashStub, bashReportStub, chain, chain, { platform: 'win32' }).GitBashSandboxExecutor.prototype)
    ex.config = { bashPath: 'X:/git/bin/bash.exe' }
    ex.ctx = settings === undefined ? {} : { get: (name) => (name === 'settings' ? settings : undefined) }
    return ex
  }
  const spec = () => ({ command: 'echo hi' })
  const gitConfig = (result) => result.dshEnv === undefined ? undefined : result.dshEnv.GIT_CONFIG_VALUE_0

  // New era: the values live in the row Config's projected form.
  const newEra = build({ describe: () => [{ ns: 'locale', value: {} }, { ns: 'gitbash-shell', value: { posixPaths: true, gitAutocrlf: true } }], update: async () => {} })
  assert.equal(gitConfig(newEra.withParityEnv(spec())), 'input', 'the 0.1.7 describe() read must find the row form')
  // Old era: the registered namespace through get(ns).
  const oldEra = build({ get: (ns) => (ns === 'gitbash-shell' ? { posixPaths: true, gitAutocrlf: true } : undefined), update: async () => {} })
  assert.equal(gitConfig(oldEra.withParityEnv(spec())), 'input', 'the <=0.1.6 namespace read still works')
  // Switch off, namespace missing, service missing: the spec is returned as-is.
  const off = build({ describe: () => [{ ns: 'gitbash-shell', value: { posixPaths: true, gitAutocrlf: false } }] })
  assert.equal(off.withParityEnv(spec()).dshEnv, undefined, 'gitAutocrlf:false disables the parity env')
  assert.equal(build({ describe: () => [] }).withParityEnv(spec()).dshEnv, undefined)
  assert.equal(build(undefined).withParityEnv(spec()).dshEnv, undefined)
  // A describe() that throws must degrade, not break the spawn.
  assert.equal(build({ describe: () => { throw new Error('boom') } }).withParityEnv(spec()).dshEnv, undefined)

  // The better-sidebar adoption read: same era split, same silent-death trap.
  const { _internal } = await import('../src/index.js')
  const adopt = async (settings) => {
    const updates = []
    const ctx = {
      get: (name) => (name === 'settings' ? { ...settings, update: async (ns, patch) => { updates.push([ns, patch]) } } : undefined),
      effect: (fn) => { fn(); return () => {} },
    }
    _internal.adoptSidebarShell(ctx, 'X:/git/bin/bash.exe', () => true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    return updates
  }
  const newEraUpdates = await adopt({ describe: () => [{ ns: 'dsh-better-sidebar', value: { terminalShell: '' } }] })
  assert.deepEqual(newEraUpdates, [['dsh-better-sidebar', { terminalShell: 'X:/git/bin/bash.exe' }]],
    '0.1.7: the adoption must still find the sidebar row through describe()')
  const oldEraUpdates = await adopt({ get: (ns) => (ns === 'dsh-better-sidebar' ? { terminalShell: '' } : undefined) })
  assert.deepEqual(oldEraUpdates, [['dsh-better-sidebar', { terminalShell: 'X:/git/bin/bash.exe' }]],
    '<=0.1.6: the namespace read still drives the adoption')
  // Already adopted: nothing to write.
  const settled = await adopt({ describe: () => [{ ns: 'dsh-better-sidebar', value: { terminalShell: 'X:/git/bin/bash.exe' } }] })
  assert.deepEqual(settled, [], 'an already-adopted sidebar is left alone')
})

test('run_code program literals ride the same MSYS mount table (v0.20.0)', async () => {
  const { _internal } = await import('../src/index.js')
  const { rewriteCodePaths, scanCodeLiterals } = _internal
  const env = { tmpDir: 'C:/Temp', home: 'C:/Users/kanna', gitRoot: 'C:/Program Files/Git' }
  // What the model writes stays what it means: the literal becomes the path a
  // native Node process can actually open.
  assert.equal(rewriteCodePaths("fs.readFileSync('/c/Users/kanna/x.txt')", env), "fs.readFileSync('C:/Users/kanna/x.txt')")
  assert.equal(rewriteCodePaths('const p = "/tmp/a.txt"', env), 'const p = "C:/Temp/a.txt"')
  assert.equal(rewriteCodePaths('x = `/c/Users/a/b`', env), 'x = `C:/Users/a/b`')
  assert.equal(rewriteCodePaths("const u = '/usr/bin/env'", env), "const u = 'C:/Program Files/Git/usr/bin/env'")
  assert.equal(rewriteCodePaths("const h = '~/notes.md'", env), "const h = 'C:/Users/kanna/notes.md'")
  // The NUL device lands as SOURCE text: it must cook back to the device path.
  const devSource = rewriteCodePaths("const dev = '/dev/null'", env)
  const devLiteral = devSource.slice(devSource.indexOf("'"), devSource.lastIndexOf("'") + 1)
  assert.equal(eval(devLiteral), '\\\\' + '.' + '\\' + 'NUL', 'escaped for the literal it is written into')
  // Anything that is not a path literal is left exactly as written.
  const untouched = [
    "// comment '/c/Users/meh'",
    "/* block '/c/Users/meh' */",
    "const url = 'http://x/c/y'",
    "const dollar = '$HOME/c/x'",
    "const win = 'C:/Users/kanna/ok'",
    "const rel = 'src/foo/bar'",
    'const tpl = `/c/${name}/x`',
    "const esc = '/c/Users/a\\\\nb'",
    "const quoted = \"see '/c/Users/kanna/inside'\"",
  ]
  for (const code of untouched) assert.equal(rewriteCodePaths(code, env), code, 'must stay verbatim: ' + code)
  // A program the scanner cannot walk is left WHOLE: never half-rewritten.
  const broken = "const a = '/c/Users/kanna/ok'\nconst b = '/c/Users/unterminated"
  assert.equal(scanCodeLiterals(broken), null)
  assert.equal(rewriteCodePaths(broken, env), broken)
  // Quotes inside a regex literal, and a division, must not desync the scan.
  assert.equal(rewriteCodePaths("const re = /['\"]/ ; const s = '/c/Users/kanna/y'", env), "const re = /['\"]/ ; const s = 'C:/Users/kanna/y'")
  assert.equal(rewriteCodePaths('const d = a / b; const s = "/c/Users/kanna/w"', env), 'const d = a / b; const s = "C:/Users/kanna/w"')
  // Drive roots are the base layer (no env needed); mounts need real facts and
  // are never invented.
  assert.equal(rewriteCodePaths("x = '/e/project/x'", null), "x = 'E:/project/x'")
  assert.equal(rewriteCodePaths("x = '/tmp/x'", null), "x = '/tmp/x'")
})

test('the run_code literal rewrite has its own switch (codePaths)', async () => {
  const text = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(text, /codePaths: Schema\.boolean\(\)\.default\(true\)/)
  assert.match(text, /exec\.name === 'run_code' && dialect\.codePaths/)
  assert.match(text, /rewriteCodePaths\(translated\.code, env\)/)
  const { _internal } = await import('../src/index.js')
  const withFlag = (value) => _internal.readDialectSettings({ get: () => ({ get: () => value }) })
  assert.equal(withFlag({ posixPaths: true, codePaths: true }).codePaths, true)
  assert.equal(withFlag({ posixPaths: true, codePaths: false }).codePaths, false)
  assert.equal(withFlag({ posixPaths: true }).codePaths, false, 'absent value stays off until the schema default applies')
  // v0.20.1: the run_code sentence is NOT in the base directive — it rides the
  // same context entry only for assemblies whose tool list carries run_code, so
  // every other mode (standard/cordis sessions, run_code disabled) stays quiet.
  const base = /const POSIX_DIRECTIVE_TEXT = '([^']*)'/.exec(text)
  assert.ok(base !== null, 'directive text is gone')
  assert.doesNotMatch(base[1], /run_code/, 'the base directive must not talk about run_code')
  const strict = /const POSIX_DIRECTIVE_TEXT_STRICT = '([^']*)'/.exec(text)
  assert.ok(strict !== null, 'strict directive text is gone')
  assert.doesNotMatch(strict[1], /run_code/, 'the strict directive must not talk about run_code either')
  assert.match(text, /const RUN_CODE_DIRECTIVE_TEXT = '/, 'the conditional run_code sentence is gone')
  assert.match(text, /runCodeHintFor\(assembly\.tools\)/, 'the assembly hook must gate the sentence on the tool list')
})

test('the run_code sentence is injected only where the tool exists (v0.20.1)', async () => {
  const { runCodeHintFor } = await import('../src/index.js')
  assert.equal(runCodeHintFor(undefined), '', 'no tool list → nothing to say')
  assert.equal(runCodeHintFor([]), '')
  assert.equal(runCodeHintFor([{ name: 'bash' }, { name: 'read' }, { name: 'present' }]), '', 'a mode without run_code stays quiet')
  const hint = runCodeHintFor([{ name: 'bash' }, { name: 'run_code' }])
  assert.match(hint, /run_code program/, 'a mode WITH run_code gets the sentence')
  assert.match(hint, /translated/, 'and it says what the layer does')
  assert.equal(runCodeHintFor([{ name: 'run_code' }, { name: 'run_code' }]), hint, 'idempotent, one sentence')
})

test('run_code gets TEMP/TMP only — never a fake HOME or PATH (v0.21.0)', async () => {
  const { programPrelude } = await import('../src/index.js')
  assert.equal(programPrelude(null), '', 'no temp fact → no prelude at all')
  assert.equal(programPrelude({}), '')
  const prelude = programPrelude({ tmpDir: 'C:/Users/kanna/AppData/Local/Temp' })
  assert.match(prelude, /e\.TEMP="C:\/Users\/kanna\/AppData\/Local\/Temp"/, 'TEMP is seeded with the real temp dir')
  assert.match(prelude, /e\.TMP=e\.TEMP/)
  assert.doesNotMatch(prelude, /HOME|PATH|USERPROFILE/, 'HOME/PATH stay untouched: seeding them would diverge from macOS')
  assert.ok(prelude.endsWith('\n'), 'the prelude is exactly one line')
  assert.equal(prelude.split('\n').length, 2, 'one line plus the terminator')
})

test('the model git gets Linux line endings from the executor (v0.21.1)', () => {
  const host = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  const shell = readFileSync(new URL('../src/shell.js', import.meta.url), 'utf8')
  assert.match(host, /gitAutocrlf: Schema\.boolean\(\)\.default\(true\)/)
  // the injection lives where the child env is actually built
  assert.match(shell, /withParityEnv\(spec\)/)
  assert.match(shell, /GIT_CONFIG_COUNT: '2'/)
  assert.match(shell, /GIT_CONFIG_KEY_0: 'core\.autocrlf'/)
  assert.match(shell, /GIT_CONFIG_VALUE_0: 'input'/, 'input (not false): a CRLF worktree must read as CLEAN, not as whole-file churn')
  assert.match(shell, /GIT_CONFIG_KEY_1: 'core\.eol'/)
  assert.match(shell, /GIT_CONFIG_VALUE_1: 'lf'/)
  assert.match(shell, /value\.gitAutocrlf === false/, 'the switch must be able to turn it off')
  assert.match(shell, /dshEnv/, 'the facts ride the trusted dshEnv layer')
  // and nothing anywhere writes the user's global git config
  assert.doesNotMatch(shell, /GIT_CONFIG_VALUE_0: 'false'/, 'false showed every line of a CRLF worktree as modified (v0.22.0 evidence)')
  assert.doesNotMatch(host, /'--global'/)
  assert.doesNotMatch(shell, /'--global'/)
})

test('a failing run_code program reports paths in the MSYS dialect (v0.21.0)', async () => {
  const text = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(text, /if \(exec\.name === 'run_code'\) \{/, 'run_code must ride the error-dialect branch')
  assert.match(text, /rewriteErrorContent\(result\.content, \{ nulHint: false, env \}\)/, 'paths only — the /dev/null hint is for file tools')
  const { rewriteErrorContent } = await import('../src/index.js')
  const err = rewriteErrorContent([{ type: 'text', text: "ENOENT: no such file or directory, open 'C:\\Users\\kanna\\x.txt'" }], { nulHint: false })
  assert.match(err[0].text, /\/c\/Users\/kanna\/x\.txt/, 'the Windows path comes back as an MSYS path')
  assert.match(err[0].text, /ENOENT: no such file or directory/, 'the diagnostic itself stays verbatim')
  assert.equal(err.length, 1, 'no guidance block is appended for a program error')
})

test('a failure speaks one dialect on BOTH faces (v0.22.0)', async () => {
  const { _internal } = await import('../src/index.js')
  const { rewriteErrorMessage, rewriteFailureMessage, rewriteErrorContent, msysEcho } = _internal
  const BS = String.fromCharCode(92)
  const Q = String.fromCharCode(34)
  const env = { tmpDir: 'C:/Users/u/AppData/Local/Temp', home: 'C:/Users/u', gitRoot: 'C:/Program Files/Git' }
  const raw = 'cannot read ' + Q + 'C:' + BS + 'Users' + BS + 'u' + BS + 'x.txt' + Q + ': not found'
  const posix = 'cannot read ' + Q + '/c/Users/u/x.txt' + Q + ': not found'
  // the message face: drive paths become MSYS, every diagnostic byte stays
  assert.equal(rewriteErrorMessage(raw), posix)
  assert.equal(rewriteErrorMessage(raw, { env }), posix)
  // and the /tmp mount echoes exactly like a successful result does
  const tmpMsg = 'ENOENT: no such file or directory, open ' + Q + env.tmpDir + '/x.txt' + Q
  assert.equal(rewriteErrorMessage(tmpMsg, { env }), 'ENOENT: no such file or directory, open ' + Q + '/tmp/x.txt' + Q)
  assert.equal(rewriteErrorMessage(tmpMsg), 'ENOENT: no such file or directory, open ' + Q + '/c/Users/u/AppData/Local/Temp/x.txt' + Q, 'no mount facts: the drive root still translates, the mount does not')
  assert.equal(rewriteErrorMessage('boom: no such file'), 'boom: no such file', 'nothing to translate → the same value')
  assert.equal(rewriteErrorMessage(''), '')
  assert.equal(rewriteErrorMessage(undefined), undefined)
  assert.equal(msysEcho(null), null, 'non-strings pass straight through')
  // the result owns the message: patched in place, identity preserved
  const result = { isError: true, error: { message: raw, info: { name: 'FsError', code: 'FS_NOT_FOUND' } } }
  assert.equal(rewriteFailureMessage(result, env), true)
  assert.equal(result.error.message, posix)
  assert.equal(result.error.info.code, 'FS_NOT_FOUND', 'the structured identity survives — this is why it is not a block decision')
  assert.equal(rewriteFailureMessage(result, env), false, 'idempotent: nothing left to rewrite')
  // someone else frozen result must not throw
  const frozen = Object.freeze({ isError: true, error: Object.freeze({ message: raw }) })
  assert.equal(rewriteFailureMessage(frozen, env), false)
  assert.equal(frozen.error.message, raw, 'a frozen error keeps the host form; the content face still carries the dialect')
  assert.equal(rewriteFailureMessage(undefined, env), false)
  assert.equal(rewriteFailureMessage({ isError: true }, env), false)
  // both faces come out of ONE helper, so they cannot disagree
  const blocks = rewriteErrorContent([{ type: 'text', text: raw }], { env })
  assert.equal(blocks[0].text, posix)
})

test('the post-execute branch patches both faces, and never forges a block (v0.22.0)', () => {
  const text = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(text, /rewriteFailureMessage\(result, env\)/, 'the message face rides the same branch as the content face')
  assert.equal((text.match(/\n\s+rewriteFailureMessage\(result, env\)/g) ?? []).length, 2, 'run_code AND the file tools')
  assert.match(text, /rewriteErrorContent\(result\.content, \{ nulHint: false, env \}\)/, 'run_code still gets paths only')
  assert.doesNotMatch(text, /kind: 'block'/, 'a block decision rebuilds the error as a bare message and drops its identity')
})

test('glob patterns may open with a tilde (v0.22.0)', async () => {
  const { _internal } = await import('../src/index.js')
  const env = { tmpDir: 'C:/Users/u/AppData/Local/Temp', home: 'C:/Users/u', gitRoot: 'C:/Program Files/Git' }
  const tg = _internal.translateGlobArguments
  assert.deepEqual(tg({ pattern: '~/sandbox/*.md' }, env), { pattern: '*.md', path: 'C:/Users/u/sandbox' })
  assert.deepEqual(tg({ pattern: '~' }, env), { pattern: 'u', path: 'C:/Users' }, 'bare ~ is the home directory itself')
  const named = { pattern: '~other/x/*.md' }
  assert.equal(tg(named, env), named, '~user has no fact behind it → untouched, same reference')
  const noEnv = { pattern: '~/x/*.md' }
  assert.equal(tg(noEnv, undefined), noEnv, 'no mount facts → no expansion')
  const rel = { pattern: 'sub/*.md' }
  assert.equal(tg(rel, env), rel, 'relative patterns still return the same reference')
})

test('a whole-value path never goes through the prose rewriter (v0.23.0, issue #3)', async () => {
  const { _internal } = await import('../src/index.js')
  const BS = String.fromCharCode(92)
  const SL = String.fromCharCode(47)
  const d = _internal.driveToMsys
  const p = _internal.pathEcho
  assert.equal(d('C:' + BS + 'my dir' + BS + 'f.txt'), SL + 'c/my dir/f.txt', 'a spaced directory no longer leaks a backslash')
  assert.equal(d('C:/my dir/f.txt'), SL + 'c/my dir/f.txt')
  assert.equal(d('my dir' + BS + 'f.txt'), 'my dir/f.txt', 'relative values only normalize')
  assert.equal(d(SL + 'c/already/posix'), SL + 'c/already/posix', 'an MSYS path passes through')
  assert.equal(d('C:relative'), 'C:relative', 'a drive-relative path is not a root')
  assert.equal(d(''), '')
  assert.equal(d(undefined), undefined)
  assert.equal(p('C:' + BS + 'Users' + BS + 'u' + BS + 'Temp dir' + BS + 'x', { tmpDir: 'C:/Users/u/Temp dir' }), SL + 'tmp/x', 'the /tmp mount survives a spaced TEMP root')
  const rr = _internal.rewriteResultPaths
  assert.equal(rr('read', { path: 'C:' + BS + 'Users' + BS + 'u' + BS + 'my dir' + BS + 'f.txt' }).path, SL + 'c/Users/u/my dir/f.txt')
  assert.equal(rr('glob', { paths: ['C:' + BS + 'a b' + BS + 'c.txt'] }).paths[0], SL + 'c/a b/c.txt')
})

test('prose rewriting crosses a space only into a path token (v0.23.0)', async () => {
  const { _internal } = await import('../src/index.js')
  const BS = String.fromCharCode(92)
  const w = _internal.windowsToMsys
  assert.equal(w('C:' + BS + 'Program Files' + BS + 'Git' + BS + 'bin' + BS + 'bash.exe'), '/c/Program Files/Git/bin/bash.exe', 'a spaced program-files path comes back whole')
  assert.equal(w('see C:' + BS + 'Users' + BS + 'kanna for details'), 'see /c/Users/kanna for details', 'prose after a path is not swallowed')
  assert.equal(w('https://x.dev/a and file://C:/x stay'), 'https://x.dev/a and file://C:/x stay')
  assert.equal(w('no paths here'), 'no paths here')
})

test('the success echo rides tools/execute, so no decision can collide (v0.23.0, issue #2)', () => {
  const text = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(text, /return next\(\)\.then\(\(result\) => \{/, 'the around-dispatch wrapper authors the result')
  assert.match(text, /rewriteResultPaths\(exec && exec\.name, result\.value, echoEnv\)/)
  assert.doesNotMatch(text, /value: patch/, 'the old post-execute value projection is gone')
  assert.doesNotMatch(text, /next\(\)\.catch/, 'a rejecting dispatch must still propagate')
  const from = text.indexOf('failure dialect on tools/post-execute')
  const post = text.slice(from, text.indexOf('tools/post-execute wiring failed', from))
  assert.doesNotMatch(post, /rewriteResultPaths/, 'the decision waterfall no longer authors a value')
  assert.doesNotMatch(post, /value:/, 'a decision here carries content only')
})

// ── dsh 0.1.7 declarative era ────────────────────────────────────────────────

test('compositions: full variants mirror the official 0.1.7 row split', async () => {
  const { pluginsFor, minimalPluginsFor, PRESET_META } = await import('../src/compositions.js')
  const row = (rows, id) => rows.find((r) => r.id === id)
  for (const kind of ['standard', 'cordis']) {
    const rows = pluginsFor({ kind, gitBash: true, skillsDir: kind === 'cordis' ? '/s' : undefined })
    const delegation = row(rows, 'delegation').config
    assert.notEqual(row(delegation, 'workflow-ptc').disabled, true)
    assert.notEqual(row(delegation, 'tool-workflow').disabled, true)
    assert.equal(row(delegation, 'tool-ralph').disabled, true)
    assert.equal(row(rows, 'tool-bash').disabled, undefined)
    assert.equal(row(rows, 'tool-pwsh').disabled, true)
    assert.equal(row(rows, 'tool-plugin-manager').disabled, kind === 'standard' ? true : undefined)
  }
  const ptc = pluginsFor({ kind: 'ptc', gitBash: true, skillsDir: undefined })
  const delegation = row(ptc, 'delegation').config
  assert.equal(row(delegation, 'workflow-ptc').disabled, true)
  assert.equal(row(delegation, 'tool-workflow').disabled, true)
  assert.equal(row(ptc, 'tool-presentation').config.mode, 'ptc')
  assert.equal(row(ptc, 'tool-cordis'), undefined)
  const cordis = pluginsFor({ kind: 'cordis', gitBash: true, skillsDir: '/s' })
  assert.equal(row(cordis, 'tool-cordis').name, '@deepseek-ai/dsh-tool-cordis')
  assert.deepEqual(row(cordis, 'skill-filesystem').config.customSkillDirs, ['/s'])
  // minimal: single-tool, bash rows pinned on, pwsh off
  const minimal = minimalPluginsFor()
  assert.equal(minimal.length, 2)
  const shell = minimal.find((r) => r.id === 'persistent-shell').config
  assert.equal(row(shell, 'persistent-bash').disabled, false)
  assert.equal(row(shell, 'persistent-pwsh').disabled, true)
  for (const id of ['standard-gitbash', 'code-gitbash', 'minimal-gitbash', 'cordis-gitbash']) {
    assert.ok(PRESET_META[id], id)
    assert.equal(typeof PRESET_META[id].name, 'string')
  }
})

test('host half: lazy Config with volatile probing and the era branch', async () => {
  const mod = await import('../src/index.js')
  assert.equal(typeof mod.Config, 'function')
  assert.equal(typeof mod.valueOf, 'function')
  const hostSource = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  // Lazy peer import: a static one makes an unresolvable schemastery kill the
  // whole row silently (the Loader skips a failed plugin import non-fatally),
  // which for this plugin means no presets, no executor and no client half.
  assert.match(hostSource, /await import\('@deepseek-ai\/schemastery'\)/)
  assert.doesNotMatch(hostSource, /^import Schema from '@deepseek-ai\/schemastery'/m)
  assert.match(hostSource, /export const Config = Schema === null \? undefined : Schema\.object\(/)
  assert.match(hostSource, /typeof ctx\.agentPresets\.register === 'function'/)
  assert.match(hostSource, /await runDeclarativeEra\(ctx, presetIds, \(\) => liveSettings\.suppressPeerCordis\(\)\)/)
})

test('client half: era-split settings acquisition, no hard settingsScope inject', () => {
  const clientSource = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(clientSource, /exports\.inject = \["locale", "slots"\]/)
  assert.match(clientSource, /ctx\.inject\(\["settingsScope"\]/)
  assert.match(clientSource, /ctx\.inject\(\["configForms"\]/)
  assert.match(clientSource, /forms\.get\(SETTINGS_NAMESPACE\)/)
})

test('package meta: 0.1.7 display assets and the renamed patch row', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.icon, './icon.svg')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.ok(pkg.files.includes('locale'))
  readFileSync(new URL('../icon.svg', import.meta.url), 'utf8')
  for (const tag of ['en', 'zh']) {
    const meta = JSON.parse(readFileSync(new URL(`../locale/${tag}.json`, import.meta.url), 'utf8'))
    assert.equal(typeof meta.meta?.title, 'string')
  }
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: gitbash-shell$/m)
  assert.doesNotMatch(patch, /id: gitbash-presets/)
})

test('the manifest subpath is exported, so desktop discovery can read it (v0.24.3)', () => {
  // packages/client/modules/src/index.ts locatePkgJson(): the Electron
  // renderer has no `ctx.loader.internal` and falls back to
  // `createRequire(baseUrl).resolve('<pkg>/package.json')`, which honours the
  // exports map. Without this row the lookup throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED, the surrounding catch swallows it, and the
  // package is cached as "not a client package" FOR THE LIFETIME OF THE
  // RENDERER: the client half never enters the desktop boot graph while every
  // host log stays green. Same defect class as dsh-better-workspace #9.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.exports['./package.json'], './package.json', 'the manifest subpath must be exported')
  // The other specifiers the host resolves by name must stay exported too.
  assert.equal(pkg.exports['.'], './src/index.js')
  assert.equal(pkg.exports['./shell'], './src/shell.js')
  assert.equal(pkg.exports['./client'], './src/client.js')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  // Runtime twin: Node's package self-reference resolves through the very same
  // exports map, so this is the desktop lookup in miniature — it throws the
  // real ERR_PACKAGE_PATH_NOT_EXPORTED when the row is missing. Both sides go
  // through realpath: a checkout reached through a symlink (tmpdir, CI cache)
  // must not turn this into a false failure.
  const resolved = createRequire(new URL('../tests/smoke.mjs', import.meta.url)).resolve('dsh-gitbash-shell/package.json')
  assert.equal(realpathSync(resolved), realpathSync(fileURLToPath(new URL('../package.json', import.meta.url))))
})

test('the dsh peer requirement covers every supported host (v0.24.3)', () => {
  // dsh 0.1.7 enforces ONE thing at install and boot: peerDependencies whose
  // name is `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*`
  // (packages/boot/app-boot/src/plugin-compatibility.ts). `engines.dsh` is
  // declarative and never read. Without this row the plugin is never
  // compatibility-checked at all — and a range that excludes a host it still
  // supports would get the row disabled, so the range mirrors the declared
  // engine floor instead of enumerating releases.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh'], pkg.engines.dsh, 'one source of truth for the dsh floor')
  assert.match(pkg.peerDependencies['@deepseek-ai/dsh'], /^>=\d+\.\d+\.\d+$/u, 'a bare lower bound: no enumerated prerelease, no invented ceiling')
  // OPTIONAL keeps the gate intact while removing the install hazard: the gate
  // reads peerDependencies only, but a package manager with autoInstallPeers
  // (pnpm's default) resolves the range against the registry — and every
  // published @deepseek-ai/dsh version is a prerelease, which a plain range
  // excludes (ERR_PNPM_NO_MATCHING_VERSION for the whole install).
  assert.equal(pkg.peerDependenciesMeta?.['@deepseek-ai/dsh']?.optional, true)
})

test('minimal descriptions keep the official block-scalar shape (v0.24.3)', async () => {
  // The official minimal preset writes both descriptions as `|-` block
  // scalars (packages/bundle/web-app/presets/minimal.patch.yml), so the
  // parsed value carries NO trailing newline; the committed old-era asset
  // spells the same. v0.24.1 appended one to the pwsh row, which made the two
  // eras of this plugin feed the model two different strings.
  const { minimalPluginsFor } = await import('../src/compositions.js')
  const group = minimalPluginsFor().find((row) => row.id === 'persistent-shell')
  for (const id of ['persistent-bash', 'persistent-pwsh']) {
    const description = group.config.find((row) => row.id === id).config.description
    assert.equal(typeof description, 'string', id + ': description must be a string')
    assert.notEqual(description.trim(), '', id + ': description must not be blank')
    assert.equal(description, description.trim(), id + ': a `|-` scalar has no leading or trailing whitespace')
    assert.ok(!description.endsWith('\n'), id + ': the official text has no trailing newline')
  }
})

test('regression (v0.24.2): apply() mounts — adoptSidebarShell never reaches into apply() scope', () => {
  // v0.24.0's makeLiveReader refactor left `run()` inside the module-level
  // adoptSidebarShell() referencing the apply()-local `liveSettings`:
  // every win32 mount threw `ReferenceError: liveSettings is not defined`
  // and the host reported "failed to apply loader entry gitbash-shell
  // (dsh-gitbash-shell)" — the plugin could not load AT ALL on Windows.
  // The 60 smoke items missed it because none of them ever executed
  // apply(); the two `liveSettings.…` source greps even blessed the
  // refactor's wording. Guard both the scope boundary and the wiring.
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  const body = source.slice(
    source.indexOf('function adoptSidebarShell('),
    source.indexOf('// ── plugin'),
  )
  assert.ok(body.includes('function adoptSidebarShell('), 'adoptSidebarShell must exist')
  assert.doesNotMatch(body, /\bliveSettings\b/, 'the module-level helper must receive the gate, not reach into apply() scope')
  assert.match(
    source,
    /if \(bashResolution\.ok\) adoptSidebarShell\(ctx, bashResolution\.path, \(\) => liveSettings\.adoptSidebar\(\)\)/,
    'apply() must hand its era-aware gate getter to the helper, and only adopt with a RESOLVED bash',
  )
})

test('regression (v0.24.2): a full apply() mount completes on a stub ctx', async () => {
  // The runtime twin of the guard above: actually run the mount path the
  // loader runs. On win32 this exercises the sidebar adoption branch whose
  // synchronous `void run()` used to throw before the era split.
  const { apply } = await import('../src/index.js')
  const updates = []
  const ctx = {
    effect: () => {},
    provide: () => () => {},
    inject: () => {},
    on: () => {},
    // settings present WITHOUT register() = the NEW-era surface (Config
    // refs, dsh >= 0.1.7); get/update pair lets the reconciler settle on
    // its first tick instead of polling for 18s.
    get: (name) => (name === 'settings'
      ? {
          get: () => ({ terminalShell: '' }),
          update: async (ns, patch) => { updates.push([ns, patch]) },
        }
      : undefined),
    agentPresets: { roots: [] }, // no register(): legacy branch, early return, zero fs side effects
  }
  await assert.doesNotReject(() => apply(ctx, {}), 'apply() must not throw on mount')
  if (process.platform === 'win32') {
    assert.ok(
      updates.some(([ns, patch]) => ns === 'dsh-better-sidebar' && patch && typeof patch.terminalShell === 'string'),
      'the sidebar adoption must hand Git Bash to the settings seam',
    )
  }
})

// ── peer dedupe against dsh-ptc-cordis-preset (v0.25.0, their issue #7) ──────

test('effectivePresetIds drops only the peer-covered variant, and only when both facts hold', () => {
  const { effectivePresetIds, PRESET_IDS, PEER_COVERED_PRESET_ID } = _internal
  assert.equal(PEER_COVERED_PRESET_ID, 'cordis-gitbash')
  // default: nothing changes — the historical four-variant roster, byte for byte
  assert.deepEqual(effectivePresetIds(PRESET_IDS), [...PRESET_IDS])
  assert.deepEqual(effectivePresetIds(undefined), [...PRESET_IDS])
  // either fact alone is not enough
  assert.deepEqual(effectivePresetIds(PRESET_IDS, { suppress: false, peerGitBash: true }), [...PRESET_IDS])
  assert.deepEqual(effectivePresetIds(PRESET_IDS, { suppress: true, peerGitBash: false }), [...PRESET_IDS])
  assert.deepEqual(effectivePresetIds(PRESET_IDS, {}), [...PRESET_IDS])
  // both facts → exactly the peer-covered variant leaves, order preserved
  assert.deepEqual(
    effectivePresetIds(PRESET_IDS, { suppress: true, peerGitBash: true }),
    ['standard-gitbash', 'minimal-gitbash', 'code-gitbash'],
  )
  // an explicit row list is still honored, and an empty one falls back to the default
  assert.deepEqual(effectivePresetIds(['cordis-gitbash'], { suppress: true, peerGitBash: true }), [])
  assert.deepEqual(
    effectivePresetIds([], { suppress: true, peerGitBash: true }),
    ['standard-gitbash', 'minimal-gitbash', 'code-gitbash'],
  )
  // the caller's array is never mutated (the row config is shared state)
  const configured = [...PRESET_IDS]
  effectivePresetIds(configured, { suppress: true, peerGitBash: true })
  assert.deepEqual(configured, PRESET_IDS)
})

test('detectPeerCoverage reads the peer capability; absent means no dedupe', async () => {
  const { detectPeerCoverage, PEER_CAPABILITY } = _internal
  assert.equal(PEER_CAPABILITY, 'ptcCordisPreset')
  assert.equal(await detectPeerCoverage({ get: () => ({ id: 'ptc-cordis', gitBashActive: true }) }), true)
  assert.equal(await detectPeerCoverage({ get: () => ({ id: 'ptc-cordis', gitBashActive: false }) }), false)
  // absent peer → false after the bounded probe, never a throw
  const started = Date.now()
  assert.equal(await detectPeerCoverage({ get: () => undefined }), false)
  assert.ok(Date.now() - started >= 900, 'the probe waits for a peer row that may still be mounting')
  // a throwing service read is swallowed (it must never break the row)
  assert.equal(await detectPeerCoverage({ get: () => { throw new Error('nope') } }), false)
})

test('readSuppressPeerCordis: old-era namespace read, default off', () => {
  const { readSuppressPeerCordis } = _internal
  const ctxWith = (value) => ({ get: (name) => (name === 'settings' ? { get: () => value } : undefined) })
  assert.equal(readSuppressPeerCordis(ctxWith({ suppressPeerCordis: true })), true)
  assert.equal(readSuppressPeerCordis(ctxWith({ suppressPeerCordis: false })), false)
  assert.equal(readSuppressPeerCordis(ctxWith({})), false)
  assert.equal(readSuppressPeerCordis(undefined), false)
  assert.equal(readSuppressPeerCordis({ get: () => { throw new Error('nope') } }), false)
})

test('host half: the dedupe switch is wired on both eras and defaults OFF', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  // declared on the row Config (new era) and on the legacy namespace
  assert.match(src, /suppressPeerCordis: live\(Schema\.boolean\(\)\.default\(false\)\)/)
  assert.match(src, /suppressPeerCordis: Schema\.boolean\(\)\.default\(false\)/)
  // new era: reactive — peer capability arrival + the volatile switch itself
  assert.match(src, /ctx\.inject\(\[PEER_CAPABILITY\]/)
  assert.match(src, /ctx\.on\('loader\/volatile-update'/)
  assert.match(src, /const unregister = await registerVariant\(ctx, presetId/)
  assert.match(src, /live\.delete\(presetId\)/, 'a suppressed variant is retired, not merely skipped')
  // old era: the same decision at startup, and orphan purge follows the effective list
  assert.match(src, /const effectiveIds = effectivePresetIds\(presetIds, \{ suppress: suppressPeer, peerGitBash \}\)/)
  assert.match(src, /purgeOrphans\(userRootPath, effectiveIds\)/)
  // the decision is never taken without the peer's Git Bash answer
  assert.match(src, /suppressPeer \? await detectPeerCoverage\(ctx\) : false/)
})

test('client card: the dedupe row is peer-gated and writes THIS row\'s field', () => {
  const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  // the peer row id is a named constant (no scattered literals)
  assert.match(src, /var PEER_NS = "ptc-cordis"/)
  // bound through configForms (the official cross-namespace face), subscribed so a
  // change made on the peer's card repaints this one
  assert.match(src, /props\.ctx\.get\("configForms"\)/)
  assert.match(src, /forms\.get\(PEER_NS\)/)
  assert.match(src, /form\.subscribe\(/)
  // the value stays on THIS plugin's row: read from the bound snapshot, written
  // through the card's own writeField (never a second copy of the state)
  assert.match(src, /var dedupe = snap\.value\.suppressPeerCordis === true;/)
  assert.match(src, /writeField\("suppressPeerCordis", true\)/)
  assert.match(src, /writeField\("suppressPeerCordis", false\)/)
  // drawn only while the peer's entry is served (absent peer / old host hide it)
  assert.match(src, /var dedupeSection = peerSnap\.status === "ready" \? E\("div", \{ className: "gb-section" \}/)
  assert.match(src, /\n\t\t\t\tdedupeSection,/)
  // the ctx reaches the component: the inject factory carries it as a plain member
  assert.match(src, /return \{ scope: scope, ctx: ctx \};/)
  // hooks stay before the scope's early return (a conditional hook would throw)
  const hookAt = src.indexOf('var peerState = useState(null);')
  const earlyReturnAt = src.indexOf('if (snap.status !== "ready") return null;')
  assert.ok(hookAt > 0 && earlyReturnAt > hookAt, 'the peer hooks must run before the early return')
  // all three copy keys exist in every dictionary (the parity test also guards this)
  for (const key of ['sec.dedupe', 'dedupe.label', 'dedupe.hint']) {
    const occurrences = [...src.matchAll(new RegExp('"' + key.replace('.', '\\.') + '":', 'g'))].length
    assert.ok(occurrences >= 21, key + ' must exist in all 21 dictionaries, saw ' + occurrences)
  }
})

// ── issue #8: the DISPATCH face (not just the pure helpers) ──────────────────

test('translateDispatch covers every argument face issue #8 reported', () => {
  const { translateDispatch } = _internal
  const env = { tmpDir: 'C:/Users/x/AppData/Local/Temp', home: 'C:/Users/x', gitRoot: 'C:/Program Files/Git' }
  const dialect = { posixPaths: true, virtualMounts: true, globSplit: true, codePaths: true }
  const t = (name, args) => translateDispatch({ name, arguments: args }, dialect, env)
  // ① MSYS drive root: the double root `/c/c/...` came from NOT translating here
  assert.equal(t('read', { file_path: '/c/Users/x/.dsh/.anonymous-user-id' }).file_path, 'C:/Users/x/.dsh/.anonymous-user-id')
  assert.equal(t('write', { file_path: '/c/Users/x/.dsh/p.txt', content: 'hi' }).file_path, 'C:/Users/x/.dsh/p.txt')
  // ② `~` expands to the home mount
  assert.equal(t('read', { file_path: '~/.anonymous-user-id' }).file_path, 'C:/Users/x/.anonymous-user-id')
  // ③ `/tmp` rides the TEMP mount
  assert.equal(t('read', { file_path: '/tmp/a.txt' }).file_path, 'C:/Users/x/AppData/Local/Temp/a.txt')
  // ④ glob/grep `path` reaches the tool translated (it went to native rg raw)
  assert.deepEqual(t('glob', { path: '/c/Users/x/.dsh/profiles/web', pattern: '*.json' }), { path: 'C:/Users/x/.dsh/profiles/web', pattern: '*.json' })
  assert.deepEqual(t('grep', { path: '/c/Users/x/.dsh', pattern: 'x' }), { path: 'C:/Users/x/.dsh', pattern: 'x' })
  // ⑤ bash `workdir` translated (untranslated it became a bogus cwd → ENOENT)
  const bash = t('bash', { command: 'pwd', workdir: '/c/Users/x/.dsh' })
  assert.equal(bash.workdir, 'C:/Users/x/.dsh')
  assert.equal(bash.command, 'pwd', 'the command field is the shell mother tongue — never rewritten')
  // the other two faces still ride the same entry point
  const split = t('glob', { pattern: '/c/Users/x/docs/*.md' })
  assert.equal(split.path, 'C:/Users/x/docs')
  assert.equal(split.pattern, '*.md')
  assert.match(t('run_code', { code: "const p = '/c/Users/x/a.txt'; console.log(p)" }).code, /C:\/Users\/x\/a\.txt/)
  // an already-native or relative argument keeps its IDENTITY (no needless re-render)
  const native = { file_path: 'C:/Users/x/a.txt' }
  assert.equal(translateDispatch({ name: 'read', arguments: native }, dialect, env), native)
  const relative = { file_path: 'rel/a.txt' }
  assert.equal(translateDispatch({ name: 'read', arguments: relative }, dialect, env), relative)
})

test('issue #8 root cause stays fixed: the dispatch face reads the LIVE dialect', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  // The legacy reader cannot see a >= 0.1.7 host at all: `settings.get(ns)` is
  // gone there, so it returns the all-off fallback. Reading the dialect through
  // it inside apply() silently disabled the whole translation layer while the
  // directive text and the shell env (both already on the live reader) kept
  // working — issue #8's "half-alive dialect".
  const rc1Shaped = { get: (name) => (name === 'settings' ? { describe: () => [], update: async () => {} } : undefined) }
  assert.equal(_internal.readDialectSettings(rc1Shaped).posixPaths, false, 'the legacy reader is blind on 0.1.7 — that is WHY it may not gate the dispatch face')
  const applyBody = src.slice(src.indexOf('export async function apply'))
  // strip line comments first: this very fix documents the old call in a
  // comment, and the assertion is about CODE, not prose
  const codeOnly = applyBody.replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(codeOnly, /readDialectSettings\(ctx\)/, 'the dispatch face must not use the legacy reader')
  assert.match(applyBody, /const dialect = liveSettings\.dialect\(\)/)
  // and the sidebar revert (its own missed era read, found in the same audit)
  // goes through the era-aware helper instead of settings.get
  assert.match(src, /const now = readShell\(\)/)
  assert.doesNotMatch(src, /now = s\.get\(SIDEBAR_NS\)/)
})

// ── experimental CPython run_code switch (peer-owned, v0.26.0) ───────────────

test('python switch: the peer fact is read conservatively, getters included', () => {
  const { peerFact, PEER_PYTHON_FIELD, PEER_CAPABILITY } = _internal
  assert.equal(PEER_CAPABILITY, 'ptcCordisPreset')
  assert.equal(PEER_PYTHON_FIELD, 'pythonRuntime')
  assert.equal(peerFact({ pythonRuntime: true }, PEER_PYTHON_FIELD), true)
  assert.equal(peerFact({ pythonRuntime: false }, PEER_PYTHON_FIELD), false)
  // a live getter is honoured (the peer may report the current switch, not a copy)
  assert.equal(peerFact({ pythonRuntime: () => true }, PEER_PYTHON_FIELD), true)
  assert.equal(peerFact({ pythonRuntime: () => false }, PEER_PYTHON_FIELD), false)
  // absent / wrong type / throwing / absent capability: ALWAYS the Node backend
  assert.equal(peerFact({}, PEER_PYTHON_FIELD), false)
  assert.equal(peerFact({ pythonRuntime: 'yes' }, PEER_PYTHON_FIELD), false)
  assert.equal(peerFact({ get pythonRuntime() { throw new Error('nope') } }, PEER_PYTHON_FIELD), false)
  assert.equal(peerFact(undefined, PEER_PYTHON_FIELD), false)
  assert.equal(peerFact(null, PEER_PYTHON_FIELD), false)
})

test('python switch: workflow rows follow the official Python composition', async () => {
  const { pluginsFor } = await import('../src/compositions.js')
  const rows = (list) => new Map(list.map((row) => [row.id, row]))
  const delegationOf = (list) => new Map(rows(list).get('delegation').config.map((row) => [row.id, row]))
  for (const kind of ['standard', 'cordis']) {
    // `pythonActive` is the EFFECTIVE backend (v0.26.1): the peer's preflight
    // passed and the CPython provider really is the one run_code will use.
    const off = delegationOf(pluginsFor({ kind, gitBash: true, pythonActive: false }))
    assert.notEqual(off.get('workflow-ptc').disabled, true, kind + ': the default keeps the official row live')
    assert.notEqual(off.get('tool-workflow').disabled, true, kind + ': idem')
    const on = delegationOf(pluginsFor({ kind, gitBash: true, pythonActive: true }))
    assert.equal(on.get('workflow-ptc').disabled, true, kind + ': CPython is TypeScript-less, so workflow-ptc must be off')
    assert.equal(on.get('tool-workflow').disabled, true, kind + ': the official Python composition disables it too')
    // and nothing ELSE moves: the rows are byte-identical apart from those two
    const before = pluginsFor({ kind, gitBash: true, pythonActive: false })
    const after = pluginsFor({ kind, gitBash: true, pythonActive: true })
    assert.deepEqual(
      after.map((row) => row.id),
      before.map((row) => row.id),
      kind + ': the switch never adds or removes a row',
    )
    assert.deepEqual(rows(after).get('tool-presentation'), rows(before).get('tool-presentation'), kind)
  }
  // the ptc variant is already workflow-free: the switch changes nothing there
  const ptcOff = pluginsFor({ kind: 'ptc', gitBash: true, pythonActive: false })
  const ptcOn = pluginsFor({ kind: 'ptc', gitBash: true, pythonActive: true })
  assert.deepEqual(ptcOn, ptcOff, 'kind=ptc already disables both workflow rows')
  // minimal has no workflow rows at all
  const { minimalPluginsFor } = await import('../src/compositions.js')
  assert.deepEqual(minimalPluginsFor(), minimalPluginsFor())
})

test('python switch: the host rebuilds variants on the EFFECTIVE backend and inserts NO runtime row', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  // read from the peer's published capability (family rule: never guess a peer fact),
  // and act on the EFFECTIVE backend rather than the bare intent (v0.26.1)
  assert.match(src, /const nextPython = pythonBackendActive\(coverage\)/)
  assert.match(src, /const intentPython = peerFact\(coverage, PEER_PYTHON_FIELD\)/)
  // the ROWS change, so live variants are re-registered rather than skipped
  assert.match(src, /registeredPython !== peerPython/)
  assert.match(src, /pythonActive: peerPython \}\)/)
  const compositions = readFileSync(new URL('../src/compositions.js', import.meta.url), 'utf8')
  assert.match(compositions, /export function pluginsFor\(\{ kind, gitBash, skillsDir, pythonActive = false \}\)/, 'the composition entry point takes the effective fact')
  assert.match(compositions, /const workflowOn = kind !== 'ptc' && pythonActive !== true/)
  // the runtime row belongs to dsh-ptc-cordis-preset alone: our bundle patch
  // must never target it (two providers would collide)
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(patch, /ptc-runtime/)
  assert.doesNotMatch(patch, /experimental-ptc-runtime-python/)
  // and we declare no dependency on the experimental package: the peer owns it
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    assert.equal(pkg[field]?.['@deepseek-ai/dsh-experimental-ptc-runtime-python'], undefined, field)
  }
})

test("client card: the python row mirrors the PEER's field and is Windows-gated", () => {
  const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(src, /var PEER_PYTHON_FIELD = "pythonRuntime"/)
  // drawn only when the peer's snapshot actually carries the field (older peer = nothing)
  assert.match(src, /Object\.prototype\.hasOwnProperty\.call\(peerSnap\.value, PEER_PYTHON_FIELD\)/)
  // the value is the peer's; the write goes through the PEER's form, so either
  // side updates both (one authoritative copy, no mirror field)
  assert.match(src, /var pythonOn = pythonOffered && peerSnap\.value\[PEER_PYTHON_FIELD\] === true;/)
  assert.match(src, /peer\.set\(PEER_PYTHON_FIELD, next\)/)
  assert.doesNotMatch(src, /writeField\("pythonRuntime"/, 'the python switch must not write OUR row')
  // the contract carries NO peer-reported reason field: a client card can only
  // read the row snapshot, so inventing one would be a second, drifting state.
  // The copy points at the host log instead (asserted below).
  assert.doesNotMatch(src, /pythonRuntimeIssue/)
  // Windows: the CPython backend refuses to load, so the buttons give way
  assert.match(src, /var winHost = winState\[0\]/)
  assert.match(src, /winHost \? null : E\("div", \{ className: "gb-seg" \}/)
  assert.match(src, /winHost \? E\("p", \{ className: "gb-error" \}, t\("python\.blocked"\)\) : null/)
  // hooks stay before the scope's early return
  const hookAt = src.indexOf('var winState = useState(false);')
  const earlyReturnAt = src.indexOf('if (snap.status !== "ready") return null;')
  assert.ok(hookAt > 0 && earlyReturnAt > hookAt, 'the windows-host hook must run before the early return')
  const sectionAt = src.indexOf('var pythonSection = pythonOffered ?')
  const bodyAt = src.indexOf('var bodyContent = E("div", { className: "gb-body" }')
  assert.ok(sectionAt > 0 && bodyAt > sectionAt, 'the section is built before the body')
  assert.match(src, /\n\t\t\t\tpythonSection,/)
  for (const key of ['sec.python', 'python.label', 'python.on', 'python.off', 'python.hint', 'python.blocked']) {
    const occurrences = [...src.matchAll(new RegExp('"' + key.replace(/\./g, '\\.') + '":', 'g'))].length
    assert.ok(occurrences >= 21, key + ' must exist in all 21 dictionaries, saw ' + occurrences)
  }
  // every hint names the restart and the host-log fallback (the contract's
  // effectiveness and diagnosis story, identical on both cards)
  const hints = [...src.matchAll(/"python\.hint": ("(?:[^"\\]|\\.)*")/g)].map((match) => JSON.parse(match[1]))
  assert.equal(hints.length, 21, 'one python hint per shipped dictionary')
  // The two sentences the contract fixes, asserted on the two inline
  // dictionaries; the 19 third languages carry the same two facts (the tail
  // was appended to every one of them, and the key-parity test guards the set).
  assert.ok(hints[0].includes('重启') && hints[0].includes('宿主启动日志'), 'the zh hint states the restart and points at the host log')
  assert.ok(hints[1].includes('restarting dsh') && hints[1].includes('startup log'), 'the en hint states the restart and points at the host log')
  for (const hint of hints) assert.ok(hint.length > 120, 'a hint looks truncated: ' + hint.slice(0, 60))
})

test('python switch: the mutex keys on the EFFECTIVE backend, and an old peer falls back to the intent', () => {
  const { pythonBackendActive, peerBackend, PEER_PYTHON_BACKEND_FIELD } = _internal
  assert.equal(PEER_PYTHON_BACKEND_FIELD, 'pythonBackend')
  // intent on AND the peer reports the CPython backend really active → mutex on
  assert.equal(pythonBackendActive({ pythonRuntime: true, pythonBackend: 'python' }), true)
  // intent on but the preflight failed → the composition still runs Node, so the
  // workflow rows must STAY LIVE (v0.26.1: the whole point of the effective fact)
  assert.equal(pythonBackendActive({ pythonRuntime: true, pythonBackend: 'node' }), false)
  // intent off wins regardless of what the backend field claims
  assert.equal(pythonBackendActive({ pythonRuntime: false, pythonBackend: 'python' }), false)
  assert.equal(pythonBackendActive({ pythonRuntime: false, pythonBackend: 'node' }), false)
  // OLD PEER (no effective field) → the intent stands in: pre-0.26.1 behavior
  assert.equal(pythonBackendActive({ pythonRuntime: true }), true)
  assert.equal(pythonBackendActive({ pythonRuntime: false }), false)
  assert.equal(peerBackend({ pythonRuntime: true }), undefined, 'an unreported backend is undefined, never "node"')
  // getters are honoured on both facts, and nothing throws
  assert.equal(pythonBackendActive({ pythonRuntime: () => true, pythonBackend: () => 'python' }), true)
  assert.equal(pythonBackendActive({ pythonRuntime: () => true, pythonBackend: () => 'node' }), false)
  // anything outside the closed vocabulary falls back to the intent
  for (const bogus of ['Python', 'cpython', '', 1, null, undefined, {}]) {
    assert.equal(peerBackend({ pythonRuntime: true, pythonBackend: bogus }), undefined, 'bogus backend: ' + String(bogus))
    assert.equal(pythonBackendActive({ pythonRuntime: true, pythonBackend: bogus }), true, 'bogus backend falls back: ' + String(bogus))
  }
  assert.equal(pythonBackendActive({ get pythonRuntime() { throw new Error('nope') }, pythonBackend: 'python' }), false)
  assert.equal(pythonBackendActive(undefined), false)
  assert.equal(peerBackend(null), undefined)
})

test('python switch: the degraded intent is reported, never acted on', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  // the log distinguishes "really switched" from "asked for but not effective",
  // so an operator can see WHY the workflow rows stayed on
  assert.ok(src.includes('peer reports the experimental CPython run_code backend: workflow rows go off in every variant'))
  assert.ok(src.includes('peer has the CPython switch on but the effective backend is '))
  assert.ok(src.includes(': workflow rows stay on (reason in the host log)'))
  // an unreported backend says so instead of naming a backend that never ran
  assert.ok(src.includes("reportedBackend === undefined ? 'unreported (older peer: the intent stands in)' : reportedBackend"))
  // the decision is one conjunctive helper, so no call site can act on the intent alone
  assert.ok(src.includes('export function pythonBackendActive(capability) {'))
  assert.ok(src.includes('if (reported === undefined) return intent'))
  assert.ok(src.includes("return intent && reported === 'python'"))
})

test('client card: the python row shows the degraded state when the backend did not take effect', () => {
  const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(src, /var PEER_PYTHON_BACKEND_FIELD = "pythonBackend"/)
  // the effective value rides the SAME peer snapshot the intent does
  assert.match(src, /peerSnap\.value\[PEER_PYTHON_BACKEND_FIELD\]/)
  assert.match(src, /var pythonDegraded = pythonOn && peerPythonBackend === "node";/)
  // shown on the state line AND as the reason paragraph
  assert.match(src, /pythonDegraded \? t\("python\.on"\) \+ " · " \+ t\("python\.degraded"\) : t\("python\.on"\)/)
  assert.ok(src.includes('pythonDegraded ? E("p", { className: "gb-error" }, t("python.degraded")) : null'), 'the reason paragraph rides the degraded state')
  // an absent field (older peer) leaves the card exactly as before: no banner
  assert.ok(src.includes('typeof peerSnap.value[PEER_PYTHON_BACKEND_FIELD] === "string"'), 'a non-string backend field is ignored')
  for (const key of ['sec.python', 'python.label', 'python.on', 'python.off', 'python.hint', 'python.blocked', 'python.degraded']) {
    const occurrences = [...src.matchAll(new RegExp('"' + key.replace(/\./g, '\\.') + '":', 'g'))].length
    assert.ok(occurrences >= 21, key + ' must exist in all 21 dictionaries, saw ' + occurrences)
  }
  const degraded = [...src.matchAll(/"python\.degraded": ("(?:[^"\\]|\\.)*")/g)].map((match) => JSON.parse(match[1]))
  assert.equal(degraded.length, 21, 'one degraded copy per shipped dictionary')
  assert.ok(degraded[0].includes('后端不可用') && degraded[0].includes('宿主启动日志'), 'zh states the degradation and the log: ' + degraded[0])
  assert.ok(degraded[1].includes('backend unavailable') && degraded[1].includes('startup log'), 'en states the degradation and the log: ' + degraded[1])
  for (const copy of degraded) assert.ok(copy.length > 10, 'a degraded copy looks truncated: ' + copy)
})

// ── delegated agents (subagents / team members) and the dialect (v0.27.0) ────

test('subagent switch: a delegated agent is recognised by its session header', () => {
  const { isDelegatedAgent, dialectApplies } = _internal
  const agent = (header) => ({ session: { header } })
  // dsh stamps BOTH when the subagent driver creates a child
  // (packages/subagent/subagent/src/child-agent.ts:139-155); either is enough.
  assert.equal(isDelegatedAgent(agent({ origin: 'subagent' })), true)
  assert.equal(isDelegatedAgent(agent({ origin: 'subagent', delegationDepth: 1 })), true)
  assert.equal(isDelegatedAgent(agent({ delegationDepth: 1 })), true, 'a nested child without the origin flag still counts')
  assert.equal(isDelegatedAgent(agent({ delegationDepth: 2 })), true)
  // a root session carries neither
  assert.equal(isDelegatedAgent(agent({})), false)
  assert.equal(isDelegatedAgent(agent({ delegationDepth: 0 })), false)
  assert.equal(isDelegatedAgent(agent({ origin: 'user' })), false)
  // unknown shapes are NEVER delegated: keeping the dialect is the helpful side
  assert.equal(isDelegatedAgent(undefined), false)
  assert.equal(isDelegatedAgent(null), false)
  assert.equal(isDelegatedAgent({}), false)
  assert.equal(isDelegatedAgent({ session: {} }), false)
  assert.equal(isDelegatedAgent({ session: { header: null } }), false)
  assert.equal(isDelegatedAgent({ get session() { throw new Error('nope') } }), false)
  // default ON: both a root agent and a delegated one participate
  assert.equal(dialectApplies({ subagentDialect: true }, agent({ origin: 'subagent' })), true)
  assert.equal(dialectApplies({ subagentDialect: true }, agent({})), true)
  assert.equal(dialectApplies(undefined, agent({ origin: 'subagent' })), true, 'an absent dialect object must never suppress')
})

test('subagent switch: OFF keeps the dialect to the main agent', () => {
  const { dialectApplies } = _internal
  const main = { session: { header: {} } }
  const sub = { session: { header: { origin: 'subagent' } } }
  const nested = { session: { header: { delegationDepth: 2 } } }
  assert.equal(dialectApplies({ subagentDialect: false }, main), true, 'the main agent always keeps it')
  assert.equal(dialectApplies({ subagentDialect: false }, sub), false)
  assert.equal(dialectApplies({ subagentDialect: false }, nested), false)
  assert.equal(dialectApplies({ subagentDialect: false }, undefined), true, 'unknown agent = main agent = dialect on')
  // the card exposes the switch on the SAME row (writeField -> this row's Config)
  const client = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(client, /var subagents = snap\.value\.subagentDialect !== false;/)
  assert.match(client, /writeField\("subagentDialect", false\)/)
  assert.match(client, /writeField\("subagentDialect", true\)/)
  for (const key of ['sub.label', 'sub.hint']) {
    const occurrences = [...client.matchAll(new RegExp('"' + key.replace(/\./g, '\\.') + '":', 'g'))].length
    assert.ok(occurrences >= 21, key + ' must exist in all 21 dictionaries, saw ' + occurrences)
  }
  // every dialect consumer asks the SAME gate, with its own agent
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(src, /dialectApplies\(dialect, assembleContext && assembleContext\.agent\)/, 'prompt assembly')
  assert.match(src, /dialectApplies\(dialect, exec && exec\.agent\)/, 'dispatch + failure faces')
  assert.match(src, /dialectApplies\(dialect, execution && execution\.agent\)/, 'the shell-env fact')
  assert.match(src, /const applies = dialectApplies\(dialect, assembleContext && assembleContext\.agent\)/)
  // the post-execute early exit RETURNS the downstream promise: swallowing it
  // would hand the caller `undefined` instead of the decision
  assert.match(src, /if \(!dialectApplies\(dialect, exec && exec\.agent\)\) return next\(\)/)
  assert.doesNotMatch(src, /\{ next\(\); return \}/, 'a waterfall listener never drops its chain')
})

test('subagent switch: an old host without the key defaults to ON', () => {
  const { readDialectSettings } = _internal
  const ctxWith = (value) => ({ get: (name) => (name === 'settings' ? { get: () => value } : undefined) })
  assert.equal(readDialectSettings(ctxWith({})).subagentDialect, true, 'missing key = default on')
  assert.equal(readDialectSettings(ctxWith({ posixPaths: true })).subagentDialect, true)
  assert.equal(readDialectSettings(ctxWith({ subagentDialect: false })).subagentDialect, false)
  assert.equal(readDialectSettings(ctxWith({ subagentDialect: true })).subagentDialect, true)
  // a throwing read falls back to the all-off dialect BUT keeps the new default
  assert.equal(readDialectSettings({ get: () => { throw new Error('nope') } }).subagentDialect, true)
  assert.equal(readDialectSettings(undefined).subagentDialect, true)
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  // declared on both eras, default true on both
  assert.match(src, /subagentDialect: live\(Schema\.boolean\(\)\.default\(true\)\)/)
  assert.match(src, /subagentDialect: Schema\.boolean\(\)\.default\(true\)/)
  assert.match(src, /subagentDialect: valueOf\(config\.subagentDialect\) !== false/)
  assert.match(src, /subagentDialect: v\.subagentDialect !== false/)
})

// ── issue #11: the ONE bash resolution chain, and the two hard rules ─────────

/** A case-insensitive fake filesystem for the resolver tests. */
function fakeIo(files, options = {}) {
  const norm = (value) => String(value).replace(/\\/g, '/').toLowerCase()
  const set = new Set(files.map(norm))
  return {
    exists: (path) => set.has(norm(path)),
    defaults: () => options.defaults ?? [],
    pathBashCandidates: () => options.path ?? [],
    gitReverseCandidates: () => options.reverse ?? [],
    registryBashCandidates: () => options.registry ?? [],
    gitVersion: options.version ?? (() => 'git version 2.54.0.windows.1'),
    uname: options.uname ?? (() => 'MINGW64_NT-10.0-22631'),
  }
}
/** A complete, valid Git for Windows tree at `root`. */
const gitTree = (root) => [
  root + '/bin/bash.exe', root + '/cmd/git.exe', root + '/usr/bin/bash.exe', root + '/mingw64',
]

test('bash resolution: explicit setting wins, and a rejected explicit value is never substituted', async () => {
  const { resolveGitBash } = await import('../src/bash-path.js')
  // explicit + valid → used, whatever the defaults say
  const good = resolveGitBash({ configured: 'Q:/Git/bin/bash.exe', io: fakeIo(gitTree('Q:/Git'), { defaults: ['C:/Program Files/Git/bin/bash.exe'] }) })
  assert.equal(good.ok, true)
  assert.equal(good.path, 'Q:/Git/bin/bash.exe')
  assert.equal(good.source, 'configured')
  // explicit + invalid → FAIL, and the chain does NOT continue into a default:
  // the user's answer is the answer (and no other shell is substituted).
  const bad = resolveGitBash({ configured: 'Q:/Git/bin/bash.exe', io: fakeIo(gitTree('C:/Program Files/Git'), { defaults: ['C:/Program Files/Git/bin/bash.exe'] }) })
  assert.equal(bad.ok, false, 'an explicit-but-broken path must fail, not silently resolve elsewhere')
  assert.equal(bad.path, '', 'the failure carries NO substitute interpreter')
  assert.equal(bad.tried.length, 1)
  assert.equal(bad.tried[0].code, 'missing')
})

test('bash resolution: defaults, then PATH — with the WSL traps rejected on the way', async () => {
  const { resolveGitBash } = await import('../src/bash-path.js')
  // empty setting → the historical default still resolves first
  const byDefault = resolveGitBash({ configured: '', io: fakeIo(gitTree('C:/Program Files/Git'), { defaults: ['C:/Program Files/Git/bin/bash.exe'] }) })
  assert.equal(byDefault.ok, true)
  assert.equal(byDefault.source, 'default')
  // default missing → PATH, after refusing System32's WSL starter and the
  // WindowsApps alias (System32 is always on PATH and sorts first)
  const byPath = resolveGitBash({
    configured: '',
    io: fakeIo(gitTree('Q:/Git'), {
      defaults: ['C:/Program Files/Git/bin/bash.exe'],
      path: ['C:/Windows/System32/bash.exe', 'C:/Users/x/AppData/Local/Microsoft/WindowsApps/bash.exe', 'C:/tools/msys64/usr/bin/bash.exe', 'C:/tools/cygwin/bin/bash.exe', 'Q:/Git/bin/bash.exe'],
    }),
  })
  assert.equal(byPath.ok, true)
  assert.equal(byPath.path, 'Q:/Git/bin/bash.exe')
  assert.equal(byPath.source, 'path')
  assert.deepEqual(byPath.tried.map((row) => row.code), ['missing', 'rejected-shell', 'rejected-shell', 'rejected-shell', 'rejected-shell'])
  // the git.exe reverse lookup and the registry PATH are the last two steps
  const byReverse = resolveGitBash({ configured: '', io: fakeIo(gitTree('D:/Tools/Git'), { reverse: ['D:/Tools/Git/bin/bash.exe'] }) })
  assert.equal(byReverse.ok, true)
  assert.equal(byReverse.source, 'path-git')
  const byRegistry = resolveGitBash({ configured: '', io: fakeIo(gitTree('E:/Git'), { registry: ['E:/Git/bin/bash.exe'] }) })
  assert.equal(byRegistry.ok, true)
  assert.equal(byRegistry.source, 'registry')
})

test('bash resolution: ONLY Git for Windows counts — WSL, MSYS2, Cygwin and non-Windows git are refused', async () => {
  const { resolveGitBash, rejectedBashMarker } = await import('../src/bash-path.js')
  // the blacklist is a location rule, applied before any filesystem probe
  assert.equal(rejectedBashMarker('C:/Windows/System32/bash.exe'), 'system32')
  assert.equal(rejectedBashMarker('C:/Users/x/AppData/Local/Microsoft/WindowsApps/bash.exe'), 'windowsapps')
  assert.equal(rejectedBashMarker('C:/tools/msys64/usr/bin/bash.exe'), 'msys')
  assert.equal(rejectedBashMarker('C:/tools/cygwin64/bin/bash.exe'), 'cygwin')
  assert.equal(rejectedBashMarker('C:/Users/x/AppData/Local/wsl/bash.exe'), 'wsl')
  assert.equal(rejectedBashMarker('Q:/Git/bin/bash.exe'), undefined)
  // a WSL bash dressed in a Git-like tree still fails the `uname -s` veto
  const wslUname = resolveGitBash({ configured: '', io: fakeIo(gitTree('Q:/Git'), { defaults: ['Q:/Git/bin/bash.exe'], uname: () => 'Linux' }) })
  assert.equal(wslUname.ok, false)
  assert.equal(wslUname.path, '', 'a WSL bash must never be returned')
  assert.equal(wslUname.tried[0].code, 'not-git-bash')
  for (const uname of ['MSYS_NT-10.0-22631', 'CYGWIN_NT-10.0', 'Darwin']) {
    const verdict = resolveGitBash({ configured: '', io: fakeIo(gitTree('Q:/Git'), { defaults: ['Q:/Git/bin/bash.exe'], uname: () => uname }) })
    assert.equal(verdict.ok, false, uname + ' is not Git Bash')
  }
  assert.equal(resolveGitBash({ configured: '', io: fakeIo(gitTree('Q:/Git'), { defaults: ['Q:/Git/bin/bash.exe'], uname: () => 'MINGW64_NT-10.0-22631' }) }).ok, true)
  assert.equal(resolveGitBash({ configured: '', io: fakeIo(gitTree('Q:/Git'), { defaults: ['Q:/Git/bin/bash.exe'], uname: () => 'MINGW32_NT-10.0' }) }).ok, true)
  // the git version fingerprint must say `.windows.`
  const notWindowsGit = resolveGitBash({ configured: '', io: fakeIo(gitTree('Q:/Git'), { defaults: ['Q:/Git/bin/bash.exe'], version: () => 'git version 2.43.0' }) })
  assert.equal(notWindowsGit.ok, false)
  assert.equal(notWindowsGit.tried[0].code, 'not-windows-git')
  // …and the Git layout itself must be complete
  for (const missing of ['Q:/Git/usr/bin/bash.exe', 'Q:/Git/cmd/git.exe']) {
    const io = fakeIo(gitTree('Q:/Git').filter((path) => path !== missing), { defaults: ['Q:/Git/bin/bash.exe'] })
    assert.equal(resolveGitBash({ configured: '', io }).ok, false, 'incomplete Git tree: missing ' + missing)
  }
})

test('bash resolution: everything fails -> a report with the chain, the fix and NO fallback', async () => {
  const { resolveGitBash, bashResolutionReport, GIT_BASH_DOWNLOAD_URL } = await import('../src/bash-path.js')
  const verdict = resolveGitBash({
    configured: '',
    io: fakeIo([], { defaults: ['C:/Program Files/Git/bin/bash.exe'], path: ['C:/Windows/System32/bash.exe'] }),
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.path, '')
  const report = bashResolutionReport(verdict)
  assert.ok(report.includes('never falls back to PowerShell'), 'the report states the design: ' + report)
  assert.ok(report.includes('C:/Program Files/Git/bin/bash.exe'), 'the report lists every probed location')
  assert.ok(report.includes('Settings') || report.includes('settings'), 'the report says where to fix it')
  assert.ok(report.includes(GIT_BASH_DOWNLOAD_URL), 'the report links the download')
  assert.ok(report.includes('only Git for Windows'), 'the report says what IS accepted')
  // an explicit failure names the configured value instead of a default
  const explicit = resolveGitBash({ configured: 'Q:/nope/bin/bash.exe', io: fakeIo([]) })
  assert.ok(bashResolutionReport(explicit).includes('Q:/nope/bin/bash.exe'))
})

test('no-fallback guards: the plugin never swaps in another shell (patch + executor source)', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  // pwsh-sandbox stays UNCONDITIONALLY withdrawn — never gated on bash health
  const block = patch.slice(patch.indexOf('- id: pwsh-sandbox'), patch.indexOf('- insert:'))
  assert.match(block, /disabled: true/)
  assert.doesNotMatch(block, /!!js/, 'the pwsh withdrawal must not become conditional')
  assert.doesNotMatch(patch, /bashPath: "C:\/Program Files\/Git\/bin\/bash\.exe"/, 'no hard-coded C: default survives in the patch')
  const shell = readFileSync(new URL('../src/shell.js', import.meta.url), 'utf8')
  // Only the PROGRAM itself is inspected: comments explain the surrounding
  // history (and legitimately mention the shipped pwsh executor it replaces).
  const shellCode = shell.replace(/^\s*\*.*$/gm, '').replace(/^\s*\/\/.*$/gm, '')
  for (const needle of ['pwsh.exe', 'powershell.exe', 'cmd.exe', 'wsl.exe', "'bash'", '"bash"']) {
    assert.ok(!shellCode.includes(needle), 'src/shell.js must not spawn a substitute shell: ' + needle)
  }
  assert.ok(!/\/bin\/bash(?!\.exe)/.test(shellCode.replace(/DEFAULT_GIT_BASH = '[^']*'/g, '')), 'no bare POSIX bash path survives')
  assert.match(shell, /requireBashPath\(\)/, 'every argv goes through the resolved-path guard')
  // the guard THROWS on an unresolved bash instead of returning something runnable
  assert.match(shell, /if \(!resolution\.ok\) \{\s*throw new Error\('dsh-gitbash-shell: no Git for Windows bash found/)
  // the composition still pins pwsh rows off in every Git Bash variant
  const compositions = readFileSync(new URL('../src/compositions.js', import.meta.url), 'utf8')
  assert.match(compositions, /const pwshDisabled = gitBash \? true : !win/)
})

test('missing-bash popup: registered globally, win32-only, once per boot, with both actions', () => {
  const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(src, /slots\.inject\("shell\.overlay", function \(\) \{/)
  assert.match(src, /id: "gitbash-shell:bash-missing"/)
  assert.match(src, /var API_PATH = "dsh-gitbash-shell\/api\/status";/, 'mount-relative route (dsh serves the shell with <base href="./">)')
  assert.match(src, /data\.platform !== "win32" \|\| data\.ok !== false/, 'win32-only, and only when resolution failed')
  assert.match(src, /window\.sessionStorage\.getItem\(DISMISS_KEY\)/, 'per-boot dismissal')
  assert.match(src, /window\.open\(status\.downloadUrl/, 'the download action')
  assert.match(src, /form\.set\("bashPath", draft\.trim\(\)\)/, 'the inline editor writes the settings field')
  // the fetch happens in an effect, never cached at apply time (apply cannot
  // see the services yet on some boots — family lesson)
  assert.match(src, /useEffect\(function \(\) \{\s*var alive = true;/, 'the probe runs per mount, not at apply')
  for (const key of ['bashmiss.title', 'bashmiss.body', 'bashmiss.tried', 'bashmiss.download', 'bashmiss.where', 'bashmiss.close']) {
    const occurrences = [...src.matchAll(new RegExp('"' + key.replace(/\./g, '\\.') + '":', 'g'))].length
    assert.ok(occurrences >= 21, key + ' must exist in all 21 dictionaries, saw ' + occurrences)
  }
  const zh = [...src.matchAll(/"bashmiss\.body": ("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]))
  assert.ok(zh[0].includes('不会回退到 PowerShell'), 'the zh copy fixes the design, not just the symptom')
  assert.ok(zh[1].includes('never falls back to PowerShell'), 'the en copy says the same')
})

test('bash status route + capability expose the verdict to the client and to peers', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(src, /ctx\.inject\(\['webServer'\]/, 'the route is an optional service, never a hard inject')
  assert.match(src, /const route = '\/dsh-gitbash-shell\/api\/status'/)
  assert.match(src, /wctx\.webServer\.register\(\{ kind: 'prefix', path: route, handler \}\)/)
  // the capability keeps `bashPath` for existing peers and adds the verdict
  assert.match(src, /const gitBashCapability = \{/)
  assert.match(src, /ok: bashResolution\.ok,/)
  assert.match(src, /tried: bashResolution\.tried,/)
  assert.match(src, /downloadUrl: GIT_BASH_DOWNLOAD_URL,/)
  // ONE resolver for the executor and the translation layer (issue #11's split)
  assert.match(src, /const resolution = resolveGitBashCached\(\{ configured: cacheKey \}\)/)
  assert.match(src, /buildTranslateEnv\(configuredBashPath\)/)
  const shell = readFileSync(new URL('../src/shell.js', import.meta.url), 'utf8')
  assert.match(shell, /resolveGitBashCached\(\{ configured \}\)/, 'the executor resolves through the same shared memo')
})

test('write verdicts: a host REFUSAL never reads as "saved" (no silent false success)', () => {
  const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  // the popup: the boolean IS the verdict
  assert.match(src, /if \(accepted === true\) \{ setSaved\(true\); return; \}/, 'the popup honours the accepted boolean')
  assert.match(src, /setSaved\(false\);\s*\n\s*setSaveError\(t\("error"\) \+ ": " \+ t\("bash\.saveFailed"\)\);/,
    'a refusal renders an explicit failure line')
  assert.match(src, /saveError !== "" \? E\("p", \{ className: "gb-error" \}, saveError\) : null/)
  // the card: same verdict, and the save button no longer claims success unconditionally
  assert.match(src, /writeField\(key, next\)[\s\S]{0,400}if \(accepted !== true\) \{/, 'writeField checks the verdict')
  assert.match(src, /if \(accepted !== true\) \{[\s\S]{0,120}setError\(t\("error"\) \+ ": " \+ t\("bash\.saveFailed"\)\);/)
  assert.match(src, /writeField\("bashPath", bashDraft\.trim\(\)\)\.then\(function \(accepted\) \{ setBashSaved\(accepted === true\); \}\)/)
  assert.doesNotMatch(src, /writeField\("bashPath", bashDraft\.trim\(\)\); setBashSaved\(true\);/, 'the old unconditional success is gone')
  // a missing seat is a refusal too — never a pretend success
  assert.match(src, /if \(!scope \|\| typeof scope\.set !== "function"\) \{/)
  assert.match(src, /if \(!form \|\| typeof form\.set !== "function"\) \{/)
  // and the failure copy exists in every shipped dictionary
  const copies = [...src.matchAll(/"bash\.saveFailed": ("(?:[^"\\]|\\.)*")/g)].map((match) => JSON.parse(match[1]))
  assert.equal(copies.length, 21, 'one failure copy per shipped dictionary')
  assert.ok(copies[0].includes('宿主拒绝'), 'zh says the host refused: ' + copies[0])
  assert.ok(copies[1].includes('host refused'), 'en says the host refused: ' + copies[1])
})

// ── task-25: the official sidebar terminal must not stay on WSL ──────────────

/** A recording stand-in for `ctx.configEditor` (the official write channel). */
function fakeEditor(options = {}) {
  const state = {
    config: {
      ...(options.extra ?? {}),
      ...(options.shell === undefined ? {} : { shell: { ...options.shell } }),
    },
  }
  const calls = []
  const row = () => ({
    entry: { options: { id: 'terminal-controller' } },
    override: options.shellInherited === true ? {} : structuredClone(state.config),
    inherited: options.shellInherited === true ? structuredClone(state.config) : {},
  })
  return {
    calls,
    state,
    configuration: () => (options.rowAbsent === true ? [] : [row()]),
    edit: async (entry, change) => {
      if (options.fail === true) throw new Error('the editor refused this write')
      const next = change(structuredClone(state.config))
      calls.push(next)
      // `sticky: false` simulates a write the row never picked up.
      if (options.sticky !== false) state.config = next
    },
  }
}

test('sidebar terminal: an unset shell is adopted with the official bash profile', async () => {
  const { adoptTerminalShell, terminalAdoptReport, TERMINAL_SHELL_ARGS, TERMINAL_SHELL_NAME } = await import('../src/terminal-shell.js')
  assert.equal(TERMINAL_SHELL_NAME, 'Git Bash', 'the display name is Git Bash, never bare bash (v0.29.1)')
  const editor = fakeEditor({ extra: { scrollback: 1000 } })
  const result = await adoptTerminalShell(editor, { platform: 'win32', enabled: true, resolved: 'Q:/Git/bin/bash.exe' })
  assert.equal(result.status, 'adopted')
  assert.equal(editor.calls.length, 1, 'exactly one write')
  assert.deepEqual(editor.calls[0].shell, { path: 'Q:/Git/bin/bash.exe', name: 'Git Bash', args: ['-i'] })
  // the profile matches the official `profile()` convention for a bash path…
  assert.deepEqual(editor.calls[0].shell.args, TERMINAL_SHELL_ARGS)
  // …and every other row config field survives the merge
  assert.equal(editor.calls[0].scrollback, 1000, 'unrelated config keys are preserved')
  assert.match(terminalAdoptReport(result), /switched to Git Bash/)
  assert.match(terminalAdoptReport(result), /new terminals use it immediately/)
})

test('sidebar terminal: same path is left alone, another path is never overwritten', async () => {
  const { adoptTerminalShell, terminalAdoptReport } = await import('../src/terminal-shell.js')
  // already ours under the right name (case/separator-insensitive) → no write at all
  const same = fakeEditor({ shell: { path: 'q:\\git\\bin\\BASH.EXE', name: 'Git Bash', args: ['-i'] } })
  const unchanged = await adoptTerminalShell(same, { platform: 'win32', enabled: true, resolved: 'Q:/Git/bin/bash.exe' })
  assert.equal(unchanged.status, 'unchanged')
  assert.equal(same.calls.length, 0, 'idempotent: nothing written')
  // an explicit choice (here: the WSL launcher) → log only, never overwrite
  const other = fakeEditor({ shell: { path: 'C:/Windows/System32/bash.exe', name: 'bash', args: ['-i'] } })
  const kept = await adoptTerminalShell(other, { platform: 'win32', enabled: true, resolved: 'Q:/Git/bin/bash.exe' })
  assert.equal(kept.status, 'kept-user-choice')
  assert.equal(other.calls.length, 0, 'a user choice is never overwritten')
  assert.equal(other.state.config.shell.path, 'C:/Windows/System32/bash.exe')
  assert.match(terminalAdoptReport(kept), /NOT adopted/)
  assert.match(terminalAdoptReport(kept), /C:\/Windows\/System32\/bash\.exe/)
  assert.match(terminalAdoptReport(kept), /Settings/, 'the log says how to hand it over')
})

test('sidebar terminal: switch off, non-Windows, unresolved and absent row all stay read-only', async () => {
  const { adoptTerminalShell } = await import('../src/terminal-shell.js')
  const cases = [
    [{ enabled: false, platform: 'win32', resolved: 'Q:/Git/bin/bash.exe' }, 'skip-disabled'],
    [{ enabled: true, platform: 'darwin', resolved: 'Q:/Git/bin/bash.exe' }, 'skip-platform'],
    [{ enabled: true, platform: 'win32', resolved: '' }, 'skip-unresolved'],
  ]
  for (const [input, expected] of cases) {
    const editor = fakeEditor({})
    const result = await adoptTerminalShell(editor, input)
    assert.equal(result.status, expected, JSON.stringify(input))
    assert.equal(editor.calls.length, 0, 'nothing written for ' + expected)
  }
  const absent = fakeEditor({ rowAbsent: true })
  assert.equal((await adoptTerminalShell(absent, { platform: 'win32', enabled: true, resolved: 'Q:/Git/bin/bash.exe' })).status, 'skip-row-absent')
  assert.equal(absent.calls.length, 0)
  // a host without the editor service at all is an expected condition, not a crash
  assert.equal((await adoptTerminalShell(undefined, { platform: 'win32', enabled: true, resolved: 'Q:/Git/bin/bash.exe' })).status, 'skip-row-absent')
})

test('sidebar terminal: a refused or non-sticky write is reported, never claimed as success', async () => {
  const { adoptTerminalShell, terminalAdoptReport } = await import('../src/terminal-shell.js')
  // the editor throws
  const refused = fakeEditor({ fail: true })
  const failed = await adoptTerminalShell(refused, { platform: 'win32', enabled: true, resolved: 'Q:/Git/bin/bash.exe' })
  assert.equal(failed.status, 'write-failed')
  assert.match(failed.detail, /refused this write/)
  assert.match(terminalAdoptReport(failed), /adoption FAILED/)
  // the editor resolves but the row never carries the value (read-back check)
  const notSticky = fakeEditor({ sticky: false })
  const stuck = await adoptTerminalShell(notSticky, { platform: 'win32', enabled: true, resolved: 'Q:/Git/bin/bash.exe' })
  assert.equal(stuck.status, 'write-failed', 'resolving edit() is not proof the write landed')
  assert.match(stuck.detail, /did not stick/)
})

test('sidebar terminal: the host reaches configEditor, never the settings service', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(src, /ctx\.inject\(\['configEditor'\], \(editorCtx\) => \{/, 'the editor is an optional service')
  assert.match(src, /adoptTerminalShell\(editorCtx\.configEditor, \{/)
  assert.match(src, /enabled: liveSettings\.autoTerminalShell\(\)/, 'the switch gates the write')
  assert.match(src, /resolved: bashResolution\.ok \? bashResolution\.path : ''/, 'only a VERIFIED bash is offered')
  assert.match(src, /terminalAdoptReport\(result\)/)
  assert.doesNotMatch(src, /settings\.update\('terminal'/, 'the settings service cannot write a non-volatile field (measured)')
  // the better-sidebar channel stays independent
  assert.match(src, /adoptSidebarShell\(ctx, bashResolution\.path/)
  // the switch is declared in both eras
  assert.match(src, /autoTerminalShell: live\(Schema\.boolean\(\)\.default\(true\)\)/)
  assert.match(src, /autoTerminalShell: Schema\.boolean\(\)\.default\(true\)/)
  assert.match(src, /autoTerminalShell: v\.autoTerminalShell !== false/)
})

test('sidebar terminal: writes go through the official editor only — no fs path to the profile patch', async () => {
  const files = ['index.js', 'terminal-shell.js', 'shell.js', 'bash-path.js', 'client.js', 'compositions.js']
  for (const name of files) {
    const code = readFileSync(new URL('../src/' + name, import.meta.url), 'utf8')
    // The profile patch is the USER's file. We reach it only through
    // `configEditor.edit()`, which the official settings UI uses as well; a
    // direct fs write from this repository would race that editor's lock and
    // clobber hand-written comments/rows.
    assert.doesNotMatch(code, /cordis\.patch/, name + ' must not name the profile patch file')
    assert.doesNotMatch(code, /patchPath/, name + ' must not touch the profile patch path')
    const nearFs = /(writeFile|appendFile|writeFileSync|appendFileSync|createWriteStream)[^\n]*\n?[^\n]*patch/i
    assert.doesNotMatch(code, nearFs, name + ' must not fs-write anything patch-shaped')
  }
  // the terminal module itself carries no filesystem import at all
  const terminal = readFileSync(new URL('../src/terminal-shell.js', import.meta.url), 'utf8')
  assert.doesNotMatch(terminal, /node:fs|from 'fs'/, 'terminal-shell.js performs no filesystem work')
  assert.match(terminal, /await editor\.edit\(row\.entry, \(raw\) => \(\{ \.\.\.raw, shell: plan\.shell \}\)\)/,
    'the single write site is configEditor.edit()')
  // and the failure path hands the user an executable next step
  assert.match(terminal, /next steps: \(1\)/)
  assert.match(terminal, /turn this plugin\\'s "autoTerminalShell" switch off/, 'log hands over an executable next step')
  // the revert semantics sentence is in the card hint for every language
  const client = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const hints = [...client.matchAll(/"term\.hint": ("(?:[^"\\]|\\.)*")/g)].map((match) => JSON.parse(match[1]))
  assert.equal(hints.length, 21, 'one hint per dictionary')
  for (const hint of hints) assert.match(hint, /terminal-controller/, 'every hint names the field to delete: ' + hint.slice(0, 40))
  assert.match(hints[0], /只会阻止/, 'zh hint says the switch only stops future writes')
  assert.match(hints[1], /only stops FUTURE writes/)
})

test('sidebar terminal: a historical `bash` label is migrated to Git Bash, then stays put', async () => {
  const { adoptTerminalShell, terminalAdoptReport, planTerminalAdopt } = await import('../src/terminal-shell.js')
  // v0.29.0 wrote `name: 'bash'` — the whole point of v0.29.1 is that an
  // existing install gets renamed WITHOUT touching path or args.
  const editor = fakeEditor({ shell: { path: 'Q:/Git/bin/bash.exe', name: 'bash', args: ['-i'] }, extra: { scrollback: 1000 } })
  const renamed = await adoptTerminalShell(editor, { platform: 'win32', enabled: true, resolved: 'q:\\git\\bin\\bash.exe' })
  assert.equal(renamed.status, 'renamed')
  assert.equal(editor.calls.length, 1, 'exactly one write for the migration')
  assert.deepEqual(editor.calls[0].shell, { path: 'Q:/Git/bin/bash.exe', name: 'Git Bash', args: ['-i'] }, 'only the name changes')
  assert.equal(editor.calls[0].scrollback, 1000, 'unrelated row config preserved')
  assert.equal(editor.state.config.shell.path, 'Q:/Git/bin/bash.exe', 'the path is left exactly as it was')
  assert.match(terminalAdoptReport(renamed), /renamed to "Git Bash"/)
  assert.match(terminalAdoptReport(renamed), /no longer confusable with the WSL candidate/)
  // running again over the migrated row is a no-op (idempotent → patch md5 stable)
  const again = await adoptTerminalShell(editor, { platform: 'win32', enabled: true, resolved: 'Q:/Git/bin/bash.exe' })
  assert.equal(again.status, 'unchanged')
  assert.equal(editor.calls.length, 1, 'no second write after the migration')
  // the pure decision only migrates OUR legacy default name
  const legacy = planTerminalAdopt({
    platform: 'win32', enabled: true, resolved: 'Q:/Git/bin/bash.exe',
    current: { path: 'Q:/Git/bin/bash.exe', name: 'bash', args: [] },
  })
  assert.equal(legacy.action, 'rename')
  assert.deepEqual(legacy.shell, { path: 'Q:/Git/bin/bash.exe', name: 'Git Bash', args: [] })
  // a rename whose name does not stick is a failure, never a success
  const notSticky = fakeEditor({ shell: { path: 'Q:/Git/bin/bash.exe', name: 'bash', args: ['-i'] }, sticky: false })
  const stuck = await adoptTerminalShell(notSticky, { platform: 'win32', enabled: true, resolved: 'Q:/Git/bin/bash.exe' })
  assert.equal(stuck.status, 'write-failed')
  assert.match(stuck.detail, /name mismatch/)
})

test('sidebar terminal: a name the USER chose is never rewritten', async () => {
  const { adoptTerminalShell, planTerminalAdopt, terminalAdoptReport } = await import('../src/terminal-shell.js')
  // path is ours, but the label is the user's own → read-only, exactly like an
  // explicit shell-path choice. Only v0.29.0's own `bash` default is migrated.
  for (const label of ['My Bash', 'Git', 'Zsh-like', '']) {
    const editor = fakeEditor({ shell: { path: 'Q:/Git/bin/bash.exe', name: label, args: ['-i'] } })
    const result = await adoptTerminalShell(editor, { platform: 'win32', enabled: true, resolved: 'Q:/Git/bin/bash.exe' })
    assert.equal(result.status, 'kept-user-name', 'name "' + label + '" must be left alone')
    assert.equal(editor.calls.length, 0, 'zero writes for a user-chosen name: ' + label)
    assert.equal(editor.state.config.shell.name, label, 'the name is untouched')
    assert.match(terminalAdoptReport(result), /NOT renamed/)
    assert.match(terminalAdoptReport(result), /never rewritten/)
  }
  const plan = planTerminalAdopt({
    platform: 'win32', enabled: true, resolved: 'Q:/Git/bin/bash.exe',
    current: { path: 'Q:/Git/bin/bash.exe', name: 'My Bash', args: [] },
  })
  assert.equal(plan.action, 'kept-user-name')
  assert.equal(plan.shell, undefined, 'a kept name produces no write payload')
  // and the boundary: our own legacy default IS migrated, a correct name is not touched
  assert.equal(planTerminalAdopt({
    platform: 'win32', enabled: true, resolved: 'Q:/Git/bin/bash.exe',
    current: { path: 'Q:/Git/bin/bash.exe', name: 'bash', args: [] },
  }).action, 'rename')
  assert.equal(planTerminalAdopt({
    platform: 'win32', enabled: true, resolved: 'Q:/Git/bin/bash.exe',
    current: { path: 'Q:/Git/bin/bash.exe', name: 'Git Bash', args: [] },
  }).action, 'unchanged')
})

// ── winget toolchain (v0.30.0) ───────────────────────────────────────────────
// Every fact these tests pin was MEASURED on winget 1.29.380 / Windows 11:
// the full-HRESULT exit codes, the GNU-vs-MSVC ripgrep ids, 7-Zip being
// winget-owned while `7z` is not on PATH, and `winget export` being the only
// machine-readable inventory.

test('toolchain: the catalog is structurally sound and fully provenance-tagged', () => {
  assert.ok(TOOLCHAIN.length >= 20, 'catalog size')
  const seen = new Set()
  for (const tool of TOOLCHAIN) {
    assert.ok(typeof tool.id === 'string' && tool.id !== '', 'id')
    assert.ok(typeof tool.cmd === 'string' && tool.cmd !== '', tool.id + ' cmd')
    assert.ok(Array.isArray(tool.ids) && tool.ids.length > 0, tool.id + ' ids')
    for (const id of tool.ids) {
      // A community-repo id: Publisher.Package, nothing exotic.
      assert.match(id, /^[A-Za-z0-9-]+\.[A-Za-z0-9._-]+$/, tool.id + ' id shape')
      assert.ok(!seen.has(id), 'duplicate winget id ' + id)
      seen.add(id)
    }
    assert.ok(['base', 'cli', 'managed', 'admin'].includes(tool.group), tool.id + ' group')
    // Provenance is rendered to the user, so it may not be blank or invented.
    assert.ok(typeof tool.publisher === 'string' && tool.publisher !== '', tool.id + ' publisher')
    assert.ok(typeof tool.source === 'string' && tool.source !== '', tool.id + ' source')
    assert.equal(tool.admin === true, tool.group === 'admin', tool.id + ' admin flag matches group')
  }
  // Exactly the two manifests that say Scope: machine.
  const admin = TOOLCHAIN.filter((tool) => tool.admin === true).map((tool) => tool.id).sort()
  assert.deepEqual(admin, ['7zip', 'tree'])
})

test('toolchain: every argv pins the exact id AND the official source', () => {
  for (const tool of TOOLCHAIN) {
    const install = installArgv(tool)
    assert.equal(install[0], 'install')
    assert.ok(install.includes('--exact'), tool.id + ' install --exact')
    assert.ok(install.includes('--source'), tool.id + ' install --source')
    assert.ok(install.includes(WINGET_SOURCE), tool.id + ' install source value')
    // The id is the catalog's own; a caller can never substitute one.
    assert.ok(install.includes(tool.ids[0]), tool.id + ' install id')
    const upgrade = upgradeArgv(tool)
    assert.equal(upgrade[0], 'upgrade')
    assert.ok(upgrade.includes('--exact') && upgrade.includes(WINGET_SOURCE), tool.id + ' upgrade pins')
  }
  // ripgrep ships as two separate packages: a fresh install takes the first,
  // an upgrade must target whatever the machine actually has.
  const rg = toolById('rg')
  assert.equal(rg.ids[0], 'BurntSushi.ripgrep.MSVC')
  assert.ok(installArgv(rg).includes('BurntSushi.ripgrep.MSVC'))
  assert.ok(upgradeArgv(rg, 'BurntSushi.ripgrep.GNU').includes('BurntSushi.ripgrep.GNU'))
})

test('toolchain: the PATH scan resolves commands, first hit wins, bad dirs are skipped', () => {
  const io = {
    pathDirs: () => ['C:/a', 'C:/b'],
    readdir: (dir) => (dir === 'C:/a' ? ['make.exe', 'README.md'] : ['make.cmd', 'yq.exe']),
  }
  const hits = scanCommands(io, TOOLCHAIN)
  // The scan keeps each PATH directory's own spelling and appends a backslash,
  // so the expectation is built the same way instead of being normalized by
  // join() (which would rewrite 'C:/a' to 'C:\\a' and mask a real difference).
  assert.equal(hits.get('make'), 'C:/a' + sep + 'make.exe', 'earlier PATH entry wins')
  assert.equal(hits.get('yq'), 'C:/b' + sep + 'yq.exe')
  assert.equal(hits.has('wget'), false)
  const broken = { pathDirs: () => ['C:/nope'], readdir: () => { throw new Error('EACCES') } }
  assert.equal(scanCommands(broken, TOOLCHAIN).size, 0, 'an unreadable directory is not fatal')
})

test('toolchain: the state machine — winget inventory first, others never touched', () => {
  assert.equal(classifyToolState({ hasCommand: false, wingetOwned: false, upgradable: false }), 'missing')
  // Somebody else's toolchain: present but NOT ours to install or upgrade.
  assert.equal(classifyToolState({ hasCommand: true, wingetOwned: false, upgradable: false }), 'external')
  // MEASURED: 7-Zip is winget-owned while `7z` is absent from PATH. Deciding by
  // command presence would offer to install a package that is already there.
  assert.equal(classifyToolState({ hasCommand: false, wingetOwned: true, upgradable: false }), 'current')
  assert.equal(classifyToolState({ hasCommand: true, wingetOwned: true, upgradable: true }), 'managed')
  // Only absent and upgradable rows may be selected.
  assert.equal(isActionable('missing'), true)
  assert.equal(isActionable('managed'), true)
  assert.equal(isActionable('external'), false)
  assert.equal(isActionable('current'), false)
})

test('toolchain: winget export JSON is the inventory, winget source only', () => {
  const json = JSON.stringify({
    Sources: [
      // A Store copy must never masquerade as the community-repo package.
      { SourceDetails: { Name: 'msstore' }, Packages: [{ PackageIdentifier: 'jqlang.jq', Version: '9.9.9' }] },
      { SourceDetails: { Name: 'winget' }, Packages: [
        { PackageIdentifier: 'BurntSushi.ripgrep.GNU', Version: '15.2.0' },
        { PackageIdentifier: 'jqlang.jq', Version: '1.8.2' },
      ] },
    ],
  })
  const found = parseExportJson(json, TOOLCHAIN)
  assert.equal(found.get('rg').pkgId, 'BurntSushi.ripgrep.GNU', 'the sibling build is recognized')
  assert.equal(found.get('rg').version, '15.2.0')
  assert.equal(found.get('jq').version, '1.8.2', 'the winget source wins, not msstore')
  assert.equal(parseExportJson('not json', TOOLCHAIN).size, 0)
  assert.equal(parseExportJson('', TOOLCHAIN).size, 0)
})

test('toolchain: measured exit codes are classified, and the two no-ops never read as failures', () => {
  // MEASURED: upgrading a current package exits 0x8A15002B ("nothing newer").
  const fresh = classifyWingetResult(0x8A15002B, '找不到可用的升级。')
  assert.equal(fresh.ok, false)
  assert.equal(fresh.kind, 'up-to-date')
  // MEASURED: an absent package exits 0x8A150014.
  assert.equal(classifyWingetResult(0x8A150014, '找不到与输入条件匹配的已安装程序包。').kind, 'not-found')
  // Node reports the full HRESULT; a POSIX shell shows only its low byte.
  assert.equal(isNoMatchExit(0x8A150014), true)
  assert.equal(isNoMatchExit(20), true)
  assert.equal(isNoMatchExit(0x8A15002B), false, 'the two must not collide')
  // Success is the ONLY ok:true; an unrecognized non-zero stays failed.
  assert.equal(classifyWingetResult(0, 'ok').ok, true)
  assert.equal(classifyWingetResult(1, 'something odd').kind, 'failed')
})

test('toolchain: only loopback + same-origin may install (the CSRF fence)', () => {
  const call = (o) => fenceToolRequest(o)
  assert.equal(call({ socket: { remoteAddress: '127.0.0.1' }, method: 'GET', headers: {} }).ok, true)
  assert.equal(call({ socket: { remoteAddress: '::1' }, method: 'GET', headers: {} }).ok, true)
  const lan = call({ socket: { remoteAddress: '192.168.1.5' }, method: 'GET', headers: {} })
  assert.equal(lan.ok, false)
  assert.equal(lan.reason, 'not-loopback')
  const sameOrigin = { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' }
  assert.equal(call({ socket: { remoteAddress: '127.0.0.1' }, method: 'POST', headers: sameOrigin }).ok, true)
  const blocked = call({ socket: { remoteAddress: '127.0.0.1' }, method: 'POST', headers: { host: '127.0.0.1:19387', origin: 'https://evil.example' } })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'cross-origin')
  // A mutating request with no origin at all is refused outright.
  assert.equal(call({ socket: { remoteAddress: '127.0.0.1' }, method: 'POST', headers: { host: '127.0.0.1:19387' } }).ok, false)
})

test('tool-runner: a request can only ever name catalog entries', async () => {
  const calls = []
  const io = {
    run: async (file, args) => { calls.push([file].concat(args).join(' ')); return { code: 0, output: 'v1.29.380' } },
    pathDirs: () => [], readdir: () => [], readFile: () => JSON.stringify({ Sources: [] }),
    tmpFile: (name) => join(tmpdir(), name), remove: () => {},
  }
  await runToolJob(io, { action: 'install', ids: ['make', 'NOT-IN-CATALOG', '../../etc/passwd', 'make'] })
  const installs = calls.filter((line) => line.includes(' install '))
  assert.equal(installs.length, 1, 'unknown ids are dropped and duplicates collapse')
  assert.ok(installs[0].includes('ezwinports.make'))
  assert.ok(calls.every((line) => !line.includes('NOT-IN-CATALOG')))
  assert.ok(calls.every((line) => !line.includes('passwd')))
})

test('tool-runner: auto upgrades what winget owns and installs the rest', async () => {
  const calls = []
  const inventory = JSON.stringify({ Sources: [{ SourceDetails: { Name: 'winget' }, Packages: [{ PackageIdentifier: 'jqlang.jq', Version: '1.8.2' }] }] })
  const io = {
    run: async (file, args) => { calls.push([file].concat(args).join(' ')); return { code: 0, output: 'v1.29.380' } },
    pathDirs: () => [], readdir: () => [], readFile: () => inventory,
    tmpFile: (name) => join(tmpdir(), name), remove: () => {},
  }
  const job = await runToolJob(io, { action: 'auto', ids: ['jq', 'make'] })
  assert.equal(job.total, 2)
  assert.equal(job.results.find((r) => r.id === 'jq').action, 'upgrade', 'installed means upgraded')
  assert.equal(job.results.find((r) => r.id === 'make').action, 'install', 'absent means installed')
  assert.ok(calls.some((line) => line.includes('upgrade --id jqlang.jq')))
  assert.ok(calls.some((line) => line.includes('install --id ezwinports.make')))
})

test('toolchain route: wired, fenced, and read by the client half', () => {
  const host = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(host, /\/dsh-gitbash-shell\/api\/tools/)
  assert.match(host, /fenceToolRequest\(req\)/)
  assert.match(host, /if \(!fence\.ok\)/, 'a refused request must not fall through to the work')
  const client = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(client, /dsh-gitbash-shell\/api\/tools/)
  assert.match(client, /"sec\.tools":/)
  assert.match(client, /"tools\.state\.external":/)
})

/* ── native right-sidebar path rescue (v0.31.0) ──────────────────────────────
   The plugin makes every tool speak MSYS drive roots; dsh's own file links then
   carry that spelling into the right Sidebar, whose Host resolves it with
   node:path against the session cwd — '/c/Users/x' becomes
   '<current drive>:\c\Users\x' and the preview says "file not found". The client
   half wraps `ctx.sidebarRight.openResource`, the ONE entry every way into that
   column passes through, and hands it the Host's own spelling. These tests drive
   the real bundle against a fake cordis ctx, so they cover the address grammar,
   the host-driven gate, and the reversible install — not a copy of the logic. */

const PATHMAP_FACTS = {
  platform: 'win32',
  home: 'C:/Users/kanna',
  tmpDir: 'C:/Users/kanna/AppData/Local/Temp',
  gitRoot: 'C:/Program Files/Git',
  mounts: { '/usr': 'usr', '/bin': 'usr/bin', '/etc': 'etc', '/var': 'var', '/home': 'home', '/root': 'root', '/mnt': 'mnt' },
}

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: (effect) => effect(),
  Component: class Component { constructor(props) { this.props = props; this.state = {} } },
}

/** One address segment, encoded exactly the way dsh's own builder encodes it. */
const addressSegment = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ':')

/** Build a session-scoped file address the way dsh's fileAddressFor does. */
const sessionAddress = (sessionId, path) => 'dsh-resource://file/session/' + addressSegment(sessionId) + '/'
  + path.split('/').map(addressSegment).join('/')

/** Read one address back into its path, the way dsh's parseFileAddress does. */
function addressPath(address) {
  const rest = address.slice('dsh-resource://file/'.length).split('/')
  const scope = rest.shift()
  if (scope === 'session') rest.shift()
  return rest.map(decodeURIComponent).join('/')
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Load src/client.js the way the browser does and mount it on a fake cordis ctx
 * whose `sidebarRight` records the address it is handed. `facts` is what
 * /api/pathmap answers with; `null` keeps the fetch pending forever, which is
 * the "host has not answered yet" state.
 */
function mountClientHalf(facts) {
  const text = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  let bundle = null
  const fetchStub = () => facts === null
    ? new Promise(() => {})
    : Promise.resolve({ ok: true, json: () => Promise.resolve(facts) })
  new Function('window', 'navigator', 'fetch', text)(
    { __ModuleLoader__: { load: (value) => { bundle = value } } },
    { language: 'zh-CN' },
    fetchStub,
  )
  const client = bundle.factory((specifier) => (specifier === 'react' ? reactStub : {}))

  const controller = {
    calls: [],
    openResource(address, options) { controller.calls.push({ method: 'openResource', address, options }); return 'opened' },
    openResourceIn(sessionId, address, options) {
      controller.calls.push({ method: 'openResourceIn', sessionId, address, options })
      return 'opened'
    },
  }
  const disposers = []
  const locale = {
    register: () => () => {},
    getSnapshot: () => ({ active: 'en' }),
    subscribe: () => () => {},
  }
  const scope = { getSnapshot: () => ({ status: 'ready', value: { posixPaths: true } }), set: async () => {} }
  const ctx = {
    get: (name) => (name === 'locale' ? locale : undefined),
    settingsScope: { bind: () => scope },
    inject: (names, callback) => {
      if (names.includes('settingsScope')) callback({ settingsScope: ctx.settingsScope })
      if (names.includes('sidebarRight')) {
        callback({
          sidebarRight: controller,
          // cordis calls the body at once and keeps its RETURN value as the
          // disposer — same contract here, so an uninstall is observable.
          effect: (body) => { disposers.push(body()); return () => {} },
        })
      }
    },
    slots: { inject: (hole, callback) => { callback() }, register: () => () => {} },
    locale,
    effect: (body) => body(),
  }
  const original = { openResource: controller.openResource, openResourceIn: controller.openResourceIn }
  client.apply(ctx)
  return { controller, original, disposers, client }
}

test('path rescue: the Host spelling is restored on every file address', async () => {
  const { controller, original } = mountClientHalf(PATHMAP_FACTS)
  await tick()
  assert.notEqual(controller.openResource, original.openResource, 'the navigation entry must be wrapped once the host answers')

  const open = (address) => {
    controller.calls.length = 0
    controller.openResource(address)
    return controller.calls[0].address
  }
  const unchanged = (address) => assert.equal(open(address), address, 'must pass through untouched: ' + address)

  // The reported bug: an absolute MSYS path outside the session workspace keeps
  // its absolute spelling in the address, so only the drive root can be wrong.
  assert.equal(
    open(sessionAddress('s-1', '/c/Users/kanna/sandbox/dsh-remote-app/AGENTS.md')),
    sessionAddress('s-1', 'C:/Users/kanna/sandbox/dsh-remote-app/AGENTS.md'),
    'a drive root becomes the Windows spelling the Host understands',
  )
  // The same mounts the host's own tool-argument translation resolves.
  assert.equal(open(sessionAddress('s-1', '/tmp/note.txt')), sessionAddress('s-1', PATHMAP_FACTS.tmpDir + '/note.txt'))
  assert.equal(open(sessionAddress('s-1', '/usr/bin/bash')), sessionAddress('s-1', PATHMAP_FACTS.gitRoot + '/usr/bin/bash'))
  assert.equal(open(sessionAddress('s-1', '/etc/hosts')), sessionAddress('s-1', PATHMAP_FACTS.gitRoot + '/etc/hosts'))
  assert.equal(open(sessionAddress('s-1', '~/notes.md')), sessionAddress('s-1', PATHMAP_FACTS.home + '/notes.md'))
  assert.equal(open(sessionAddress('s-1', '/c')), sessionAddress('s-1', 'C:/'))
  // A whole-value path only: a mid-word '/tmpfoo' or '/usrx' is not a mount.
  unchanged(sessionAddress('s-1', '/tmpfoo/x'))
  unchanged(sessionAddress('s-1', '/usrx'))
  unchanged(sessionAddress('s-1', '/Tmp/x'))
  unchanged(sessionAddress('s-1', '/ab/c'))
  // Already in the Host's spelling — the dialect may be off, or the link may
  // have been written by Windows in the first place.
  unchanged(sessionAddress('s-1', 'C:/Users/kanna/x.md'))
  // A workspace-relative link is resolved by the Host against the session cwd
  // and needs no rewrite at all.
  unchanged(sessionAddress('s-1', 'AGENTS.md'))
  unchanged(sessionAddress('s-1', ''))
  // Absolute-scope addresses (present / deliverables) carry the same grammar.
  assert.equal(open('dsh-resource://file/absolute/c/Users/kanna/x.md'), 'dsh-resource://file/absolute/C:/Users/kanna/x.md')
  unchanged('dsh-resource://file/absolute//server/share/x.md')
  // Not a file address, not decodable, or not a file at all: the ORIGINAL string
  // is forwarded, so nothing we did not translate can be altered.
  unchanged('dsh-resource://browser/https%3A%2F%2Fexample.com')
  unchanged('session/s-1//c/x')
  unchanged('dsh-resource://file/session/s-1/%ZZ')
  unchanged('dsh-resource://file/other/s-1/c/x')
  // A navigation suffix survives the rebuild.
  assert.equal(
    open(sessionAddress('s-1', '/c/Users/kanna/x.md') + '?line=12'),
    sessionAddress('s-1', 'C:/Users/kanna/x.md') + '?line=12',
  )
  // The per-session twin goes through the same rewrite.
  controller.calls.length = 0
  controller.openResourceIn('s-9', sessionAddress('s-1', '/c/x.md'))
  assert.equal(controller.calls[0].address, sessionAddress('s-1', 'C:/x.md'))
  assert.equal(controller.calls[0].sessionId, 's-9')
})

test('path rescue: nothing is rewritten until the HOST reports win32', async () => {
  // A macOS/Linux Host must never see its paths translated — the client's own
  // user agent says nothing about whose filesystem the path belongs to. The
  // wrapper may be in place; the GATE is the host's own platform fact, so on a
  // foreign host it forwards the original string byte for byte.
  const foreign = mountClientHalf({ ...PATHMAP_FACTS, platform: 'linux' })
  await tick()
  const linuxAddress = sessionAddress('s-1', '/c/Users/kanna/x.md')
  foreign.controller.openResource(linuxAddress)
  assert.equal(foreign.controller.calls[0].address, linuxAddress,
    'a non-Windows host must never have its paths translated')

  // The host has not answered yet (or never will): the dialect rewrite stays off
  // rather than guessing, so a failed fetch degrades to the unpatched behaviour.
  const pending = mountClientHalf(null)
  await tick()
  const address = sessionAddress('s-1', '/c/Users/kanna/x.md')
  pending.controller.openResource(address)
  assert.equal(pending.controller.calls[0].address, address,
    'an unanswered path map must leave the dialect alone')
})

test('path rescue: installed on the instance, removed with the fiber, never hard-injected', async () => {
  const client = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  // A HARD inject of a service this plugin does not own would leave the fiber
  // PENDING forever on a host without it (the settingsScope lesson, v0.24.0),
  // taking the pluggable card down with it — so sidebarRight is acquired
  // optionally, exactly like the settings face.
  assert.match(client, /exports\.inject = \["locale", "slots"\]/)
  assert.doesNotMatch(client, /exports\.inject = \[[^\]]*sidebarRight/)
  assert.match(client, /ctx\.inject\(\["sidebarRight"\]/)
  assert.match(client, /controller\.openResource = function/)
  assert.match(client, /sctx\.effect\(function \(\) \{ return restore; \}/)

  const { controller, original, disposers } = mountClientHalf(PATHMAP_FACTS)
  await tick()
  assert.equal(disposers.length, 1, 'the wrapper must register exactly one disposer')
  assert.notEqual(controller.openResource, original.openResource)
  disposers[0]()
  assert.equal(controller.openResource, original.openResource, 'the disposer restores the original method')
  assert.equal(controller.openResourceIn, original.openResourceIn)
  assert.equal(controller.gbPathRescue, undefined, 'the marker must be gone so a remount can wrap again')
})

test('path rescue: the browser mirror tracks the host translator case for case', async () => {
  const { controller } = mountClientHalf(PATHMAP_FACTS)
  await tick()
  const hostEnv = { home: PATHMAP_FACTS.home, tmpDir: PATHMAP_FACTS.tmpDir, gitRoot: PATHMAP_FACTS.gitRoot }
  const cases = [
    '/c/Users/x', '/c', '/tmp/x', '/tmp', '/usr/bin/x', '/bin/x', '/etc/x', '/var/x',
    '/home/x', '/root/x', '/mnt/x', '~/x', '~', '/dev/null', 'C:/x', 'relative/x',
    '/tmpfoo/x', '/Tmp/x', '/usrx', '/ab/c', '//server/share/x', '/c/',
  ]
  for (const value of cases) {
    const expected = _internal.translateMsysPath(value, hostEnv)
    const address = sessionAddress('s-1', value)
    controller.calls.length = 0
    controller.openResource(address)
    const seen = controller.calls[0].address
    // The wrapper forwards the ORIGINAL string when nothing changed, so an
    // unchanged case is compared against the input itself.
    const actual = seen === address ? value : addressPath(seen)
    assert.equal(actual, expected, 'client mirror must match translateMsysPath for ' + value)
  }
})

test('path rescue (measured): the rewritten path is the file the user actually clicked', { skip: process.platform !== 'win32' }, async () => {
  // The bug as the Host experiences it, on a real file: dsh resolves the link
  // with node:path against the session cwd, and an MSYS drive root is not
  // absolute to node — it lands on the CURRENT drive as '<drive>:\c\...'.
  const real = fileURLToPath(new URL('../package.json', import.meta.url))
  const msys = '/' + real.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => drive.toLowerCase())
  assert.ok(existsSync(real), 'fixture: this repository is on disk')
  assert.equal(existsSync(resolvePath(process.cwd(), msys)), false,
    'the MSYS spelling resolves to a path that does not exist — this is the reported "file not found"')

  const { controller } = mountClientHalf(PATHMAP_FACTS)
  await tick()
  controller.openResource(sessionAddress('s-1', msys))
  const opened = addressPath(controller.calls[0].address)
  assert.equal(opened, real.replace(/\\/g, '/'), 'the Sidebar is handed the Windows spelling instead')
  assert.ok(existsSync(opened), 'and that spelling IS the file, so the preview can read it')
})

test('path map route: registered, loopback-fenced, and reporting the host facts', async () => {
  // The browser half is only allowed to rewrite while the HOST says win32, so
  // the fact has to actually reach it. Drive the real apply() and serve the
  // route the way the web server would.
  const { apply } = await import('../src/index.js')
  const routes = []
  const ctx = {
    effect: () => {},
    provide: () => () => {},
    inject: (names, callback) => {
      if (names.includes('webServer')) {
        callback({
          webServer: { register: (registration) => { routes.push(registration); return () => {} } },
          effect: () => {},
        })
      }
    },
    on: () => {},
    get: (name) => (name === 'settings'
      ? { get: () => ({ terminalShell: '' }), update: async () => {} }
      : undefined),
    agentPresets: { roots: [] },
  }
  await assert.doesNotReject(() => apply(ctx, {}), 'apply() must not throw on mount')

  const route = routes.find((entry) => entry.path === '/dsh-gitbash-shell/api/pathmap')
  assert.ok(route, 'the browser half reads its facts from this route')
  assert.equal(route.kind, 'prefix')

  const serve = (remoteAddress) => {
    const captured = { code: 0, body: '' }
    const res = {
      writeHead: (code) => { captured.code = code },
      end: (text) => { captured.body = text },
    }
    route.handler({ method: 'GET', url: route.path, socket: { remoteAddress }, headers: { host: '127.0.0.1:3080' } }, res)
    return captured
  }

  const allowed = serve('127.0.0.1')
  assert.equal(allowed.code, 200)
  const facts = JSON.parse(allowed.body)
  assert.equal(facts.platform, process.platform, 'the client gate reads THIS value')
  assert.deepEqual(Object.keys(facts.mounts), ['/usr', '/bin', '/etc', '/var', '/home', '/root', '/mnt'],
    'the client mirror walks these mounts in exactly this order')
  for (const key of ['home', 'tmpDir', 'gitRoot']) {
    assert.ok(facts[key] === null || typeof facts[key] === 'string', key + ' must be a path or null')
  }

  // The web server may be bound to 0.0.0.0, and this route reports the account's
  // own directories — so it is fenced like the toolchain route.
  const refused = serve('192.168.1.20')
  assert.equal(refused.code, 403)
  assert.equal(JSON.parse(refused.body).reason, 'not-loopback')
})
