// Pure unit tests for the explicit path converter (src/path-tool.js) composed
// with the REAL shared helper (src/index.js translateMsysPath). No host Core,
// no registry, no filesystem, no subprocess: the translator here is the
// genuine shared helper, only its mount-fact bag is a controlled literal.
// The real installed-Core engine coverage (ToolRuntime/NodePtcRuntime/
// LocalSubprocessRuntime) lives in path-preview.mjs (run with host-loader).
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PATH_TOOL_NAME,
  convertMsysToNative,
  buildPathToolDefinition,
  createPathToolModule,
  isWindowsNativeValue,
  looksPosixValue,
  pathToolDescription,
} from '../src/path-tool.js'
import { translateMsysPath, buildTranslateEnv } from '../src/index.js'

/** A fully-provisioned controlled mount-fact bag (the shape buildTranslateEnv returns). */
const FULL_ENV = {
  home: 'C:/Users/someone',
  tmpDir: 'C:/Users/someone/AppData/Local/Temp',
  gitRoot: 'C:/Program Files/Git',
}

/** The shared helper composed with a fixed env — the wiring's shape, one fact source. */
const withFullEnv = (value) => translateMsysPath(value, FULL_ENV)

test('path-tool: composition uses the shared helper, not a copied table', () => {
  // Drive roots (no env needed by the shared helper — facts come from IT).
  assert.equal(convertMsysToNative('/c/Users/x', { translate: withFullEnv }).native_path, 'C:/Users/x')
  assert.equal(convertMsysToNative('/c', { translate: withFullEnv }).native_path, 'C:/')
  assert.equal(convertMsysToNative('/D/dir', { translate: withFullEnv }).native_path, 'D:/dir')
  // Virtual mounts resolve through the shared helper's own table.
  assert.equal(
    convertMsysToNative('/tmp/a b/#c.txt', { translate: withFullEnv }).native_path,
    FULL_ENV.tmpDir + '/a b/#c.txt',
  )
  assert.equal(convertMsysToNative('/dev/null', { translate: withFullEnv }).native_path, '\\\\.\\NUL')
  assert.equal(
    convertMsysToNative('/usr/bin/bash.exe', { translate: withFullEnv }).native_path,
    FULL_ENV.gitRoot + '/usr/bin/bash.exe',
  )
  assert.equal(
    convertMsysToNative('/bin/sh', { translate: withFullEnv }).native_path,
    FULL_ENV.gitRoot + '/usr/bin/sh',
  )
  // /home is the GIT mount (git-root/home), NOT the user profile — same fact as bash.
  assert.equal(
    convertMsysToNative('/home/u', { translate: withFullEnv }).native_path,
    FULL_ENV.gitRoot + '/home/u',
  )
  // Home shorthand and variables ride the shared helper's expanders.
  assert.equal(convertMsysToNative('~', { translate: withFullEnv }).native_path, FULL_ENV.home)
  assert.equal(convertMsysToNative('~/notes', { translate: withFullEnv }).native_path, FULL_ENV.home + '/notes')
  assert.equal(convertMsysToNative('$HOME/notes', { translate: withFullEnv }).native_path, FULL_ENV.home + '/notes')
  assert.equal(convertMsysToNative('$TMP/out', { translate: withFullEnv }).native_path, FULL_ENV.tmpDir + '/out')
  assert.equal(convertMsysToNative('${TEMP}/out', { translate: withFullEnv }).native_path, FULL_ENV.tmpDir + '/out')
  // Unicode, '#' and spaces pass through byte for byte.
  assert.equal(
    convertMsysToNative('/c/我的#目录/文件 1.txt', { translate: withFullEnv }).native_path,
    'C:/我的#目录/文件 1.txt',
  )
})

test('path-tool: both dep shapes (composed translate / raw helper + env) agree', () => {
  const composed = convertMsysToNative('/tmp/x', { translate: withFullEnv })
  const raw = convertMsysToNative('/tmp/x', { translate: translateMsysPath, env: FULL_ENV })
  assert.deepEqual(composed, raw)
  assert.equal(composed.status, 'converted')
})

test('path-tool: rejections are explicit — empty, NUL byte, URL, non-string', () => {
  const run = (value) => convertMsysToNative(value, { translate: withFullEnv })
  for (const value of ['', '   ', '\t']) {
    const outcome = run(value)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'EMPTY')
    assert.match(outcome.message, /msys_path must be a non-empty string/)
  }
  const nul = run('a\0b')
  assert.equal(nul.ok, false)
  assert.equal(nul.code, 'NUL_BYTE')
  const url = run('https://example.com/x')
  assert.equal(url.ok, false)
  assert.equal(url.code, 'URL')
  assert.match(url.message, /scheme 'https'/)
  assert.equal(run('file:///c/x').code, 'URL')
  assert.equal(run('ftp://host/p').code, 'URL')
  for (const value of [42, null, undefined, {}, []]) {
    assert.equal(run(value).code, 'EMPTY')
  }
  // A single-letter drive is NOT a URL scheme: C:/ and C: (drive-relative) stay accepted.
  assert.equal(run('C:/x').ok, true)
  assert.equal(run('C:x').ok, true)
})

