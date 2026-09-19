/**
 * dsh-gitbash-shell — host half (preset materialization).
 *
 * Installed as a profile bundle, this plugin swaps Windows' PowerShell shell
 * for Git for Windows bash (the executor lives in ./shell.js). On startup it
 * also materializes four Git Bash agent presets into the FIRST user-trust
 * preset root, mirroring how dsh-ptc-cordis-preset ships its 'ptc-cordis'
 * preset:
 *
 *   standard-gitbash — 标准模式 · Git Bash (tool-bash on, tool-pwsh off)
 *   minimal-gitbash  — 极简模式 · Git Bash (persistent Git Bash terminal)
 *   code-gitbash     — PTC 模式 · Git Bash (Code Mode presentation)
 *   cordis-gitbash   — 创造模式 · Git Bash (self-modifying toolset; skills
 *                       copied from the INSTALLED shipped 'cordis' preset so
 *                       the guidance tracks the deployment)
 *
 * Each preset directory carries a .plugin-managed.json marker recording the
 * hash of every file this plugin wrote. Ownership rules (per preset):
 *   - absent           → materialize;
 *   - foreign          → written by someone else: never touch;
 *   - user-modified    → ours but edited: never touch again (delete the
 *                        directory to re-materialize);
 *   - unmodified       → refreshed only when the plugin version changed (or,
 *                        for cordis-gitbash, when the live skills source
 *                        drifted); otherwise idle.
 *
 * Uninstall hygiene mirrors dsh-ptc-cordis-preset: on disposal, a package
 * directory that still exists means reload/update/restart — keep the
 * presets; a vanished package.json means uninstall — remove each preset the
 * user never modified.
 *
 * ERA SPLIT (v0.6.0): dsh renamed the built-in `code` preset to `ptc` in
 * 0.1.2 with no compatibility alias (tool-presentation `mode` value, plus new
 * built-in rows), so each variant ships BOTH committed era texts where the
 * built-in changed (minimal did not — one text serves both). The era is
 * probed per boot from the roster (`ptc` → dsh >= 0.1.2, else `code`),
 * recorded in the marker (`base`), and a flipped detection re-materializes
 * on the next startup — either upgrade order converges, and preset IDS never
 * change (sessions are pinned to them; `code-gitbash` keeps its historical
 * id even though its dsh >= 0.1.2 text presents through the `ptc` built-in).
 */

import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-gitbash-shell'

/** The preset roster is a hard dependency: without it there is nothing to do. */
export const inject = ['agentPresets']

const TAG = '[gitbash-shell]'
const MANAGED_BY = 'dsh-gitbash-shell'
const MARKER_FILE = '.plugin-managed.json'

/** Default preset ids this plugin materializes, in roster order (configurable). */
export const PRESET_IDS = ['standard-gitbash', 'minimal-gitbash', 'code-gitbash', 'cordis-gitbash']

/** Git Bash binary default — must match src/shell.js. */
const DEFAULT_GIT_BASH = 'C:/Program Files/Git/bin/bash.exe'

/** The shipped preset whose skills/ dir seeds cordis-gitbash. */
const SKILLS_SOURCE_PRESET = 'cordis'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(here, '..')

// ── tree hashing ────────────────────────────────────────────────────────────

/** Every file under `root`, as sorted relative POSIX-style paths. */
function walkFiles(root, rel = '') {
  const out = []
  let entries
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walkFiles(root, r))
    else if (e.isFile()) out.push(r)
  }
  return out.sort()
}

/** Map of relative path → sha256 for every file under `root`. */
function hashTree(root) {
  const files = {}
  for (const rel of walkFiles(root)) {
    if (rel === MARKER_FILE) continue
    files[rel] = createHash('sha256').update(readFileSync(join(root, rel))).digest('hex')
  }
  return files
}

/** The parsed marker, or null when the tree is not ours. */
function readMarker(target) {
  try {
    const m = JSON.parse(readFileSync(join(target, MARKER_FILE), 'utf8'))
    if (m && m.managedBy === MANAGED_BY && m.files && typeof m.files === 'object') return m
  } catch {
    /* absent or unreadable → not ours */
  }
  return null
}

/** Classify a preset directory: absent | foreign | user-modified | unmodified. */
function classify(target) {
  if (!existsSync(target)) return 'absent'
  const marker = readMarker(target)
  if (!marker) return 'foreign'
  const current = hashTree(target)
  const recorded = marker.files
  const keys = Object.keys(recorded)
  if (keys.length !== Object.keys(current).length) return 'user-modified'
  for (const k of keys) if (current[k] !== recorded[k]) return 'user-modified'
  return 'unmodified'
}

/** 'skills/<rel>' → sha256 map of a skills source tree, or null when absent. */
function skillsHashes(source) {
  if (!source || !existsSync(source)) return null
  const out = {}
  for (const rel of walkFiles(source)) {
    out[`skills/${rel}`] = createHash('sha256').update(readFileSync(join(source, rel))).digest('hex')
  }
  return out
}

// ── built-in era detection (dsh 0.1.2 renamed the `code` preset to `ptc`) ──

/**
 * Which built-in PTC preset does the installed dsh ship? dsh 0.1.2 renamed
 * the preset id `code` to `ptc` with no compatibility alias, so the variant
 * compositions are era-specific where the built-in changed. The roster probe
 * is the version-agnostic signal. Pure companion of `detectBase`; 'ptc' wins
 * if both ids somehow exist, and an unknown roster conservatively maps to
 * 'code' — the era text the stable release accepted.
 */
function baseForRoster(ids) {
  const set = new Set(ids)
  if (set.has('ptc')) return 'ptc'
  return 'code'
}

/** Async probe against the live roster; never throws. */
async function detectBase(agentPresets) {
  try {
    const list = await agentPresets.list()
    return baseForRoster((Array.isArray(list) ? list : []).map((p) => p && p.id))
  } catch (error) {
    console.log(`${TAG} built-in preset probe failed (${error?.message ?? error}) — assuming the 'code' era`)
    return 'code'
  }
}

/** Era suffix for committed composition assets: ptc-era files carry `.ptc`. */
function eraSuffix(base) {
  return base === 'ptc' ? '.ptc' : ''
}

// ── persona-form detection (dsh 0.1.3-alpha.2 split the persona row) ──────

/**
 * Which persona config shape does one composition text use? 0.1.3-alpha.2
 * (40792330c0) split dsh-persona's single `text` key into `prefix:` +
 * `suffix:` with no compatibility alias, so compositions carrying a persona
 * row are persona-form-specific. Pure companion of `detectPersonaEra`.
 */
export function personaEraForText(text) {
  return /- id:\s*persona[\s\S]{0,600}?\bprefix:/.test(text) ? 'split' : 'text'
}

/**
 * Async probe of a SHIPPED preset's composition through the live roster;
 * never throws. Built-in ids only — this plugin's own variants sit on the
 * roster too and would echo whichever form they were materialized with. The
 * roster entry path is the preset file (or its directory); either way we
 * read agent.cordis.yml. A missing probe conservatively maps to 'text'.
 */
export async function detectPersonaEra(agentPresets) {
  try {
    const list = await agentPresets.list()
    const entries = Array.isArray(list) ? list : []
    const entry = ['ptc', 'standard', 'cordis', 'minimal']
      .map((id) => entries.find((p) => p && p.id === id && typeof p.path === 'string'))
      .find(Boolean)
    if (!entry) return 'text'
    const file = /\.yml$/.test(entry.path) ? entry.path : join(entry.path, 'agent.cordis.yml')
    return personaEraForText(readFileSync(file, 'utf8'))
  } catch (error) {
    console.log(`${TAG} persona-form probe failed (${error?.message ?? error}) — assuming the pre-split 'text' form`)
    return 'text'
  }
}

/**
 * Does the SHIPPED composition already carry the official `present` row? The
 * row (`@deepseek-ai/dsh-tool-present`, immutable file-delivery download
 * cards) first shipped with dsh 0.1.5-alpha.2, and a composition row that
 * cannot be imported rejects the WHOLE preset mount — so the row is injected
 * only on hosts whose own shipped presets have it. The live roster is the
 * authority: package resolution alone would lie on CLI installs (first-party
 * packages live outside the profile) and on linked development trees.
 * `minimal` never gains the row (single-tool preset). Never throws.
 */
async function detectPresentSupport(agentPresets) {
  try {
    const list = await agentPresets.list()
    const entries = Array.isArray(list) ? list : []
    const entry = ['ptc', 'standard', 'cordis']
      .map((id) => entries.find((p) => p && p.id === id && typeof p.path === 'string'))
      .find(Boolean)
    if (!entry) return false
    const file = /\.yml$/.test(entry.path) ? entry.path : join(entry.path, 'agent.cordis.yml')
    return readFileSync(file, 'utf8').includes("'@deepseek-ai/dsh-tool-present'")
  } catch (error) {
    console.log(`${TAG} present-row probe failed (${error?.message ?? error}) — not injecting the row`)
    return false
  }
}

/** Row ids the shipped workflow-engine row has answered to (dsh 0.1.6 renamed it). */
const ENGINE_ROW_IDS = ['workflow-worker-thread', 'workflow-ptc']

/** Which built-in preset each of this plugin's variants mirrors, for row-form lookup. */
export const ROW_SOURCE = {
  'standard-gitbash': 'standard',
  'cordis-gitbash': 'cordis',
  'code-gitbash': 'ptc',
}

/** Leading whitespace of one line (pure). */
function indentOf(line) {
  return line.slice(0, line.length - line.trimStart().length)
}

/** The unquoted value of a name line, or undefined when the line is not one (pure). */
function quotedName(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('name: ')) return undefined
  const raw = trimmed.slice(6).trim()
  if (raw.length > 1 && raw.charAt(0) === "'" && raw.charAt(raw.length - 1) === "'") return raw.slice(1, -1)
  return raw
}

/**
 * Read ONE row's spelling out of a composition text (pure): the name value
 * that follows its id line and whether the row's own block turns it off before
 * the next row starts. Returns undefined when the row is absent, and never
 * throws, so a composition that legitimately lacks the row (minimal) is simply
 * left alone.
 * @param text - composition text.
 * @param rowId - exact id value to locate.
 * @returns the row's spelling, or undefined.
 */
export function rowFormOf(text, rowId) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '- id: ' + rowId) continue
    const nameLine = i + 1 < lines.length ? lines[i + 1] : ''
    const name = quotedName(nameLine)
    if (name === undefined) continue
    let disabled = false
    let disabledIndent = indentOf(nameLine)
    for (let j = i + 2; j < lines.length; j += 1) {
      if (lines[j].trim().startsWith('- id: ')) break
      if (lines[j].trim() === 'disabled: true') {
        disabled = true
        disabledIndent = indentOf(lines[j])
        break
      }
    }
    return { id: rowId, name, indent: indentOf(lines[i]), nameIndent: indentOf(nameLine), disabled, disabledIndent }
  }
  return undefined
}

/**
 * Read the two rows this plugin's committed compositions must track out of a
 * SHIPPED composition text (pure). The built-in preset is the authority: it
 * mounts on this host by construction, so whatever it spells is mountable
 * here, on every era, without shipping one asset variant per rename.
 * @param text - a shipped agent.cordis.yml.
 * @returns an object with the engine row and the tool-ralph row; either may be undefined.
 */
export function rowFormsOf(text) {
  let engine
  for (const id of ENGINE_ROW_IDS) {
    engine = rowFormOf(text, id)
    if (engine !== undefined) break
  }
  return { engine, ralph: rowFormOf(text, 'tool-ralph') }
}

