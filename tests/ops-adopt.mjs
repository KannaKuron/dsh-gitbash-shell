import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  OPS_MODE_ROW_IDS,
  OPS_SHELL_ROW_ID,
  OPS_SHELL_ROW_IDS,
  effectivePublishBashTool,
  planOpsAdopt,
  adoptOpsBashRemoval,
  restoreOpsBash,
  opsAdoptReport,
  opsRestoreReport,
  opsRowList,
} from '../src/ops-adopt.js'
import { OPS_SHELL_TOOLS } from '../src/inline-tools.js'

const rowOf = (id, override, inherited) => ({
  entry: { options: { id } },
  override: override ?? {},
  inherited: inherited ?? {},
})

/**
 * configEditor stand-in with the parts the plugin module touches: rows(),
 * configuration() and an edit() that replaces the override wholesale (the
 * official change(current, inherited) => next contract, next compared with
 * inherited afterwards — which this fake does NOT simulate; the readback
 * assertions only ever look at publishBashTool).
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
      row.override = change(row.override ?? {}, row.inherited ?? {})
    },
  }
}

test('ops-adopt: effectivePublishBashTool reads override, then inherited, then the default', () => {
  assert.equal(effectivePublishBashTool(rowOf(OPS_SHELL_ROW_ID, { publishBashTool: false }, { publishBashTool: true })), false)
  assert.equal(effectivePublishBashTool(rowOf(OPS_SHELL_ROW_ID, {}, { publishBashTool: false })), false)
  assert.equal(effectivePublishBashTool(rowOf(OPS_SHELL_ROW_ID, {}, {})), true, 'the dsh-ops default')
  assert.equal(effectivePublishBashTool(rowOf(OPS_SHELL_ROW_ID, { publishBashTool: 'yes' }, { publishBashTool: false })), false, 'a malformed override falls through to the inherited value')
  assert.equal(effectivePublishBashTool(undefined), true, 'a missing row cannot mean off')
  assert.equal(effectivePublishBashTool(null), true)
})

test('ops-adopt: planOpsAdopt covers the full decision matrix', () => {
  assert.equal(planOpsAdopt(undefined).action, 'skip-row-absent')
  assert.equal(planOpsAdopt(null).action, 'skip-row-absent')
  assert.equal(planOpsAdopt(rowOf(OPS_SHELL_ROW_ID, { publishBashTool: false }, { publishBashTool: true })).action, 'present')
  assert.equal(planOpsAdopt(rowOf(OPS_SHELL_ROW_ID, {}, { publishBashTool: false })).action, 'unchanged-inherited-off', 'off at the source: not ours to enforce, nothing to write')
  assert.equal(planOpsAdopt(rowOf(OPS_SHELL_ROW_ID, { publishBashTool: true }, {})).action, 'adopt')
  assert.equal(planOpsAdopt(rowOf(OPS_SHELL_ROW_ID, {}, { publishBashTool: true })).action, 'adopt')
  assert.equal(planOpsAdopt(rowOf(OPS_SHELL_ROW_ID, {}, {})).action, 'adopt', 'a fresh row publishes by default')
})

test('ops-adopt: adoption writes through the editor and reads the value back', async () => {
  const editor = fakeOpsEditor({ rows: [rowOf(OPS_SHELL_ROW_ID, { promptPolicy: true }, { publishBashTool: true })] })
  const result = await adoptOpsBashRemoval(editor)
  assert.equal(result.status, 'adopted')
  assert.deepEqual(result.rows, [{ id: OPS_SHELL_ROW_ID, action: 'adopt', reason: result.rows[0].reason }])
  assert.deepEqual(editor.state.edits, [OPS_SHELL_ROW_ID])
  const after = editor.state.rows.find((candidate) => candidate.entry.options.id === OPS_SHELL_ROW_ID)
  assert.equal(after.override.publishBashTool, false)
  assert.equal(after.override.promptPolicy, true, 'unrelated keys in the row survive the edit')
})

test('ops-adopt: adoption skips every no-write condition without touching the editor', async () => {
  for (const rows of [
    [],
    [rowOf(OPS_SHELL_ROW_ID, { publishBashTool: false }, {})],
    [rowOf(OPS_SHELL_ROW_ID, {}, { publishBashTool: false })],
  ]) {
    const editor = fakeOpsEditor({ rows })
    const result = await adoptOpsBashRemoval(editor)
    assert.notEqual(result.status, 'adopted')
    assert.deepEqual(editor.state.edits, [], 'no edit call for ' + JSON.stringify(rows))
  }
  const nothing = await adoptOpsBashRemoval(null)
  assert.equal(nothing.status, 'skip-row-absent')
})

test('ops-adopt: a refused or non-sticking write is reported, never claimed', async () => {
  const failing = fakeOpsEditor({ rows: [rowOf(OPS_SHELL_ROW_ID, {}, {})], failEdit: new Error('overridden by a home patch') })
  const refused = await adoptOpsBashRemoval(failing)
  assert.equal(refused.status, 'write-failed')
  assert.match(refused.detail, /refused the write/)
  assert.match(refused.detail, /overridden by a home patch/)

  const ghost = fakeOpsEditor({ rows: [rowOf(OPS_SHELL_ROW_ID, {}, {})], ghostEdit: true })
  const hollow = await adoptOpsBashRemoval(ghost)
  assert.equal(hollow.status, 'write-failed', 'edit() resolving is not proof; the readback decides')
  assert.match(hollow.detail, /did not stick/)
})

test('ops-adopt: restore lifts our false back to the inherited value and nothing else', async () => {
  const withInherited = rowOf(OPS_SHELL_ROW_ID, { publishBashTool: false, promptPolicy: true }, { publishBashTool: true, promptPolicy: false })
  const editorA = fakeOpsEditor({ rows: [withInherited] })
  const restoredA = await restoreOpsBash(editorA)
  assert.equal(restoredA.status, 'restored')
  assert.deepEqual(restoredA.rows, [{ id: OPS_SHELL_ROW_ID, action: 'restore' }])
  const afterA = editorA.state.rows[0]
  assert.equal(afterA.override.publishBashTool, true, 'restored to the inherited value')
  assert.equal(afterA.override.promptPolicy, true, 'the user\'s own override keys are untouched')

  const withoutInherited = rowOf(OPS_SHELL_ROW_ID, { publishBashTool: false, shellPolicy: 'advise' }, {})
  const editorB = fakeOpsEditor({ rows: [withoutInherited] })
  assert.equal((await restoreOpsBash(editorB)).status, 'restored')
  const afterB = editorB.state.rows[0]
  assert.equal('publishBashTool' in afterB.override, false, 'no inherited value means the key goes away again')
  assert.equal(afterB.override.shellPolicy, 'advise')
})

test('ops-adopt: restore leaves later user choices and absent rows alone', async () => {
  const userTrue = rowOf(OPS_SHELL_ROW_ID, { publishBashTool: true }, { publishBashTool: true })
  const editorA = fakeOpsEditor({ rows: [userTrue] })
  const kept = await restoreOpsBash(editorA)
  assert.equal(kept.status, 'unchanged')
  assert.match(kept.detail, /left alone/)
  assert.deepEqual(editorA.state.edits, [])

  const bare = rowOf(OPS_SHELL_ROW_ID, {}, {})
  const editorB = fakeOpsEditor({ rows: [bare] })
  assert.equal((await restoreOpsBash(editorB)).status, 'unchanged')
  assert.deepEqual(editorB.state.edits, [])

  const gone = fakeOpsEditor({ rows: [] })
  assert.equal((await restoreOpsBash(gone)).status, 'skip-row-absent')
  assert.equal((await restoreOpsBash(null)).status, 'restore-failed')
})

test('ops-adopt: a failed restore is reported with the manual safety net', async () => {
  const failing = fakeOpsEditor({ rows: [rowOf(OPS_SHELL_ROW_ID, { publishBashTool: false }, {})], failEdit: new Error('file locked') })
  const refused = await restoreOpsBash(failing)
  assert.equal(refused.status, 'restore-failed')
  assert.match(refused.detail, /refused the restore/)

  const ghost = fakeOpsEditor({ rows: [rowOf(OPS_SHELL_ROW_ID, { publishBashTool: false }, {})], ghostEdit: true })
  const hollow = await restoreOpsBash(ghost)
  assert.equal(hollow.status, 'restore-failed')
  assert.match(hollow.detail, /did not stick/)
})

test('ops-adopt: the reports carry the owner-facing wording', () => {
  assert.match(opsAdoptReport({ status: 'adopted' }), /publishBashTool=false/)
  assert.match(opsAdoptReport({ status: 'adopted' }), /disable this plugin/)
  assert.match(opsAdoptReport({ status: 'present' }), /already removed/)
  assert.match(opsAdoptReport({ status: 'unchanged-inherited-off' }), /nothing written/)
  assert.match(opsAdoptReport({ status: 'skip-row-absent', detail: 'not mounted' }), /not mounted/)
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
  assert.match(block, /ctx\.effect\(\(\) => async \(\) => \{/)
  assert.match(block, /restoreOpsBash\(opsEditorCtx\.configEditor\)/)
  assert.match(block, /result\.status === 'adopted' \|\| result\.status === 'present'/, 'the restore hook only arms once the removal is actually in force')
})


test('ops-adopt: the removal list never grows into dsh-ops background or file tools (2026-10-19 user decision)', () => {
  // gitbash owns the *bash* slot only. dsh-ops background jobs (ops_run_background /
  // ops_job_*) and its file/PTC enhancements stay untouched and visible: users run
  // them alongside gitbash, including inside PTC sessions (they are global tools).
  assert.deepEqual([...OPS_SHELL_TOOLS], ['ops_bash', 'ops_run'],
    'the removal list must stay exactly ops_bash + ops_run — never extend it without a user decision')
  for (const keep of ['ops_run_background', 'ops_job_output', 'ops_job_list', 'ops_job_kill', 'ops_inspect_local_file', 'ops_grep', 'ops_glob', 'ops_replace']) {
    assert.equal(OPS_SHELL_TOOLS.includes(keep), false, keep + ' must never be denied by gitbash')
  }
  // The deny wiring consumes exactly this list; assert the constant is what flows in.
  const source = readFileSync(new URL('../src/inline-tools.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.match(source, /export const OPS_SHELL_TOOLS = Object\.freeze\(\['ops_bash', 'ops_run'\]\)/)
})

// ── dsh-ops 0.4.3+ (v0.46.0) ────────────────────────────────────────────────
// 0.4.3 replaced the component roster with preset-mode switches: the legacy
// `dsh-ops-shell` row is gone and four `dsh-ops-mode-*` rows every one of
// which plans a Windows shell. The removal must walk the whole set.

test('ops-adopt: the row set spans the legacy row and all four mode rows', () => {
  assert.deepEqual([...OPS_MODE_ROW_IDS], [
    'dsh-ops-mode-minimal',
    'dsh-ops-mode-standard',
    'dsh-ops-mode-ptc',
    'dsh-ops-mode-cordis',
  ], 'dsh-ops 0.4.3 cordis.patch.yml row ids')
  assert.deepEqual([...OPS_SHELL_ROW_IDS], [OPS_SHELL_ROW_ID, ...OPS_MODE_ROW_IDS],
    'the legacy row stays first so a mixed profile writes both eras')
  const source = readFileSync(new URL('../src/ops-adopt.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.match(source, /MODE_PLANS\[\*\]\.shell/, 'the module records WHY every mode row can publish bash')
})

test('ops-adopt: a 0.4.3 profile disables publishBashTool on every mode row', async () => {
  const rows = OPS_MODE_ROW_IDS.map((id) => rowOf(id, {}, { promptPolicy: true }))
  const editor = fakeOpsEditor({ rows })
  const result = await adoptOpsBashRemoval(editor)
  assert.equal(result.status, 'adopted')
  assert.deepEqual(editor.state.edits, [...OPS_MODE_ROW_IDS], 'one official editor write per mode row')
  for (const row of editor.state.rows) assert.equal(row.override.publishBashTool, false, row.entry.options.id)
  assert.equal(opsRowList(result), OPS_MODE_ROW_IDS.join(', '), 'the log names every row it touched')
})

test('ops-adopt: a mixed profile adopts the live rows and respects the settled ones', async () => {
  const editor = fakeOpsEditor({ rows: [
    rowOf(OPS_SHELL_ROW_ID, { publishBashTool: false, promptPolicy: true }, { publishBashTool: true }),
    rowOf('dsh-ops-mode-standard', {}, { publishBashTool: true }),
    rowOf('dsh-ops-mode-ptc', {}, { publishBashTool: false }),
  ] })
  const result = await adoptOpsBashRemoval(editor)
  assert.equal(result.status, 'adopted')
  assert.deepEqual(editor.state.edits, ['dsh-ops-mode-standard'], 'only the row that still publishes is written')
  const byId = Object.fromEntries(result.rows.map((row) => [row.id, row.action]))
  assert.equal(byId[OPS_SHELL_ROW_ID], 'present')
  assert.equal(byId['dsh-ops-mode-standard'], 'adopt')
  assert.equal(byId['dsh-ops-mode-ptc'], 'unchanged-inherited-off')
})

test('ops-adopt: a disabled mode row is never written, and all-disabled settles quietly', async () => {
  const disabledRow = { entry: { options: { id: 'dsh-ops-mode-ptc', disabled: true } }, override: {}, inherited: {} }
  assert.equal(planOpsAdopt(disabledRow).action, 'skip-disabled', 'a disabled row publishes nothing to remove')
  const editor = fakeOpsEditor({ rows: [disabledRow] })
  const result = await adoptOpsBashRemoval(editor)
  assert.equal(result.status, 'skip-disabled-rows')
  assert.deepEqual(editor.state.edits, [])
  assert.match(opsAdoptReport(result), /every dsh-ops shell row is disabled/)
})

test('ops-adopt: restore lifts our value from every mode row and leaves the user\'s earlier ON alone', async () => {
  const editor = fakeOpsEditor({ rows: [
    rowOf('dsh-ops-mode-minimal', { publishBashTool: false, promptPolicy: true }, { publishBashTool: true, promptPolicy: false }),
    rowOf('dsh-ops-mode-cordis', { publishBashTool: false }, {}),
    rowOf('dsh-ops-mode-standard', { publishBashTool: true }, { publishBashTool: true }),
  ] })
  const result = await restoreOpsBash(editor)
  assert.equal(result.status, 'restored')
  assert.deepEqual(editor.state.edits, ['dsh-ops-mode-minimal', 'dsh-ops-mode-cordis'])
  const minimal = editor.state.rows.find((row) => row.entry.options.id === 'dsh-ops-mode-minimal')
  assert.equal(minimal.override.publishBashTool, true, 'restored to the inherited value')
  assert.equal(minimal.override.promptPolicy, true, 'the user\'s own keys survive')
  const cordis = editor.state.rows.find((row) => row.entry.options.id === 'dsh-ops-mode-cordis')
  assert.equal('publishBashTool' in cordis.override, false, 'no inherited value: the key goes away')
  const standard = editor.state.rows.find((row) => row.entry.options.id === 'dsh-ops-mode-standard')
  assert.equal(standard.override.publishBashTool, true, 'the user\'s later ON choice is left alone')
})
