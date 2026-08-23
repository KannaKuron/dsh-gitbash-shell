import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  const marker = { version: '0.1.0', files: {} }
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
