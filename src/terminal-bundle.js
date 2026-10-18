/**
 * dsh-gitbash-shell — OFFICIAL persistent-terminal bundle adoption (v0.41.0).
 *
 * The experimental terminal bundle (@deepseek-ai/dsh-experimental-terminal-bundle)
 * ships its shell backends behind a bundle patch whose own win32 gating reads:
 * the bash backend row is DISABLED on win32 and the pwsh backend row is enabled
 * — its README states this verbatim ("POSIX 使用 Bash,Windows 使用 PowerShell").
 * On a Git Bash house that is exactly backwards: the official terminal_* tools
 * would open PowerShell while every other shell surface on this host runs Git
 * Bash (session tool, sidebar terminal, PTC translation).
 *
 * Fixing it needs a PROFILE-PATCH edit, not the settings service:
 *  - the bundle rows are group CHILDREN, and the host patch algorithm addresses
 *    children by id (buildMap recurses into group config arrays), so a profile
 *    patch row `- id: optional-terminal-bash {disabled: false, config:{...}}`
 *    overrides the bundle row (bundle patches are read BEFORE the profile patch
 *    file — packages/boot/app-boot/src/profile-context.ts:57);
 *  - configEditor CANNOT do this (measured, packages/boot/config-editor):
 *    entries() only sees include-mounted TOP-LEVEL rows, and edit() only
 *    writes the config key, never a row-level `disabled`.
 *
 * So this module edits the profile patch file directly, with the same care the
 * official editor takes: `yaml`'s parseDocument (comments and !!js expressions
 * survive untouched), targeted setIn on the two rows, a re-parse self-check,
 * an atomic write, a verify-by-reread and a rollback to the previous bytes on
 * any mismatch. HARD RULES (inherited from terminal-shell.js): never overwrite
 * an explicit user choice, only ever write a VERIFIED Git Bash path, and
 * re-read after writing.
 *
 * The bundle not being mounted is the normal state for most hosts: nothing is
 * written then, and the session-tool inline patch keeps owning the shell story.
 *
 * @module dsh-gitbash-shell/terminal-bundle
 */

import { normalizeBashPath } from './bash-path.js'

/** Bundle row that mounts the terminal_* tool suite — its presence (enabled) IS the bundle. */
export const TERMINAL_BUNDLE_TOOL_ROW = 'optional-tool-terminal'
/** Bundle row for the persistent bash backend (disabled on win32 by the bundle itself). */
export const TERMINAL_BUNDLE_BASH_ROW = 'optional-terminal-bash'
/** Bundle row for the persistent pwsh backend (enabled on win32 by the bundle itself). */
export const TERMINAL_BUNDLE_PWSH_ROW = 'optional-terminal-pwsh'

/** Live dialect fact for the prompt-assembly waterfall (read by index.js).
 * True only when the persistent terminal provably runs this host's Git Bash. */
export const terminalDialect = { gitBash: false }

/**
 * Is the official terminal bundle mounted with its tool row active? The tool
 * row's presence is what turns terminal_open on — the shell backends without
 * it are inert. Reads through the loader service the same way the ops
 * presence probe does (an async fiber, so this awaits).
 * @param {object} ctx - host context carrying `inject`.
 * @returns {Promise<boolean>}
 */
export async function detectTerminalBundle(ctx) {
  let present = false
  await ctx.inject(['loader'], (loaderCtx) => {
    const entries = loaderCtx?.get?.('loader')?.entries?.()
    if (typeof entries?.[Symbol.iterator] !== 'function') return
    for (const entry of entries) {
      if (entry?.options?.id !== TERMINAL_BUNDLE_TOOL_ROW) continue
      if (entry.options.disabled === true) continue
      present = true
      break
    }
  })
  return present
}

/**
 * Read the plugin config entry for one patch row (the fields this module owns).
 * Takes the RAW parsed patch entry (`config` wrapper included) and returns the
 * FLATTENED facts; undefined when the input is not a row-shaped object.
 * @param {unknown} row - a parsed patch entry.
 * @returns {{disabled?: boolean, shellPath?: string}|undefined}
 */
export function readPatchRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined
  const out = {}
  if (row.disabled === true) out.disabled = true
  else if (row.disabled === false) out.disabled = false
  const config = row.config
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    if (typeof config.shellPath === 'string') out.shellPath = config.shellPath
  }
  return out
}

