import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { _internal as x } from '../src/index.js'
import { inlineNeeds } from '../src/inline-tools.js'

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const tick = () => new Promise((resolve) => setImmediate(resolve))
const flush = async () => { for (let i = 0; i < 4; i++) await tick() }
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const migration = source.slice(source.indexOf('async function migrateVariantDefault('), source.indexOf('\nasync function registerVariant('))
const declarative = source.slice(source.indexOf('async function runDeclarativeEra('), source.indexOf('\nexport async function apply('))

function runtime(register) {
  return new Function('cleanupLegacyTrees', 'resolveSkillsDir', 'probeHostExtras', 'effectivePresetIds', 'registerVariant', 'TAG', 'PEER_CAPABILITY', 'peerFact', 'PEER_PYTHON_FIELD', 'peerBackend', 'pythonBackendActive', 'PEER_PYTHON_BACKEND_FIELD', 'PRESET_IDS', 'VARIANT_DEFAULT_SUCCESSORS', migration + declarative + '\nreturn runDeclarativeEra')(
    () => {}, async () => undefined, async () => ({}), x.effectivePresetIds, register,
    '[host-regression]', x.PEER_CAPABILITY, x.peerFact, x.PEER_PYTHON_FIELD, x.peerBackend,
    x.pythonBackendActive, x.PEER_PYTHON_BACKEND_FIELD, x.PRESET_IDS, x.VARIANT_DEFAULT_SUCCESSORS,
  )
}

async function fixture(t, { enabled = false, defaultId = 'standard', registerGate, retireGate, migrate = true, failRetireOnce = false } = {}) {
  const effects = [], listeners = new Map(), injects = new Map(), definitions = new Set(), timeline = []
  let variants = enabled, selected = defaultId, retirementFailures = failRetireOnce ? 1 : 0
  const settings = {
    async update(namespace, patch) {
      assert.equal(namespace, 'agent-preset-registry')
      timeline.push('default:' + patch.selectedDefault)
      if (migrate) selected = patch.selectedDefault
    },
  }
  const ctx = {
    agentPresets: { get defaultId() { return selected }, async list() { return [{ id: 'standard' }, { id: 'ptc' }, { id: 'cordis' }, { id: 'minimal' }] } },
    get(name) { return name === 'settings' ? settings : undefined },
    effect(fn) { const off = fn(); effects.push(off); return off },
    on(name, fn) { listeners.set(name, fn) },
    inject(keys, fn) { injects.set(keys[0], fn) },
  }
  const register = async (_ctx, id, options) => {
    assert.equal(definitions.has(id), false, 'retirement must precede a duplicate registration')
    definitions.add(id); timeline.push('register:' + id + ':' + options.pythonActive)
    if (registerGate) await registerGate.promise
    return async () => {
      if (retirementFailures-- > 0) throw new Error('fixture retirement failure')
      definitions.delete(id); timeline.push('off:' + id)
      if (retireGate) await retireGate.promise
      timeline.push('retired:' + id)
    }
  }
  let disposePromise
  const dispose = () => disposePromise ??= (async () => { for (const off of [...effects].reverse()) await off() })()
  t.after(dispose)
  await runtime(register)(ctx, ['standard-gitbash'], () => false, () => ({ ok: false }), () => variants)
  return {
    ctx, definitions, timeline, dispose, injects,
    get defaultId() { return selected },
    update(value) { variants = value; listeners.get('loader/volatile-update')([['variantPresets']]) },
  }
}

test('host: all full Win32 variants use the inline private-executor face; minimal stays persistent', () => {
  const compositions = readFileSync(new URL('../src/compositions.js', import.meta.url), 'utf8').replace(/^export /gm, '')
  const { pluginsFor, minimalPluginsFor } = new Function('process', compositions + '\nreturn { pluginsFor, minimalPluginsFor }')({ platform: 'win32' })
  for (const kind of ['standard', 'ptc', 'cordis']) {
    const rows = pluginsFor({ kind, gitBash: true })
    assert.equal(rows.find((row) => row.id === 'tool-bash').disabled, true)
    assert.notEqual(rows.find((row) => row.id === 'tool-pwsh').disabled, true)
    assert.equal(inlineNeeds(['pwsh']).needsBash, true)
  }
  const persistent = minimalPluginsFor().find((row) => row.id === 'persistent-shell').config
  assert.notEqual(persistent.find((row) => row.id === 'persistent-bash').disabled, true)
  assert.equal(persistent.find((row) => row.id === 'persistent-pwsh').disabled, true)
})

test('host: dispose drains pending registration and awaits its late unregister', async (t) => {
  const registering = deferred(), retiring = deferred()
  const f = await fixture(t, { registerGate: registering, retireGate: retiring })
  f.update(true); await flush()
  assert.deepEqual([...f.definitions], ['standard-gitbash'])
  let disposed = false
  const done = f.dispose().then(() => { disposed = true })
  await flush(); assert.equal(disposed, false)
  registering.resolve(); await flush()
  assert.equal(f.definitions.size, 0)
  assert.equal(disposed, false, 'unregister is also asynchronous')
  retiring.resolve(); await done
  f.update(true); await flush()
  assert.equal(f.definitions.size, 0, 'closed reconciler cannot register again')
})