test('path-tool: missing mount facts are rejected, never returned as native', () => {
  // Mounts off entirely (env null): /tmp and ~ cannot resolve — loud refusal.
  const off = (value) => convertMsysToNative(value, { translate: (v) => translateMsysPath(v, null), env: null })
  const tmpOff = off('/tmp/owned/x')
  assert.equal(tmpOff.ok, false)
  assert.equal(tmpOff.code, 'NO_MOUNT_MAPPING')
  assert.match(tmpOff.message, /mount facts unavailable/)
  assert.equal(off('~').code, 'NO_MOUNT_MAPPING')
  assert.equal(off('/usr/lib').code, 'NO_MOUNT_MAPPING')
  // Drive roots and /dev/null need NO env fact — still convert with mounts off.
  assert.equal(off('/c/x').native_path, 'C:/x')
  assert.equal(off('/dev/null').native_path, '\\\\.\\NUL')

  // Facts present but the needed one missing (no gitRoot): /usr must refuse.
  const noGit = (value) => convertMsysToNative(value, {
    translate: (v) => translateMsysPath(v, { home: FULL_ENV.home, tmpDir: FULL_ENV.tmpDir }),
    env: { home: FULL_ENV.home, tmpDir: FULL_ENV.tmpDir },
  })
  const usr = noGit('/usr/lib')
  assert.equal(usr.ok, false)
  assert.equal(usr.code, 'NO_MOUNT_MAPPING')
  assert.match(usr.message, /gitRoot=no/)

  // A POSIX root that NO mount maps, even with every fact present.
  const unmapped = convertMsysToNative('/opt/does-not-exist', { translate: withFullEnv, env: FULL_ENV })
  assert.equal(unmapped.ok, false)
  assert.equal(unmapped.code, 'NO_MOUNT_MAPPING')
  assert.match(unmapped.message, /no MSYS mount mapping for "\/opt\/does-not-exist"/)
  assert.match(unmapped.message, /home=yes tmpDir=yes gitRoot=yes/)
  assert.match(unmapped.message, /Refusing to return the POSIX spelling as a native path/)
  // Named home forms (~other) carry no fact: refuse, mirroring the shared helper.
  assert.equal(convertMsysToNative('~other/x', { translate: withFullEnv, env: FULL_ENV }).code, 'NO_MOUNT_MAPPING')

  // No translator wired at all: refuse rather than guess.
  assert.equal(convertMsysToNative('/c/x', {}).code, 'NO_TRANSLATOR')
})

test('path-tool: already-native and cwd-relative values pass through, declared', () => {
  const run = (value) => convertMsysToNative(value, { translate: withFullEnv, env: FULL_ENV })
  const windows = ['C:/Users/x', 'C:\\Users\\x', '\\\\srv\\share', '//srv/share']
  for (const value of windows) {
    const outcome = run(value)
    assert.deepEqual({ ok: outcome.ok, native: outcome.native_path, status: outcome.status, kind: outcome.kind },
      { ok: true, native: value, status: 'passthrough', kind: 'windows-native' })
  }
  for (const value of ['docs/file.txt', './x', '..\\y', 'file.txt', 'C:', 'C:tmp']) {
    const outcome = run(value)
    assert.equal(outcome.ok, true)
    assert.equal(outcome.native_path, value)
    assert.equal(outcome.status, 'passthrough')
    assert.equal(outcome.kind, 'cwd-relative')
  }
  // The passthrough decision never consults the mount facts.
  assert.equal(convertMsysToNative('docs/x', { translate: withFullEnv }).native_path, 'docs/x')
})

test('path-tool: classification helpers', () => {
  assert.equal(isWindowsNativeValue('C:/x'), true)
  assert.equal(isWindowsNativeValue('C:\\x'), true)
  assert.equal(isWindowsNativeValue('\\\\srv\\share'), true)
  assert.equal(isWindowsNativeValue('//srv/share'), true)
  assert.equal(isWindowsNativeValue('C:'), false)
  assert.equal(isWindowsNativeValue('relative'), false)
  assert.equal(looksPosixValue('/c/x'), true)
  assert.equal(looksPosixValue('/tmp'), true)
  assert.equal(looksPosixValue('~'), true)
  assert.equal(looksPosixValue('$HOME/x'), true)
  assert.equal(looksPosixValue('C:/x'), false)
  assert.equal(looksPosixValue('relative'), false)
})

