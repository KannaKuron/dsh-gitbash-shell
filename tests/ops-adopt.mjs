import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  OPS_MODES,
  OPS_MODE_ROW_IDS,
  OPS_ROW_ID,
  OPS_SHELL_ROW_ID,
  OPS_SHELL_ROW_IDS,
  effectiveGlobalBash,
  effectiveModeBash,
  effectiveModeEnabled,
  planOpsAdopt,
  adoptOpsBashRemoval,
  restoreOpsBash,
  opsAdoptReport,
  opsRestoreReport,
  opsModeList,
  opsRowList,
} from '../src/ops-adopt.js'
import { OPS_SHELL_TOOLS } from '../src/inline-tools.js'

const rowOf = (id, override, inherited, disabled) => ({
  entry: { options: { id, disabled } },
  override: override ?? {},
  inherited: inherited ?? {},
})

const allModes = (value) => Object.fromEntries(OPS_MODES.map((mode) => [mode, { bash: value }]))
const modeActions = (result) => Object.fromEntries((result.modes ?? result.rows).map((row) => [row.mode, row.action]))

/**
 * configEditor stand-in with the parts the plugin module touches: rows(),
 * configuration() and an edit() that replaces the override wholesale (the
 * official change(current, inherited) => next contract; current includes the
 * effective inherited settings, matching the installed Core editor).
 */
function fakeOpsEditor({ rows = [], failEdit = null, ghostEdit = false, extraRows = false } = {}) {
  const state = { edits: [], rows: structuredClone(rows) }
  return {
    state,
    configuration() {
      if (extraRows) return [...state.rows, rowOf('unrelated-row', { other: 1 }, {})]
      return state.rows
    },
    async edit(entry, change) {
      state.edits.push(entry.options.id)
      if (failEdit) throw failEdit
      if (ghostEdit) return
      const row = state.rows.find((candidate) => candidate.entry.options.id === entry.options.id)
      if (!row) throw new Error('fake: row vanished')
      const current = { ...row.inherited, ...row.override }
      for (const mode of OPS_MODES) if (row.inherited?.[mode] || row.override?.[mode]) current[mode] = { ...row.inherited?.[mode], ...row.override?.[mode] }
      row.override = change(current, row.inherited ?? {})
    },
  }
}

test('ops-adopt: effectiveGlobalBash and effectiveModeBash read override, then inherited', () => {
  assert.equal(effectiveGlobalBash(rowOf(OPS_ROW_ID, { global: { bash: false } }, { global: { bash: true } })), false)
  assert.equal(effectiveGlobalBash(rowOf(OPS_ROW_ID, {}, { global: { bash: false } })), false)
  assert.equal(effectiveGlobalBash(rowOf(OPS_ROW_ID, {}, {})), true, 'the dsh-ops default')
  assert.equal(effectiveGlobalBash(undefined), true, 'a missing row cannot mean off')

  assert.equal(effectiveModeBash(rowOf(OPS_ROW_ID, { minimal: { bash: false } }, { minimal: { bash: true } }), 'minimal'), false)
  assert.equal(effectiveModeBash(rowOf(OPS_ROW_ID, {}, { minimal: { bash: false } }), 'minimal'), false)
  assert.equal(effectiveModeBash(rowOf(OPS_ROW_ID, {}, {}), 'minimal'), true, 'the mode default')
  assert.equal(effectiveModeBash(rowOf(OPS_ROW_ID, { minimal: { bash: true } }, { minimal: { bash: false } }), 'minimal'), true, 'an override wins')
  assert.equal(effectiveModeBash(rowOf(OPS_ROW_ID, { global: { bash: false } }, {}), 'minimal'), false, 'global gates every mode')
  assert.equal(effectiveModeEnabled(rowOf(OPS_ROW_ID, { minimal: { enabled: false } }, {}), 'minimal'), false)
  assert.equal(effectiveModeEnabled(rowOf(OPS_ROW_ID, {}, { minimal: { enabled: false } }), 'minimal'), false)
  assert.equal(effectiveModeEnabled(rowOf(OPS_ROW_ID, {}, {}), 'minimal'), true, 'the section default')
})

