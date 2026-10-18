/**
 * dsh-gitbash-shell — persistent-terminal bundle adoption (v0.41.0).
 *
 * Covers the plan matrix (pure) and the patch writer against a real `yaml`
 * document module: comment/!!js survival, atomic write, verify-by-reread and
 * rollback. The `yaml` module is resolved from the installed DSH host when
 * present; without it the plan matrix still runs and the writer part reports
 * SKIP-YAML (same posture as the other host-dependent tests).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  TERMINAL_BUNDLE_BASH_ROW,
  TERMINAL_BUNDLE_PWSH_ROW,
  TERMINAL_BUNDLE_TOOL_ROW,
  adoptTerminalBundlePatch,
  currentBundleRows,
  detectTerminalBundle,
  planTerminalBundleAdopt,
  readPatchRow,
  terminalBundleReport,
} from '../src/terminal-bundle.js'

const BASH_PATH = 'C:/Program Files/Git/bin/bash.exe'
const GOOD = { platform: 'win32', enabled: true, mounted: true, resolved: BASH_PATH }

/** Resolve a real eemeli `yaml` from the machine (host install preferred). */
async function realYaml() {
  const candidates = []
  try { candidates.push(createRequire(import.meta.url).resolve('yaml')) } catch { /* not linked here */ }
  for (const host of [
    'C:/Users/kanna/.dsh/profiles/desktop/node_modules/yaml/package.json',
    'D:/APP/DeepSeek Harness/resources/app.asar/dsh/node_modules/yaml/package.json',
  ]) {
    try { candidates.push(createRequire(pathToFileURL(host)).resolve('yaml')) } catch { /* not installed there */ }
  }
  for (const candidate of candidates) {
    try { return await import(pathToFileURL(candidate).href) } catch { /* next */ }
  }
  return undefined
}

test('plan: off-platform is a skip', () => {
  const plan = planTerminalBundleAdopt({ ...GOOD, platform: 'linux' })
  assert.equal(plan.action, 'skip-platform')
})

test('plan: bundle absent is its own state and writes nothing', () => {
  const plan = planTerminalBundleAdopt({ ...GOOD, mounted: false })
  assert.equal(plan.action, 'bundle-absent')
})

test('plan: autoTerminalShell off skips', () => {
  const plan = planTerminalBundleAdopt({ ...GOOD, enabled: false })
  assert.equal(plan.action, 'skip-disabled')
})

test('plan: unresolved bash skips', () => {
  const plan = planTerminalBundleAdopt({ ...GOOD, resolved: '' })
  assert.equal(plan.action, 'skip-unresolved')
})

test('plan: fresh adopt writes bash row and a disabling pwsh row', () => {
  const plan = planTerminalBundleAdopt({ ...GOOD, rows: {} })
  assert.equal(plan.action, 'adopt')
  assert.equal(plan.bash.disabled, false)
  assert.equal(plan.bash.shellPath, BASH_PATH)
  assert.deepEqual(plan.pwsh, { disabled: true })
})

test('plan: adopt keeps an existing user pwsh row alone', () => {
  const plan = planTerminalBundleAdopt({ ...GOOD, rows: { pwsh: { disabled: false } } })
  assert.equal(plan.action, 'adopt')
  assert.equal(plan.pwsh, undefined)
  assert.match(plan.reason, /pwsh-backend row already exists/)
})

test('plan: an explicit bash disable is a user choice', () => {
  const plan = planTerminalBundleAdopt({ ...GOOD, rows: { bash: { disabled: true } } })
  assert.equal(plan.action, 'kept-user-choice')
})

test('plan: enabled bash row without shellPath gets completed', () => {
  const plan = planTerminalBundleAdopt({ ...GOOD, rows: { bash: { disabled: false } } })
  assert.equal(plan.action, 'update-shellpath')
  assert.equal(plan.bash.shellPath, BASH_PATH)
})

test('plan: a different shellPath is a user choice', () => {
  const plan = planTerminalBundleAdopt({ ...GOOD, rows: { bash: { disabled: false, shellPath: 'C:/Git/usr/bin/bash.exe' } } })
  assert.equal(plan.action, 'kept-user-choice')
})

test('plan: our exact shape is unchanged', () => {
  const plan = planTerminalBundleAdopt({ ...GOOD, rows: { bash: { disabled: false, shellPath: BASH_PATH }, pwsh: { disabled: true } } })
  assert.equal(plan.action, 'unchanged')
})

test('plan: our bash row with pwsh still enabled is unchanged with a note', () => {
  const plan = planTerminalBundleAdopt({ ...GOOD, rows: { bash: { disabled: false, shellPath: BASH_PATH }, pwsh: { disabled: false } } })
  assert.equal(plan.action, 'unchanged')
  assert.match(plan.reason, /pwsh backend row is also enabled/)
})

test('plan: malformed rows are read defensively', () => {
  assert.equal(readPatchRow(undefined), undefined)
  assert.equal(readPatchRow('nope'), undefined)
  assert.deepEqual(readPatchRow({ disabled: true, config: { shellPath: 'x' } }), { disabled: true, shellPath: 'x' })
  assert.deepEqual(readPatchRow({ config: null }), {})
})

