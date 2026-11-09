/**
 * dsh-gitbash-shell — global PTC SDK row switch.
 *
 * Covers the plan matrix (pure) and the patch writer against a real `yaml`
 * document module: comment/!!js survival, atomic write, verify-by-reread,
 * idempotency, and the ownership receipt (review P0) that keeps OFF from
 * deleting rows the user hand-wrote before ever toggling the switch.
 *
 * Without a resolvable `yaml` the plan matrix still runs and the writer part
 * reports SKIP-YAML (same posture as the other host-dependent tests).
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
  adoptGlobalPtcPatch,
  currentGlobalPtcRows,
  globalPtcReport,
  planGlobalPtcAdopt,
} from '../src/global-ptc.js'
import {
  OWNERSHIP_FILENAME,
  emptyReceipt,
  globalPtcOwnership,
  rowFingerprint,
  validateReceipt,
} from '../src/global-ptc-ownership.js'

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
}

/** The reviewer's P0 reproducer: a user hand-wrote the same rows. */
const USER_HANDWRITTEN = `- id: tool-executor-native
  disabled: true
- id: tool-executor-ptc
  disabled: false
- id: preset-minimal
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          complete: false
`

test('plan: the switch being off writes nothing', () => {
  const plan = planGlobalPtcAdopt({ enabled: false, rows: {} })
  assert.equal(plan.action, 'skip-disabled')
})

test('plan: a fresh patch adopts both executor rows', () => {
  const plan = planGlobalPtcAdopt({ enabled: true, rows: {} })
  assert.equal(plan.action, 'adopt')
  assert.equal(plan.writeNative, true)
  assert.equal(plan.writePtc, true)
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

test('plan: a non-literal row is never replaced by a literal', () => {
  for (const rows of [{ ...OUR, native: { opaque: true } }, { ...OUR, ptc: { opaque: true } }]) {
    const plan = planGlobalPtcAdopt({ enabled: true, rows })
    assert.equal(plan.action, 'kept-user-choice')
    assert.match(plan.reason, /non-literal/)
  }
})

test('plan: a partial patch writes only the missing row', () => {
  const plan = planGlobalPtcAdopt({ enabled: true, rows: { native: { disabled: true } } })
  assert.equal(plan.action, 'adopt')
  assert.equal(plan.writeNative, false)
  assert.equal(plan.writePtc, true)
})

test('report: detail wins over reason', () => {
  assert.match(globalPtcReport({ status: 'write-failed', detail: 'boom', reason: 'because' }), /boom/)
  assert.match(globalPtcReport({ status: 'skip-disabled', reason: 'off' }), /off/)
})

// ── receipt ──────────────────────────────────────────────────────────────

test('fingerprint: key order does not matter, content does', () => {
  assert.equal(rowFingerprint({ a: 1, b: { c: 2, d: 3 } }), rowFingerprint({ b: { d: 3, c: 2 }, a: 1 }))
  assert.notEqual(rowFingerprint({ a: 1 }), rowFingerprint({ a: 2 }))
  assert.notEqual(rowFingerprint({ a: 1 }), rowFingerprint({ a: 1, extra: true }))
})

test('receipt: an empty receipt owns nothing', () => {
  assert.deepEqual(emptyReceipt(), { version: 1, rows: {} })
})

test('receipt: malformed receipts are refused, never guessed', () => {
  assert.throws(() => validateReceipt({ version: 2, rows: {} }), /refusing to guess/)
  assert.throws(() => validateReceipt({ version: 1, rows: { 'tool-executor-native': 'nope' } }), /malformed fingerprint/)
  assert.throws(() => validateReceipt({ version: 1, rows: { 'some-other-row': 'a'.repeat(64) } }), /unexpected owned row/)
})

// ── writer ──────────────────────────────────────────────────────────────

async function withPatch(t, initial) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-global-ptc-'))
  const file = join(dir, 'cordis.patch.yml')
  writeFileSync(file, initial)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const yamlModule = await realYaml()
  if (!yamlModule) return { skip: true }
  const io = {
    readFile: async (target) => readFileSync(target, 'utf8'),
    writeFileAtomic: async (target, data) => writeFileSync(target, data),
    yaml: async () => yamlModule,
  }
  return {
    io,
    dir,
    file,
    yamlModule,
    read: () => readFileSync(file, 'utf8'),
    receipt: () => {
      try { return JSON.parse(readFileSync(join(dir, OWNERSHIP_FILENAME), 'utf8')) } catch { return undefined }
    },
  }
}

test('writer: adopts onto a patch and records ownership', async (t) => {
  const h = await withPatch(t, '# my patch\n[]\n')
  if (h.skip) return t.skip('no yaml module available')
  const result = await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: true })
  assert.equal(result.status, 'adopted')
  const text = h.read()
  assert.match(text, /tool-executor-native/)
  assert.match(text, /tool-executor-ptc/)
  const receipt = h.receipt()
  assert.deepEqual(Object.keys(receipt.rows).sort(), [EXECUTOR_NATIVE_ROW, EXECUTOR_PTC_ROW].sort())
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

test('writer: a broken YAML document is refused', async (t) => {
  const h = await withPatch(t, '- id: [unclosed\n')
  if (h.skip) return t.skip('no yaml module available')
  const result = await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: true })
  assert.ok(['skip-parse', 'skip-shape'].includes(result.status), result.status)
})