test('ops-adopt: planOpsAdopt covers the full decision matrix', () => {
  assert.equal(planOpsAdopt(undefined).action, 'skip-row-absent')
  assert.equal(planOpsAdopt(null).action, 'skip-row-absent')
  assert.equal(planOpsAdopt(rowOf(OPS_ROW_ID, allModes(false), {})).action, 'present')
  assert.deepEqual(modeActions(planOpsAdopt(rowOf(OPS_ROW_ID, allModes(false), {}))), Object.fromEntries(OPS_MODES.map((mode) => [mode, 'present'])))
  assert.equal(planOpsAdopt(rowOf(OPS_ROW_ID, {}, allModes(false))).action, 'unchanged-inherited-off', 'off at the source: not ours to enforce')
  assert.equal(planOpsAdopt(rowOf(OPS_ROW_ID, { minimal: { bash: true } }, {})).action, 'adopt')
  assert.equal(planOpsAdopt(rowOf(OPS_ROW_ID, {}, { minimal: { bash: true } })).action, 'adopt')
  assert.equal(planOpsAdopt(rowOf(OPS_ROW_ID, {}, {})).action, 'adopt', 'a fresh row publishes by default')
  // one settled mode does not hide the three that still publish
  const mixed = planOpsAdopt(rowOf(OPS_ROW_ID, { minimal: { bash: false } }, { ptc: { bash: false } }))
  assert.equal(mixed.action, 'adopt')
  assert.equal(modeActions(mixed).minimal, 'present')
  assert.equal(modeActions(mixed).ptc, 'unchanged-inherited-off')
  assert.equal(modeActions(mixed).standard, 'adopt')
  // a disabled mode publishes nothing and is never written
  const disabledMode = rowOf(OPS_ROW_ID, { minimal: { enabled: false } }, {})
  assert.equal(modeActions(planOpsAdopt(disabledMode)).minimal, 'skip-disabled-mode')
  assert.equal(planOpsAdopt(disabledMode).action, 'adopt', 'the other modes still publish')
  // all four sections disabled => nothing to do
  const allDisabled = rowOf(OPS_ROW_ID, Object.fromEntries(OPS_MODES.map((mode) => [mode, { enabled: false }])), {})
  assert.equal(planOpsAdopt(allDisabled).action, 'skip-disabled-modes')
  // a disabled ROW publishes nothing at all
  assert.equal(planOpsAdopt(rowOf(OPS_ROW_ID, {}, {}, true)).action, 'skip-disabled')
})

test('ops-adopt: adoption writes nested bash=false through the editor and reads every mode back', async () => {
  const editor = fakeOpsEditor({ rows: [rowOf(OPS_ROW_ID, { promptPolicy: true, discovery: { enabled: false } }, {})] })
  const result = await adoptOpsBashRemoval(editor)
  assert.equal(result.status, 'adopted')
  assert.deepEqual(result.rows.map((row) => [row.id, row.mode, row.action]), OPS_MODES.map((mode) => [OPS_ROW_ID, mode, 'adopt']))
  assert.deepEqual(editor.state.edits, [OPS_ROW_ID], 'one official editor write for the single row')
  const after = editor.state.rows[0]
  for (const mode of OPS_MODES) assert.equal(after.override[mode].bash, false, mode)
  assert.equal(after.override.promptPolicy, true, 'unrelated keys in the row survive the edit')
  assert.deepEqual(after.override.discovery, { enabled: false }, 'nested unrelated keys survive')
  assert.equal(opsRowList(result), OPS_ROW_ID)
  assert.equal(opsModeList(result, ['adopt']), OPS_MODES.join('/'))
})

test('ops-adopt: adoption skips every no-write condition without touching the editor', async () => {
  for (const rows of [
    [],
    [rowOf(OPS_ROW_ID, allModes(false), {})],
    [rowOf(OPS_ROW_ID, {}, allModes(false))],
    [rowOf(OPS_ROW_ID, Object.fromEntries(OPS_MODES.map((mode) => [mode, { enabled: false }])), {})],
  ]) {
    const editor = fakeOpsEditor({ rows })
    const result = await adoptOpsBashRemoval(editor)
    assert.notEqual(result.status, 'adopted')
    assert.deepEqual(editor.state.edits, [], 'no edit call for ' + JSON.stringify(rows))
  }
  assert.equal((await adoptOpsBashRemoval(null)).status, 'skip-row-absent')
})

test('ops-adopt: a refused or non-sticking write is reported, never claimed', async () => {
  const failing = fakeOpsEditor({ rows: [rowOf(OPS_ROW_ID, {}, {})], failEdit: new Error('overridden by a home patch') })
  const refused = await adoptOpsBashRemoval(failing)
  assert.equal(refused.status, 'write-failed')
  assert.match(refused.detail, /refused the write/)
  assert.match(refused.detail, /overridden by a home patch/)

  const ghost = fakeOpsEditor({ rows: [rowOf(OPS_ROW_ID, {}, {})], ghostEdit: true })
  const hollow = await adoptOpsBashRemoval(ghost)
  assert.equal(hollow.status, 'write-failed', 'edit() resolving is not proof; the readback decides')
  assert.match(hollow.detail, /did not stick/)
})

