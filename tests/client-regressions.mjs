import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

function cardFixture() {
  let declaration, hooks = [], effects = [], setters = [], stateIndex = 0
  let status = 'pending', overrides = new Map(), fetchMode = 'none', pollingCalls = 0
  const timers = new Map()
  let timerId = 0
  const React = {
    Component: function () {},
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(value) {
      hooks.push('state')
      const index = stateIndex++
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
  const form = { getSnapshot: () => ({ status, value: {} }), subscribe: () => () => {}, set: () => Promise.resolve(true) }
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
    setJob: (job) => { overrides = new Map([[6, job]]) },
    setFetchMode: (mode) => { fetchMode = mode },
    render() {
      hooks = []; effects = []; setters = []; stateIndex = 0
      card.type(card.props)
      return { hooks: [...hooks], effects: [...effects] }
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

test('client: pending, ready and unavailable snapshots call the same hooks', () => {
  const fixture = cardFixture()
  const pending = fixture.render()
  fixture.setStatus('ready')
  const ready = fixture.render()
  fixture.setStatus('unavailable')
  const unavailable = fixture.render()
  assert.deepEqual(pending.hooks, ready.hooks)
  assert.deepEqual(unavailable.hooks, ready.hooks)
  assert.equal(ready.hooks.filter((kind) => kind === 'effect').length, 5)
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
