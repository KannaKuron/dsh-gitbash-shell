import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

function cardFixture({ expanded = false } = {}) {
  let declaration, hooks = [], effects = [], setters = [], stateIndex = 0
  let status = 'pending', overrides = new Map(), fetchMode = 'none', pollingCalls = 0
  const timers = new Map()
  let timerId = 0
  let values = {}
  const writes = []
  const React = {
    Component: function () {},
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(value) {
      hooks.push('state')
      const index = stateIndex++
      if (expanded && index === 0) value = true
      if (expanded && value && typeof value === 'object' && !Array.isArray(value)) value = { ...value, 'sec.inline': true }
      return [overrides.has(index) ? overrides.get(index) : (typeof value === 'function' ? value() : value), (next) => setters.push({ index, value: next })]
    },
    useEffect(callback) { hooks.push('effect'); effects.push(callback) },
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { declaration = value } } },
    console: { ...console, warn: () => {} },
    async fetch(url) {
      if (String(url).includes('?job=1')) {
        pollingCalls++
        if (fetchMode === 'network-error') throw new Error('fixture transient network failure')
        if (fetchMode === 'http-error') return { ok: false, status: 503, json: async () => ({}) }
        return { ok: true, json: async () => ({ job: { finished: true } }) }
      }
      return { ok: false }
    },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
  }
  vm.runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), sandbox)
  const mod = declaration.factory((name) => name === 'react' ? React : {})
  const registrations = []
  const form = { getSnapshot: () => ({ status, value: values }), subscribe: () => () => {}, set: (key, value) => { writes.push({ key, value }); return Promise.resolve(true) } }
  const forms = { get: () => form }
  const ctx = {
    locale: { register: () => () => {} }, configForms: forms,
    get: (name) => name === 'configForms' ? forms : undefined,
    inject(names, callback) { if (names[0] === 'configForms') callback(ctx) },
    effect: (callback) => callback(),
    slots: {
      inject: (_name, callback) => callback(),
      register(options, component) { registrations.push({ options, component }); return () => {} },
    },
  }
  mod.apply(ctx)
  const wrapper = registrations.find((row) => row.options.name === 'plugins.bundle.config').component
  const locale = wrapper({ scope: form, ctx })
  const card = locale.type(locale.props).children[0]
  return {
    setStatus: (value) => { status = value },
    setValues: value => { values = value },
    writes,
    setJob: (job) => { overrides = new Map([[6, job]]) },
    setFetchMode: (mode) => { fetchMode = mode },
    render() {
      hooks = []; effects = []; setters = []; stateIndex = 0
      const tree = card.type(card.props)
      return { hooks: [...hooks], effects: [...effects], tree }
    },
    async runTimer() {
      const [id, callback] = timers.entries().next().value
      timers.delete(id)
      callback()
      await new Promise(setImmediate)
    },
    get timers() { return timers },
    get pollingCalls() { return pollingCalls },
    get setters() { return setters },
  }
}