test('ops-adopt: restore preserves existing false and restores only adopted fields', async () => {
  const editor = fakeOpsEditor({ rows: [rowOf(OPS_ROW_ID,
    { minimal: { bash: false, promptPolicy: true }, cordis: { bash: true } },
    { standard: { bash: true }, ptc: { bash: false } })] })
  await adoptOpsBashRemoval(editor)
  const restored = await restoreOpsBash(editor)
  assert.equal(restored.status, 'restored')
  const after = editor.state.rows[0].override
  assert.deepEqual(after.minimal, { bash: false, promptPolicy: true })
  assert.equal(after.standard, undefined, 'an absent override is restored as absent, not as an explicit true')
  assert.equal(effectiveModeBash(editor.state.rows[0], 'standard'), true, 'the inherited value still applies')
  assert.equal(after.cordis.bash, true)
  assert.deepEqual(after.ptc, { bash: false }, 'inherited unrelated mode remains effective')
  assert.equal((await restoreOpsBash(editor)).status, 'unchanged')
})

test('ops-adopt: restore leaves later user choices and absent rows alone', async () => {
  const editor = fakeOpsEditor({ rows: [rowOf(OPS_ROW_ID, {}, {})] })
  await adoptOpsBashRemoval(editor)
  editor.state.rows[0].override.minimal.bash = true
  delete editor.state.rows[0].override.standard
  await restoreOpsBash(editor)
  assert.equal(editor.state.rows[0].override.minimal.bash, true)
  assert.equal(editor.state.rows[0].override.standard, undefined)
  const unowned = fakeOpsEditor({ rows: [rowOf(OPS_ROW_ID, { minimal: { bash: false } }, {})] })
  assert.equal((await restoreOpsBash(unowned)).status, 'unchanged')
  assert.deepEqual(unowned.state.edits, [])
  assert.equal((await restoreOpsBash(fakeOpsEditor({ rows: [] }))).status, 'skip-row-absent')
  assert.equal((await restoreOpsBash(null)).status, 'restore-failed')
})

test('ops-adopt: a failed restore retains ownership for a retry', async () => {
  const editor = fakeOpsEditor({ rows: [rowOf(OPS_ROW_ID, {}, {})] })
  await adoptOpsBashRemoval(editor)
  const edit = editor.edit
  editor.edit = async () => { throw new Error('file locked') }
  const failed = await restoreOpsBash(editor)
  assert.equal(failed.status, 'restore-failed')
  assert.match(failed.detail, /file locked/)
  editor.edit = async () => {}
  assert.match((await restoreOpsBash(editor)).detail, /did not stick/)
  editor.edit = edit
  assert.equal((await restoreOpsBash(editor)).status, 'restored')
})

test('ops-adopt: the reports carry the owner-facing wording', () => {
  assert.match(opsAdoptReport({ status: 'adopted' }), /bash=false/)
  assert.match(opsAdoptReport({ status: 'adopted' }), /minimal\/standard\/ptc\/cordis/)
  assert.match(opsAdoptReport({ status: 'adopted' }), /disable this plugin/)
  assert.match(opsAdoptReport({ status: 'present' }), /already removed/)
  assert.match(opsAdoptReport({ status: 'unchanged-inherited-off' }), /nothing written/)
  assert.match(opsAdoptReport({ status: 'skip-row-absent', detail: 'not mounted' }), /not mounted/)
  assert.match(opsAdoptReport({ status: 'skip-disabled-modes' }), /mode section is disabled/)
  const failed = opsAdoptReport({ status: 'write-failed', detail: 'boom' })
  assert.match(failed, /VISIBLE/, 'the failure report must not pretend the tool is hidden')
  assert.match(failed, /boom/)
  assert.match(opsRestoreReport({ status: 'restored' }), /restored/)
  assert.match(opsRestoreReport({ status: 'unchanged', detail: 'no override of ours' }), /no override of ours/)
  assert.match(opsRestoreReport({ status: 'restore-failed', detail: 'locked' }), /restore defaults/)
})