/**
 * Pure decision: should (and how exactly) the profile patch adopt the bundle's
 * shell rows for this host? Mirrors terminal-shell's planTerminalAdopt shape —
 * one action + one human reason, every state enumerable and testable.
 * @param {{platform?: string, enabled?: boolean, mounted?: boolean, resolved?: string, rows?: {bash?: {disabled?: boolean, shellPath?: string}, pwsh?: {disabled?: boolean}}}} input - rows are the FLATTENED row facts (readPatchRow/currentBundleRows output).
 * @returns {{action: string, reason: string, bash?: {disabled: boolean, shellPath?: string}, pwsh?: {disabled: boolean}}}
 */
export function planTerminalBundleAdopt(input) {
  const { platform, enabled, mounted, resolved, rows } = input ?? {}
  if (platform !== 'win32') {
    return { action: 'skip-platform', reason: 'the persistent terminal bundle keeps its own POSIX bash backend; nothing to adopt off-Windows' }
  }
  if (mounted !== true) {
    return { action: 'bundle-absent', reason: 'the persistent terminal bundle is not mounted (or its tool row is disabled) — nothing to adopt' }
  }
  if (enabled !== true) {
    return { action: 'skip-disabled', reason: 'autoTerminalShell is off — the bundle keeps its official shell backends' }
  }
  if (typeof resolved !== 'string' || resolved.trim() === '') {
    return { action: 'skip-unresolved', reason: 'no verified Git Bash executable on this host — the bundle keeps its official backends' }
  }
  const shellPath = resolved.trim()
  // `rows` carries the FLATTENED facts (readPatchRow/currentBundleRows output):
  // { disabled?, shellPath? } — not the raw patch row with its config wrapper.
  const bash = rows?.bash
  const pwsh = rows?.pwsh
  if (bash === undefined) {
    // No user/bundle override row yet: write ours, and disable the pwsh backend
    // ONLY when no row of its own exists (a user-written row is never touched).
    const pwshWrite = pwsh === undefined ? { disabled: true } : undefined
    return {
      action: 'adopt',
      reason: pwshWrite
        ? 'writing the persistent-terminal overrides: bash backend on the verified Git Bash, pwsh backend off'
        : 'writing the persistent-terminal bash-backend override on the verified Git Bash; a pwsh-backend row already exists and is left alone',
      bash: { disabled: false, shellPath },
      ...(pwshWrite ? { pwsh: pwshWrite } : {}),
    }
  }
  if (bash.disabled === true) {
    return { action: 'kept-user-choice', reason: 'the profile patch explicitly disables the persistent bash backend — not touching an explicit user choice' }
  }
  const configured = typeof bash.shellPath === 'string' ? bash.shellPath.trim() : ''
  if (configured === '') {
    // Row exists, backend on, but shellPath left at the bundle's POSIX default
    // (/bin/bash) — that cannot work on Windows. Completing it is not a user
    // override: the field is EMPTY.
    return {
      action: 'update-shellpath',
      reason: 'the bash backend row is enabled but shellPath is unset (the bundle default /bin/bash cannot work on Windows); completing it with the verified Git Bash',
      bash: { disabled: false, shellPath },
    }
  }
  if (normalizeBashPath(configured) !== normalizeBashPath(shellPath)) {
    return { action: 'kept-user-choice', reason: `the persistent bash backend already points at "${configured}" — not overwriting an explicit user choice` }
  }
  if (pwsh !== undefined && pwsh.disabled !== true) {
    return { action: 'unchanged', reason: 'the persistent terminal already runs the verified Git Bash; the pwsh backend row is also enabled (a user choice we do not touch)' }
  }
  return { action: 'unchanged', reason: 'the persistent terminal already runs the verified Git Bash (bash row on it, pwsh backend off)' }
}

/**
 * Extract the current override rows for our two ids from a parsed patch document.
 * @param {object} yaml - the eemeli yaml module (isMap/getIn surface).
 * @param {object} document - a yaml parseDocument result.
 * @returns {{bash?: object, pwsh?: object}}
 */
