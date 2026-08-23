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

/** Startup decision for an existing unmodified tree: 'refresh' or 'idle'. */
function syncDecision({ state, marker, version, sourceHashes }) {
  if (state !== 'unmodified' || !marker) return 'refresh'
  if (marker.version !== version) return 'refresh'
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
function materialize({ target, presetId, skillsSource, version }) {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })

  writeFileSync(join(target, 'agent.cordis.yml'), readFileSync(join(pkgDir, 'assets', presetId, 'agent.cordis.yml')))
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

  const marker = { managedBy: MANAGED_BY, version, presetId, files: hashTree(target) }
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

// ── dsh-better-sidebar shell cooperation ───────────────────────────────────
//
// dsh-better-sidebar (v0.15.2+) resolves its terminal shell PER OPEN: a
// settings-page `terminalShell` value wins over the yaml/plugin default
// (their own words: "values here win for terminals opened afterwards").
// So this plugin adopts that official runtime seam — zero upstream change,
// no restart needed — and points the sidebar's UI terminal tabs AND the
// model-facing terminal_* tools at Git Bash on Windows. A terminal shell
// the user set themselves is respected (we only fill an empty field), and
// the write is reverted on disposal (reload/update/uninstall), so removing
// this plugin returns the sidebar to its auto/default shell.

const SIDEBAR_NS = 'dsh-better-sidebar'

/**
 * Fill the sidebar's `terminalShell` pref through the settings service.
 * One-shot; retries once after a short delay in case the sidebar's
 * namespace registration lands a beat after our row ran. Never throws.
 */
function adoptSidebarShell(ctx, bashPath) {
  let tried = 0
  const run = async () => {
    tried += 1
    const settings = ctx.get('settings')
    if (!settings || typeof settings.update !== 'function') return
    let current
    try {
      current = settings.get(SIDEBAR_NS)
    } catch {
      current = undefined // namespace not registered yet / sidebar absent
    }
    const value = current && typeof current === 'object' ? current : {}
    const existing = typeof value.terminalShell === 'string' ? value.terminalShell.trim() : ''
    if (existing !== '') return // user/deployment choice — never override
    try {
      await settings.update(SIDEBAR_NS, { terminalShell: bashPath })
    } catch (error) {
      if (tried < 2) {
        const timer = setTimeout(run, 1500)
        ctx.effect(() => () => clearTimeout(timer), 'dsh-gitbash-shell: sidebar adoption retry')
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
          s.update(SIDEBAR_NS, { terminalShell: '' }).catch(() => {})
        }
      },
      'dsh-gitbash-shell: sidebar shell revert',
    )
    console.log(`${TAG} dsh-better-sidebar terminal shell -> Git Bash (${bashPath})`)
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
  let shim = { installed: false, restore: () => {} }
  try {
    shim = installRegisterShim(ctx.get('cordisInspect'))
  } catch {
    /* never block startup */
  }
  if (shim.installed) {
    ctx.effect(() => () => shim.restore(), 'dsh-gitbash-shell: inspect-registry shim')
    console.log(`${TAG} inspect-registry compatibility shim active (multiple cordis-mode sessions supported)`)
  }

  // ── cooperation capability ────────────────────────────────────────────────
  // Publish whether the Git Bash shell stack is active on this host so peer
  // plugins (e.g. dsh-ptc-cordis-preset) can adopt it in the presets they
  // materialize: service present, 'active: true' on Windows, 'active: false'
  // where the bundle is installed but the platform stack stayed native.
  const gitBashCapability = { active: process.platform === 'win32', bashPath: DEFAULT_GIT_BASH }
  const disposeGitBash = ctx.provide('gitBash', gitBashCapability)
  ctx.effect(() => disposeGitBash, 'dsh-gitbash-shell: gitBash capability')

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
    if (state === 'unmodified' && syncDecision({ state, marker, version, sourceHashes }) === 'idle') {
      ctx.logger?.('gitbash-shell')?.debug?.( `preset '${presetId}' up to date (v${version}) — idle`)
      continue
    }

    const skills = materialize({ target, presetId, skillsSource, version })
    const verb = state === 'absent' ? 'materialized' : 'refreshed'
    console.log(
      `${TAG} ${verb} preset '${presetId}' into ${userRootPath} (v${version})` +
        (skills === 'copied' ? " (skills copied from the installed 'cordis' preset)" : '')
    )
  }
}

// Test surface: pure helpers, no Cordis context required.
export const _internal = { PRESET_IDS, MARKER_FILE, classify, materialize, cleanupOnDispose, firstUserRoot, hashTree, skillsHashes, syncDecision, installRegisterShim }
