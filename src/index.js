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
function syncDecision({ state, marker, version, sourceHashes, base = 'code', persona = 'text', present = false, rows = '' }) {
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

/** Write one preset directory from scratch. Returns 'ok' or 'no-skills-source'. */
function materialize({ target, presetId, skillsSource, version, base = 'code', persona = 'text', present = false, rows }) {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })

  const available = readdirSync(join(pkgDir, 'assets', presetId)).filter((f) => f.endsWith('.yml'))
  const compositionFile = pickComposition(base, persona, available)
  let composition = readFileSync(join(pkgDir, 'assets', presetId, compositionFile), 'utf8')
  if (present && compositionFile.includes('.ptc.')) composition = injectPresentRow(composition)
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

  const marker = { managedBy: MANAGED_BY, version, presetId, base, persona, present, rows: rowFingerprint(rows, presetId), files: hashTree(target) }
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
const POSIX_DIRECTIVE_TEXT = 'The working shell is Git for Windows bash: paths use MSYS drive roots (/c/Users/...), and every tool accepts that form directly.'

// Official runtime counterpart to the directive (v0.11.0): dsh-shell-env is
// the host-plane registry behind the model-visible $DSH_* facts, and the
// bash tool's schema tells the model to inspect them — so the dialect also
// lives there, verifiable at runtime instead of only stated in the prompt.
const PATH_DIALECT_KEY = 'DSH_PATH_DIALECT'
const PATH_DIALECT_VALUE = 'msys'
const PATH_DIALECT_DESCRIPTION = 'Path dialect for tool calls and tool results: MSYS drive roots (/c/Users/...); every tool accepts this form directly.'

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