export function currentBundleRows(yaml, document) {
  const out = {}
  const items = document?.contents?.items
  if (!Array.isArray(items)) return out
  const read = (id) => {
    const index = findRow(yaml, document, id)
    if (index < 0) return undefined
    const item = items[index]
    const row = {}
    const disabled = item.getIn?.(['disabled'])
    if (disabled === true || disabled === false) row.disabled = disabled
    const shellPath = item.getIn?.(['config', 'shellPath'])
    if (typeof shellPath === 'string') row.shellPath = shellPath
    return row
  }
  const bash = read(TERMINAL_BUNDLE_BASH_ROW)
  if (bash !== undefined) out.bash = bash
  const pwsh = read(TERMINAL_BUNDLE_PWSH_ROW)
  if (pwsh !== undefined) out.pwsh = pwsh
  return out
}

/**
 * Last matching row index for an id (later rows win, mirroring the host patch
 * algorithm); skips insert rows, same guards as config-editor's lookup.
 * @returns {number} index or -1.
 */
export function findRow(yaml, document, id) {
  const items = document?.contents?.items
  if (!Array.isArray(items)) return -1
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (!yaml.isMap?.(item)) continue
    if (item.getIn?.(['insert']) !== undefined) continue
    if (item.getIn?.(['id']) !== id) continue
    return i
  }
  return -1
}

/**
 * Rewrite the profile patch file so the official persistent terminal runs the
 * verified Git Bash. Reads, plans, writes ONLY on adopt/update-shellpath,
 * re-parses its own output as a self-check, writes atomically, verifies by
 * re-reading and rolls back to the previous bytes on any mismatch.
 * @param {{readFile: Function, writeFileAtomic: Function, yaml: Function}} io - injected IO (fs + yaml loader).
 * @param {{platform?: string, enabled?: boolean, mounted?: boolean, resolved?: string, patchPath: string}} input
 * @returns {Promise<{action: string, status: string, reason?: string, shellPath?: string, pwshRowWritten?: boolean}>}
 */
