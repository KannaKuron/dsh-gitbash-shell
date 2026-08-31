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

/**
 * Pick the committed composition asset inside one variant directory (pure).
 * The ptc-era twin is preferred when the roster says `ptc`; variants without
 * a twin (minimal — its built-in did not change) fall back to the plain base
 * file. Every candidate is a committed file — no runtime text synthesis.
 */
function pickComposition(base, available) {
  const era = eraSuffix(base)
  const candidates = [`agent.cordis${era}.yml`, 'agent.cordis.yml']
  for (const file of candidates) if (available.includes(file)) return file
  return 'agent.cordis.yml'
}

/** Startup decision for an existing unmodified tree: 'refresh' or 'idle'. */
function syncDecision({ state, marker, version, sourceHashes, base = 'code' }) {
  if (state !== 'unmodified' || !marker) return 'refresh'
  if (marker.version !== version) return 'refresh'
  if (marker.base !== base) return 'refresh'
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

/** Write one preset directory from scratch. Returns 'ok' or 'no-skills-source'. */
function materialize({ target, presetId, skillsSource, version, base = 'code' }) {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })

  const available = readdirSync(join(pkgDir, 'assets', presetId)).filter((f) => f.endsWith('.yml'))
  const compositionFile = pickComposition(base, available)
  writeFileSync(join(target, 'agent.cordis.yml'), readFileSync(join(pkgDir, 'assets', presetId, compositionFile)))
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

  const marker = { managedBy: MANAGED_BY, version, presetId, base, files: hashTree(target) }
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
const POSIX_DIRECTIVE_TEXT = 'The host is Windows and the working shell is Git for Windows bash: use POSIX-style paths with MSYS drive roots everywhere — /c/Users/..., /e/project/... Every tool accepts this form: bash commands and the workdir parameter, and the file tools (read, write, edit, read_image, glob, grep) file_path/path arguments — MSYS roots are translated for them automatically, so never switch to a Windows form on their behalf. Never emit Windows drive-letter paths (C:\Users or C:/Users): when instructions, facts, or context show one, rewrite it to the POSIX form before use; when a tool result prints a Windows path, use its POSIX form (/c/...) in later calls.'

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
 * Rewrite MSYS drive roots in an arguments object path fields, in place.
 * @returns {boolean} whether any field changed (false also when args is not
 *   an object — the caller treats that as nothing to do).
 */
export function translatePathArguments(args) {
  if (!args || typeof args !== 'object') return false
  let changed = false
  for (const key of Object.keys(args)) {
    if (!TRANSLATABLE_PATH_FIELDS.has(key)) continue
    const value = args[key]
    if (typeof value !== 'string') continue
    const translated = translateMsysPath(value)
    if (translated === value) continue
    try { args[key] = translated; changed = true } catch { /* frozen: degrade */ }
  }
  return changed
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
            posixPaths: Schema.boolean().default(false),
          }))
          console.log(`${TAG} settings namespace registered: ${SETTINGS_NAMESPACE} (posixPaths default off)`)
        })
        .catch((error) => {
          console.log(`${TAG} settings namespace registration FAILED: ${error && error.stack || String(error)}`)
        })
    })
  } catch (error) {
    console.log(`${TAG} settings inject wiring failed: ${error?.message ?? error}`)
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
            translatePathArguments(exec.arguments)
          }
        } catch { /* never block a call on translation */ }
        return next()
      })
      console.log(TAG + ' MSYS drive-root translation active on tool dispatch')
    } catch (error) {
      console.log(TAG + ' tools/execute wiring failed: ' + (error?.message ?? error))
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
    if (state === 'unmodified' && syncDecision({ state, marker, version, sourceHashes, base }) === 'idle') {
      ctx.logger?.('gitbash-shell')?.debug?.( `preset '${presetId}' up to date (v${version}, ${base}-era) — idle`)
      continue
    }

    const skills = materialize({ target, presetId, skillsSource, version, base })
    const verb = state === 'absent' ? 'materialized' : 'refreshed'
    console.log(
      `${TAG} ${verb} preset '${presetId}' into ${userRootPath} (v${version}, ${base}-era composition)` +
        (skills === 'copied' ? " (skills copied from the installed 'cordis' preset)" : '')
    )
  }
}

// Test surface: pure helpers, no Cordis context required.
export const _internal = { PRESET_IDS, translateMsysPath, translatePathArguments, readPosixPaths, MARKER_FILE, classify, materialize, cleanupOnDispose, firstUserRoot, hashTree, skillsHashes, syncDecision, installRegisterShim, baseForRoster, detectBase, pickComposition }