// Windows absolute path -> MSYS drive-root form, for rewriting the OFFICIAL
// prompt text in place (v0.10.0). Two patterns keep quoted spaced paths
// ("C:\Program Files\Git") whole while bare paths stop at whitespace or a
// closing punctuation; the lookbehind set rejects URL schemes (https:),
// file:// forms, and anything already mid-word, so only real drive-letter
// paths are translated. Separators normalize to single slashes.
const BARE_WIN_PATH = /(?<![A-Za-z0-9:\\/"'`])([A-Za-z]):(?:\\|\/)([^\s"'`<>|),;:!?]+)/g
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

/** Normalize backslash separators in a RELATIVE result path to slashes; pure. */
function posixSeparators(value) {
  return typeof value === 'string' && value.includes(String.fromCharCode(92))
    ? value.split(String.fromCharCode(92)).join('/')
    : value
}

/**
 * Rewrite result METADATA path fields to the MSYS dialect (pure, 0.10.4).
 * Only the well-known metadata fields per tool are touched — read/write/edit
 * `path` (absolute, via windowsToMsys), glob `paths[]` and grep
 * `matches[].path` (workspace-relative, separator-normalized). File CONTENT
 * (read lines, grep match text) and error results are never modified: the
 * tool result is data, only its path metadata changes dialect so the model
 * never meets a Windows-form path flowing back from a successful call.
 * @returns {object} a new value when any field changed, the input otherwise.
 */
export function rewriteResultPaths(name, value) {
  if (!value || typeof value !== 'object') return value
  if (name === 'read' || name === 'read_image' || name === 'write' || name === 'edit') {
    if (typeof value.path === 'string' && value.path !== '') {
      const out = windowsToMsys(value.path)
      if (out !== value.path) return { ...value, path: out }
    }
    return value
  }
  if (name === 'glob' && Array.isArray(value.paths)) {
    let changed = false
    const paths = value.paths.map((p) => {
      if (typeof p !== 'string') return p
      const out = posixSeparators(windowsToMsys(p))
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
      const out = posixSeparators(windowsToMsys(m.path))
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
const TRANSLATABLE_PATH_FIELDS = new Set(['file_path', 'path', 'workdir'])

/** '/c/Users/x' -> 'C:/Users/x'; any other shape returns the input unchanged. */
export function translateMsysPath(value) {
  if (typeof value !== 'string') return value
  const match = MSYS_DRIVE_ROOT.exec(value)
  if (!match) return value
  return match[1].toUpperCase() + ':/' + match[2]
}

/**
 * Return an arguments object whose path fields carry drive-letter roots.
 * Pure: builds a NEW object when any field changes and returns the ORIGINAL
 * reference otherwise — the registry deep-freezes exec.arguments at exec
 * construction (0.10.2 lesson: in-place writes throw in strict mode and were
 * silently swallowed), so the caller REPLACES the exec.arguments property
 * (the exec object itself is not frozen until tools/result; signal
 * replacement is the registry's own precedent).
 * @returns {object} the translated arguments object, or the input when
 *   nothing changed (also the input itself when args is not an object).
 */
export function translatePathArguments(args) {
  if (!args || typeof args !== 'object') return args
  let changed = false
  const next = { ...args }
  for (const key of Object.keys(next)) {
    if (!TRANSLATABLE_PATH_FIELDS.has(key)) continue
    const value = next[key]
    if (typeof value !== 'string') continue
    const translated = translateMsysPath(value)
    if (translated === value) continue
    next[key] = translated
    changed = true
  }
  return changed ? next : args
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

/**
 * Write the sidebar's `terminalShell` pref through the settings service.
 * Polls until the settings service (and the sidebar's namespace) are ready:
 * at boot the service may not be provided yet when this row's apply runs, so
 * the first attempt can silently see nothing — every attempt after the first
 * catches the service once it exists. Never throws; always logs the outcome.
 */
function adoptSidebarShell(ctx, bashPath) {
  let tried = 0
  let timer = null
  ctx.effect(() => () => { if (timer) clearTimeout(timer) }, 'dsh-gitbash-shell: sidebar adoption polling')
  const run = async () => {
    tried += 1
    const settings = ctx.get('settings')
    const ready = settings && typeof settings.update === 'function' && typeof settings.get === 'function'
    if (!ready) {
      if (tried < SIDEBAR_TRIES) {
        timer = setTimeout(run, SIDEBAR_RETRY_MS)
        return
      }
      console.log(`${TAG} better-sidebar shell adoption skipped: settings service unavailable after ${tried} tries`)
      return
    }
    let current
    try {
      current = settings.get(SIDEBAR_NS)
    } catch {
      current = undefined // namespace not registered yet / sidebar absent
    }
    const value = current && typeof current === 'object' ? current : {}
    const previous = typeof value.terminalShell === 'string' ? value.terminalShell : ''
    try {
      await settings.update(SIDEBAR_NS, { terminalShell: bashPath })
    } catch (error) {
      if (tried < SIDEBAR_TRIES) {
        timer = setTimeout(run, SIDEBAR_RETRY_MS)
        return
      }
      console.log(`${TAG} better-sidebar shell adoption unavailable: ${error?.message ?? error}`)
      return
    }
    let reverted = false
    ctx.effect(
      () => () => {
        if (reverted) return
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
    console.log(
      `${TAG} dsh-better-sidebar terminal shell -> Git Bash (${bashPath})` +
        (previous ? ` (took over from '${previous}')` : ''),
    )
  }
  void run()
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

  // ── settings namespace: the posixPaths switch (default OFF) ──────────────
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
          settings.register(ns, Schema.object({
            posixPaths: Schema.boolean().default(true),
          }))
          console.log(`${TAG} settings namespace registered: ${SETTINGS_NAMESPACE} (posixPaths default on)`)
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
  // sub-dispatches, and dynamic-tool calls all pass.
  if (process.platform === 'win32') {
    try {
      ctx.on('tools/execute', (exec, next) => {
        try {
          if (exec && exec.arguments && typeof exec.arguments === 'object' && readPosixPaths(ctx)) {
            const translated = translatePathArguments(exec.arguments)
            if (translated !== exec.arguments) exec.arguments = translated
          }
        } catch { /* never block a call on translation */ }
        return next()
      })
      console.log(TAG + ' MSYS drive-root translation active on tool dispatch')
    } catch (error) {
      console.log(TAG + ' tools/execute wiring failed: ' + (error?.message ?? error))
    }
  }

  // ── result-path dialect on tools/post-execute (Windows only, gated; v0.10.4) ──
  // Successful results carry Windows-form path METADATA (read.path, glob
  // paths[], grep matches[].path) out of the Node fs layer. The official
  // post-execute waterfall allows replacing the value projection, so while
  // posixPaths is on those metadata fields flow back in the MSYS dialect and
  // the model never sees a Windows path echoed by a successful call. File
  // content and error results are untouched (see rewriteResultPaths).
  if (process.platform === 'win32') {
    try {
      ctx.on('tools/post-execute', (exec, result, next) => {
        let patch
        try {
          if (readPosixPaths(ctx) && result && result.isError === false && result.value && typeof result.value === 'object') {
            const value = rewriteResultPaths(exec && exec.name, result.value)
            if (value !== result.value) patch = value
          }
        } catch { /* never block a result */ }
        const chain = next()
        if (patch === undefined) return chain
        return chain.then((decision) => {
          try {
            if (decision && decision.kind === 'accept') return { ...decision, value: patch }
          } catch { /* keep the downstream decision */ }
          return decision
        })
      })
      console.log(TAG + ' result-path dialect active on tools/post-execute')
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
                return value && value.posixPaths === true ? POSIX_DIRECTIVE_TEXT : ''
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
    if (state === 'unmodified' && syncDecision({ state, marker, version, sourceHashes, base, persona, present, rows: markerRows }) === 'idle') {
      ctx.logger?.('gitbash-shell')?.debug?.( `preset '${presetId}' up to date (v${version}, ${base}-era${persona === 'split' ? ', persona-split' : ''}) — idle`)
      continue
    }

    const skills = materialize({ target, presetId, skillsSource, version, base, persona, present, rows })
    const verb = state === 'absent' ? 'materialized' : 'refreshed'
    console.log(
      `${TAG} ${verb} preset '${presetId}' into ${userRootPath} (v${version}, ${base}-era composition${persona === 'split' ? ', persona-split' : ''})` +
        (skills === 'copied' ? " (skills copied from the installed 'cordis' preset)" : '')
    )
  }
}

// Test surface: pure helpers, no Cordis context required.
export const _internal = { PRESET_IDS, translateMsysPath, translatePathArguments, readPosixPaths, windowsToMsys, rewriteResultPaths, MARKER_FILE, classify, materialize, cleanupOnDispose, firstUserRoot, hashTree, skillsHashes, syncDecision, installRegisterShim, baseForRoster, detectBase, pickComposition, personaEraForText, detectPersonaEra, injectPresentRow, hostHasToolPresent, detectPresentSupport, rowFormOf, rowFormsOf, alignEngineRow, alignRalphRow, ROW_SOURCE }