// ── writer ───────────────────────────────────────────────────────────────

/** In-memory + real-fs IO harness for adoptTerminalBundlePatch. */
function harness(yaml, { initial, failWrite = false, reread } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'gitbash-terminal-'))
  const patchPath = join(tmp, 'cordis.patch.yml')
  if (initial !== undefined) writeFileSync(patchPath, initial, 'utf8')
  let writes = 0
  let lastWrite
  const io = {
    readFile: (file) => {
      assert.equal(file, patchPath)
      if (reread !== undefined && writes > 0) return reread
      try { return readFileSync(file, 'utf8') } catch (error) { error.code = error.code ?? 'ENOENT'; throw error }
    },
    writeFileAtomic: (file, data) => {
      writes += 1
      lastWrite = data
      if (failWrite) { const e = new Error('disk full'); e.code = 'EACCES'; throw e }
      writeFileSync(file, data, 'utf8')
    },
    yaml: async () => {
      if (!yaml) throw new Error('yaml unavailable')
      return yaml
    },
  }
  return { io, patchPath, tmp, wrote: () => writes, last: () => lastWrite }
}

const COMMENT_PATCH = [
  '# keep me: user header comment',
  'patches:',
]

test('writer: skips when the yaml module is unavailable', async () => {
  const h = harness(undefined, { initial: '[]\n' })
  const result = await adoptTerminalBundlePatch(h.io, { ...GOOD, patchPath: h.patchPath })
  assert.equal(result.status, 'skip-modules')
  assert.equal(h.wrote(), 0)
})

test('writer: refuses to edit a broken YAML document', async (t) => {
  const yaml = await realYaml()
  if (!yaml) { t.skip('no real yaml module on this machine'); return }
  const h = harness(yaml, { initial: '- id: [unclosed' })
  const result = await adoptTerminalBundlePatch(h.io, { ...GOOD, patchPath: h.patchPath })
  assert.equal(result.status, 'skip-parse')
  assert.equal(h.wrote(), 0)
})

test('writer: refuses to edit a non-sequence patch', async (t) => {
  const yaml = await realYaml()
  if (!yaml) { t.skip('no real yaml module on this machine'); return }
  const h = harness(yaml, { initial: 'patches: []\n' })
  const result = await adoptTerminalBundlePatch(h.io, { ...GOOD, patchPath: h.patchPath })
  assert.equal(result.status, 'skip-shape')
  assert.equal(h.wrote(), 0)
})

test('writer: adopts onto an empty patch and verifies by reread', async (t) => {
  const yaml = await realYaml()
  if (!yaml) { t.skip('no real yaml module on this machine'); return }
  const h = harness(yaml, { initial: '[]\n' })
  const result = await adoptTerminalBundlePatch(h.io, { ...GOOD, patchPath: h.patchPath })
  assert.equal(result.status, 'adopted')
  assert.equal(h.wrote(), 1)
  const text = readFileSync(h.patchPath, 'utf8')
  assert.match(text, new RegExp(`- id: ${TERMINAL_BUNDLE_BASH_ROW}`))
  assert.match(text, /shellPath: "C:\/Program Files\/Git\/bin\/bash\.exe"/)
  assert.match(text, new RegExp(`- id: ${TERMINAL_BUNDLE_PWSH_ROW}\\n\\s+disabled: true`))
})