// Unlike the observation-only card fixture above, this runner preserves hook
// state and compares the real dependency arrays across parent-driven renders.
function draftFixture(initial = { status: 'loading' }) {
  let declaration, stateIndex = 0, effectIndex = 0, dirty = false, tree
  const states = [], dependencies = [], cleanups = [], effects = [], writes = []
  const React = {
    Component: function () {},
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initialValue) {
      const index = stateIndex++
      if (!(index in states)) states[index] = typeof initialValue === 'function' ? initialValue() : initialValue
      return [states[index], (value) => {
        const next = typeof value === 'function' ? value(states[index]) : value
        if (!Object.is(next, states[index])) { states[index] = next; dirty = true }
      }]
    },
    useEffect(callback, next) {
      const index = effectIndex++, previous = dependencies[index]
      if (!previous || previous.length !== next.length || next.some((value, i) => !Object.is(value, previous[i]))) {
        dependencies[index] = next
        effects.push(() => { cleanups[index]?.(); cleanups[index] = callback() })
      }
    },
  }
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.ok(source.includes('return module.exports;'))
  vm.runInNewContext(source.replace('return module.exports;', 'exports.testCard = GitBashCard; return module.exports;'), {
    window: { __ModuleLoader__: { load(value) { declaration = value } } }, console,
    fetch: async () => ({ ok: false, status: 503 }), setTimeout, clearTimeout,
  })
  const Card = declaration.factory((name) => name === 'react' ? React : {}).testCard
  function form(snapshot) {
    return {
      snapshot, accepted: true,
      getSnapshot() { return this.snapshot },
      set(key, value) { writes.push({ scope: this, key, value }); return Promise.resolve(this.accepted) },
    }
  }
  const own = form(initial)
  const props = { scope: own, ctx: { get: () => undefined }, view: 'page', t: (key) => key }
  function render() {
    for (let turn = 0; turn < 20; turn++) {
      stateIndex = effectIndex = 0; effects.length = 0; dirty = false
      tree = Card(props)
      for (const effect of effects) effect()
      if (!dirty) return tree
    }
    assert.fail('hook fixture did not settle')
  }
  const nodes = () => walk(render())
  function controls() {
    let input = nodes().find((node) => node.type === 'input' && node.props.placeholder === 'C:/Program Files/Git/bin/bash.exe')
    if (!input) {
      const fold = nodes().find((node) => node.props.className === 'gb-foldHead' && walk(node).some((child) => child.children?.includes('sec.executor')))
      assert.ok(fold)
      fold.props.onClick()
      input = nodes().find((node) => node.type === 'input' && node.props.placeholder === 'C:/Program Files/Git/bin/bash.exe')
    }
    return { input, save: nodes().find((node) => node.type === 'button' && node.props.className?.includes('gb-saveBtn')) }
  }
  return { own, form, writes, render, controls, nodes, setScope: (scope) => { props.scope = scope }, dispose: () => cleanups.forEach((cleanup) => cleanup?.()) }
}

function walk(node) {
  return !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flat(Infinity).flatMap(walk)]
}

test('client: bash draft hydrates when loading first becomes ready through a parent render', async (t) => {
  const f = draftFixture()
  t.after(f.dispose)
  assert.equal(f.render(), null)
  f.own.snapshot = { status: 'ready', value: { bashPath: 'Q:/Git/bin/bash.exe' } }
  // Core owns the ConfigForm subscription and rerenders this child on arrival.
  f.render()
  const { input, save } = f.controls()
  assert.equal(input.props.value, 'Q:/Git/bin/bash.exe')
  save.props.onClick()
  await new Promise(setImmediate)
  assert.equal(f.writes.at(-1).value, 'Q:/Git/bin/bash.exe', 'untouched save must not clear the existing path')
  assert.ok(f.controls().save.props.className.includes('gb-saved'))
})

test('client: bash draft hydrates on a ready initial mount', (t) => {
  const f = draftFixture({ status: 'ready', value: { bashPath: 'R:/Git/bin/bash.exe' } })
  t.after(f.dispose)
  assert.equal(f.controls().input.props.value, 'R:/Git/bin/bash.exe')
})

test('client: pristine bash draft follows a later mirror path update', (t) => {
  const f = draftFixture({ status: 'ready', value: { bashPath: 'R:/Git/bin/bash.exe' } })
  t.after(f.dispose)
  assert.equal(f.controls().input.props.value, 'R:/Git/bin/bash.exe')
  f.own.snapshot = { status: 'ready', value: { bashPath: 'T:/external/Git/bin/bash.exe' } }
  assert.equal(f.controls().input.props.value, 'T:/external/Git/bin/bash.exe')
})

test('client: dirty bash draft survives later mirror refreshes', (t) => {
  const f = draftFixture({ status: 'ready', value: { bashPath: 'R:/Git/bin/bash.exe' } })
  t.after(f.dispose)
  f.controls().input.props.onChange({ target: { value: 'S:/edited/Git/bin/bash.exe' } })
  f.own.snapshot = { status: 'ready', value: { bashPath: 'T:/external/Git/bin/bash.exe', posixPaths: true } }
  assert.equal(f.controls().input.props.value, 'S:/edited/Git/bin/bash.exe')
  assert.ok(!f.controls().save.props.className.includes('gb-saved'))
})

