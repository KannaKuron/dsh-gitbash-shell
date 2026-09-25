/**
 * dsh-gitbash-shell — Git for Windows bash RESOLUTION (issue #11).
 *
 * One resolver, used by BOTH the executor (src/shell.js) and the path-dialect
 * translation layer (src/index.js). Before v0.28.0 the translation layer
 * probed PATH on its own while the executor kept whatever `bashPath` the patch
 * hard-coded, so a Git installed outside `C:/Program Files/Git` produced
 * "translation works, the shell does not exist" — the split this module ends.
 *
 * THE TWO HARD RULES (user, 2026-09-25; see AGENTS.md §4h):
 *   1. Never substitute another shell. No pwsh, no cmd, no WSL bash, no
 *      "temporarily keep something runnable": an unresolved bash is a FAILURE
 *      with guidance, never a silent downgrade.
 *   2. Only Git for Windows' own bash counts. WSL's starter
 *      (`C:\Windows\System32\bash.exe`, always on PATH), the WindowsApps
 *      alias, MSYS2's and Cygwin's bash are REJECTED — they speak a different
 *      path world, so using one is worse than finding none.
 *
 * The resolver is deliberately injectable: every filesystem/process fact
 * arrives through `io`, so the whole chain is unit-testable off-Windows.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

/** The historical default — still the FIRST default-path candidate. */
export const DEFAULT_GIT_BASH = 'C:/Program Files/Git/bin/bash.exe'

/** Where a user without Git for Windows should go. */
export const GIT_BASH_DOWNLOAD_URL = 'https://git-scm.com/download/win'

/**
 * Path fragments (on the NORMALIZED path) that disqualify a bash outright.
 * `system32` and `windowsapps` are WSL's two delivery points; `msys`/`cygwin`
 * are the sibling Unix emulations; `wsl` catches distro-installed shims.
 */
export const REJECTED_BASH_MARKERS = ['system32', 'windowsapps', 'msys', 'cygwin', 'wsl']

/** `git version 2.54.0.windows.1` — only Git for Windows prints this. */
export const GIT_WINDOWS_VERSION_MARKER = '.windows.'

/** The final veto: what `bash -c 'uname -s'` must print on Git for Windows. */
export const GIT_BASH_UNAME = /^MINGW(32|64)_NT-/

/** Exit codes/sources reported back to the caller. */
export const BASH_SOURCES = ['configured', 'default', 'path', 'path-git', 'registry']

/**
 * Normalize a Windows path for comparison: forward slashes, lowercase, no
 * duplicate separators, no trailing separator. Short (8.3) names cannot be
 * expanded without the filesystem, so callers on Windows pass the resolved
 * path when they have one.
 * @param {unknown} value - candidate path.
 * @returns {string} the normalized form ('' for non-strings).
 */
