import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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
  assert.match(text, /liveSettings\.posix\(\)/, 'wrapper must read the gate per dispatch')
  assert.match(text, /liveSettings\.dialect\(\)/, 'directive closure must read the live dialect')
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
  assert.match(text, /resolve\(\) \{\s*return liveSettings\.posix\(\) \? \{ \[PATH_DIALECT_KEY\]: PATH_DIALECT_VALUE \} : \{\}/)
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
  const scope = new Function('SandboxBashExecutor', 'z', 'process',
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
  const liveFields = scope(FakeBase, withVolatile.z, process).gitBashShellConfig(withVolatile.z)
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
  const plainFields = scope(FakeBase, withoutVolatile.z, process).gitBashShellConfig(withoutVolatile.z)
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
  const scope = new Function('SandboxBashExecutor', 'z', 'process', stripped + '\nreturn { GitBashSandboxExecutor }')
  class FakeBase {
    constructor() { this.calls = [] }
    async run(spec) { this.calls.push(['super.run', spec]); return { via: 'super.run' } }
    start(spec) { this.calls.push(['super.start', spec]); return { via: 'super.start' } }
    async runArgv(spec, argv) { this.calls.push(['runArgv', argv]); return { exitCode: 0, stdout: {}, stderr: {} } }
    startArgv(spec, argv) { this.calls.push(['startArgv', argv]); return { started: true } }
  }
  const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain })
  const make = (platform) => {
    const mod = scope(FakeBase, chain, { platform })
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
  const scope = new Function('SandboxBashExecutor', 'z', 'process', stripped + '\nreturn { GitBashSandboxExecutor }')
  const RESULT = { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000, stdout: { text: 'hi', truncated: false }, stderr: { text: '', truncated: false } }
  const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain })
  const build = (Base, platform) => {
    const mod = scope(Base, chain, { platform })
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
  const scope = new Function('SandboxBashExecutor', 'z', 'process', stripped + '\nreturn { GitBashSandboxExecutor }')
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
    const mod = scope(Base, chain, { platform })
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
  const scope = new Function('SandboxBashExecutor', 'z', 'process', stripped + '\nreturn { GitBashSandboxExecutor }')
  const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain })
  const build = (settings) => {
    const ex = Object.create(scope(chain, chain, { platform: 'win32' }).GitBashSandboxExecutor.prototype)
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
    /adoptSidebarShell\(ctx, gitBashCapability\.bashPath, \(\) => liveSettings\.adoptSidebar\(\)\)/,
    'apply() must hand its era-aware gate getter to the helper',
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