test('client: scope change discards the former scope draft and hydrates the new ready snapshot', (t) => {
  const f = draftFixture({ status: 'ready', value: { bashPath: 'R:/Git/bin/bash.exe' } })
  t.after(f.dispose)
  f.controls().input.props.onChange({ target: { value: 'S:/unsaved/Git/bin/bash.exe' } })
  const other = f.form({ status: 'loading' })
  f.setScope(other)
  assert.equal(f.render(), null)
  other.snapshot = { status: 'ready', value: { bashPath: 'U:/other/Git/bin/bash.exe' } }
  assert.equal(f.controls().input.props.value, 'U:/other/Git/bin/bash.exe')
  const third = f.form({ status: 'ready', value: {} })
  f.setScope(third)
  assert.equal(f.controls().input.props.value, '')
})

for (const newScopeSaved of [false, true]) {
  test(`client: a pending former-scope save cannot change the new scope saved state (${newScopeSaved})`, async (t) => {
    const f = draftFixture({ status: 'ready', value: { bashPath: 'R:/Git/bin/bash.exe' } })
    t.after(f.dispose)
    let acceptOld
    f.own.accepted = new Promise((resolve) => { acceptOld = resolve })
    f.controls().save.props.onClick()
    const other = f.form({ status: 'ready', value: { bashPath: 'R:/Git/bin/bash.exe' } })
    f.setScope(other)
    assert.ok(!f.controls().save.props.className.includes('gb-saved'))
    if (newScopeSaved) {
      f.controls().save.props.onClick()
      await new Promise(setImmediate)
    }
    acceptOld(true)
    await new Promise(setImmediate)
    assert.equal(f.controls().save.props.className.includes('gb-saved'), newScopeSaved)
    assert.equal(f.controls().input.props.value, 'R:/Git/bin/bash.exe')
  })
}

for (const change of ['edit', 'scope roundtrip']) {
  test(`client: a pending save cannot mark a replacement draft saved after ${change}`, async (t) => {
    const f = draftFixture({ status: 'ready', value: { bashPath: 'R:/Git/bin/bash.exe' } })
    t.after(f.dispose)
    let acceptOld
    f.own.accepted = new Promise((resolve) => { acceptOld = resolve })
    f.controls().save.props.onClick()
    if (change === 'edit') {
      f.controls().input.props.onChange({ target: { value: 'S:/edited/Git/bin/bash.exe' } })
    } else {
      f.setScope(f.form({ status: 'ready', value: { bashPath: 'T:/other/Git/bin/bash.exe' } }))
      f.render()
      f.setScope(f.own)
      f.render()
    }
    acceptOld(true)
    await new Promise(setImmediate)
    assert.ok(!f.controls().save.props.className.includes('gb-saved'))
  })
}

test('client: refused bash save keeps the dirty draft and never claims success', async (t) => {
  const f = draftFixture({ status: 'ready', value: { bashPath: 'R:/Git/bin/bash.exe' } })
  t.after(f.dispose)
  f.own.accepted = false
  f.controls().input.props.onChange({ target: { value: '  S:/edited/Git/bin/bash.exe  ' } })
  f.controls().save.props.onClick()
  await new Promise(setImmediate)
  assert.equal(f.writes.at(-1).value, 'S:/edited/Git/bin/bash.exe')
  f.own.snapshot = { status: 'ready', value: { bashPath: 'R:/Git/bin/bash.exe' } }
  assert.equal(f.controls().input.props.value, '  S:/edited/Git/bin/bash.exe  ')
  assert.ok(!f.controls().save.props.className.includes('gb-saved'))
  assert.ok(f.nodes().some((node) => node.children?.some((child) => typeof child === 'string' && child.includes('bash.saveFailed'))))
})