/**
 * Align the workflow-engine row with the host's own spelling (pure,
 * idempotent, plain string surgery — never a YAML round-trip, so !!js literals
 * survive).
 *
 * dsh 0.1.6-alpha.1 renamed this row workflow-worker-thread to workflow-ptc
 * AND deleted the old package. A composition row whose module fails to import
 * rejects the WHOLE preset mount (agent-presets mount.ts), so a committed old
 * spelling breaks every Git Bash preset on the new host while the new spelling
 * breaks them on hosts that still ship only the old package. The materializer
 * therefore copies the row out of the host's own built-in preset instead of
 * pinning either spelling.
 * @param text - composition text.
 * @param form - the host's engine row from rowFormsOf, or undefined to leave the text alone.
 * @param options - engineEnabled forces the row on regardless of the host's own state.
 * @returns the aligned text.
 */
export function alignEngineRow(text, form, options) {
  if (!form) return text
  const engineEnabled = Boolean(options && options.engineEnabled)
  let current
  for (const id of ENGINE_ROW_IDS) {
    current = rowFormOf(text, id)
    if (current !== undefined) break
  }
  if (current === undefined) return text
  const head = '- id: ' + current.id + '\n' + current.nameIndent + "name: '" + current.name + "'"
  const wanted = '- id: ' + form.id + '\n' + current.nameIndent + "name: '" + form.name + "'"
  const wantOff = engineEnabled ? false : form.disabled
  let out = text.replace(head, wanted)
  if (wantOff && !current.disabled) {
    out = out.replace(wanted + '\n', wanted + '\n' + current.nameIndent + 'disabled: true\n')
  } else if (!wantOff && current.disabled) {
    out = out.replace(wanted + '\n' + current.disabledIndent + 'disabled: true\n', wanted + '\n')
  }
  return out
}

/**
 * Align the tool-ralph row with the host's own default (pure, idempotent).
 * dsh 0.1.6-alpha.1 ships ralph disabled in every built-in preset: its tool
 * description restricts it to runs the human explicitly asked for. The row
 * still imports on older hosts, so this is a semantics alignment rather than a
 * mount fix — but a composition claiming to mirror the built-in preset should
 * not silently re-enable a tool the deployment turned off.
 * @param text - composition text.
 * @param form - the host's tool-ralph row from rowFormsOf, or undefined.
 * @returns the aligned text.
 */
export function alignRalphRow(text, form) {
  if (!form) return text
  const current = rowFormOf(text, 'tool-ralph')
  if (current === undefined) return text
  const head = '- id: tool-ralph\n' + current.nameIndent + "name: '" + current.name + "'"
  if (form.disabled && !current.disabled) {
    return text.replace(head + '\n', head + '\n' + current.nameIndent + 'disabled: true\n')
  }
  if (!form.disabled && current.disabled) {
    return text.replace(head + '\n' + current.disabledIndent + 'disabled: true\n', head + '\n')
  }
  return text
}

/**
 * Probe every built-in preset this plugin's variants mirror for those row
 * spellings (never throws). The live roster is the authority — package
 * resolution alone would lie on linked development trees and on CLI installs
 * whose first-party packages live outside the profile.
 * @param agentPresets - the roster service.
 * @returns a map of row forms per available built-in id, or undefined.
 */
async function detectRowForms(agentPresets) {
  try {
    const list = await agentPresets.list()
    const entries = Array.isArray(list) ? list : []
    const out = {}
    for (const id of ['ptc', 'standard', 'cordis']) {
      const entry = entries.find((p) => p && p.id === id && typeof p.path === 'string')
      if (!entry) continue
      const file = /\.yml$/.test(entry.path) ? entry.path : join(entry.path, 'agent.cordis.yml')
      out[id] = rowFormsOf(readFileSync(file, 'utf8'))
    }
    return Object.keys(out).length > 0 ? out : undefined
  } catch (error) {
    console.log(TAG + ' row-form probe failed (' + (error && error.message ? error.message : error) + ') — keeping the committed spellings')
    return undefined
  }
}

/**
 * Marker fingerprint of the row spellings one variant is aligned to, so a host
 * that renames (or re-defaults) them re-materializes on the next boot.
 * @param rows - detectRowForms result.
 * @param presetId - the variant being materialized.
 * @returns a short stable string, '' when nothing was probed.
 */
function rowFingerprint(rows, presetId) {
  const source = ROW_SOURCE[presetId]
  const form = rows && source ? rows[source] : undefined
  if (!form || !form.engine) return ''
  const ralph = form.ralph === undefined ? 'na' : (form.ralph.disabled ? 'off' : 'on')
  return form.engine.id + ':' + (form.engine.disabled ? 'off' : 'on') + ':' + ralph
}

/**
 * Pick the committed composition asset inside one variant directory (pure).
 * The ptc-era twin is preferred when the roster says `ptc`; the persona-split
 * twin (`.ps`, v0.12.0) is preferred when the shipped persona row carries the
 * split keys; variants without a twin fall back down the chain (minimal never
 * had a ptc twin and gained its `.ps` twin instead). Every candidate is a
 * committed file — no runtime text synthesis.
 */
function pickComposition(base, persona, available) {
  const era = eraSuffix(base)
  const ps = persona === 'split' ? '.ps' : ''
  const candidates = base === 'ptc'
    ? [`agent.cordis${era}${ps}.yml`, `agent.cordis${era}.yml`, ...(ps ? ['agent.cordis.ps.yml'] : []), 'agent.cordis.yml']
    : ['agent.cordis.yml']
  for (const file of candidates) if (available.includes(file)) return file
  return 'agent.cordis.yml'
}

/** Startup decision for an existing unmodified tree: 'refresh' or 'idle'. */
function syncDecision({ state, marker, version, sourceHashes, base = 'code', persona = 'text', present = false, pluginManager = false, rows = '' }) {
  if (state !== 'unmodified' || !marker) return 'refresh'
  if (marker.version !== version) return 'refresh'
  if (marker.base !== base) return 'refresh'
  if ((marker.persona ?? 'text') !== persona) return 'refresh'
  // Host row-form flip: dsh 0.1.6-alpha.1 renamed the workflow-engine row and
  // deleted the package behind the old spelling. A composition row that cannot
  // be imported rejects the WHOLE preset mount, so a host reporting a
  // different spelling must re-materialize (same marker-dimension pattern as
  // persona and present).
  if ((marker.rows ?? '') !== rows) return 'refresh'
  // Host-capability flip: @deepseek-ai/dsh-tool-present first shipped with dsh
  // 0.1.5-alpha.2. A preset composed with the row on a host that lacks the
  // package REJECTS THE WHOLE MOUNT (mount.ts: a row whose module failed to
  // import already rejects the mount), so the row is injected only when the
  // host resolves it — and a host upgrade past that point must re-materialize
  // to gain it (same marker-dimension pattern as persona).
  if ((marker.present ?? false) !== present) return 'refresh'
  // Host-capability flip: @deepseek-ai/dsh-plugin-manager/tools first shipped
  // with dsh 0.1.6-alpha.2 — same mount-rejection stakes and the same marker
  // dimension pattern as present above.
  if ((marker.pluginManager ?? false) !== pluginManager) return 'refresh'
  const recorded = {}
  for (const k of Object.keys(marker.files)) if (k.startsWith('skills/')) recorded[k] = marker.files[k]
  if (sourceHashes === null) return Object.keys(recorded).length === 0 ? 'idle' : 'refresh'
  const live = Object.keys(sourceHashes)
  const seen = Object.keys(recorded)
  if (live.length !== seen.length) return 'refresh'
  for (const k of live) if (recorded[k] !== sourceHashes[k]) return 'refresh'
  return 'idle'
}

// ── materialization ─────────────────────────────────────────────────────────

/*
 * Conditional present-row injection (v0.13.0, dsh 0.1.5-alpha.2 sync). The
 * official ptc/standard/cordis compositions appended `- id: present / name:
 * '@deepseek-ai/dsh-tool-present'` (immutable file-delivery download cards).
 * The row is NOT committed into the ptc-era twin files: a host older than
 * 0.1.5-alpha.2 lacks the package, and a composition row that fails to
 * import rejects the WHOLE preset mount. Instead the materializer probes the
 * host (hostHasToolPresent) and splices the row in as PLAIN TEXT — anchor
 * string surgery only, never a YAML round-trip, so !!js literals survive.
 * Placement mirrors the official compositions: right after the
 * tool-presentation block when the composition has one (all ptc-derived
 * twins), otherwise appended at the tail (cordis/standard twins). Only
 * `.ptc.` files are ever touched: code-era (<= 0.1.1) snapshots and the
 * minimal variants are frozen history (official minimal never gained the
 * row — it is the single-tool preset).
 */
const PRESENT_ROW = "\n- id: present\n  name: '@deepseek-ai/dsh-tool-present'\n"
const PRESENT_ANCHOR = "  name: '@deepseek-ai/dsh-agent-tool-presentation'\n  config:\n    mode: ptc\n"

function injectPresentRow(text) {
  if (text.includes("'@deepseek-ai/dsh-tool-present'")) return text
  const at = text.indexOf(PRESENT_ANCHOR)
  if (at !== -1) return text.slice(0, at + PRESENT_ANCHOR.length) + PRESENT_ROW + text.slice(at + PRESENT_ANCHOR.length)
  return text.endsWith('\n') ? text + PRESENT_ROW : text + '\n' + PRESENT_ROW
}

let toolPresentCache
/** Probe whether THIS host can resolve the present package (cached per boot). */
async function hostHasToolPresent() {
  if (toolPresentCache !== undefined) return toolPresentCache
  try {
    const { createRequire } = await import('node:module')
    createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tool-present')
    toolPresentCache = true
  } catch {
    toolPresentCache = false
  }
  return toolPresentCache
}

/*
 * Conditional plugin-manager-row injection (v0.15.0, dsh 0.1.6-alpha.2 sync).
 * Official ptc/standard/cordis gained `- id: tool-plugin-manager / name:
 * '@deepseek-ai/dsh-plugin-manager/tools'` (persistent plugin management;
 * the official ptc preset carries it DISABLED, Creation keeps it on). The
 * package only exists from 0.1.6-alpha.2 on, so the row is injected as plain
 * text behind a host probe — never committed into the assets — anchored
 * after the present row when there is one, else at the tail, mirroring the
 * official order (tool-presentation → present → tool-plugin-manager).
 * Per-variant shape mirrors each variant's official base: code-gitbash (ptc
 * base) DISABLED, standard/cordis-gitbash ENABLED, minimal untouched
 * (official minimal never gained the row), code-era files frozen history.
 */
const PLUGIN_MANAGER_ROW_ON = "- id: tool-plugin-manager\n  name: '@deepseek-ai/dsh-plugin-manager/tools'\n"
const PLUGIN_MANAGER_ROW_OFF = "- id: tool-plugin-manager\n  name: '@deepseek-ai/dsh-plugin-manager/tools'\n  disabled: true\n"
const PRESENT_ROW_FULL = "\n- id: present\n  name: '@deepseek-ai/dsh-tool-present'\n"

function injectPluginManagerRow(text, { enabled }) {
  if (text.includes("'@deepseek-ai/dsh-plugin-manager/tools'")) return text
  const body = enabled ? PLUGIN_MANAGER_ROW_ON : PLUGIN_MANAGER_ROW_OFF
  const at = text.indexOf(PRESENT_ROW_FULL)
  if (at !== -1) return text.slice(0, at + PRESENT_ROW_FULL.length) + body + text.slice(at + PRESENT_ROW_FULL.length)
  return text.endsWith('\n') ? text + body : text + '\n' + body
}