test('writer: comments and !!js expressions survive the edit', async (t) => {
  const yaml = await realYaml()
  if (!yaml) { t.skip('no real yaml module on this machine'); return }
  const initial = [
    '# keep me: user header comment',
    '- id: some-row',
    '  disabled: !!js process.platform !== \'win32\'',
    '  config:',
    '    keep: yes',
  ].join('\n')
  const h = harness(yaml, { initial })
  const result = await adoptTerminalBundlePatch(h.io, { ...GOOD, patchPath: h.patchPath })
  assert.equal(result.status, 'adopted')
  const text = readFileSync(h.patchPath, 'utf8')
  assert.match(text, /# keep me: user header comment/)
  assert.match(text, /disabled: !!js process\.platform !== 'win32'/)
  assert.match(text, /keep: yes/)
})

test('writer: our exact current shape is left untouched', async (t) => {
  const yaml = await realYaml()
  if (!yaml) { t.skip('no real yaml module on this machine'); return }
  const initial = [
    '- id: optional-terminal-bash',
    '  disabled: false',
    '  config:',
    "    shellPath: 'C:/Program Files/Git/bin/bash.exe'",
    '- id: optional-terminal-pwsh',
    '  disabled: true',
    '',
  ].join('\n')
  const h = harness(yaml, { initial })
  const result = await adoptTerminalBundlePatch(h.io, { ...GOOD, patchPath: h.patchPath })
  assert.equal(result.status, 'unchanged')
  assert.equal(h.wrote(), 0)
  assert.equal(readFileSync(h.patchPath, 'utf8'), initial)
})

test('writer: a different shellPath is not overwritten', async (t) => {
  const yaml = await realYaml()
  if (!yaml) { t.skip('no real yaml module on this machine'); return }
  const initial = [
    '- id: optional-terminal-bash',
    '  disabled: false',
    '  config:',
    '    shellPath: C:/Git/usr/bin/bash.exe',
  ].join('\n')
  const h = harness(yaml, { initial })
  const result = await adoptTerminalBundlePatch(h.io, { ...GOOD, patchPath: h.patchPath })
  assert.equal(result.status, 'kept-user-choice')
  assert.equal(h.wrote(), 0)
})

test('writer: completes an enabled bash row that never got a shellPath', async (t) => {
  const yaml = await realYaml()
  if (!yaml) { t.skip('no real yaml module on this machine'); return }
  const initial = [
    '# user header',
    '- id: optional-terminal-bash',
    '  disabled: false',
  ].join('\n')
  const h = harness(yaml, { initial })
  const result = await adoptTerminalBundlePatch(h.io, { ...GOOD, patchPath: h.patchPath })
  assert.equal(result.status, 'updated')
  const text = readFileSync(h.patchPath, 'utf8')
  assert.match(text, /# user header/)
  assert.match(text, /shellPath: "C:\/Program Files\/Git\/bin\/bash\.exe"/)
})

test('writer: pwsh row already enabled by the user stays enabled', async (t) => {
  const yaml = await realYaml()
  if (!yaml) { t.skip('no real yaml module on this machine'); return }
  const initial = [
    '- id: optional-terminal-pwsh',
    '  disabled: false',
  ].join('\n')
  const h = harness(yaml, { initial })
  const result = await adoptTerminalBundlePatch(h.io, { ...GOOD, patchPath: h.patchPath })
  assert.equal(result.status, 'adopted')
  const text = readFileSync(h.patchPath, 'utf8')
  assert.doesNotMatch(text, /id: optional-terminal-pwsh[\s\S]*disabled: true\n- id|^- id: optional-terminal-pwsh\n  disabled: true/m)
  const parsed = currentBundleRows(yaml, yaml.parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (v) => v }] }))
  assert.equal(parsed.pwsh?.disabled, false)
  assert.equal(parsed.bash?.disabled, false)
})

test('writer: a failed write leaves the previous bytes standing', async (t) => {
  const yaml = await realYaml()
  if (!yaml) { t.skip('no real yaml module on this machine'); return }
  const initial = '[]\n'
  const h = harness(yaml, { initial, failWrite: true })
  const result = await adoptTerminalBundlePatch(h.io, { ...GOOD, patchPath: h.patchPath })
  assert.equal(result.status, 'write-failed')
  assert.equal(readFileSync(h.patchPath, 'utf8'), initial)
})

test('writer: a bad reread rolls back', async (t) => {
  const yaml = await realYaml()
  if (!yaml) { t.skip('no real yaml module on this machine'); return }
  const initial = '[]\n'
  const h = harness(yaml, { initial, reread: '[]\n' })
  const result = await adoptTerminalBundlePatch(h.io, { ...GOOD, patchPath: h.patchPath })
  assert.equal(result.status, 'write-failed')
  assert.equal(readFileSync(h.patchPath, 'utf8'), initial)
})

test('writer: ENOENT starts from an empty sequence', async (t) => {
  const yaml = await realYaml()
  if (!yaml) { t.skip('no real yaml module on this machine'); return }
  const h = harness(yaml, {}) // nothing written first
  const result = await adoptTerminalBundlePatch(h.io, { ...GOOD, patchPath: h.patchPath })
  assert.equal(result.status, 'adopted')
  assert.match(readFileSync(h.patchPath, 'utf8'), new RegExp(TERMINAL_BUNDLE_BASH_ROW))
})

test('report renders every state into one line', () => {
  for (const status of ['adopted', 'updated', 'unchanged', 'bundle-absent', 'skip-disabled', 'write-failed']) {
    const line = terminalBundleReport({ action: status, status, reason: `reason-${status}` })
    assert.match(line, new RegExp(`persistent terminal: reason-${status}`))
  }
  assert.match(terminalBundleReport({ status: 'skip-modules', detail: 'boom' }), /boom/)
  assert.match(terminalBundleReport(undefined), /returned nothing/)
})

test('detectTerminalBundle reads the tool row through the loader service', async () => {
  const calls = []
  const entry = (id, disabled) => ({ options: { id, disabled } })
  const ctx = {
    inject(services, callback) {
      calls.push(services[0])
      const loaderCtx = { get: (name) => name === 'loader' ? { entries: () => [entry('unrelated', false), entry(TERMINAL_BUNDLE_TOOL_ROW, false), entry('optional-terminal-bash', true)] } : undefined }
      return Promise.resolve(callback(loaderCtx))
    },
  }
  assert.equal(await detectTerminalBundle(ctx), true)
  assert.deepEqual(calls, ['loader'])
  const disabledCtx = {
    inject(services, callback) {
      const loaderCtx = { get: (name) => name === 'loader' ? { entries: () => [entry(TERMINAL_BUNDLE_TOOL_ROW, true)] } : undefined }
      return Promise.resolve(callback(loaderCtx))
    },
  }
  assert.equal(await detectTerminalBundle(disabledCtx), false)
})
