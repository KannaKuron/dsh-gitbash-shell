import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { translateDispatch, programLanguageFor } from '../src/path-dialect.js'
import { adoptOpsBashRemoval, restoreOpsBash } from '../src/ops-adopt.js'

const env = { tmpDir: 'C:/Temp', home: 'C:/Users/test', gitRoot: 'C:/Git' }
test('audit: only confirmed TypeScript programs receive JS translation; Python and unknown preserve source', () => {
  const code = 'print("/c/test.txt")'
  for (const language of ['python', undefined, 'unknown']) {
    const args = { code }
    assert.equal(translateDispatch({ name: 'run_code', arguments: args }, { codePaths: true }, env, language), args)
  }
  const out = translateDispatch({ name: 'run_code', arguments: { code: 'return "/c/test.txt"' } }, { codePaths: true }, env, 'typescript')
  assert.match(out.code, /^try\{const e=process.env/)
  assert.match(out.code, /C:\/test.txt/)
  const parent = { get: () => ({ language: 'typescript' }) }
  assert.equal(programLanguageFor(parent, { ctx: { get: () => ({ language: 'python' }) } }), 'python')
  assert.equal(programLanguageFor(parent, { ctx: { get: () => undefined } }), undefined)
  assert.equal(programLanguageFor(parent), 'typescript')
  assert.equal(programLanguageFor({ get() { throw Error('unavailable') } }), undefined)
})

test('audit: ops ownership survives a separate process and never claims original false', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gitbash-ops-receipt-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const documentPath = join(dir, 'cordis.patch.yml')
  const moduleUrl = new URL('../src/ops-adopt.js', import.meta.url).href
  const source = `import { adoptOpsBashRemoval } from ${JSON.stringify(moduleUrl)};
    const row={entry:{options:{id:'dsh-ops'}},inherited:{},override:{standard:{bash:false,keep:123},cordis:{bash:true}}};
    const editor={documentPath:${JSON.stringify(documentPath)},configuration:()=>[row],edit:async(e,fn)=>{row.override=fn(row.override,row.inherited)}};
    await adoptOpsBashRemoval(editor); console.log(JSON.stringify(row));`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', windowsHide: true })
  assert.equal(child.status, 0, child.stderr)
  const row = JSON.parse(child.stdout)
  const receipt = JSON.parse(readFileSync(join(dir, '.gitbash-ops-ownership.json'), 'utf8'))
  assert.equal(receipt.fields.standard, undefined)
  assert.deepEqual(receipt.fields.cordis, { hadOverride: true, value: true })
  const editor = { documentPath, configuration: () => [row], edit: async (_entry, fn) => { row.override = fn(row.override, row.inherited) } }
  assert.equal((await adoptOpsBashRemoval(editor)).status, 'present')
  assert.equal((await restoreOpsBash(editor)).status, 'restored')
  assert.deepEqual(row.override, { standard: { bash: false, keep: 123 }, cordis: { bash: true } })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.gitbash-ops-ownership.json'), 'utf8')).fields, {})
})

test('audit: rejected adoption never owns a future user false; concurrent edits are preserved', async () => {
  for (const scenario of ['rejected', 'concurrent']) {
    const row = { entry: { options: { id: 'dsh-ops' } }, inherited: {}, override: {} }
    const editor = { configuration: () => [structuredClone(row)], async edit(_entry, change) {
      if (scenario === 'rejected') throw Error('fixed write failure')
      row.override.standard = { bash: false }
      row.override = change(row.override, row.inherited)
    } }
    assert.equal((await adoptOpsBashRemoval(editor)).status, 'write-failed')
    row.override.standard = { bash: false }
    editor.edit = async (_entry, change) => { row.override = change(row.override, row.inherited) }
    await restoreOpsBash(editor)
    assert.equal(row.override.standard.bash, false, scenario)
  }
})