let pluginManagerToolsCache
/** Probe whether THIS host can resolve the plugin-manager tools package (cached per boot). */
async function hostHasPluginManagerTools() {
  if (pluginManagerToolsCache !== undefined) return pluginManagerToolsCache
  try {
    const { createRequire } = await import('node:module')
    createRequire(import.meta.url).resolve('@deepseek-ai/dsh-plugin-manager/tools')
    pluginManagerToolsCache = true
  } catch {
    pluginManagerToolsCache = false
  }
  return pluginManagerToolsCache
}

/** Write one preset directory from scratch. Returns 'ok' or 'no-skills-source'. */
function materialize({ target, presetId, skillsSource, version, base = 'code', persona = 'text', present = false, pluginManager = false, rows }) {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })

  const available = readdirSync(join(pkgDir, 'assets', presetId)).filter((f) => f.endsWith('.yml'))
  const compositionFile = pickComposition(base, persona, available)
  let composition = readFileSync(join(pkgDir, 'assets', presetId, compositionFile), 'utf8')
  if (present && compositionFile.includes('.ptc.')) composition = injectPresentRow(composition)
  // v0.15.0: ptc-era files only; the ptc-based variant mirrors the official
  // ptc DISABLED form, standard/cordis mirror their ENABLED bases, minimal is
  // untouched (official minimal never gained the row).
  if (pluginManager && compositionFile.includes('.ptc.') && presetId !== 'minimal-gitbash') {
    composition = injectPluginManagerRow(composition, { enabled: presetId !== 'code-gitbash' })
  }
  // Row-form alignment (v0.14.0): the committed assets pin one spelling of the
  // workflow-engine row, but a host renames it out from under them (dsh
  // 0.1.6-alpha.1) and a row whose module fails to import rejects the whole
  // mount. Copy the host's own spelling rather than shipping a third asset
  // variant per era. Absent probe = leave the frozen history untouched.
  const rowSource = ROW_SOURCE[presetId]
  const rowForm = rows && rowSource ? rows[rowSource] : undefined
  if (rowForm) {
    composition = alignEngineRow(composition, rowForm.engine)
    composition = alignRalphRow(composition, rowForm.ralph)
  }
  writeFileSync(join(target, 'agent.cordis.yml'), composition)
  writeFileSync(join(target, 'preset.yml'), readFileSync(join(pkgDir, 'assets', presetId, 'preset.yml')))

  let skills = 'none'
  if (presetId === 'cordis-gitbash') {
    if (skillsSource && existsSync(skillsSource)) {
      cpSync(skillsSource, join(target, 'skills'), { recursive: true, force: true, dereference: true })
      skills = 'copied'
    } else {
      mkdirSync(join(target, 'skills'), { recursive: true })
      skills = 'missing-source'
    }
  }

  const marker = { managedBy: MANAGED_BY, version, presetId, base, persona, present, pluginManager, rows: rowFingerprint(rows, presetId), files: hashTree(target) }
  writeFileSync(join(target, MARKER_FILE), JSON.stringify(marker, null, 2) + '\n')
  return skills
}

/** Disposal-time cleanup for one preset. */
function cleanupOnDispose({ target, packageJsonExists }) {
  if (packageJsonExists) return 'kept-package-intact'
  const state = classify(target)
  if (state === 'unmodified') {
    rmSync(target, { recursive: true, force: true })
    return 'removed'
  }
  return `kept-${state}`
}

// ── inspect-registry compatibility shim ─────────────────────────────────────
//
// The host-plane runner's inspect registry is a process-global singleton and
// its `register` THROWS on a duplicate provider id. `tool-cordis` registers
// the same provider ids from every preset that mounts it, so a process
// hosting both the built-in Creation mode and any cordis-derived preset
// (cordis-gitbash here, ptc-cordis from dsh-ptc-cordis-preset) fails the
// SECOND mount. Two registrants of the SAME package produce identical
// manifests, so replacing the stored entry instead of throwing is a no-op for
// consumers, and the identity-guarded disposer keeps teardown consistent.
// Installed once at boot by this always-mounted host row, so every later
// cordis toolset mount coexists.

const SHIM_FLAG = '__gitbashShellRegisterShim'

/** Wrap one inspect registry's `register` to tolerate duplicate registrations. */
export function installRegisterShim(reg) {
  const restore = () => {}
  if (!reg || typeof reg.register !== 'function' || !(reg.providers instanceof Map)) {
    return { installed: false, restore }
  }
  if (reg.register[SHIM_FLAG] === true) return { installed: false, restore }
  const original = reg.register
  try {
    const wrapped = function register(registration) {
      try {
        return original.call(this, registration)
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        if (!message.includes('is already registered')) throw error
        const manifest = registration && registration.manifest
        if (!manifest || typeof manifest.id !== 'string') throw error
        const stored = { ...registration, manifest }
        this.providers.set(manifest.id, stored)
        const self = this
        return () => {
          if (self.providers.get(manifest.id) === stored) self.providers.delete(manifest.id)
        }
      }
    }
    try { Object.defineProperty(wrapped, SHIM_FLAG, { value: true }) } catch { /* cosmetic */ }
    reg.register = wrapped
    return {
      installed: true,
      restore: () => {
        try { if (reg.register === wrapped) reg.register = original } catch { /* never block */ }
      },
    }
  } catch {
    return { installed: false, restore }
  }
}

// ── unified path dialect: settings namespace + gate (v0.9.0) ───────────────
//
// The dialect (directive + translation wrapper) is OFF by default and gated
// by the posixPaths boolean in the 'gitbash-shell' settings namespace,
// flipped from the Settings → Plugins card (src/client.js). The directive's
// text closure returns '' while off — empty context contributions are
// dropped at assembly, so a disabled dialect adds zero prompt noise; the
// wrapper reads the same value per dispatch and passes calls through.

const SETTINGS_NAMESPACE = 'gitbash-shell'

/** The full directive text, injected only while posixPaths is on. */
const POSIX_DIRECTIVE_TEXT = 'The working shell is Git for Windows bash: paths use MSYS drive roots (/c/Users/...), and every tool accepts that form directly — including the bash-native habits (~ home shorthand, /tmp, /dev/null, /usr/bin/...), which resolve in every tool exactly as bash itself resolves them.'

/** Strict drive-root-only directive (v0.19.0): used while virtualMounts is off. */
const POSIX_DIRECTIVE_TEXT_STRICT = 'The working shell is Git for Windows bash: paths use MSYS drive roots (/c/Users/...), and every tool accepts that form directly.'

/**
 * The run_code sentence is added ONLY for assemblies whose tool list actually
 * carries run_code (v0.20.1): a preset without it — standard/cordis sessions,
 * or a code-mode session whose tool row is disabled — has no program text to
 * write paths into, so the sentence would be pure noise there. Cheap and
 * honest: the tool list of the very assembly being rendered decides.
 */
const RUN_CODE_DIRECTIVE_TEXT = ' Path literals written inside a run_code program are translated the same way before the program runs; shell expansion is not available there, so spell paths out instead of relying on $VARS.'
const RUN_CODE_DIRECTIVE_STRICT_TEXT = ' Path literals written inside a run_code program are translated before the program runs.'

/** The run_code sentence for this assembly, or '' when the tool is not offered. */
export function runCodeHintFor(tools) {
  if (!Array.isArray(tools)) return ''
  for (const tool of tools) {
    const name = tool && typeof tool.name === 'string' ? tool.name : ''
    if (name === 'run_code') return RUN_CODE_DIRECTIVE_TEXT
  }
  return ''
}

// Official runtime counterpart to the directive (v0.11.0): dsh-shell-env is
// the host-plane registry behind the model-visible $DSH_* facts, and the
// bash tool's schema tells the model to inspect them — so the dialect also
// lives there, verifiable at runtime instead of only stated in the prompt.
const PATH_DIALECT_KEY = 'DSH_PATH_DIALECT'
const PATH_DIALECT_VALUE = 'msys'
const PATH_DIALECT_DESCRIPTION = 'Path dialect for tool calls and tool results: MSYS drive roots (/c/Users/...) plus the bash-native mounts (~, /tmp, /dev/null, /usr); every tool accepts these forms directly.'

// v0.21.1 — line endings for the MODEL's git commands live in the EXECUTOR
// (src/shell.js, withParityEnv): Windows Git defaults to core.autocrlf=true, so
// an LF file the model writes comes back CRLF after a checkout (scripts break on
// the stray \r, byte assertions fail), while a Linux guest has autocrlf=false.
// They cannot ride the shell-env registry below: that registry accepts DSH_*
// facts only, and a non-DSH key throws the whole contribution away.

/** Read the posixPaths switch from the live settings service; never throws. */
export function readPosixPaths(ctxLike) {
  try {
    const settings = ctxLike && typeof ctxLike.get === 'function' ? ctxLike.get('settings') : undefined
    const value = settings && typeof settings.get === 'function' ? settings.get(SETTINGS_NAMESPACE) : undefined
    return !!(value && value.posixPaths === true)
  } catch {
    return false
  }
}

/**
 * Read every dialect switch at once (v0.19.0): posixPaths gates the whole
 * dialect; virtualMounts gates the bash virtual mounts + ~ + $VAR expansion
 * (off = strict drive-root-only translation); globSplit gates the absolute
 * glob-pattern rewrite; errorDialect gates error-message translation and the
 * NUL guidance block; bashPath (optional) joins the Git-root probe candidates
 * first. All default ON (schema defaults); never throws.
 */
export function readDialectSettings(ctxLike) {
  const fallback = { posixPaths: false, virtualMounts: false, globSplit: false, errorDialect: false, codePaths: false, gitAutocrlf: false, bashPath: '' }
  try {
    const settings = ctxLike && typeof ctxLike.get === 'function' ? ctxLike.get('settings') : undefined
    const value = settings && typeof settings.get === 'function' ? settings.get(SETTINGS_NAMESPACE) : undefined
    const v = value && typeof value === 'object' ? value : {}
    return {
      posixPaths: v.posixPaths === true,
      virtualMounts: v.virtualMounts === true,
      globSplit: v.globSplit === true,
      errorDialect: v.errorDialect === true,
      codePaths: v.codePaths === true,
      gitAutocrlf: v.gitAutocrlf === true,
      bashPath: typeof v.bashPath === 'string' ? v.bashPath : '',
    }
  } catch {
    return fallback
  }
}

/**
 * Read the adoptSidebar switch (v0.15.0, default ON). Unlike posixPaths the
 * default is on, so only an explicit false disables the takeover.
 */
export function readAdoptSidebar(ctxLike) {
  try {
    const settings = ctxLike && typeof ctxLike.get === 'function' ? ctxLike.get('settings') : undefined
    const value = settings && typeof settings.get === 'function' ? settings.get(SETTINGS_NAMESPACE) : undefined
    return !(value && value.adoptSidebar === false)
  } catch {
    return true
  }
}