export async function adoptTerminalBundlePatch(io, input) {
  const done = (action, status, reason, extra = {}) => ({ action, status, reason, ...extra })
  const { patchPath } = input
  let yamlModule
  try {
    yamlModule = await io.yaml()
  } catch (error) {
    return done('skip-modules', 'skip-modules', undefined, { detail: `the yaml document module is unavailable (${error?.message ?? error})` })
  }
  if (typeof yamlModule?.parseDocument !== 'function' || typeof yamlModule?.isSeq !== 'function' || typeof yamlModule?.isMap !== 'function') {
    return done('skip-modules', 'skip-modules', undefined, { detail: 'the yaml document module lacks parseDocument/isSeq/isMap' })
  }

  let before
  try {
    before = await io.readFile(patchPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') return done('skip-read', 'skip-read', undefined, { detail: `the profile patch could not be read (${error?.message ?? error})` })
    before = '[]\n'
  }

  const parse = (text) => yamlModule.parseDocument(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }],
  })

  const document = parse(before)
  if (Array.isArray(document?.errors) && document.errors.length > 0) {
    return done('skip-parse', 'skip-parse', undefined, { detail: 'the profile patch has YAML errors; refusing to edit a broken document' })
  }
  if (!yamlModule.isSeq(document?.contents)) {
    return done('skip-shape', 'skip-shape', undefined, { detail: 'the profile patch is not a YAML sequence; refusing to edit an unknown shape' })
  }

  // The plan runs AFTER the current rows are known: it decides between
  // writing and standing down based on what the profile patch already says.
  const rows = currentBundleRows(yamlModule, document)
  const plan = planTerminalBundleAdopt({ ...input, rows })
  if (plan.action !== 'adopt' && plan.action !== 'update-shellpath') {
    return done(plan.action, plan.action, plan.reason)
  }

  // Explicit QUOTE_DOUBLE scalars: the patch stays human-readable and the
  // path keeps its quotes (the plain style a bare createNode produces is
  // valid but nothing like what a hand-written row looks like).
  const quotedScalar = (value) => {
    const node = new yamlModule.Scalar(value)
    node.type = 'QUOTE_DOUBLE'
    return node
  }
  const newMap = (...pairs) => {
    const map = document.createNode({})
    for (const [key, value] of pairs) map.set(key, value)
    return map
  }

  // An empty patch file parses as a FLOW sequence ([]); once rows are added
  // it must print in block style or every new row comes out one-line flow.
  document.contents.flow = false

  // A brand-new row is added by parsing a handwritten-looking FRAGMENT and
  // pushing its node: what lands on disk then reads exactly like the row a
  // careful human would write (block style, quoted path), instead of the
  // flow-style shape a bare createNode serializes to.
  const rowFromFragment = (text) => {
    const fragment = parse(text)
    if (Array.isArray(fragment?.errors) && fragment.errors.length > 0) return undefined
    return fragment?.contents?.items?.[0]
  }
  const bashIndex = findRow(yamlModule, document, TERMINAL_BUNDLE_BASH_ROW)
  const bashNode = plan.bash
  if (bashIndex >= 0) {
    document.setIn([bashIndex, 'disabled'], bashNode.disabled)
    document.setIn([bashIndex, 'config'], newMap(['shellPath', quotedScalar(bashNode.shellPath)]))
  } else {
    const row = rowFromFragment(`- id: ${TERMINAL_BUNDLE_BASH_ROW}\n  disabled: ${bashNode.disabled}\n  config:\n    shellPath: ${JSON.stringify(bashNode.shellPath)}\n`)
    if (row === undefined) {
      return done(plan.action, 'write-failed', plan.reason, { detail: 'the new bash row fragment did not parse; nothing was written' })
    }
    document.add(row)
  }
  let pwshRowWritten = false
  if (plan.pwsh && findRow(yamlModule, document, TERMINAL_BUNDLE_PWSH_ROW) < 0) {
    const row = rowFromFragment(`- id: ${TERMINAL_BUNDLE_PWSH_ROW}\n  disabled: ${plan.pwsh.disabled}\n`)
    if (row === undefined) {
      return done(plan.action, 'write-failed', plan.reason, { detail: 'the new pwsh row fragment did not parse; nothing was written' })
    }
    document.add(row)
    pwshRowWritten = true
  }

  // Self-check before touching disk: the serialized document must re-parse clean.
  const serialized = String(document)
  const check = parse(serialized)
  if (Array.isArray(check?.errors) && check.errors.length > 0) {
    return done(plan.action, 'write-failed', plan.reason, { detail: 'the edited patch did not re-parse cleanly; nothing was written' })
  }
  if (findRow(yamlModule, check, TERMINAL_BUNDLE_BASH_ROW) < 0) {
    return done(plan.action, 'write-failed', plan.reason, { detail: 'the edited patch lost the bash row during serialization; nothing was written' })
  }

  try {
    await io.writeFileAtomic(patchPath, serialized)
  } catch (error) {
    return done(plan.action, 'write-failed', plan.reason, { detail: `the atomic write failed (${error?.message ?? error}); the previous patch bytes stand` })
  }

  // Verify by re-reading what actually landed on disk.
  try {
    const reread = parse(await io.readFile(patchPath))
    const rows = currentBundleRows(yamlModule, reread)
    const bash = rows.bash
    const pathOk = bash !== undefined
      && bash.disabled === false
      && typeof bash.shellPath === 'string'
      && normalizeBashPath(bash.shellPath) === normalizeBashPath(bashNode.shellPath)
    const pwshOk = !pwshRowWritten || readPatchRow(rows.pwsh)?.disabled === true
    if (!pathOk || !pwshOk) {
      await io.writeFileAtomic(patchPath, before)
      return done(plan.action, 'write-failed', plan.reason, { detail: 'the written patch did not read back as intended; rolled back to the previous bytes' })
    }
  } catch (error) {
    try { await io.writeFileAtomic(patchPath, before) } catch { /* report the primary failure */ }
    return done(plan.action, 'write-failed', plan.reason, { detail: `the verification read failed (${error?.message ?? error}); rolled back to the previous bytes` })
  }

  return done(plan.action, plan.action === 'adopt' ? 'adopted' : 'updated', plan.reason, { shellPath: bashNode.shellPath, pwshRowWritten })
}

/**
 * One line per outcome, terminal-shell style.
 * @param {{action: string, status: string, reason?: string, detail?: string, shellPath?: string}} result
 * @returns {string}
 */
export function terminalBundleReport(result) {
  if (!result || typeof result !== 'object') return 'persistent terminal adoption returned nothing'
  if (typeof result.detail === 'string' && result.detail !== '') return `persistent terminal: ${result.status} — ${result.detail}`
  if (typeof result.reason === 'string' && result.reason !== '') return `persistent terminal: ${result.reason}`
  return `persistent terminal: ${result.status}`
}