test('path-tool: plain definition — schema data, execute, fresh buildEnv per call', () => {
  let buildCalls = 0
  const definition = buildPathToolDefinition({
    translateMsysPath,
    buildEnv: () => { buildCalls++; return FULL_ENV },
  })
  assert.equal(definition.name, PATH_TOOL_NAME)
  // Plain JSON-schema shape: property required via the array, object closed.
  assert.deepEqual(definition.parameters, {
    type: 'object',
    properties: { msys_path: { type: 'string', description: definition.parameters.properties.msys_path.description } },
    required: ['msys_path'],
    additionalProperties: false,
  })
  assert.equal(definition.parameters.properties.msys_path.description.length > 20, true)
  assert.deepEqual(definition.output.schema, {
    type: 'object',
    properties: { native_path: { type: 'string' } },
    required: ['native_path'],
    additionalProperties: false,
  })
  // Execute converts and consumes FRESH facts per call (never a copied table).
  assert.deepEqual(definition.execute({ msys_path: '/c/我的#目录' }), { native_path: 'C:/我的#目录' })
  assert.equal(buildCalls, 1)
  assert.deepEqual(definition.execute({ msys_path: '/tmp/a b' }), { native_path: FULL_ENV.tmpDir + '/a b' })
  assert.equal(buildCalls, 2)
  // Rejections throw with the explicit code in the message.
  assert.throws(() => definition.execute({ msys_path: '' }), /msys_path must be a non-empty string/)
  assert.throws(() => definition.execute({ msys_path: 'https://x/y' }), /looks like a URL/)
  assert.throws(() => definition.execute({ msys_path: '/opt/nope' }), /no MSYS mount mapping/)
  assert.throws(() => definition.execute({}), /msys_path must be a non-empty string/)
  // Render: the native value goes out verbatim, nothing re-decoded.
  assert.deepEqual(
    definition.output.render({ msys_path: '/c/x' }, { native_path: 'D:/我的#目录 1.txt' }),
    [{ type: 'text', text: JSON.stringify({ native_path: 'D:/我的#目录 1.txt' }) }],
  )
})

test('path-tool: typed author-schema data (captured defineTool)', () => {
  let captured
  const definition = buildPathToolDefinition({
    toolsModule: { defineTool: (options) => { captured = options; return { name: options.name } } },
    translateMsysPath,
    buildEnv: () => FULL_ENV,
  })
  assert.equal(definition.name, PATH_TOOL_NAME)
  // Author dialect: parameters is a property map, required:true ON the property.
  assert.deepEqual(captured.parameters, {
    msys_path: { type: 'string', required: true, description: captured.parameters.msys_path.description },
  })
  // Output object: explicit additionalProperties, every property required.
  assert.deepEqual(captured.output.schema, {
    type: 'object',
    properties: { native_path: { type: 'string', required: true } },
    additionalProperties: false,
  })
  assert.equal(typeof captured.output.render, 'function')
  assert.equal(captured.isConcurrencySafe, true)
  assert.equal(captured.description, pathToolDescription())
  assert.match(captured.description, /Call this ONLY when the full value is already known to be a single filesystem path/)
  assert.match(captured.description, /REJECTED with an explicit error/)
  assert.match(captured.description, /no filesystem I\/O/)
})

test('path-tool: the module owns its registration and reverts it on disposal', () => {
  const registered = []
  const effects = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => { registered.pop() }
      },
    },
    effect(callback) { effects.push(callback()) },
  }
  const logs = []
  const module = createPathToolModule({
    translateMsysPath,
    buildEnv: () => FULL_ENV,
    log: (message) => logs.push(message),
  })
  assert.deepEqual(module.inject, ['tools'])
  module.apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, PATH_TOOL_NAME)
  // Two log lines are correct without the host module: the plain-definition
  // fallback note at build time, plus the registration line in apply.
  assert.equal(logs.length, 2)
  assert.match(logs[0], /dsh-tools not resolvable; building a plain JSON-schema definition/)
  assert.match(logs[1], /gitbash_to_native_path registered/)
  // Scope disposal (the effects cordis runs) removes the tool, no residue.
  for (const dispose of effects) dispose()
  assert.equal(registered.length, 0)
})

test('path-tool: factory fails loud without a translator and on a broken registry', () => {
  assert.throws(() => createPathToolModule({}), /a shared translator is required/)
  assert.throws(() => createPathToolModule({ buildEnv: () => FULL_ENV }), /a shared translator is required/)
  const module = createPathToolModule({ translateMsysPath, buildEnv: () => FULL_ENV })
  assert.throws(() => module.apply({}), /ctx\.tools\.register is unavailable/)
})

test('path-tool: the real shared buildTranslateEnv feeds the same helper (composition fact)', () => {
  // One real read on this machine: the factory's buildEnv dep is exactly this
  // composition in production. Facts must be the plain string bag the helper
  // consumes (tmpDir may legitimately be absent in a stripped environment).
  const env = buildTranslateEnv('')
  assert.equal(typeof env, 'object')
  for (const key of ['home', 'tmpDir', 'gitRoot']) {
    assert.ok(env[key] === undefined || (typeof env[key] === 'string' && env[key].includes('\\') === false),
      `${key} must be absent or a forward-slash string, got ${JSON.stringify(env[key])}`)
  }
  // Whatever the machine, the drive-root face needs no facts at all.
  assert.equal(translateMsysPath('/c/x', env), 'C:/x')
  assert.equal(convertMsysToNative('/c/x', { translate: (v) => translateMsysPath(v, env), env }).native_path, 'C:/x')
})
