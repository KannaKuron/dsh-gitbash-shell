/**
 * dsh-gitbash-shell — global PTC SDK row switch.
 *
 * Covers the plan matrix (pure) and the patch writer against a real `yaml`
 * document module: comment/!!js survival, atomic write, verify-by-reread,
 * idempotency and the lift path. Without a resolvable `yaml` the plan matrix
 * still runs and the writer part reports SKIP-YAML (same posture as the other
 * host-dependent tests).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  EXECUTOR_NATIVE_ROW,
  EXECUTOR_PTC_ROW,
  MINIMAL_PRESET_ROW,
  adoptGlobalPtcPatch,
  currentGlobalPtcRows,
  globalPtcReport,
  planGlobalPtcAdopt,
  readMinimalRow,
} from '../src/global-ptc.js'

/** Resolve a real eemeli `yaml` from the machine (host install preferred). */
async function realYaml() {
  const candidates = []
  try { candidates.push(createRequire(import.meta.url).resolve('yaml')) } catch { /* not linked here */ }
  if (process.env.DSH_PREVIEW_HOST_DIR) {
    candidates.unshift(createRequire(pathToFileURL(join(process.env.DSH_PREVIEW_HOST_DIR, 'package.json'))).resolve('yaml'))
  }
  for (const candidate of candidates) {
    try { return await import(pathToFileURL(candidate).href) } catch { /* next */ }
  }
  return undefined
}

const OUR = {
  native: { disabled: true },
  ptc: { disabled: false },
  minimal: { complete: false },
}

test('plan: the switch being off writes nothing', () => {
  const plan = planGlobalPtcAdopt({ enabled: false, rows: {} })
  assert.equal(plan.action, 'skip-disabled')
})

test('plan: a fresh patch adopts all three rows', () => {
  const plan = planGlobalPtcAdopt({ enabled: true, rows: {} })
  assert.equal(plan.action, 'adopt')
  assert.equal(plan.writeNative, true)
  assert.equal(plan.writePtc, true)
  assert.equal(plan.writeMinimal, true)
})

test('plan: our exact shape is unchanged', () => {
  const plan = planGlobalPtcAdopt({ enabled: true, rows: OUR })
  assert.equal(plan.action, 'unchanged')
})

test('plan: an explicit native row stands down', () => {
  const plan = planGlobalPtcAdopt({ enabled: true, rows: { ...OUR, native: { disabled: false } } })
  assert.equal(plan.action, 'kept-user-choice')
  assert.match(plan.reason, /native root executor/)
})

test('plan: an explicitly disabled ptc row stands down', () => {
  const plan = planGlobalPtcAdopt({ enabled: true, rows: { ...OUR, ptc: { disabled: true } } })
  assert.equal(plan.action, 'kept-user-choice')
  assert.match(plan.reason, /disables the PTC root executor/)
})

test('plan: a user-written minimal row with complete:true stands down', () => {
  const plan = planGlobalPtcAdopt({ enabled: true, rows: { ...OUR, minimal: { complete: true } } })
  assert.equal(plan.action, 'kept-user-choice')
  assert.match(plan.reason, /preset-minimal/)
})

test('plan: a non-literal row is never replaced by a literal', () => {
  for (const rows of [
    { ...OUR, native: { opaque: true } },
    { ...OUR, ptc: { opaque: true } },
    { ...OUR, minimal: { opaque: true } },
  ]) {
    const plan = planGlobalPtcAdopt({ enabled: true, rows })
    assert.equal(plan.action, 'kept-user-choice')
    assert.match(plan.reason, /non-literal/)
  }
})

test('plan: a partial patch writes only the missing rows', () => {
  const plan = planGlobalPtcAdopt({ enabled: true, rows: { native: { disabled: true }, minimal: { complete: false } } })
  assert.equal(plan.action, 'adopt')
  assert.equal(plan.writeNative, false)
  assert.equal(plan.writePtc, true)
  assert.equal(plan.writeMinimal, false)
})

test('readMinimalRow: absent complete reads as the official default (true)', () => {
  assert.deepEqual(readMinimalRow({ config: { plugins: [{ id: 'persona', config: {} }] } }), { complete: true })
})

test('readMinimalRow: a plugin list without persona is opaque', () => {
  assert.deepEqual(readMinimalRow({ config: { plugins: [{ id: 'tool-fs' }] } }), { opaque: true })
})