test('client: pending, ready and unavailable snapshots call the same hooks', () => {
  const fixture = cardFixture()
  const pending = fixture.render()
  fixture.setStatus('ready')
  const ready = fixture.render()
  fixture.setStatus('unavailable')
  const unavailable = fixture.render()
  assert.deepEqual(pending.hooks, ready.hooks)
  assert.deepEqual(unavailable.hooks, ready.hooks)
  // v0.45.0 added the init-script draft hydration alongside the bash-path one.
  assert.equal(ready.hooks.filter((kind) => kind === 'effect').length, 6)
  assert.equal(pending.effects.at(-2)(), undefined)
  assert.equal(pending.effects.at(-1)(), undefined)
  assert.equal(fixture.timers.size, 0)
})

for (const failure of ['network-error', 'http-error']) {
  test(`client: job polling retries after ${failure} and cancels on cleanup`, async () => {
    const fixture = cardFixture()
    fixture.setStatus('ready')
    fixture.setJob({ finished: false, done: 0, total: 1, results: [] })
    fixture.setFetchMode(failure)
    const render = fixture.render()
    const cleanup = render.effects.at(-1)()
    assert.equal(fixture.timers.size, 1)
    await fixture.runTimer()
    assert.equal(fixture.pollingCalls, 1)
    assert.equal(fixture.timers.size, 1, 'a failed fetch must leave a retry timer')
    assert.equal(fixture.setters.filter((row) => row.index === 6).length, 0)
    fixture.setFetchMode('success')
    await fixture.runTimer()
    assert.equal(fixture.pollingCalls, 2)
    assert.equal(fixture.setters.filter((row) => row.index === 6).length, 1)
    cleanup()
    assert.equal(fixture.timers.size, 0)
  })
}

test('client: cleanup prevents a failed in-flight poll from scheduling a retry', async () => {
  const fixture = cardFixture()
  fixture.setStatus('ready')
  fixture.setJob({ finished: false, done: 0, total: 1, results: [] })
  fixture.setFetchMode('network-error')
  const cleanup = fixture.render().effects.at(-1)()
  const polling = fixture.runTimer()
  cleanup()
  await polling
  assert.equal(fixture.timers.size, 0)
  assert.equal(fixture.setters.filter((row) => row.index === 6).length, 0)
})

test('client: experimental switch defaults ON and writes the authoritative field both ways', async () => {
  const f = cardFixture({ expanded: true });
  f.setStatus('ready');
  const walk = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flat(Infinity).flatMap(walk)];
  const buttons = () => walk(f.render().tree).filter(node => node.type === 'button' && String(node.props.onClick).includes('experimentalNative'));
  let controls = buttons();
  assert.equal(controls.length, 2);
  assert.ok(controls[0].props.className.includes('gb-segActive'));
  controls[1].props.onClick();
  await new Promise(setImmediate);
  assert.equal(f.writes.at(-1).key, 'experimentalNative');
  assert.equal(f.writes.at(-1).value, false);
  f.setValues({ experimentalNative: false });
  controls = buttons();
  assert.ok(controls[1].props.className.includes('gb-segActive'));
  controls[0].props.onClick();
  await new Promise(setImmediate);
  assert.equal(f.writes.at(-1).value, true);
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
  for (const key of ['experimental.label', 'experimental.hint']) assert.equal(source.split('"' + key + '":').length - 1, 21);
  const labels = [...source.matchAll(/"experimental.label": ("(?:[^"\\]|\\.)*")/g)].map(match => JSON.parse(match[1]));
  assert.equal(labels.filter(label => label === labels[1]).length, 1, 'only English uses the English placeholder');
  const hints = [...source.matchAll(/"experimental.hint": ("(?:[^"\\]|\\.)*")/g)].map(match => JSON.parse(match[1]));
  for (const hint of hints) for (const fact of ['gitbash_native', 'gitbash_to_native_path', 'UNCONFINED', 'danger-full-access']) assert.ok(hint.includes(fact));
});