// Windows absolute path -> MSYS drive-root form, for rewriting PROSE in place
// (v0.10.0). Quoted spaced paths ("C:\Program Files\Git") are matched whole; a bare
// path stops at a closing punctuation and crosses a space ONLY into a token that
// itself carries a separator — so "C:\Program Files\Git\bin" comes back whole (v0.23.0)
// while "see C:\Users\kanna for details" keeps its prose. An unquoted path whose LAST
// segment holds the space (…\my dir\f.txt") stays ambiguous in prose; the model meets such
// a path as a whole-value FIELD, which never goes through here (driveToMsys).
// The lookbehind set rejects URL schemes (https:), file:// forms, and anything
// already mid-word, so only real drive-letter paths are translated. Separators
// normalize to single slashes.
const BARE_WIN_PATH = /(?<![A-Za-z0-9:\\/"'`])([A-Za-z]):(?:\\|\/)([^\s"'`<>|),;:!?]+(?: [^\s"'`<>|),;:!?]*[\\/][^\s"'`<>|),;:!?]*)*)/g
const QUOTED_WIN_PATH = /(["'`])([A-Za-z]):(?:\\|\/)([^`]*?)\1/g

/** Rewrite every Windows absolute path in a text to the MSYS form; pure. */
export function windowsToMsys(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  return text
    .replace(QUOTED_WIN_PATH, (_whole, quote, drive, rest) =>
      quote + '/' + drive.toLowerCase() + '/' + rest.replace(/[\\/]+/g, '/') + quote)
    .replace(BARE_WIN_PATH, (_whole, drive, rest) =>
      '/' + drive.toLowerCase() + '/' + rest.replace(/[\\/]+/g, '/'))
}

/**
 * The MSYS echo of one text the Windows layer produced (v0.22.0): the
 * drive-root translation plus the /tmp mount, so a path that came back out
 * of the host reads as the very path the model wrote. ONE helper for every
 * echo face — success metadata, failure content, failure message — because
 * those faces must never disagree about the dialect.
 */
function msysEcho(value, env) {
  const out = windowsToMsys(value)
  if (typeof out !== 'string' || out.length === 0) return out
  const tempRoot = env && env.tmpDir ? driveToMsys(env.tmpDir) : ''
  if (!tempRoot) return out
  return mountTempRoot(out, tempRoot)
}

/**
 * Swap every /tmp-mount path inside a text for the short bash spelling;
 * pure. Whole-value path fields hit the first branch; a diagnostic that
 * QUOTES a temp path ("ENOENT ... open /c/Users/u/AppData/.../x.txt") is
 * the reason this is an embedded scan rather than a prefix test — the
 * model must recognise its own /tmp path in an error the way it does in a
 * successful result. Case-insensitive like the Windows filesystem, and
 * anchored on a path boundary so a sibling name (…/Temperature) never
 * matches.
 */
function mountTempRoot(text, tempRoot) {
  const haystack = text.toLowerCase()
  const needle = tempRoot.toLowerCase()
  let out = ''
  let cursor = 0
  let hits = 0
  for (;;) {
    const at = haystack.indexOf(needle, cursor)
    if (at < 0) break
    const after = at + needle.length
    const boundary = after === text.length || text.charCodeAt(after) === 47
    if (boundary) {
      out += text.slice(cursor, at) + '/tmp'
      hits++
    } else {
      out += text.slice(cursor, after)
    }
    cursor = after
  }
  return hits === 0 ? text : out + text.slice(cursor)
}

/** Normalize backslash separators in a RELATIVE result path to slashes; pure. */
function posixSeparators(value) {
  return typeof value === 'string' && value.includes(String.fromCharCode(92))
    ? value.split(String.fromCharCode(92)).join('/')
    : value
}

/**
 * One WHOLE path value -> the MSYS dialect (v0.23.0). windowsToMsys is a PROSE
 * rewriter: its bare pattern stops at whitespace, so a path whose DIRECTORY
 * contains a space came back half-translated — "C:\my dir\f.txt" turned into
 * "/c/my dir\f.txt", and the model met that mixed form in a SUCCESSFUL
 * read/write/edit result (issue #3). A whole-value field IS exactly one path, so
 * the drive prefix is translated directly and every remaining separator
 * normalizes; no prose pattern is involved. Relative values (grep match paths)
 * only normalize. A UNC root becomes the MSYS spelling "//server/share";
 * anything without a drive prefix passes through unchanged. Pure.
 */
function driveToMsys(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  const drive = /^([A-Za-z]):(?=[\\/])/.exec(value)
  if (drive) return '/' + drive[1].toLowerCase() + '/' + posixSeparators(value.slice(2)).replace(/^\/+/, '')
  return posixSeparators(value)
}

/**
 * The MSYS echo of one whole path VALUE — never prose (v0.23.0): the drive root
 * and separators through driveToMsys, then the /tmp mount. Every whole-value
 * face (read/write/edit path, glob paths[], grep matches[].path, present
 * files[].path) goes through here, so none of them can disagree about the
 * dialect, and a spaced directory no longer leaks a backslash.
 */
function pathEcho(value, env) {
  const out = driveToMsys(value)
  if (typeof out !== 'string' || out.length === 0) return out
  const tempRoot = env && env.tmpDir ? driveToMsys(env.tmpDir) : ''
  return tempRoot ? mountTempRoot(out, tempRoot) : out
}

/**
 * Rewrite Windows absolute paths inside an ERROR result's text blocks to
 * the MSYS dialect (pure, v0.17.1). Error results cannot carry a
 * replacement `value` (the registry rejects that), but replacing `content`
 * is the official post-execute channel, so the message the model reads
 * stays in one dialect — it must not relearn Windows forms from failure
 * text. Non-drive-letter diagnostics (device paths, URLs) never match
 * windowsToMsys and are left verbatim.
 */
/**
 * The only tools whose ERROR content is dialect-translated (v0.17.1).
 * These messages are harness-generated path diagnostics (cannot read
 * "C:\..."), so rewriting them is safe. Every other tool — bash above all,
 * whose failed runs carry raw command stdout/stderr — keeps its error
 * content VERBATIM: output is data, never rewritten (the same red line as
 * file content in successful results).
 */
const ERROR_CONTENT_TOOLS = new Set(['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'present'])

export function rewriteErrorContent(content, options) {
  if (!Array.isArray(content)) return content
  const nulHint = !options || options.nulHint !== false
  const env = options && options.env ? options.env : null
  let changed = false
  const next = content.map((block) => {
    if (!block || typeof block !== 'object' || typeof block.text !== 'string') return block
    const out = msysEcho(block.text, env)
    if (out === block.text) return block
    changed = true
    return { ...block, text: out }
  })
  // /dev/null x file tools: the harness realpath step rejects device
  // paths, so the failure is EXPECTED — append one guidance line (v0.18.0)
  // instead of leaving the model to puzzle over EINVAL. The original
  // diagnostic stays verbatim; only a hint block is appended.
  const nulHit = content.some((block) => {
    const t = block && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''
    return t.includes('EINVAL') && t.includes('NUL')
  })
  if (nulHint && nulHit) {
    next.push({ type: 'text', text: 'hint: /dev/null is the NUL device — file tools cannot target device paths (their realpath step rejects them); discard output through bash instead (echo ... > /dev/null)' })
    changed = true
  }
  return changed ? next : content
}

/**
 * The SECOND face of a failure (v0.22.0). The content blocks are what the
 * model reads on a failed call and what the UI card shows; error.message is
 * what the PTC bridge hands a running program as its caught ToolCallError
 * message (the durable record keeps only the structured identity). Rewriting
 * only the content left a program that printed a caught error holding the
 * Windows form while every other face said the MSYS one. Pure; options
 * mirror rewriteErrorContent.
 */
export function rewriteErrorMessage(message, options) {
  if (typeof message !== 'string' || message.length === 0) return message
  return msysEcho(message, options && options.env ? options.env : null)
}

/**
 * Apply rewriteErrorMessage to a failure RESULT in place (v0.22.0). The
 * registry keeps result.error by reference through the whole post-execute
 * waterfall and only snapshots the projection afterwards
 * (normalizeDispatchResult -> materializeFinalResult), so this write reaches
 * the PTC bridge, which is where a program meets its caught error.
 * post-execute block decision: a block rebuilds the error as a bare message
 * and would drop the structured identity (FS_NOT_FOUND and friends) that the
 * record and the UI keep. Defensive — a frozen or absent error object leaves
 * the result untouched, and the content face still carries the dialect alone.
 */
export function rewriteFailureMessage(result, env) {
  try {
    const error = result && result.error
    if (!error || typeof error !== 'object' || typeof error.message !== 'string') return false
    const rewritten = msysEcho(error.message, env)
    if (rewritten === error.message) return false
    error.message = rewritten
    return error.message === rewritten
  } catch {
    return false
  }
}

export function rewriteResultPaths(name, value, env) {
  if (!value || typeof value !== 'object') return value
  // v0.17.0: paths under the user TEMP directory echo back in the bash
  // /tmp dialect (that IS what /tmp means in Git Bash), so the model sees
  // the same short root bash itself prints for $TMP.
  // v0.23.0: every value around here is ONE path, so it goes through
  // pathEcho — the prose rewriter stops at whitespace and left a spaced
  // directory half-translated (issue #3). posixSeparators now lives inside
  // pathEcho, so the three nested branches below need no second pass.
  const toMsys = (p) => pathEcho(p, env)
  if (name === 'read' || name === 'read_image' || name === 'write' || name === 'edit') {
    if (typeof value.path === 'string' && value.path !== '') {
      const out = toMsys(value.path)
      if (out !== value.path) return { ...value, path: out }
    }
    return value
  }
  if (name === 'present' && Array.isArray(value.files)) {
    let changed = false
    const files = value.files.map((file) => {
      if (!file || typeof file !== 'object' || typeof file.path !== 'string' || file.path === '') return file
      const out = toMsys(file.path)
      if (out === file.path) return file
      changed = true
      return { ...file, path: out }
    })
    return changed ? { ...value, files } : value
  }
  if (name === 'glob' && Array.isArray(value.paths)) {
    let changed = false
    const paths = value.paths.map((p) => {
      if (typeof p !== 'string') return p
      const out = toMsys(p)
      if (out === p) return p
      changed = true
      return out
    })
    return changed ? { ...value, paths } : value
  }
  if (name === 'grep' && Array.isArray(value.matches)) {
    let changed = false
    const matches = value.matches.map((m) => {
      if (!m || typeof m !== 'object' || typeof m.path !== 'string') return m
      const out = toMsys(m.path)
      if (out === m.path) return m
      changed = true
      return { ...m, path: out }
    })
    return changed ? { ...value, matches } : value
  }
  return value
}

// ── MSYS drive-root path translation (Windows, EVERY tool dispatch) ────────
//
// The directive below tells the model to use POSIX-style MSYS paths (/c/...)
// for EVERY tool. Bash digests those natively, but the Node-backed file tools
// resolve an MSYS root against the current drive (/c/Users -> C:/c/Users), so a
// global tools/execute wrapper rewrites the path-bearing ARGUMENT FIELDS (by
// field NAME, not by tool name — dynamic tools using the standard field names
// are covered too) into the drive-letter form the host accepts. The bash
// command field is deliberately untouched: MSYS roots are Git Bash native
// there. Defensive by design: the waterfall hands the same mutable exec object
// to the tool body, but if a future registry freezes it the write throws, is
// swallowed, and the call proceeds with the model original arguments (the
// directive still stands).

const MSYS_DRIVE_ROOT = /^\/([a-z])\/(.*)$/i
const MSYS_BARE_DRIVE = /^\/([a-z])$/i
const TRANSLATABLE_PATH_FIELDS = new Set(['file_path', 'path', 'workdir'])

// ── virtual mounts + env (v0.17.0) ─────────────────────────────────────
//
// Git Bash resolves a few POSIX roots through its OWN mount table before
// any drive root applies (`mount` inside Git Bash): /tmp is the user TEMP
// dir (usertemp), /dev/null is the Windows NUL device, and /usr /bin /etc
// /var /home /root /mnt live under the Git install root. The model carries
// those bash habits into EVERY tool, so the translation layer mirrors the
// same table or the file tools silently misplace them (/tmp becomes a
// fresh C:/tmp on the current drive; /dev/null becomes a real file under
// C:/dev). All matches are segment-bounded and case-sensitive, exactly
// like the msys mount table itself (/Tmp does NOT match).
//
// /home is deliberately the GIT mount (git-root/home, usually empty), NOT
// the user profile: bash itself resolves /home/x there, while the home
// SHORTHAND ~ expands to $HOME (= C:/Users/<u>) — mirroring both keeps
// file tools and bash in perfect agreement. A bare '/' is never
// translated: it would scope tools to the whole Git install tree.

/** The Windows null device — the exact target of Git Bash's /dev/null. */
const NUL_DEVICE = '\\\\.\\NUL'

/** Git-root mounts: MSYS path -> subdirectory under the Git install root. */
const GIT_MOUNTS = new Map([
  ['/usr', 'usr'],
  ['/bin', 'usr/bin'],
  ['/etc', 'etc'],
  ['/var', 'var'],
  ['/home', 'home'],
  ['/root', 'root'],
  ['/mnt', 'mnt'],
])

const translateEnvCache = new Map()

/**
 * The runtime facts the virtual mounts resolve against (all optional — a
 * missing fact simply leaves its paths untranslated). Probed once per
 * distinct bashPath setting (v0.19.0: a settings-configured bash.exe joins
 * the candidates FIRST, fixing /usr translation for custom installs);
 * tmpdir/homedir are cheap; the Git root walks the candidate bash.exe list
 * (the default install plus every PATH entry) and accepts a root only when
 * <root>/usr/bin exists, which excludes the WSL bash shim in WindowsApps.
 */
export function buildTranslateEnv(configuredBashPath) {
  const cacheKey = typeof configuredBashPath === 'string' && configuredBashPath !== '' ? configuredBashPath : ''
  const cached = translateEnvCache.get(cacheKey)
  if (cached) return cached
  const env = { tmpDir: undefined, home: undefined, gitRoot: undefined }
  try {
    const t = tmpdir()
    if (t && existsSync(t)) env.tmpDir = t.replace(/\\/g, '/')
  } catch { /* keep undefined */ }
  // v0.18.2: in an EMPTY-env process (the PTC run_code child) os.tmpdir()
  // degrades to a garbage path and the guard above drops it — fall back to
  // the standard Windows per-user temp layout under the detected home, so
  // importing this module from inside run_code still translates /tmp.
  if (!env.tmpDir && process.platform === 'win32') {
    try {
      const fallback = join(homedir(), 'AppData', 'Local', 'Temp')
      if (existsSync(fallback)) env.tmpDir = fallback.replace(/\\/g, '/')
    } catch { /* keep undefined */ }
  }
  try {
    const h = homedir()
    if (h && existsSync(h)) env.home = h.replace(/\\/g, '/')
  } catch { /* keep undefined */ }
  try {
    const candidates = []
    if (cacheKey !== '') candidates.push(cacheKey.replace(/\\/g, '/'))
    candidates.push(DEFAULT_GIT_BASH)
    for (const dir of String(process.env.PATH ?? '').split(';')) {
      const clean = dir && dir.trim()
      if (clean) candidates.push(clean.replace(/\\/g, '/') + '/bash.exe')
    }
    for (const candidate of candidates) {
      try {
        if (!existsSync(candidate)) continue
        const root = dirname(dirname(candidate))
        if (existsSync(join(root, 'usr', 'bin'))) {
          env.gitRoot = root.replace(/\\/g, '/')
          break
        }
      } catch { /* try the next candidate */ }
    }
  } catch { /* keep undefined */ }
  translateEnvCache.set(cacheKey, env)
  return env
}

/**
 * '/c/Users/x' -> 'C:/Users/x'. With an env, the bash-native habits resolve
 * first (~ -> home) and the virtual mounts (/tmp, /dev/null, /usr & friends)
 * resolve after the drive roots; any other shape returns the input
 * unchanged. Pure: the env is a plain fact bag, nothing is probed here.
 */
/**
 * Expand a leading dollar-sign NAME / braced NAME path variable the way
 * Git Bash would (pure, string surgery, v0.18.0): HOME is the user home,
 * TMPDIR/TMP/TEMP all mean the /tmp mount. Unknown names and NAMEX-style
 * false positives return the input verbatim (written without any dollar
 * literal — a code-transport layer mangles that byte inside quotes).
 */
function expandLeadingVar(value, env) {
  if (!env || typeof value !== 'string' || value.length < 2) return value
  if (value.charCodeAt(0) !== 36) return value
  let name = ''
  let rest = ''
  if (value.charCodeAt(1) === 123) {
    const close = value.indexOf('}', 2)
    if (close < 0) return value
    name = value.slice(2, close)
    rest = value.slice(close + 1)
  } else {
    const head = value.slice(1)
    let i = 0
    while (i < head.length) {
      const c = head.charCodeAt(i)
      const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
      const digit = c >= 48 && c <= 57
      if (i === 0 ? !letter : !(letter || digit)) break
      i++
    }
    if (i === 0) return value
    name = head.slice(0, i)
    rest = head.slice(i)
  }
  if (rest !== '' && rest.charCodeAt(0) !== 47) return value
  let base
  if (name === 'HOME') base = env.home
  else if (name === 'TMPDIR' || name === 'TMP' || name === 'TEMP') base = env.tmpDir
  else return value
  return base ? (rest !== '' ? base + rest : base) : value
}
/**
 * Expand a leading tilde the way Git Bash does (v0.22.0): ~ and ~/... mean
 * the user home — the same fact the mount table already applies to every
 * other path argument. A named form (~other/...) is left alone: the plugin
 * has no such fact, and a wrong guess would search the wrong tree.
 */
function expandLeadingTilde(value, env) {
  if (!env || !env.home || typeof value !== 'string') return value
  if (value === '~') return env.home
  if (value.charCodeAt(0) !== 126 || value.charCodeAt(1) !== 47) return value
  return env.home + value.slice(1)
}

export function translateMsysPath(value, env) {
  if (typeof value !== 'string') return value
  if (env && env.home && (value === '~' || value.startsWith('~/'))) {
    return value === '~' ? env.home : env.home + '/' + value.slice(2)
  }
  if (env) {
    const expanded = expandLeadingVar(value, env)
    if (expanded !== value) return expanded
  }
  const match = MSYS_DRIVE_ROOT.exec(value)
  if (match) return match[1].toUpperCase() + ':/' + match[2]
  const bare = MSYS_BARE_DRIVE.exec(value)
  if (bare) return bare[1].toUpperCase() + ':/'
  if (value === '/dev/null') return NUL_DEVICE
  if (env && env.tmpDir && (value === '/tmp' || value.startsWith('/tmp/'))) {
    return value === '/tmp' ? env.tmpDir : env.tmpDir + value.slice(4)
  }
  if (env && env.gitRoot) {
    for (const [mount, target] of GIT_MOUNTS) {
      if (value === mount || value.startsWith(mount + '/')) {
        const rest = value === mount ? '' : value.slice(mount.length)
        return env.gitRoot + '/' + target + rest
      }
    }
  }
  return value
}

/**
 * Return an arguments object whose path fields carry drive-letter roots.
 * Pure: builds a NEW object when any field changes and returns the ORIGINAL
 * reference otherwise — the registry deep-freezes exec.arguments at exec
 * construction (0.10.2 lesson: in-place writes throw in strict mode and
 * were silently swallowed), so the caller REPLACES the exec.arguments
 * property (the exec object itself is not frozen until tools/result;
 * signal replacement is the registry's own precedent).
 *
 * v0.17.0: present's NESTED files[].path rides along (the field-name
 * whitelist only sees top-level keys, and present is the one tool whose
 * path arguments live one level down).
 * @returns {object} the translated arguments object, or the input when
 *   nothing changed (also the input itself when args is not an object).
 */
export function translatePathArguments(args, env) {
  if (!args || typeof args !== 'object') return args
  let changed = false
  const next = { ...args }
  for (const key of Object.keys(next)) {
    if (!TRANSLATABLE_PATH_FIELDS.has(key)) continue
    const value = next[key]
    if (typeof value !== 'string') continue
    const translated = translateMsysPath(value, env)
    if (translated === value) continue
    next[key] = translated
    changed = true
  }
  if (Array.isArray(next.files)) {
    const files = next.files.map((file) => {
      if (!file || typeof file !== 'object' || typeof file.path !== 'string') return file
      const translated = translateMsysPath(file.path, env)
      return translated === file.path ? file : { ...file, path: translated }
    })
    if (files.some((file, index) => file !== next.files[index])) {
      next.files = files
      changed = true
    }
  }
  return changed ? next : args
}

// ── MSYS paths written INSIDE a run_code program (v0.20.0) ───────────────
//
// run_code hands the model's program to a native Node process: a path literal
// in that source is plain program DATA, so '/c/Users/x' is resolved by Node
// against the current drive ('<drive>:\\c\\Users\\x') — that is where the stray
// C:\\c\\... directories came from, since the tool-argument translation never
// sees it (see AGENTS.md 4c). The same mount table is therefore applied to the
// program's string literals — but ONLY when the whole program scans cleanly and
// a literal's ENTIRE content is an absolute MSYS path. Anything unclear — an
// unterminated literal, a template with ${} interpolation, a regex we cannot
// place — turns the whole rewrite into a no-op: a half-rewritten program would
// be far worse than an untranslated one, and this layer never guesses.
//
// Deliberately NOT translated: shell-style '$VAR/x' (a JS literal is data, not
// a shell word) and anything carrying a scheme ('http://...').

/** Source text allowed inside a rewritten literal: no escapes, no dollar sign. */
const CODE_LITERAL_SAFE = /^[A-Za-z0-9._@+~\-/ ]+$/

/** Previous significant character that lets a '/' start a regex literal. */
function regexCanStart(previous) {
  if (previous === '') return true
  return '(,=:[!&|?{};+-*%<>~^'.indexOf(previous) >= 0
}

/** Index after the closing quote of the literal at `index`, or -1. */
function skipQuotedLiteral(code, index) {
  const quote = code[index]
  let i = index + 1
  while (i < code.length) {
    const c = code[i]
    if (c === '\\') { i += 2; continue }
    if (c === '\n') return -1
    if (c === quote) return i + 1
    i += 1
  }
  return -1
}

/** Index after a regex literal (body + flags), or -1 when it cannot be walked. */
function skipRegexLiteral(code, index) {
  let i = index + 1
  let inClass = false
  while (i < code.length) {
    const c = code[i]
    if (c === '\\') { i += 2; continue }
    if (c === '\n') return -1
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && inClass === false) {
      i += 1
      while (i < code.length && /[a-z]/i.test(code[i])) i += 1
      return i
    }
    i += 1
  }
  return -1
}

/** Index after the '}' matching an already-consumed interpolation, or -1. */
function skipBracedExpression(code, index) {
  let depth = 1
  let i = index
  let last = ''
  while (i < code.length) {
    const c = code[i]
    const next = code[i + 1]
    if (c === '/' && next === '/') {
      const nl = code.indexOf('\n', i)
      if (nl === -1) return -1
      i = nl
      continue
    }
    if (c === '/' && next === '*') {
      const close = code.indexOf('*/', i + 2)
      if (close === -1) return -1
      i = close + 2
      continue
    }
    if (c === '"' || c === "'") {
      const end = skipQuotedLiteral(code, i)
      if (end === -1) return -1
      i = end
      last = 'x'
      continue
    }
    if (c === '`') {
      const inner = skipTemplateLiteral(code, i)
      if (inner === null) return -1
      i = inner.end
      last = 'x'
      continue
    }
    if (c === '/' && regexCanStart(last)) {
      const end = skipRegexLiteral(code, i)
      if (end === -1) return -1
      i = end
      last = 'x'
      continue
    }
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
    if (c.trim() !== '') last = c
    i += 1
  }
  return -1
}

/**
 * Walk a template literal. Returns { end, plain } — plain means it holds no
 * interpolation, i.e. its text is one literal value — or null when the
 * template could not be walked to its end.
 */
function skipTemplateLiteral(code, index) {
  let i = index + 1
  let plain = true
  while (i < code.length) {
    const c = code[i]
    if (c === '\\') { i += 2; continue }
    if (c === '`') return { end: i + 1, plain: plain }
    if (c === '$' && code[i + 1] === '{') {
      plain = false
      const after = skipBracedExpression(code, i + 2)
      if (after === -1) return null
      i = after
      continue
    }
    i += 1
  }
  return null
}

/**
 * Every plain string-literal span of a program, or null when the source could
 * not be walked with certainty. Spans cover the CONTENT (quotes excluded).
 */
export function scanCodeLiterals(code) {
  const spans = []
  let i = 0
  let last = ''
  while (i < code.length) {
    const c = code[i]
    const next = code[i + 1]
    if (c === '/' && next === '/') {
      const nl = code.indexOf('\n', i)
      if (nl === -1) return null
      i = nl
      continue
    }
    if (c === '/' && next === '*') {
      const close = code.indexOf('*/', i + 2)
      if (close === -1) return null
      i = close + 2
      continue
    }
    if (c === '"' || c === "'") {
      const end = skipQuotedLiteral(code, i)
      if (end === -1) return null
      spans.push({ start: i + 1, end: end - 1 })
      i = end
      last = 'x'
      continue
    }
    if (c === '`') {
      const template = skipTemplateLiteral(code, i)
      if (template === null) return null
      if (template.plain) spans.push({ start: i + 1, end: template.end - 1 })
      i = template.end
      last = 'x'
      continue
    }
    if (c === '/' && regexCanStart(last)) {
      const end = skipRegexLiteral(code, i)
      if (end === -1) return null
      i = end
      last = 'x'
      continue
    }
    if (c.trim() !== '') last = c
    i += 1
  }
  return spans
}

/**
 * The one line prepended to a run_code program (v0.21.0). run_code's process
 * environment is EMPTY BY DESIGN — exactly the same on macOS — so this is NOT
 * "giving the program a shell env". It exists for one measured Windows-only
 * symptom: with an empty env, Node's os.tmpdir() on Windows returns the literal
 * 'undefined\\temp' (macOS falls back to a real per-user directory), so a program
 * asking for the temp dir silently writes into a bogus 'undefined' folder.
 * Seeding ONLY TEMP/TMP — Windows' own convention — makes it resolvable again.
 * HOME/PATH are deliberately NOT seeded: values macOS does not have would make
 * the two platforms behave DIFFERENTLY, which is the opposite of the goal.
 * @param {{tmpDir?: string}|null} env
 * @returns {string} prelude source, or '' when there is no temp fact to seed
 */
export function programPrelude(env) {
  const tmp = env && typeof env.tmpDir === 'string' && env.tmpDir !== '' ? env.tmpDir : ''
  if (tmp === '') return ''
  return 'try{const e=process.env;if(e&&!e.TEMP){e.TEMP=' + JSON.stringify(tmp) + ';e.TMP=e.TEMP}}catch{}\n'
}

/**
 * Translates MSYS path literals inside a run_code program. Returns the input
 * unchanged when nothing matched or when the scan was not certain.
 * @param {string} code the model's program
 * @param {{tmpDir?: string, home?: string, gitRoot?: string}|null} env mounts
 * @returns {string} the program to execute
 */
export function rewriteCodePaths(code, env) {
  if (typeof code !== 'string' || code === '') return code
  if (code.indexOf('/') === -1) return code
  const spans = scanCodeLiterals(code)
  if (spans === null) return code
  let out = ''
  let cursor = 0
  let changed = false
  for (const span of spans) {
    const raw = code.slice(span.start, span.end)
    if (raw.charCodeAt(0) !== 47 && raw.startsWith('~/') === false) continue
    if (raw.indexOf('$') >= 0 || raw.indexOf('\\') >= 0) continue
    if (CODE_LITERAL_SAFE.test(raw) === false) continue
    if (raw.indexOf('://') >= 0) continue
    const translated = translateMsysPath(raw, env)
    if (typeof translated !== 'string' || translated === raw) continue
    // What lands in the program is SOURCE text, not the value: a backslash in
    // the translated path (the NUL device) must be escaped for the literal it
    // is written into, and a quote inside it (a home directory with an
    // apostrophe) would end that literal early — refuse rather than corrupt.
    const quote = code[span.start - 1]
    if (translated.indexOf(quote) >= 0) continue
    if (quote === '`' && translated.indexOf('${') >= 0) continue
    const source = translated.replace(/\\/g, '\\\\')
    out += code.slice(cursor, span.start) + source
    cursor = span.end
    changed = true
  }
  if (changed === false) return code
  return out + code.slice(cursor)
}

// ── absolute glob patterns (v0.17.0) ────────────────────────────────────
//
// The glob tool takes its search root in the `path` argument and expects a
// RELATIVE pattern; an absolute pattern ('/c/Users/x/*.md', or the Windows
// form) is treated as relative text and silently matches nothing. A model
// raised on bash writes absolute patterns anyway, so for the glob tool the
// wrapper splits an absolute pattern at the last directory separator
// before the first wildcard and moves the translated directory into
// `path` ('/c/a/*/b/*.md' -> path 'C:/a', pattern '*/b/*.md'). An absolute
// path WITHOUT wildcards splits into directory + basename. Runs only for
// the glob tool and only for patterns that start absolute.

const GLOB_META = /[*?\[\]]/

/** Split an absolute glob pattern into { prefix, rest }; null when relative. */
function splitGlobPrefix(pattern) {
  if (typeof pattern !== 'string') return null
  let p = pattern
  // A Windows drive head ('C:' + separator) is normalized to the MSYS form
  // first so both absolute dialects split through the same code path.
  const winHead = /^([A-Za-z]):[\\/]+(.*)$/.exec(p)
  if (winHead) p = '/' + winHead[1].toLowerCase() + '/' + winHead[2].replace(/[\\/]+/g, '/')
  if (p[0] !== '/') return null
  const meta = GLOB_META.exec(p)
  const cut = meta ? p.lastIndexOf('/', meta.index) : p.lastIndexOf('/')
  if (cut <= 0) return null
  const rest = p.slice(cut + 1)
  if (rest === '') return null
  return { prefix: p.slice(0, cut), rest }
}


/** Translate the (always MSYS-form) directory prefix; null when it is not one. */
function normalizeAbsolutePrefix(prefix, env) {
  const translated = translateMsysPath(prefix, env)
  return translated !== prefix ? translated : null
}


/**
 * Rewrite a glob call's absolute pattern into the { path, pattern } pair
 * the tool actually supports; any existing `path` is superseded (an
 * absolute pattern already names its root). Pure; returns the input on any
 * miss.
 */
export function translateGlobArguments(args, env) {
  if (!args || typeof args !== 'object' || typeof args.pattern !== 'string') return args
  // Expand a leading variable shorthand first (v0.18.1): a pattern opening
  // with $HOME/... must become absolute before the split, or the splitter
  // rejects it and glob silently matches nothing.
  // Then the tilde shorthand (v0.22.0): ~/x names the same tree as $HOME/x
  // in every other tool, so glob must not silently match nothing for it.
  const expanded = env ? expandLeadingTilde(expandLeadingVar(args.pattern, env), env) : args.pattern
  const split = splitGlobPrefix(expanded)
  if (!split) return args
  const prefix = normalizeAbsolutePrefix(split.prefix, env)
  if (!prefix) return args
  return { ...args, pattern: split.rest, path: prefix }
}


// ── dsh-better-sidebar shell cooperation ───────────────────────────────────
//
// dsh-better-sidebar (v0.15.2+) resolves its terminal shell PER OPEN: a
// settings-page `terminalShell` value wins over the yaml/plugin default
// (their own words: "values here win for terminals opened afterwards").
// So this plugin adopts that official runtime seam — zero upstream change,
// no restart needed — and points the sidebar's UI terminal tabs AND the
// model-facing terminal_* tools at Git Bash on Windows. The plugin TAKES
// OVER the pref unconditionally while installed (a value set elsewhere is
// overwritten at every boot — that is the contract); the previous value is
// captured and restored on disposal (reload/update/uninstall), so removing
// this plugin returns the sidebar to what it was before.

const SIDEBAR_NS = 'dsh-better-sidebar'
const SIDEBAR_TRIES = 12
const SIDEBAR_RETRY_MS = 1500

// Owner scope of the gitbash-shell namespace once registered (shared with
// the register callback so a late registration can reconcile + watch).
let sidebarScope = undefined

// Reconciler installed by adoptSidebarShell; a no-op until then.
let reconcileSidebar = () => {}

/**
 * Reconcile the better-sidebar `terminalShell` takeover with the adoptSidebar
 * setting (v0.15.0, default ON). ON writes our bashPath (remembering what was
 * there before); OFF restores that previous value — but only while the current
 * value is still ours, so a user's manual choice is never clobbered. The
 * polling keeps the original ready-wait behavior: at boot the settings
 * service may not be provided yet when this row's apply runs. Never throws.
 */
function adoptSidebarShell(ctx, bashPath) {
  let adopted = false
  let previous = ''
  let tried = 0
  let timer = null
  ctx.effect(() => () => { if (timer) clearTimeout(timer) }, 'dsh-gitbash-shell: sidebar adoption polling')

  const readShell = () => {
    const settings = ctx.get('settings')
    if (!settings || typeof settings.get !== 'function' || typeof settings.update !== 'function') return null
    try {
      const value = settings.get(SIDEBAR_NS)
      return value && typeof value === 'object' && typeof value.terminalShell === 'string' ? value.terminalShell : ''
    } catch {
      return null // namespace not registered yet / sidebar absent
    }
  }

  reconcileSidebar = (desired) => {
    const current = readShell()
    if (current === null) return false
    const settings = ctx.get('settings')
    if (desired && current !== bashPath) {
      const was = current
      settings.update(SIDEBAR_NS, { terminalShell: bashPath })
        .then(() => {
          previous = was
          adopted = true
          console.log(
            `${TAG} dsh-better-sidebar terminal shell -> Git Bash (${bashPath})` +
              (was ? ` (took over from '${was}')` : ''),
          )
        })
        .catch((error) => {
          console.log(`${TAG} better-sidebar shell adoption unavailable: ${error?.message ?? error}`)
        })
      return true
    }
    if (desired && current === bashPath) {
      adopted = true
      return true
    }
    if (!desired && adopted && current === bashPath) {
      settings.update(SIDEBAR_NS, { terminalShell: previous })
        .then(() => {
          adopted = false
          console.log(`${TAG} dsh-better-sidebar terminal shell restored ('${previous || 'sidebar default'}') — adoptSidebar off`)
        })
        .catch(() => {})
      return true
    }
    return true
  }

  const run = () => {
    tried += 1
    const ok = reconcileSidebar(readAdoptSidebar(ctx))
    if (ok) {
      // The namespace scope may register after the settings service; hook
      // the live watch once it exists (idempotent via the effect disposer).
      if (sidebarScope && typeof sidebarScope.watch === 'function' && !run.watched) {
        run.watched = true
        try {
          const off = sidebarScope.watch((next) => { reconcileSidebar(next && next.adoptSidebar !== false) })
          ctx.effect(() => off, 'dsh-gitbash-shell: adoptSidebar watch (polling path)')
        } catch { /* best effort */ }
      }
      return
    }
    if (tried < SIDEBAR_TRIES) {
      timer = setTimeout(run, SIDEBAR_RETRY_MS)
      return
    }
    console.log(`${TAG} better-sidebar shell adoption skipped: settings service unavailable after ${tried} tries`)
  }
  run.watched = false
  void run()

  // Dispose: while we still hold the value, restore what was there before.
  let reverted = false
  ctx.effect(
    () => () => {
      if (reverted || !adopted) return
      reverted = true
      const s = ctx.get('settings')
      if (!s || typeof s.update !== 'function') return
      let now
      try {
        now = s.get(SIDEBAR_NS)
      } catch {
        return
      }
      if (String(now?.terminalShell ?? '') === bashPath) {
        s.update(SIDEBAR_NS, { terminalShell: previous }).catch(() => {})
      }
    },
    'dsh-gitbash-shell: sidebar shell revert',
  )
}

// ── plugin ──────────────────────────────────────────────────────────────────

/** First user-trust root: the roster's authoring target. */
function firstUserRoot(roots) {
  for (const r of roots) if (r && r.trust === 'user' && typeof r.path === 'string') return r
  return undefined
}

/** Directory of skills inside the installed shipped `cordis` preset, if any. */
async function findSkillsSource(agentPresets) {
  try {
    const list = await agentPresets.list()
    const cordis = Array.isArray(list) ? list.find((p) => p && p.id === SKILLS_SOURCE_PRESET && typeof p.path === 'string') : undefined
    if (!cordis) return undefined
    return join(dirname(cordis.path), 'skills')
  } catch {
    return undefined
  }
}

/**
 * Purge preset directories this plugin materialized in earlier versions but
 * that are no longer in the configured materialization set. Only an
 * UNMODIFIED tree is removed; a user-edited one stays (and is left alone).
 * @param userRoot - the user-trust preset root path.
 * @param keep - preset ids to keep.
 */
function purgeOrphans(userRoot, keep) {
  try {
    for (const entry of readdirSync(userRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const id = entry.name
      if (keep.includes(id)) continue
      const target = join(userRoot, id)
      const marker = readMarker(target)
      if (!marker || marker.managedBy !== MANAGED_BY) continue
      if (classify(target) === 'unmodified') {
        rmSync(target, { recursive: true, force: true })
        console.log(`${TAG} removed orphan preset '${id}' (no longer materialized)`)
      } else {
        console.log(`${TAG} orphan preset '${id}' was modified after materialization — leaving it alone`)
      }
    }
  } catch (error) {
    console.log(`${TAG} orphan cleanup skipped: ${error?.message ?? error}`)
  }
}

export async function apply(ctx, config = {}) {
  const presetIds = Array.isArray(config.presets) && config.presets.length > 0 ? config.presets : PRESET_IDS

  // The shim rides along every mount of this plugin and degrades silently if
  // the upstream shape differs from what we verified.
  //
  // INSTALL TIMING (aligned with dsh-ptc-cordis-preset 0.6.3): the host
  // runner row activates AFTER this plugin's row, so a one-shot
  // installRegisterShim(ctx.get('cordisInspect')) sampled a service that was
  // not provided yet and silently installed nothing — every later mount of a
  // second cordis-mode preset (e.g. 'cordis · Git Bash' beside the built-in
  // Creation mode) kept dying with 'Host Cordis inspect provider "Service"
  // is already registered' for the rest of the process. ctx.inject schedules
  // the install for the moment the service actually appears — independent of
  // row activation order, and still a no-op in a runner-less deployment.
  try {
    ctx.inject(['cordisInspect'], (inspectCtx) => {
      const shim = installRegisterShim(inspectCtx.get('cordisInspect'))
      if (!shim.installed) return
      inspectCtx.effect(() => () => shim.restore(), 'dsh-gitbash-shell: inspect-registry shim')
      console.log(`${TAG} inspect-registry compatibility shim active (multiple cordis-mode sessions supported)`)
    })
  } catch (error) {
    console.log(`${TAG} inspect-registry shim wiring failed: ${error?.message ?? error}`)
  }

  // ── cooperation capability ────────────────────────────────────────────────
  // Publish whether the Git Bash shell stack is active on this host so peer
  // plugins (e.g. dsh-ptc-cordis-preset) can adopt it in the presets they
  // materialize: service present, 'active: true' on Windows, 'active: false'
  // where the bundle is installed but the platform stack stayed native.
  const gitBashCapability = { active: process.platform === 'win32', bashPath: DEFAULT_GIT_BASH }
  const disposeGitBash = ctx.provide('gitBash', gitBashCapability)
  ctx.effect(() => disposeGitBash, 'dsh-gitbash-shell: gitBash capability')

  // ── settings namespace: the posixPaths switch (default ON, v0.10.0) ──────
  // Served on the host so the Plugins tab pairs it with the browser card
  // (the tab dispatches Host-served namespaces ∩ registered cards). Dynamic
  // imports keep the zero-dependency smoke path importable; the schema MUST
  // be a callable schemastery object (dsh-settings calls schema(merged)).
  try {
    ctx.inject(['settings'], (sctx) => {
      Promise.all([import('@deepseek-ai/dsh-settings'), import('@deepseek-ai/schemastery')])
        .then(([ds, sm]) => {
          const settings = sctx && sctx.settings
          if (!settings || typeof settings.register !== 'function') return
          const Schema = sm.default
          // Era probe: newer dsh register() takes a plain string; the older
          // one accepted the branded helper — one call satisfies both.
          const ns = typeof ds.settingsNamespace === 'function'
            ? ds.settingsNamespace(SETTINGS_NAMESPACE)
            : SETTINGS_NAMESPACE
          const scope = settings.register(ns, Schema.object({
            posixPaths: Schema.boolean().default(true),
            virtualMounts: Schema.boolean().default(true),
            globSplit: Schema.boolean().default(true),
            errorDialect: Schema.boolean().default(true),
            codePaths: Schema.boolean().default(true),
            gitAutocrlf: Schema.boolean().default(true),
            bashPath: Schema.string().default(''),
            adoptSidebar: Schema.boolean().default(true),
          }))
          sidebarScope = scope
          console.log(`${TAG} settings namespace registered: ${SETTINGS_NAMESPACE} (posixPaths default on, adoptSidebar default on)`)
          // A late register (settings service up after the adoption polling
          // finished) still reconciles once, and the live watch flips the
          // takeover when the user toggles the card switch.
          try {
            if (typeof scope?.watch === 'function') {
              const off = scope.watch((next) => { reconcileSidebar(next && next.adoptSidebar !== false) })
              ctx.effect(() => off, 'dsh-gitbash-shell: adoptSidebar watch')
            }
            reconcileSidebar(readAdoptSidebar(ctx))
          } catch (error) {
            console.log(`${TAG} adoptSidebar watch wiring failed: ${error?.message ?? error}`)
          }
        })
        .catch((error) => {
          console.log(`${TAG} settings namespace registration FAILED: ${error && error.stack || String(error)}`)
        })
    })
  } catch (error) {
    console.log(`${TAG} settings inject wiring failed: ${error?.message ?? error}`)
  }

  // ── official shell-env fact: DSH_PATH_DIALECT (Windows only, gated; v0.11.0) ──
  // dsh-shell-env owns the model-visible $DSH_* facts (host-plane service;
  // the web composition injects it and publishes DSH_WEB_URL beside the
  // built-ins), and the bash tool's schema points the model straight at them
  // ("inspect them when needed"). While posixPaths is on, every shell call
  // therefore also carries a runtime-verifiable dialect declaration: the
  // prompt rewrite states the dialect once at the source, the environment
  // answers on demand. The resolver reads the live switch per execution, so
  // toggling the setting empties the variable without re-registration; the
  // disposer rides the plugin fiber. ctx.inject keeps the wiring independent
  // of row activation order and a silent no-op where the registry is absent.
  if (process.platform === 'win32') {
    try {
      ctx.inject(['shellEnv'], (envCtx) => {
        try {
          const shellEnv = envCtx && envCtx.shellEnv
          if (!shellEnv || typeof shellEnv.register !== 'function') return
          const unregister = shellEnv.register({
            name: 'gitbash-shell',
            // The registry accepts DSH_* FACTS ONLY (a non-DSH key makes the
            // whole contribution throw — learned in v0.21.0, see CHANGELOG):
            // git line endings and anything else non-DSH_* ride the executor's
            // own env layer (src/shell.js), not this registry.
            variables: { [PATH_DIALECT_KEY]: { description: PATH_DIALECT_DESCRIPTION } },
            resolve() {
              return readPosixPaths(envCtx) ? { [PATH_DIALECT_KEY]: PATH_DIALECT_VALUE } : {}
            },
          })
          envCtx.effect(() => unregister, 'dsh-gitbash-shell: shellEnv path-dialect fact')
          console.log(`${TAG} shellEnv fact registered: ${PATH_DIALECT_KEY} (gated by the posixPaths setting)`)
        } catch (error) {
          console.log(`${TAG} shellEnv fact registration failed: ${error?.message ?? error}`)
        }
      })
    } catch (error) {
      console.log(`${TAG} shellEnv wiring failed: ${error?.message ?? error}`)
    }
  }

  // ── prompt-assembly path dialect (Windows only, gated; v0.10.0) ────────
  // While posixPaths is on, EVERY Windows absolute path the model would
  // see — section text, context text, and prompt variables — is rewritten
  // IN PLACE to the MSYS drive-root form. Nothing is added or removed: the
  // official prompt keeps its exact shape and only the path examples
  // change dialect, so the model meets a /c/ world at the source instead
  // of being asked to translate Windows forms it sees. Our own directive
  // context is skipped (self-reference), and tool schemas stay untouched
  // (they carry no drive-letter examples today, and blind string rewriting
  // could corrupt pattern/default fields).
  if (process.platform === 'win32') {
    try {
      ctx.on('system-prompt/assemble', (assembly, _assembleContext, next) => {
        try {
          if (readPosixPaths(ctx) && assembly && typeof assembly === 'object') {
            for (const section of Array.isArray(assembly.sections) ? assembly.sections : []) {
              if (section && typeof section.text === 'string') section.text = windowsToMsys(section.text)
            }
            for (const assembled of Array.isArray(assembly.contexts) ? assembly.contexts : []) {
              if (!assembled || assembled.name === 'gitbash-shell:posix-paths') continue
              if (typeof assembled.text === 'string') assembled.text = windowsToMsys(assembled.text)
            }
            const variables = assembly.variables
            if (variables && typeof variables === 'object') {
              for (const key of Object.keys(variables)) {
                if (typeof variables[key] === 'string') variables[key] = windowsToMsys(variables[key])
              }
            }
            // v0.20.1: the run_code sentence rides the SAME context entry, but
            // only when this assembly actually offers the tool (see
            // runCodeHintFor) — every other mode stays quiet.
            const hint = runCodeHintFor(assembly.tools)
            if (hint !== '') {
              for (const assembled of Array.isArray(assembly.contexts) ? assembly.contexts : []) {
                if (assembled && assembled.name === 'gitbash-shell:posix-paths' && typeof assembled.text === 'string') {
                  assembled.text += hint
                }
              }
            }
          }
        } catch { /* never block assembly */ }
        return next()
      })
      console.log(TAG + ' prompt-assembly path dialect active (gated by the posixPaths setting)')
    } catch (error) {
      console.log(TAG + ' system-prompt/assemble wiring failed: ' + (error?.message ?? error))
    }
  }

  // ── MSYS path translation on every tool dispatch (Windows only) ─────────
  // Covers every preset and mode: the wrapper sits on the global
  // tools/execute waterfall, through which model-direct calls, PTC run_code
  // sub-dispatches, and dynamic-tool calls all pass. It carries BOTH dialect
  // faces of one call — the path-bearing ARGUMENTS on the way in, and the
  // path-bearing RESULT metadata on the way out.
  //
  // The result face rides HERE, not tools/post-execute (v0.23.0, issue #2).
  // The registry rejects a post-execute decision that replaces `value` while
  // any listener on that waterfall replaced `content` —
  // "tools/post-execute accept decision cannot replace both value and content",
  // raised after the waterfall settles and outside every listener try/catch,
  // so the call ended as an isError and the model lost the result. An
  // around-dispatch wrapper may author the result instead: the registry re-runs
  // the owning output contract on what we return (normalizeDispatchResult ->
  // createSuccessResult -> render), so the content the model reads is rendered
  // FROM the dialect value handed back, and this plugin never projects a
  // `value` on a decision at all — the collision cannot happen. An unchanged
  // value returns the ORIGINAL result object, so the registry re-renders
  // nothing. Only a SUCCESSFUL result is touched; failures keep their value
  // (and their dialect rides the post-execute listener below).
  if (process.platform === 'win32') {
    try {
      ctx.on('tools/execute', (exec, next) => {
        let echo = false
        let echoEnv = null
        try {
          const dialect = readDialectSettings(ctx)
          if (dialect.posixPaths) {
            echo = true
            const env = dialect.virtualMounts ? buildTranslateEnv(dialect.bashPath) : null
            echoEnv = env
            if (exec && exec.arguments && typeof exec.arguments === 'object') {
              let translated = translatePathArguments(exec.arguments, env)
              if (exec.name === 'glob' && dialect.globSplit) {
                const globTranslated = translateGlobArguments(translated, env)
                if (globTranslated !== translated) translated = globTranslated
              }
              // v0.20.0: a run_code program is DATA for a native Node process, so
              // a '/c/...' literal inside it never reached this layer and landed
              // on the current drive as '<drive>:\\c\\...'. The same mount table
              // now covers the program path literals (see rewriteCodePaths;
              // anything unclear leaves the code untouched).
              if (exec.name === 'run_code' && dialect.codePaths && typeof translated.code === 'string') {
                const rewritten = rewriteCodePaths(translated.code, env)
                const nextCode = programPrelude(env) + rewritten
                if (nextCode !== translated.code) translated = { ...translated, code: nextCode }
              }
              if (translated !== exec.arguments) exec.arguments = translated
            }
          }
        } catch { /* never block a call on translation */ }
        if (!echo) return next()
        return next().then((result) => {
          try {
            if (!result || typeof result !== 'object' || result.isError !== false) return result
            if (!result.value || typeof result.value !== 'object') return result
            const value = rewriteResultPaths(exec && exec.name, result.value, echoEnv)
            return value === result.value ? result : { ...result, value }
          } catch { return result }
        })
      })
      console.log(TAG + ' MSYS path translation active on tool dispatch (arguments and result metadata)')
    } catch (error) {
      console.log(TAG + ' tools/execute wiring failed: ' + (error?.message ?? error))
    }
  }

  // ── failure dialect on tools/post-execute (Windows only, gated; v0.17.1) ─
  // A FAILURE has two faces: `content` (the text the model reads on the failed
  // call, and what the UI card shows) and `error.message` (what the PTC bridge
  // hands a running program as its caught ToolCallError, while the durable
  // record keeps the structured identity). Rewriting only the content left a
  // program that printed a caught error holding the Windows form while every
  // other face said MSYS (v0.22.0).
  //
  // This listener projects CONTENT ONLY, and that is deliberate (v0.23.0,
  // issue #2): a decision carrying both `content` and `value` makes the
  // registry throw, and a replacement value is illegal on a failed result
  // anyway. The SUCCESS face therefore lives on the tools/execute wrapper
  // above, and this listener can never collide with any other plugin.
  //
  // error.message is rewritten IN PLACE on the result the waterfall was handed:
  // the registry keeps `result.error` by reference until the final
  // materialization, so this write reaches the PTC bridge and the record.
  // A post-execute `block` decision would rebuild the error as a bare message
  // and drop its structured identity — never do that.
  if (process.platform === 'win32') {
    try {
      ctx.on('tools/post-execute', (exec, result, next) => {
        let contentPatch
        try {
          const dialect = readDialectSettings(ctx)
          if (dialect.posixPaths && dialect.errorDialect && exec && result && typeof result === 'object'
            && result.isError === true && Array.isArray(result.content)) {
            const env = dialect.virtualMounts ? buildTranslateEnv(dialect.bashPath) : null
            if (exec.name === 'run_code') {
              // paths only — the /dev/null hint is for file tools
              const content = rewriteErrorContent(result.content, { nulHint: false, env })
              if (content !== result.content) contentPatch = content
              rewriteFailureMessage(result, env)
            } else if (ERROR_CONTENT_TOOLS.has(exec.name)) {
              const content = rewriteErrorContent(result.content, { env })
              if (content !== result.content) contentPatch = content
              rewriteFailureMessage(result, env)
            }
          }
        } catch { /* never block a result */ }
        const chain = next()
        if (contentPatch === undefined) return chain
        return chain.then((decision) => {
          try {
            if (decision && decision.kind === 'accept') return { ...decision, content: contentPatch }
          } catch { /* keep the downstream decision */ }
          return decision
        })
      })
      console.log(TAG + ' failure dialect active on tools/post-execute (content + error.message)')
    } catch (error) {
      console.log(TAG + ' tools/post-execute wiring failed: ' + (error?.message ?? error))
    }
  }

  // ── Unified POSIX path directive (Windows Git Bash, EVERY session) ─────
  // ONE path style for every tool: MSYS drive roots (/c/Users/...). Bash
  // digests them natively; the file tools receive the drive-letter form
  // through the translation wrapper above, so the model never has to switch
  // dialects. The directive also pins the rewrite rules that neutralize the
  // Windows-form facts the harness injects elsewhere (backslash cwd strings,
  // tool results printing drive-letter paths). Same channel as dsh-agent-lang;
  // order 126 sits after the official CONTEXT_ORDERS 110/115/120 and beside
  // the 125 free slot. Non-Windows mounts inject nothing.
  if (process.platform === 'win32') {
    try {
      ctx.inject(['systemPrompt'], (pctx) => {
        try {
          pctx.effect(() => pctx.systemPrompt.context({
            name: 'gitbash-shell:posix-paths',
            order: 126,
            text: () => {
              try {
                const settings = pctx.get('settings')
                const value = settings && typeof settings.get === 'function' ? settings.get(SETTINGS_NAMESPACE) : undefined
                if (!value || value.posixPaths !== true) return ''
                return value.virtualMounts === false ? POSIX_DIRECTIVE_TEXT_STRICT : POSIX_DIRECTIVE_TEXT
              } catch {
                return ''
              }
            },
          }), 'dsh-gitbash-shell: posix-path context')
          console.log(TAG + ' unified POSIX-path directive context active (win32, gated by the posixPaths setting)')
        } catch (error) {
          console.log(TAG + ' context registration failed: ' + (error?.message ?? error))
        }
      })
    } catch (error) {
      console.log(TAG + ' systemPrompt inject wiring failed: ' + (error?.message ?? error))
    }
  }

  // ── dsh-better-sidebar terminal adoption (Windows only) ────────────────
  // The sidebar resolves its terminal shell through the settings seam per
  // open; adopt it through that seam (see adoptSidebarShell for rationale).
  // Disable with `betterSidebarShell: false` in the plugin row config.
  if (config.betterSidebarShell !== false && process.platform === 'win32') {
    adoptSidebarShell(ctx, gitBashCapability.bashPath)
  }

  const roots = ctx.agentPresets?.roots ?? []
  const userRoot = firstUserRoot(roots)
  if (!userRoot) {
    console.log(`${TAG} no user-trust preset root configured — nothing to materialize`)
    return
  }

  let version = '0.0.0'
  try {
    version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version ?? version
  } catch {
    /* fall back to the placeholder */
  }

  const skillsSource = await findSkillsSource(ctx.agentPresets)
  const base = await detectBase(ctx.agentPresets)
  const persona = await detectPersonaEra(ctx.agentPresets)
  // Two independent signals, either of which is sufficient: the shipped
  // composition text (authoritative on every install layout) and the package
  // resolving from this plugin's own tree (covers hosts where the roster
  // probe is unavailable).
  const present = (await detectPresentSupport(ctx.agentPresets)) || (await hostHasToolPresent())
  // v0.15.0 (dsh 0.1.6-alpha.2): official ptc/standard/cordis gained the
  // tool-plugin-manager row; inject behind the same host-package probe as
  // present (resolve-only is sufficient — the package cannot exist on an
  // older host, so a roster text probe adds nothing).
  const pluginManager = await hostHasPluginManagerTools()
  // Row spellings of the built-in presets these variants mirror: the
  // workflow-engine row was renamed and its old package deleted in dsh
  // 0.1.6-alpha.1, so the materializer copies whatever the host itself ships.
  const rows = await detectRowForms(ctx.agentPresets)
  const userRootPath = userRoot.path
  purgeOrphans(userRootPath, presetIds)

  for (const presetId of presetIds) {
    const target = join(userRootPath, presetId)
    const state = classify(target)
    if (state === 'foreign') {
      console.log(`${TAG} a preset not written by this plugin already exists at ${target} — leaving it alone`)
      continue
    }
    if (state === 'user-modified') {
      console.log(`${TAG} preset at ${target} was modified after materialization — keeping the user's version (delete the directory to re-materialize)`)
      continue
    }

    // Reversible side effect, registered BEFORE the idle check so a quiet
    // startup keeps uninstall hygiene.
    ctx.effect(() => () => {
      try {
        const result = cleanupOnDispose({ target, packageJsonExists: existsSync(join(pkgDir, 'package.json')) })
        if (result === 'removed') console.log(`${TAG} package uninstalled — removed the unmodified '${presetId}' preset`)
        else if (result !== 'kept-package-intact' && result !== 'kept-absent') console.log(`${TAG} preset ${result} on disposal — kept`)
      } catch (error) {
        console.log(`${TAG} cleanup skipped: ${error?.message ?? error}`)
      }
    }, `dsh-gitbash-shell: preset materialization (${presetId})`)

    const sourceHashes = presetId === 'cordis-gitbash' ? skillsHashes(skillsSource) : null
    const marker = readMarker(target)
    const markerRows = rowFingerprint(rows, presetId)
    if (state === 'unmodified' && syncDecision({ state, marker, version, sourceHashes, base, persona, present, pluginManager, rows: markerRows }) === 'idle') {
      ctx.logger?.('gitbash-shell')?.debug?.( `preset '${presetId}' up to date (v${version}, ${base}-era${persona === 'split' ? ', persona-split' : ''}) — idle`)
      continue
    }

    const skills = materialize({ target, presetId, skillsSource, version, base, persona, present, pluginManager, rows })
    const verb = state === 'absent' ? 'materialized' : 'refreshed'
    console.log(
      `${TAG} ${verb} preset '${presetId}' into ${userRootPath} (v${version}, ${base}-era composition${persona === 'split' ? ', persona-split' : ''})` +
        (skills === 'copied' ? " (skills copied from the installed 'cordis' preset)" : '')
    )
  }
}

// Test surface: pure helpers, no Cordis context required.
export const _internal = { PRESET_IDS, translateMsysPath, translatePathArguments, rewriteCodePaths, scanCodeLiterals, programPrelude, translateGlobArguments, buildTranslateEnv, rewriteErrorContent, rewriteErrorMessage, rewriteFailureMessage, msysEcho, driveToMsys, pathEcho, ERROR_CONTENT_TOOLS, readPosixPaths, readAdoptSidebar, readDialectSettings, windowsToMsys, rewriteResultPaths, MARKER_FILE, classify, materialize, cleanupOnDispose, firstUserRoot, hashTree, skillsHashes, syncDecision, installRegisterShim, baseForRoster, detectBase, pickComposition, personaEraForText, detectPersonaEra, injectPresentRow, hostHasToolPresent, detectPresentSupport, injectPluginManagerRow, hostHasPluginManagerTools, rowFormOf, rowFormsOf, alignEngineRow, alignRalphRow, ROW_SOURCE }
