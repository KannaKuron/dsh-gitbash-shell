/**
 * dsh-gitbash-shell — official-preset alignment evidence (AGENTS.md §9①).
 *
 * Compares the declarative composition data in src/compositions.js against the
 * preset texts the AUTHORITATIVE dsh checkout ships, row by row:
 * id sequence, nesting depth, `name`, group flags and `disabled` semantics.
 * It is deliberately NOT part of `npm test`: it needs a dsh source checkout,
 * which a user's machine does not have.
 *
 *   node tests/align-official.mjs [/path/to/deepseek-harness]
 *   DSH_HARNESS_SRC=/path/to/deepseek-harness node tests/align-official.mjs
 *
 * The pinned PRESET_SHA256 map records the host revision this plugin was
 * verified against. A mismatch is not automatically a bug — it means the host
 * preset text CHANGED and every variant must be re-diffed by hand before this
 * file's pins are updated (the drift this script exists to catch).
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { minimalPluginsFor, pluginsFor } from '../src/compositions.js'

/** dsh-v0.2.2-rc.1, packages/bundle/web-app/presets/*.patch.yml.
 * Baseline: the single-generation row set of 0.2.2-rc.1. The full presets
 * carry `config: { applyPatch: false }` on tool-fs, manager/market gates ride
 * the live profile context, subagent uses modelSelection/modelDiscovery, and
 * list-agents lives in tool-subagent-control. Optional rows (time-context,
 * tool-schedule, plugin-market, compaction) are package-probed at runtime, so
 * oursOf passes the full-probe hostExtras set below. */
const PRESET_SHA256 = {
  standard: '3006cc3780cddaa7fb0089e5854e6bbef4409cf1d425930fd835226b95660afd',
  cordis: '0e8f611644b3c36249808c4d7eb7a40d78006d04da6b55eef1a42797a5a34355',
  ptc: 'ce02148b1fd575cc93071744180468cd305bdcd50dbfdd3b9b0605c5281d283d',
  minimal: 'a2a9ba1c9c392a45466708f18bc0aefbf300577f9b544dc06049f73a8a5b3267',
}

/** Only minimal's persistent terminal differs from the official shell rows.
 * Full variants retain the official platform gates for inline patching. */
const GIT_BASH_ROWS = new Map([
  ['terminal-bash', false], ['persistent-bash', false],
  ['terminal-pwsh', true], ['persistent-pwsh', true],
])

const KINDS = {
  'standard-gitbash': 'standard',
  'code-gitbash': 'ptc',
  'cordis-gitbash': 'cordis',
  'minimal-gitbash': 'minimal',
}

/**
 * Extract the row sequence under `insert[0].config.plugins` of one preset
 * patch. Line scanning, not YAML parsing: the patch carries `!!js` scalars and
 * block strings no generic parser may round-trip.
 * @param {string} text - the patch file contents.
 * @returns {{depth:number,id:string,name:string,disabled:string|undefined,group:boolean}[]}
 */
export function rowsOf(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^\s*plugins:\s*$/.test(line))
  if (start < 0) throw new Error('this patch has no plugins: block')
  const baseIndent = lines[start].match(/^ */)[0].length
  const rows = []
  let current
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const indent = line.match(/^ */)[0].length
    if (indent <= baseIndent) break
    const row = /^(\s*)- id:\s*(.+?)\s*$/.exec(line)
    if (row) {
      current = { depth: row[1].length, id: row[2], name: '', disabled: undefined, group: false }
      rows.push(current)
      continue
    }
    if (current === undefined) continue
    const prop = /^(\s*)(name|disabled|group):\s*(.*?)\s*$/.exec(line)
    if (prop === null || prop[1].length <= current.depth) continue
    if (prop[2] === 'name' && current.name === '') current.name = prop[3].replace(/^['"]|['"]$/g, '')
    else if (prop[2] === 'disabled' && current.disabled === undefined) current.disabled = prop[3]
    else if (prop[2] === 'group' && prop[3] === 'true') current.group = true
  }
  // Nesting depth is reported in levels below the first row (top-level rows);
  // the patch indents one level with four spaces.
  const top = rows.length > 0 ? rows[0].depth : 0
  return rows.map((row) => ({ ...row, depth: (row.depth - top) / 4 }))
}

/**
 * Normalize a `disabled` fact into this variant's own boolean. Official rows
 * use `!!js` platform expressions; our variants carry a concrete boolean.
 * @param {string|undefined} raw - the extracted official `disabled` text.
 * @param {'unix'|'win32'} platform - which branch to evaluate.
 * @returns {boolean|'profile-context'|undefined}
 */
function officialDisabled(raw, platform) {
  if (raw === undefined) return undefined
  if (raw === 'true') return true
  if (raw === 'false') return false
  const win = platform === 'win32'
  if (/^!!js process\.platform === 'win32'$/.test(raw)) return win
  if (/^!!js process\.platform !== 'win32'$/.test(raw)) return !win
  if (/profileContext/.test(raw)) return 'profile-context'
  throw new Error('unknown disabled expression: ' + raw)
}

/**
 * Flatten our declarative rows (groups carry their children in `config`).
 * @param {object[]} rows - pluginsFor()/minimalPluginsFor() output.
 * @param {number} depth - nesting depth of this level.
 * @returns {{depth:number,id:string,name:string,disabled:boolean|undefined,group:boolean}[]}
 */