test('writer: lift removes only rows this switch wrote', async (t) => {
  const h = await withPatch(t, '- id: keep-me\n  disabled: true\n')
  if (h.skip) return t.skip('no yaml module available')
  await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: true })
  assert.match(h.read(), /tool-executor-native/)
  const lifted = await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: false, lift: true })
  assert.equal(lifted.status, 'lifted')
  const text = h.read()
  assert.doesNotMatch(text, /tool-executor-native/)
  assert.doesNotMatch(text, /tool-executor-ptc/)
  assert.match(text, /keep-me/)
})

test('writer: P0 — OFF never deletes a user-handwritten same-value row', async (t) => {
  const h = await withPatch(t, USER_HANDWRITTEN)
  if (h.skip) return t.skip('no yaml module available')
  const before = h.read()
  const lifted = await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: false, lift: true })
  assert.equal(lifted.status, 'unchanged', 'a patch this switch never wrote has nothing to lift')
  assert.equal(h.read(), before, 'the user file must be byte-identical')
})

test('writer: P0 — OFF leaves a row the user edited after the switch wrote it', async (t) => {
  const h = await withPatch(t, '[]\n')
  if (h.skip) return t.skip('no yaml module available')
  await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: true })
  // The user then flips the native row back on (a different value).
  const edited = h.read().replace(`- id: ${EXECUTOR_NATIVE_ROW}\n  disabled: true`, `- id: ${EXECUTOR_NATIVE_ROW}\n  disabled: false`)
  writeFileSync(h.file, edited)
  const lifted = await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: false, lift: true })
  assert.equal(lifted.status, 'kept-user-choice')
  assert.match(h.read(), new RegExp(`${EXECUTOR_NATIVE_ROW}\\n  disabled: false`))
})

test('writer: lift on a patch without our rows changes nothing', async (t) => {
  const h = await withPatch(t, '- id: untouched\n')
  if (h.skip) return t.skip('no yaml module available')
  const before = h.read()
  const lifted = await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: false, lift: true })
  assert.equal(lifted.status, 'unchanged')
  assert.equal(h.read(), before)
})

test('writer: adopt then lift round-trips to the original bytes', async (t) => {
  const h = await withPatch(t, '- id: keep-me\n  disabled: true\n')
  if (h.skip) return t.skip('no yaml module available')
  const before = h.read()
  await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: true })
  await adoptGlobalPtcPatch(h.io, { patchPath: h.file, enabled: false, lift: true })
  assert.equal(h.read(), before)
  assert.deepEqual(h.receipt().rows, {})
})

test('ownership: a receipt store reads back what it wrote', async (t) => {
  const h = await withPatch(t, '[]\n')
  if (h.skip) return t.skip('no yaml module available')
  const store = globalPtcOwnership(h.io, h.file)
  assert.deepEqual(await store.read(), { version: 1, rows: {} })
  await store.write({ version: 1, rows: { [EXECUTOR_NATIVE_ROW]: 'a'.repeat(64) } })
  assert.deepEqual((await store.read()).rows, { [EXECUTOR_NATIVE_ROW]: 'a'.repeat(64) })
})