test('host: dynamic OFF migrates deployment default before retiring the variant', async (t) => {
  const f = await fixture(t, { enabled: true, defaultId: 'standard-gitbash' })
  f.update(false); await flush()
  assert.equal(f.defaultId, 'standard')
  assert.equal(f.definitions.size, 0)
  assert.ok(f.timeline.indexOf('default:standard') < f.timeline.indexOf('off:standard-gitbash'))
  assert.equal(f.timeline.filter((row) => row.startsWith('default:')).length, 1)
})

test('host: unverifiable default migration does not retire its live variant', async (t) => {
  const f = await fixture(t, { enabled: true, defaultId: 'standard-gitbash', migrate: false })
  f.update(false); await flush()
  assert.equal(f.defaultId, 'standard-gitbash')
  assert.equal(f.definitions.has('standard-gitbash'), true)
})

test('host: backend rebuild awaits retirement before registering the same id', async (t) => {
  const gate = deferred(), f = await fixture(t, { enabled: true, retireGate: gate })
  f.injects.get(x.PEER_CAPABILITY)({ [x.PEER_CAPABILITY]: { pythonRuntime: true, pythonBackend: 'python' }, effect(fn) { return fn() } })
  await flush()
  assert.equal(f.timeline.filter((entry) => entry.startsWith('register:')).length, 1)
  gate.resolve(); await flush()
  assert.equal(f.timeline.filter((entry) => entry.startsWith('register:')).length, 2)
  assert.ok(f.timeline.indexOf('retired:standard-gitbash') < f.timeline.indexOf('register:standard-gitbash:true'))
})

test('host: a failed retirement prevents replacement and remains retryable', async (t) => {
  const f = await fixture(t, { enabled: true, failRetireOnce: true })
  f.injects.get(x.PEER_CAPABILITY)({ [x.PEER_CAPABILITY]: { pythonRuntime: true, pythonBackend: 'python' }, effect(fn) { return fn() } })
  await flush()
  assert.equal(f.timeline.filter((row) => row.startsWith('register:')).length, 1)
  assert.equal(f.definitions.has('standard-gitbash'), true)
  f.update(true); await flush()
  assert.equal(f.timeline.filter((row) => row.startsWith('register:')).length, 2)
})

test('host: disposal attempts every unregister even when one fails', async () => {
  const effects = [], retired = []
  const ctx = { effect(fn) { effects.push(fn()) }, inject() {}, on() {} }
  const register = async (_ctx, id) => async () => {
    retired.push(id)
    if (id === 'standard-gitbash') throw new Error('fixture retirement failure')
  }
  await runtime(register)(ctx, ['standard-gitbash', 'cordis-gitbash'], () => false, () => ({ ok: false }), () => true)
  await assert.rejects(effects[0](), /Git Bash preset cleanup failed/)
  assert.deepEqual(retired, ['standard-gitbash', 'cordis-gitbash'])
})

test('host: the sidebar settings namespace is the row id, not the npm package name (issue #25 Bug 3)', () => {
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(source, /const SIDEBAR_NS = 'better-sidebar'/,
    'dsh-better-sidebar/cordis.patch.yml declares `- id: better-sidebar`; describe()/update() must use that id')
  assert.doesNotMatch(source, /const SIDEBAR_NS = 'dsh-better-sidebar'/)
})

test('host: keyword-led regexes remain data, and ambiguous slash aborts the whole rewrite', () => {
  const re = "/['/c/x']/"
  for (const keyword of ['return', 'throw', 'yield', 'await', 'case', 'delete', 'void', 'typeof']) {
    const code = `const p = '/c/a'; ${keyword} ${re}`
    assert.equal(x.rewriteCodePaths(code, null), `const p = 'C:/a'; ${keyword} ${re}`)
  }
  for (const code of [
    `const p='/c/a'; if (ready) ${re}.test(value)`,
    `const p='/c/a'; {} ${re}.test(value)`,
    `const p='/c/a'; return /unterminated`,
  ]) assert.equal(x.rewriteCodePaths(code, null), code)
  const code = "(() => { return /['/c/x']/ })()"
  assert.equal(x.rewriteCodePaths(code, null), code)
  assert.equal(eval(code).test('C'), false)
  assert.equal(x.rewriteCodePaths("const a='/c/a'; const b='~/b'", { home: "C:/user's" }), "const a='/c/a'; const b='~/b'", 'unsafe translated quote aborts all edits')
})