export function normalizeBashPath(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Does this path point at something that is NOT Git for Windows' bash? The
 * blacklist runs BEFORE any filesystem probe, so a WSL starter on PATH is
 * never even considered a candidate (issue #11's head trap: System32 is
 * always on PATH and sorts first).
 * @param {unknown} candidate - candidate path.
 * @returns {string|undefined} the matched marker, or undefined when clean.
 */
export function rejectedBashMarker(candidate) {
  const path = normalizeBashPath(candidate)
  if (path === '') return undefined
  const segments = path.split('/')
  for (const marker of REJECTED_BASH_MARKERS) {
    // Whole-segment matches only: "C:/tools/msys2/usr/bin/bash.exe" is caught by
    // the `msys2` segment? No — by `msys` as a substring of that segment, which
    // is exactly what we want (msys2, msys64, msys32). `system32`/`windowsapps`
    // are full segments in practice; match the segment both ways.
    for (const segment of segments) {
      if (segment === marker || segment.includes(marker)) return marker
    }
  }
  return undefined
}

/**
 * The Git root a bash path implies (`<root>/bin/bash.exe` → `<root>`), or ''
 * when the shape is wrong.
 * @param {unknown} bashPath - candidate bash path.
 * @returns {string} the normalized root, or ''.
 */
export function gitRootOfBash(bashPath) {
  const path = normalizeBashPath(bashPath)
  const parts = path.split('/')
  if (parts.length < 2 || parts[parts.length - 1] !== 'bash.exe') return ''
  return parts.slice(0, -2).join('/')
}

/**
 * Validate one candidate as Git for Windows' bash. Every step is a hard
 * requirement; the first failure decides the rejection code.
 * @param {string} candidate - absolute candidate path.
 * @param {object} io - injected facts (see {@link defaultIo}).
 * @returns {{ok: true, path: string, root: string, gitExe: string}
 *   | {ok: false, code: string, detail: string}} the verdict.
 */
export function classifyBashCandidate(candidate, io) {
  const marker = rejectedBashMarker(candidate)
  if (marker !== undefined) {
    return { ok: false, code: 'rejected-shell', detail: 'path matches the "' + marker + '" exclusion (WSL/MSYS2/Cygwin are not Git Bash)' }
  }
  const root = gitRootOfBash(candidate)
  if (root === '') return { ok: false, code: 'bad-shape', detail: 'not a <git-root>/bin/bash.exe shape' }
  if (!io.exists(candidate)) return { ok: false, code: 'missing', detail: 'file does not exist' }
  // Git for Windows layout: a git binary beside it AND the MSYS runtime.
  const gitExe = [root + '/cmd/git.exe', root + '/bin/git.exe'].find((path) => io.exists(path))
  if (gitExe === undefined) return { ok: false, code: 'no-git-exe', detail: 'no cmd/git.exe or bin/git.exe under ' + root }
  if (!io.exists(root + '/usr/bin/bash.exe')) return { ok: false, code: 'no-usr-bin', detail: 'no usr/bin/bash.exe under ' + root }
  if (!(io.exists(root + '/mingw64') || io.exists(root + '/usr/bin/msys-2.0.dll'))) {
    return { ok: false, code: 'no-mingw', detail: 'no mingw64/ and no usr/bin/msys-2.0.dll under ' + root }
  }
  // Version fingerprint: only Git for Windows prints `.windows.`.
  const version = io.gitVersion(gitExe)
  if (typeof version !== 'string' || !version.includes(GIT_WINDOWS_VERSION_MARKER)) {
    return { ok: false, code: 'not-windows-git', detail: (version === undefined ? 'git --version failed' : 'git --version = "' + version + '"') + ' (no "' + GIT_WINDOWS_VERSION_MARKER + '" marker)' }
  }
  // The final veto: run the candidate itself.
  const uname = io.uname(candidate)
  if (typeof uname !== 'string' || !GIT_BASH_UNAME.test(uname.trim())) {
    return { ok: false, code: 'not-git-bash', detail: "bash -c 'uname -s' = " + (uname === undefined ? 'failed' : JSON.stringify(uname)) + ' (not MINGW*_NT-*)' }
  }
  return { ok: true, path: candidate, root, gitExe }
}

/**
 * The ordered candidate chain for one resolution, WITHOUT validation. Order is
 * the contract (issue #11): explicit setting → default install locations →
 * PATH → git.exe reverse lookup → registry PATH (the last one only helps when
 * the process PATH snapshot predates a user's PATH edit).
 * @param {object} input - resolution input.
 * @param {string} input.configured - explicit path ('' = none).
 * @param {object} io - injected facts.
 * @returns {{path: string, source: string}[]} the ordered candidates.
 */
export function bashCandidates({ configured }, io) {
  const out = []
  const explicit = typeof configured === 'string' ? configured.trim() : ''
  if (explicit !== '') {
    out.push({ path: explicit, source: 'configured' })
    return out // an explicit setting is the user's answer; never substitute it
  }
  for (const path of io.defaults()) out.push({ path, source: 'default' })
  for (const path of io.pathBashCandidates()) out.push({ path, source: 'path' })
  for (const path of io.gitReverseCandidates()) out.push({ path, source: 'path-git' })
  for (const path of io.registryBashCandidates()) out.push({ path, source: 'registry' })
  return out
}

/**
 * Resolve the Git for Windows bash to run. Pure w.r.t. every fact it needs —
 * all of it arrives through `io`, which is why the whole chain (including the
 * Windows-only registry step) is unit-testable anywhere.
 * @param {object} [options] - resolution options.
 * @param {string} [options.configured] - explicit `bashPath` from config.
 * @param {object} [options.io] - injected facts; defaults to the real ones.
 * @returns {{ok: boolean, path: string, root: string, gitExe: string, source: string,
 *   tried: {path: string, source: string, code: string, detail: string}[],
 *   configured: string}} the verdict, with the full probe list for guidance.
 */
export function resolveGitBash(options = {}) {
  const io = options.io ?? defaultIo()
  const configured = typeof options.configured === 'string' ? options.configured.trim() : ''
  const tried = []
  const rejected = []
  for (const candidate of bashCandidates({ configured }, io)) {
    let verdict
    try {
      verdict = classifyBashCandidate(candidate.path, io)
    } catch (error) {
      verdict = { ok: false, code: 'probe-failed', detail: String(error && error.message ? error.message : error) }
    }
    if (verdict.ok) {
      return { ok: true, path: verdict.path, root: verdict.root, gitExe: verdict.gitExe, source: candidate.source, tried, rejected, configured }
    }
    tried.push({ path: candidate.path, source: candidate.source, code: verdict.code, detail: verdict.detail })
    rejected.push(verdict.code)
  }
  return { ok: false, path: '', root: '', gitExe: '', source: '', tried, rejected, configured }
}

/**
 * The fail-loud report for one resolution — the text a user reads in the host
 * log when Git Bash could not be resolved. It states the design rather than
 * blaming the environment: this plugin will NOT fall back to another shell.
 * @param {object} resolution - a {@link resolveGitBash} result.
 * @returns {string} the multi-line report.
 */
export function bashResolutionReport(resolution) {
  const lines = []
  if (resolution.ok) {
    lines.push('Git Bash resolved from the ' + resolution.source + ' source: ' + resolution.path)
    if (resolution.tried.length > 0) {
      lines.push('  (probed first, rejected: ' + resolution.tried.map((row) => row.path + ' [' + row.code + ']').join(', ') + ')')
    }
    return lines.join('\n')
  }
  lines.push('Git Bash could NOT be resolved — the shell is unavailable by design, not broken: this plugin never falls back to PowerShell, cmd or a WSL/MSYS2/Cygwin bash.')
  lines.push(resolution.configured === ''
    ? '  bashPath is empty, so the automatic chain ran (setting > default install paths > PATH > registry PATH).'
    : '  bashPath is set to "' + resolution.configured + '" and that value was rejected; nothing else is substituted.')
  if (resolution.tried.length === 0) lines.push('  probed: (nothing — no candidate was produced)')
  for (const row of resolution.tried) lines.push('  probed [' + row.source + '] ' + row.path + ' -> ' + row.code + ' (' + row.detail + ')')
  lines.push('  fix: set the "Git Bash path" field in this plugin\'s settings, or install Git for Windows: ' + GIT_BASH_DOWNLOAD_URL)
  lines.push('  note: only Git for Windows\' own bash is accepted; WSL (/Windows/System32/bash.exe), the WindowsApps alias, MSYS2 and Cygwin are refused on purpose.')
  return lines.join('\n')
}


/**
 * The explicit `bashPath` a SETTINGS row carries, read the era-aware way (the
 * exact double shape src/index.js uses for better-sidebar's namespace): on
 * dsh <= 0.1.6 through `settings.get(ns).bashPath`, on >= 0.1.7 through
 * `settings.describe()`'s own row. Never throws; a missing service reads ''.
 * @param {object} ctx - a context exposing `settings`.
 * @param {string} [ns] - the settings namespace/row id (default this plugin's).
 * @returns {string} the configured path, '' when unset or unreadable.
 */
export function settingsBashPath(ctx, ns = 'gitbash-shell') {
  try {
    const settings = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : undefined
    if (!settings) return ''
    if (typeof settings.get === 'function') {
      const value = settings.get(ns)
      return value && typeof value === 'object' && typeof value.bashPath === 'string' ? value.bashPath : ''
    }
    if (typeof settings.describe === 'function') {
      const entry = settings.describe().find((row) => row !== null && typeof row === 'object' && row.ns === ns)
      const value = entry === undefined ? undefined : entry.value
      return value && typeof value === 'object' && typeof value.bashPath === 'string' ? value.bashPath : ''
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * Merge the explicit tiers of the chain: the row's OWN config wins over the
 * settings row, which wins over empty (which means "run the automatic chain").
 * The order is the contract (issue #11): an explicit answer is never
 * substituted, and an empty one is not an answer at all.
 * @param {unknown} ownRowValue - `gitbash-executor` row config's `bashPath`.
 * @param {unknown} settingsValue - the `gitbash-shell` row/settings `bashPath`.
 * @returns {string} the explicit path to resolve with.
 */
export function effectiveConfiguredBashPath(ownRowValue, settingsValue) {
  const own = typeof ownRowValue === 'string' ? ownRowValue.trim() : ''
  if (own !== '') return own
  return typeof settingsValue === 'string' ? settingsValue.trim() : ''
}


/**
 * The `gitbash-executor` ROW's own `bashPath` — the highest-priority tier.
 * Read through the Loader's public `resolve(id)` (the row id is part of this
 * plugin's own bundle patch), so the translation layer sees the same explicit
 * value the executor row carries instead of quietly resolving a different
 * one. Absent row / absent config / any loader shape change reads ''.
 * @param {object} ctx - a context exposing `loader`.
 * @returns {string} the row's configured path, '' when unset.
 */
export function executorConfiguredBashPath(ctx) {
  try {
    const entry = ctx && ctx.loader && typeof ctx.loader.resolve === 'function'
      ? ctx.loader.resolve('gitbash-executor')
      : undefined
    const value = entry && entry.options ? entry.options.config : undefined
    return value && typeof value.bashPath === 'string' ? value.bashPath : ''
  } catch {
    return ''
  }
}

/**
 * The real `io`: filesystem probes, the Windows registry PATH read (argv
 * arrays, never a shell string) and the two subprocess fingerprints.
 * Every call is defensive — a probe that throws is a candidate that fails,
 * never a crash.
 * @returns {object} the production io.
 */
export function defaultIo() {
  const run = (file, args) => {
    try {
      return String(execFileSync(file, args, { encoding: 'utf8', timeout: 5000, windowsHide: true })).trim()
    } catch {
      return undefined
    }
  }
  const registryPath = (hive, key) => {
    const out = run('reg', ['query', hive + '\\' + key, '/v', 'Path'])
    if (typeof out !== 'string') return []
    const match = /Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(out)
    if (match === null) return []
    return match[1].split(';').map((entry) => entry.trim()).filter((entry) => entry !== '')
  }
  const dirs = () => {
    const out = []
    for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
      const base = process.env[key]
      if (typeof base === 'string' && base.trim() !== '') out.push(base.replace(/\\/g, '/') + '/Git/bin/bash.exe')
    }
    const local = process.env.LOCALAPPDATA
    if (typeof local === 'string' && local.trim() !== '') out.push(local.replace(/\\/g, '/') + '/Programs/Git/bin/bash.exe')
    return out
  }
  const pathDirs = () => String(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').map((entry) => entry.trim()).filter((entry) => entry !== '')
  return {
    exists: (path) => {
      try { return existsSync(path) } catch { return false }
    },
    defaults: () => [DEFAULT_GIT_BASH, ...dirs()],
    pathBashCandidates: () => pathDirs().map((dir) => dir.replace(/\\/g, '/') + '/bash.exe'),
    gitReverseCandidates: () => pathDirs()
      .filter((dir) => /(^|[/\\])cmd$/i.test(dir) || /(^|[/\\])bin$/i.test(dir))
      .flatMap((dir) => {
        const parent = dirname(dir.replace(/\\/g, '/'))
        return [parent + '/bin/bash.exe', dirname(parent) + '/bin/bash.exe']
      }),
    registryBashCandidates: () => [
      ...registryPath('HKCU', 'Environment'),
      ...registryPath('HKLM', 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),
    ].flatMap((entry) => {
      const dir = entry.replace(/%([^%]+)%/g, (whole, name) => {
        const value = process.env[name] ?? process.env[name.toUpperCase()]
        return typeof value === 'string' ? value : whole
      })
      return /bash\.exe$/i.test(dir) ? [dir] : [dir.replace(/\\/g, '/') + '/bash.exe']
    }),
    gitVersion: (gitExe) => run(gitExe, ['--version']),
    uname: (bash) => run(bash, ['-c', 'uname -s']),
  }
}

/**
 * Process-wide memo of the resolution. The translation layer and the executor
 * MUST agree — a split ("translation resolved Q:/Git, the executor still looks
 * at C:/...") is exactly issue #11 — so both read this one cache. A failed
 * resolution is cached too: re-probing on every command would spawn `reg` and
 * `bash` repeatedly, and the diagnosed failure is stable within a boot.
 * @param {object} [options] - as {@link resolveGitBash}, plus `fresh` to bypass.
 * @returns {object} the memoized resolution.
 */
const memoized = new Map()

export function resolveGitBashCached(options = {}) {
  const key = (typeof options.configured === 'string' ? options.configured.trim() : '')
    + '\u0000' + (options.platform ?? process.platform)
  if (options.fresh === true || !memoized.has(key)) {
    memoized.set(key, resolveGitBash(options))
  }
  return memoized.get(key)
}

/**
 * Drop the memo. Keyed by the configured value already, so a settings edit
 * resolves afresh without this; the reset exists for tests and for a caller
 * that knows the environment changed (e.g. a fresh registry read).
 */
export function resetGitBashMemo() {
  memoized.clear()
}