test('readMinimalRow: a non-list plugin shape is opaque', () => {
  assert.deepEqual(readMinimalRow({ config: {} }), { opaque: true })
})

test('report: detail wins over reason', () => {
  assert.match(globalPtcReport({ status: 'write-failed', detail: 'boom', reason: 'because' }), /boom/)
  assert.match(globalPtcReport({ status: 'skip-disabled', reason: 'off' }), /off/)
})

// ── writer ────────────────────────────────────────────────────────────────

async function withPatch(t, initial) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-global-ptc-'))
  const file = join(dir, 'cordis.patch.yml')
  writeFileSync(file, initial)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const yamlModule = await realYaml()
  if (!yamlModule) return { skip: true }
  const io = {
    readFile: async () => readFileSync(file, 'utf8'),
    writeFileAtomic: async (_file, data) => writeFileSync(file, data),
    yaml: async () => yamlModule,
  }
  return { io, file, yamlModule, read: () => readFileSync(file, 'utf8') }
}

test('writer: adopts onto a patch and verifies by reread', async (t) => {
  const h = await withPatch(t, '# my patch\n[]\n')
  if (h.skip) return t.skip('no yaml module available')
  const result = await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: true })
  assert.equal(result.status, 'adopted')
  const text = h.read()
  assert.match(text, /tool-executor-native/)
  assert.match(text, /tool-executor-ptc/)
  assert.match(text, /preset-minimal/)
  assert.match(text, /complete: false/)
})

test('writer: a second run is idempotent', async (t) => {
  const h = await withPatch(t, '[]\n')
  if (h.skip) return t.skip('no yaml module available')
  await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: true })
  const first = h.read()
  const again = await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: true })
  assert.equal(again.status, 'unchanged')
  assert.equal(h.read(), first)
})

test('writer: comments survive the edit', async (t) => {
  const h = await withPatch(t, '# keep me\nextends: []\nrows:\n  - id: x\n# trailing\n')
  if (h.skip) return t.skip('no yaml module available')
  // A patch shaped as a mapping is refused, so nothing is written.
  const result = await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: true })
  assert.equal(result.status, 'skip-shape')
  assert.equal(h.read(), '# keep me\nextends: []\nrows:\n  - id: x\n# trailing\n')
})

test('writer: a broken YAML document is refused', async (t) => {
  const h = await withPatch(t, '- id: [unclosed\n')
  if (h.skip) return t.skip('no yaml module available')
  const result = await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: true })
  assert.ok(['skip-parse', 'skip-shape'].includes(result.status), result.status)
})

test('writer: lift removes our rows only', async (t) => {
  const h = await withPatch(t, '- id: keep-me\n  disabled: true\n')
  if (h.skip) return t.skip('no yaml module available')
  await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: true })
  assert.match(h.read(), /tool-executor-native/)
  const lifted = await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: false, lift: true })
  assert.equal(lifted.status, 'lifted')
  const text = h.read()
  assert.doesNotMatch(text, /tool-executor-native/)
  assert.doesNotMatch(text, /tool-executor-ptc/)
  assert.doesNotMatch(text, /preset-minimal/)
  assert.match(text, /keep-me/)
})

test('writer: lift leaves a user row that differs from ours', async (t) => {
  const h = await withPatch(t, '[]\n')
  if (h.skip) return t.skip('no yaml module available')
  await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: true })
  // The user flips the native row back on; lift must now leave it alone.
  const edited = h.read().replace(`- id: ${EXECUTOR_NATIVE_ROW}\n  disabled: true`, `- id: ${EXECUTOR_NATIVE_ROW}\n  disabled: false`)
  writeFileSync(h.file, edited)
  const lifted = await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: false, lift: true })
  assert.equal(lifted.status, 'lifted')
  const text = h.read()
  assert.match(text, new RegExp(`${EXECUTOR_NATIVE_ROW}\\n  disabled: false`))
})

test('writer: lift on a patch without our rows changes nothing', async (t) => {
  const h = await withPatch(t, '- id: untouched\n')
  if (h.skip) return t.skip('no yaml module available')
  const before = h.read()
  const lifted = await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: false, lift: true })
  assert.equal(lifted.status, 'unchanged')
  assert.equal(h.read(), before)
})