export function flatten(rows, depth = 0) {
  const out = []
  for (const row of rows) {
    out.push({
      depth,
      id: row.id,
      name: row.name,
      disabled: row.disabled === true,
      group: row.group === true,
    })
    if (Array.isArray(row.config)) out.push(...flatten(row.config, depth + 1))
  }
  return out
}

/** Our rows for one variant id, with the Git Bash delta applied.
 * The optional-row probe is ON: the alignment target is the 0.2.2-rc.1 text
 * including time-context, tool-schedule, plugin-market and compaction. */
function oursOf(variant, platform) {
  const kind = KINDS[variant]
  if (kind === 'minimal') return flatten(minimalPluginsFor({ hostExtras: { compaction: true } }))
  // Force the win32/unix platform branch independently of the machine running
  // this audit. This pure composition module has no imports or runtime effects.
  const source = readFileSync(new URL('../src/compositions.js', import.meta.url), 'utf8').replace(/^export /gm, '')
  const compose = new Function('process', source + '\nreturn pluginsFor')({ platform: platform === 'win32' ? 'win32' : 'linux' })
  return flatten(compose({ kind, skillsDir: kind === 'cordis' ? '<skillsDir>' : undefined, hostExtras: { timeContext: true, toolSchedule: true, pluginMarket: true, compaction: true, profileContext: true } }))
}

const reported = []

/** Compare one variant; pushes human-readable failure lines. */
function compareVariant(variant, officialRows, platform) {
  const ours = oursOf(variant, platform)
  const label = variant + ' [official ' + platform + ' branch]'
  if (officialRows.length !== ours.length) {
    reported.push(`${label}: row count ${ours.length} != official ${officialRows.length}`)
    reported.push('  ours:     ' + ours.map((row) => row.id).join(' '))
    reported.push('  official: ' + officialRows.map((row) => row.id).join(' '))
    return
  }
  for (let index = 0; index < ours.length; index += 1) {
    const mine = ours[index]
    const theirs = officialRows[index]
    const where = `${label} #${index}`
    if (mine.id !== theirs.id) reported.push(`${where}: id ${mine.id} != ${theirs.id}`)
    if (mine.depth !== theirs.depth) reported.push(`${where} (${mine.id}): depth ${mine.depth} != ${theirs.depth}`)
    if (mine.group !== theirs.group) reported.push(`${where} (${mine.id}): group ${mine.group} != ${theirs.group}`)
    if (mine.name !== theirs.name) reported.push(`${where} (${mine.id}): name ${mine.name} != ${theirs.name}`)
    const disabled = officialDisabled(theirs.disabled, platform)
    if (disabled === 'profile-context') {
      // Official cordis keeps the plugin-manager tool live wherever a profile
      // context exists (every web deployment); our variant has no expression
      // language, so "enabled" is the faithful mirror.
      if (mine.disabled) reported.push(`${where} (${mine.id}): official is profile-context-gated, ours is disabled`)
      continue
    }
    if (platform === 'win32' && GIT_BASH_ROWS.has(mine.id)) {
      // Exact, row-local exceptions only: full variants receive their private
      // bash at agent creation; minimal owns a separate persistent terminal.
      const expected = GIT_BASH_ROWS.get(mine.id)
      if (mine.disabled !== expected) reported.push(`${where} (${mine.id}): Git Bash delta lost (disabled ${mine.disabled})`)
      continue
    }
    if (mine.disabled !== (disabled === true)) {
      reported.push(`${where} (${mine.id}): disabled ${mine.disabled} != official ${String(disabled)}`)
    }
  }
}

const harness = process.argv[2] ?? process.env.DSH_HARNESS_SRC ?? '/Users/kanna/project/deepseek-harness'
const dir = join(harness, 'packages/bundle/web-app/presets')
let failed = false

for (const [name, pinned] of Object.entries(PRESET_SHA256)) {
  let text
  try {
    text = readFileSync(join(dir, `${name}.patch.yml`), 'utf8')
  } catch (error) {
    console.error(`SKIP ${name}: cannot read ${join(dir, `${name}.patch.yml`)} (${error.message})`)
    failed = true
    continue
  }
  const digest = createHash('sha256').update(text).digest('hex')
  const pinMatches = digest.startsWith(pinned)
  console.log(`${pinMatches ? 'OK  ' : 'DRIFT'} ${name}.patch.yml sha256=${digest.slice(0, 16)} pinned=${pinned}`)
  if (!pinMatches) {
    console.error('  the official preset text CHANGED since dsh-v0.2.2-rc.1: re-diff every variant by hand, then update PRESET_SHA256')
    failed = true
  }
  const rows = rowsOf(text)
  for (const variant of Object.keys(KINDS)) {
    if (variant === 'minimal-gitbash' && name !== 'minimal') continue
    if (variant !== 'minimal-gitbash' && KINDS[variant] !== name) continue
    compareVariant(variant, rows, 'unix')
    compareVariant(variant, rows, 'win32')
  }
  console.log(`  ${rows.length} official rows`)
}

if (reported.length > 0) {
  console.error('\nalignment failures:')
  for (const line of reported) console.error('  ' + line)
  failed = true
} else {
  console.log('\nalignment OK: all four variants mirror the official row sequence')
}
process.exit(failed ? 1 : 0)