function sidebar(t, enabled = true, initial = 'previous-shell') {
  let value = initial, adopt = enabled
  const listeners = new Map(), effects = [], updates = []
  const settings = { describe: () => [{ ns: 'better-sidebar', value: { terminalShell: value } }], async update(_ns, patch) { value = patch.terminalShell; updates.push(value) } }
  const ctx = { get: () => settings, effect(fn) { effects.push(fn()) }, on(name, fn) { listeners.set(name, fn) } }
  x.adoptSidebarShell(ctx, 'Q:/Git/bin/bash.exe', () => adopt)
  let disposed
  const dispose = () => disposed ??= (async () => { for (const off of [...effects].reverse()) await off() })()
  t.after(dispose)
  return { get value() { return value }, updates, dispose, manual(next) { value = next }, toggle(next) { adopt = next; listeners.get('loader/volatile-update')([['adoptSidebar']]) } }
}

test('host: sidebar volatile OFF restores previous, ON adopts again, and user choice survives OFF', async (t) => {
  const f = sidebar(t); await flush()
  assert.equal(f.value, 'Q:/Git/bin/bash.exe')
  f.toggle(false); await flush(); assert.equal(f.value, 'previous-shell')
  f.toggle(true); await flush(); assert.equal(f.value, 'Q:/Git/bin/bash.exe')
  f.manual('user-shell'); f.toggle(false); await flush()
  assert.equal(f.value, 'user-shell')
  assert.deepEqual(f.updates, ['Q:/Git/bin/bash.exe', 'previous-shell', 'Q:/Git/bin/bash.exe'])
})

test('host: a startup same-value sidebar is not ours to restore on OFF or dispose', async (t) => {
  const f = sidebar(t, true, 'Q:/Git/bin/bash.exe'); await flush()
  f.toggle(false); await flush()
  await f.dispose()
  assert.equal(f.value, 'Q:/Git/bin/bash.exe')
  assert.deepEqual(f.updates, [], 'no takeover means no write and no restoration')
})

test('host: manual sidebar selection while adopted survives owner dispose', async (t) => {
  const f = sidebar(t); await flush()
  f.manual('user-shell')
  await f.dispose()
  assert.equal(f.value, 'user-shell')
  assert.deepEqual(f.updates, ['Q:/Git/bin/bash.exe'])
})

test('host: sidebar starting OFF can adopt after a volatile ON', async (t) => {
  const f = sidebar(t, false); await flush()
  assert.equal(f.value, 'previous-shell')
  f.toggle(true); await flush(); assert.equal(f.value, 'Q:/Git/bin/bash.exe')
})

test('host: FastCtx callbacks share root/delegate gates and virtual mounts are independently optional', () => {
  const start = source.indexOf('mountFastctx(ctx, {')
  const body = source.slice(start, source.indexOf('\n      })', start) + '\n      })'.length)
    .replace(/import\.meta\.url/g, JSON.stringify(import.meta.url))
  let callbacks, dialect, probes = 0
  new Function('mountFastctx', 'ctx', 'process', 'liveSettings', 'createRequire', 'translateMsysPath', 'buildTranslateEnv', 'readConfiguredBashPath', 'MSYS_DRIVE_ROOT', 'MSYS_BARE_DRIVE', 'dialectApplies', 'msysEcho', 'windowsToMsys', 'TAG', body)(
    (_ctx, deps) => { callbacks = deps }, {}, { platform: 'win32' }, { dialect: () => dialect }, () => {}, x.translateMsysPath,
    () => { probes++; return { tmpDir: 'C:/Temp', home: 'C:/Users/u', gitRoot: 'Q:/Git' } }, () => '', /^\/([A-Za-z])\/(.*)$/, /^\/([A-Za-z])$/, x.dialectApplies, x.msysEcho, x.windowsToMsys, '[fixture]',
  )
  const root = { agent: { session: { header: {} } } }
  const child = { agent: { session: { header: { origin: 'subagent' } } } }
  const nested = { agent: { session: { header: { delegationDepth: 2 } } } }
  dialect = { posixPaths: true, virtualMounts: true, subagentDialect: false }
  for (const exec of [child, nested]) {
    assert.equal(callbacks.msysToWin('/c/a', exec), '/c/a')
    assert.equal(callbacks.echo('C:/Temp/a', exec), 'C:/Temp/a')
  }
  assert.equal(probes, 0)
  assert.equal(callbacks.msysToWin('/tmp/a', root), 'C:/Temp/a')
  assert.equal(callbacks.echo('C:/Temp/a', root), '/tmp/a')
  dialect = { ...dialect, posixPaths: false }
  assert.equal(callbacks.msysToWin('/c/a', root), '/c/a')
  assert.equal(callbacks.echo('C:/a', root), 'C:/a')
  dialect = { ...dialect, posixPaths: true, virtualMounts: false, subagentDialect: true }
  for (const exec of [root, child, nested]) {
    assert.equal(callbacks.msysToWin('/c/a', exec), 'C:/a')
    for (const path of ['/tmp/a', '/usr/bin', '/dev/null', '~/a']) assert.equal(callbacks.msysToWin(path, exec), path)
    assert.equal(callbacks.echo('C:/Temp/a', exec), '/c/Temp/a')
  }
})