test('ops-adopt: the module stays inside the editor channel (no filesystem escape hatch)', () => {
  const source = readFileSync(new URL('../src/ops-adopt.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  for (const banned of ['node:fs', 'writeFileSync', 'readFile', 'appendFile', 'require(', 'process.env', 'cordis.patch']) {
    assert.equal(source.includes(banned), false, 'ops-adopt.js must not touch ' + banned + ' — the official config editor is the only write channel')
  }
})

test('ops-adopt: index.js wires the disposal restore and keeps it inside the win32 gate', () => {
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.match(source, /import \{[^}]*adoptOpsBashRemoval[^}]*\} from '\.\/ops-adopt\.js'/)
  assert.match(source, /adoptOpsBashRemoval\(opsEditorCtx\.configEditor\)/)
  const marker = source.indexOf('dsh-ops bash removal from the agent face')
  assert.ok(marker > 0, 'the wiring block exists')
  const block = source.slice(marker, source.indexOf('OFFICIAL persistent-terminal bundle adoption', marker))
  assert.match(block, /process\.platform === 'win32'/, 'the removal is a Windows-host concern only')
  assert.match(block, /opsEditorCtx\.effect\(\(\) => async \(\) => \{/)
  assert.match(block, /restoreOpsBash\(opsEditorCtx\.configEditor\)/)
  assert.match(block, /await pending/, 'restore joins in-flight adoption')
  assert.match(block, /clearTimeout\(retry\)/, 'disposal owns pending retries')
})

test('ops-adopt: the removal list never grows into dsh-ops background or file tools (2026-10-19 user decision)', () => {
  // gitbash owns the *bash* slot only. dsh-ops background jobs and file/PTC
  // enhancements stay untouched and visible: users run them alongside gitbash,
  // including inside PTC sessions (they are global tools).
  assert.deepEqual([...OPS_SHELL_TOOLS], ['ops_bash', 'ops_run'],
    'the removal list must stay exactly ops_bash + ops_run — never extend it without a user decision')
  for (const keep of ['ops_run_background', 'ops_job_output', 'ops_job_list', 'ops_job_kill', 'ops_inspect_local_file', 'ops_grep', 'ops_glob', 'ops_replace']) {
    assert.equal(OPS_SHELL_TOOLS.includes(keep), false, keep + ' must never be denied by gitbash')
  }
  const source = readFileSync(new URL('../src/inline-tools.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.match(source, /export const OPS_SHELL_TOOLS = Object\.freeze\(\['ops_bash', 'ops_run'\]\)/)
})

// ── dsh-ops 0.5.0 (v0.50.0) ────────────────────────────────────────────────
// 0.5.0 replaced the component roster with ONE row and four nested mode
// sections. The old row ids no longer exist; writing them would be a no-op.

test('ops-adopt: the row set is the single dsh-ops row with four nested modes', () => {
  assert.equal(OPS_ROW_ID, 'dsh-ops')
  assert.deepEqual([...OPS_MODES], ['minimal', 'standard', 'ptc', 'cordis'])
  assert.equal(OPS_SHELL_ROW_ID, OPS_ROW_ID, 'the deprecated alias points at the live row')
  assert.deepEqual([...OPS_SHELL_ROW_IDS], [OPS_ROW_ID], 'the 0.4.x row set is gone')
  assert.deepEqual([...OPS_MODE_ROW_IDS], ['dsh-ops-mode-minimal', 'dsh-ops-mode-standard', 'dsh-ops-mode-ptc', 'dsh-ops-mode-cordis'],
    'the deprecated alias still names the vanished 0.4.3 rows')
  const source = readFileSync(new URL('../src/ops-adopt.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.match(source, /OPS_MODES = Object\.freeze\(\['minimal', 'standard', 'ptc', 'cordis'\]\)/)
  assert.match(source, /OPS_ROW_ID = 'dsh-ops'/)
  assert.match(source, /only the four BUILT-IN modes/i, 'the doc records the dsh-ops 0.5.0 breaking change')
})

test('ops-adopt: global.bash is never touched and only the four built-in modes are written', async () => {
  const editor = fakeOpsEditor({ rows: [rowOf(OPS_ROW_ID, { global: { bash: true } }, {})] })
  const result = await adoptOpsBashRemoval(editor)
  assert.equal(result.status, 'adopted')
  const override = editor.state.rows[0].override
  assert.equal(override.global.bash, true, 'the global switch belongs to the user')
  for (const mode of OPS_MODES) assert.equal(override[mode].bash, false, mode)
  assert.deepEqual(Object.keys(override).sort(), ['cordis', 'global', 'minimal', 'ptc', 'standard'], 'no custom preset key is invented')
})
