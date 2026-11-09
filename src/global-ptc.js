/**
 * dsh-gitbash-shell — global PTC SDK adoption (row switch, default OFF).
 *
 * WHY THIS EXISTS
 * A deployment that wants every agent to reach its tools through the PTC
 * `run_code` SDK instead of a per-tool native face needs the ROOT executor
 * switched: `tool-executor-native` off, `tool-executor-ptc` on. That is a
 * profile-patch decision (bundle patches are read BEFORE the profile patch
 * file), so this module writes it the way the official editor would:
 * `yaml`'s parseDocument (comments and !!js expressions survive untouched),
 * targeted edits on known rows, a re-parse self-check, an atomic write, a
 * verify-by-reread and a rollback to the previous bytes on any mismatch.
 *
 * WHY NOT configEditor
 * Measured on packages/boot/config-editor: `entries()` only sees
 * include-mounted TOP-LEVEL rows and `edit()` only writes a config key, never
 * a row-level `disabled`. The same wall is documented in terminal-bundle.js;
 * the channel here is therefore the patch file, with the official editor's
 * own care.
 *
 * OWNERSHIP (review P0)
 * Lift never matches on a controlled field alone — see
 * `src/global-ptc-ownership.js` for the receipt that records exactly which
 * rows this switch wrote and their canonical fingerprints. A row the user
 * hand-wrote before ever toggling the switch has no receipt entry and is
 * therefore never deleted, even when it is byte-identical to ours.
 *
 * WHY preset-minimal IS NOT RESTATED (review P1)
 * minimal's `persona.complete: true` erases the PTC SDK at assembly, so a
 * minimal agent under a global PTC executor publishes `run_code` without a
 * callable SDK. The only way to fix that from here is a full restatement of
 * the preset, which AGENTS.md §4l rejects (it freezes the official row set at
 * the copy moment and drifts on every DSH upgrade; the fragment also omitted
 * the persistent-bash/persistent-pwsh descriptions). The switch therefore
 * writes ONLY the two executor rows and leaves minimal alone. A deployment
 * that needs minimal under PTC must own that restatement itself — the
 * CHANGELOG says so explicitly.
 *
 * WHAT IS NEVER DONE
 *  - A row the user shaped differently is never overwritten (kept-user-choice).
 *  - A non-literal row (`disabled: !!js …`) is never replaced by a literal.
 *  - Nothing is written when the switch is OFF.
 *  - OFF deletes only rows this switch wrote AND the user has not edited since.
 *
 * @module dsh-gitbash-shell/global-ptc
 */

import { readPatchRow } from './terminal-bundle.js'
import { OWNED_ROWS, globalPtcOwnership, rowFingerprint } from './global-ptc-ownership.js'

/** Root executor row that runs each tool natively on the wire. */
export const EXECUTOR_NATIVE_ROW = 'tool-executor-native'
/** Root executor row that runs each tool through the PTC run_code SDK. */
export const EXECUTOR_PTC_ROW = 'tool-executor-ptc'

/** The value this switch writes for each row. */
const WANTED = new Map([
  [EXECUTOR_NATIVE_ROW, true],
  [EXECUTOR_PTC_ROW, false],
])

/**
 * Pure decision: should (and how exactly) the profile patch adopt the global
 * PTC executor for this host?
 *
 * One action plus one human reason, every state enumerable and testable —
 * mirroring `planTerminalBundleAdopt`.
 *
 * @param {{enabled?: boolean, rows?: {native?: {disabled?: boolean, opaque?: true}, ptc?: {disabled?: boolean, opaque?: true}}}} input
 *   `rows` are the FLATTENED facts (`readPatchRow` output).
 * @returns {{action: string, reason: string, writeNative?: boolean, writePtc?: boolean}}
 */
export function planGlobalPtcAdopt(input) {
  const { enabled, rows } = input ?? {}
  if (enabled !== true) {
    return {
      action: 'skip-disabled',
      reason: 'globalPtcSdk is off — the root executor keeps its official shape (native face, no SDK)',
    }
  }

  const native = rows?.native
  const ptc = rows?.ptc

  // A non-literal value is somebody's condition, not our setting.
  if (native?.opaque === true || ptc?.opaque === true) {
    return {
      action: 'kept-user-choice',
      reason: 'a root executor row carries a non-literal value (for example !!js) — not replacing an explicit condition with a literal',
    }
  }
  // An explicit row that says the OPPOSITE of what the switch wants.
  if (native !== undefined && native.disabled !== true) {
    return {
      action: 'kept-user-choice',
      reason: 'the profile patch explicitly keeps the native root executor — not overriding an explicit user choice',
    }
  }
  if (ptc !== undefined && ptc.disabled !== false) {
    return {
      action: 'kept-user-choice',
      reason: 'the profile patch explicitly disables the PTC root executor — not overriding an explicit user choice',
    }
  }

  const writeNative = native === undefined
  const writePtc = ptc === undefined
  if (!writeNative && !writePtc) {
    return {
      action: 'unchanged',
      reason: 'the profile patch already runs every agent through the global PTC SDK (native off, ptc on)',
    }
  }
  return {
    action: 'adopt',
    reason: `writing the global PTC SDK overrides (${[
      writeNative ? 'native off' : undefined,
      writePtc ? 'ptc on' : undefined,
    ].filter(Boolean).join(', ')})`,
    writeNative,
    writePtc,
  }
}

/**
 * Extract the current override rows for the two ids this module owns.
 * @param {object} document - a yaml parseDocument result.
 * @returns {{native?: object, ptc?: object, raw?: {native?: unknown, ptc?: unknown}, indices?: {native: number, ptc: number}}}
 */
export function currentGlobalPtcRows(document) {
  const out = {}
  const raw = {}
  const indices = { native: -1, ptc: -1 }
  const items = document?.contents?.items
  if (!Array.isArray(items)) return { ...out, raw, indices }

  items.forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const id = typeof item.get === 'function' ? item.get('id') : item.id
    if (id === EXECUTOR_NATIVE_ROW) {
      indices.native = index
      raw.native = toPlain(item)
      out.native = readPatchRow(raw.native)
    } else if (id === EXECUTOR_PTC_ROW) {
      indices.ptc = index
      raw.ptc = toPlain(item)
      out.ptc = readPatchRow(raw.ptc)
    }
  })
  return { ...out, raw, indices }
}

/** Convert a yaml node to plain JS data (no anchors, no tags). */
function toPlain(node) {
  if (node && typeof node.toJSON === 'function') {
    try { return node.toJSON() } catch { return undefined }
  }
  return node
}

/**
 * Apply (or lift) the global PTC SDK override through the profile patch file.
 *
 * @param {{readFile: (file: string) => Promise<string>, writeFileAtomic: (file: string, data: string) => Promise<void>, yaml: () => Promise<object>}} io
 * @param {{patchPath: string, enabled?: boolean, lift?: boolean}} input
 * @returns {Promise<{action: string, status: string, reason?: string, detail?: string, wrote?: string[]}>}
 */
export async function adoptGlobalPtcPatch(io, input) {
  const done = (action, status, reason, extra = {}) => ({ action, status, reason, ...extra })
  const { patchPath, enabled, lift } = input ?? {}

  let yamlModule
  try {
    yamlModule = await io.yaml()
  } catch (error) {
    return done('skip-modules', 'skip-modules', undefined, { detail: `the yaml document module is unavailable (${error?.message ?? error})` })
  }
  if (typeof yamlModule?.parseDocument !== 'function' || typeof yamlModule?.isSeq !== 'function') {
    return done('skip-modules', 'skip-modules', undefined, { detail: 'the yaml document module lacks parseDocument/isSeq' })
  }

  const ownership = globalPtcOwnership(io, patchPath)

  let before
  try {
    before = await io.readFile(patchPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return done('skip-read', 'skip-read', undefined, { detail: `the profile patch could not be read (${error?.message ?? error})` })
    }
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

  // ── LIFT ────────────────────────────────────────────────────────────────
  // Delete a row only when BOTH hold: the receipt names it (this switch wrote
  // it) and the row still fingerprints to what was written (the user has not
  // edited it since). No receipt ⇒ nothing is owned ⇒ nothing is deleted.
  if (lift === true) {
    return ownership.run(async () => {
      const receipt = await ownership.read()
      const { raw, indices } = currentGlobalPtcRows(document)
      const remove = []
      for (const id of OWNED_ROWS) {
        const recorded = receipt.rows[id]
        if (typeof recorded !== 'string') continue
        const row = id === EXECUTOR_NATIVE_ROW ? raw.native : raw.ptc
        const index = id === EXECUTOR_NATIVE_ROW ? indices.native : indices.ptc
        if (index < 0 || row === undefined) continue
        if (rowFingerprint(row) !== recorded) {
          return done('lift', 'kept-user-choice', `${id} was edited after this switch wrote it — leaving the row alone`)
        }
        remove.push([id, index])
      }
      if (remove.length === 0) {
        return done('unchanged', 'unchanged', 'no global PTC rows are owned by this switch; nothing changed')
      }
      document.contents.flow = false
      // Splice from the highest index down so earlier indices still hold.
      for (const [, index] of remove.slice().sort((a, b) => b[1] - a[1])) {
        try { document.contents.items.splice(index, 1) } catch { /* reported below */ }
      }
      const after = String(document)
      const check = parse(after)
      if (Array.isArray(check?.errors) && check.errors.length > 0) {
        return done('lift', 'write-failed', 'the edited patch did not re-parse cleanly; nothing was written')
      }
      try {
        await io.writeFileAtomic(patchPath, after)
      } catch (error) {
        return done('lift', 'write-failed', undefined, { detail: `the atomic write failed (${error?.message ?? error}); the previous patch bytes stand` })
      }
      // Drop the lifted ids from the receipt so a second OFF is a no-op.
      const nextRows = { ...receipt.rows }
      for (const [id] of remove) delete nextRows[id]
      try {
        await ownership.write({ version: 1, rows: nextRows })
      } catch (error) {
        // The patch is already correct; a stale receipt only means a later OFF
        // re-checks fingerprints (and finds the rows gone). Report, do not revert.
        return done('lift', 'lifted', 'removed the global PTC rows this switch wrote (the receipt could not be updated)', { wrote: remove.map(([id]) => id), detail: `receipt write failed: ${error?.message ?? error}` })
      }
      return done('lift', 'lifted', 'removed the global PTC rows this switch wrote', { wrote: remove.map(([id]) => id) })
    })
  }

  // ── ADOPT ───────────────────────────────────────────────────────────────
  const rows = currentGlobalPtcRows(document)
  const plan = planGlobalPtcAdopt({ enabled, rows })
  if (plan.action !== 'adopt') return done(plan.action, plan.action, plan.reason)

  return ownership.run(async () => {
    document.contents.flow = false
    const addFragment = (text) => {
      const fragment = parse(text)
      if (Array.isArray(fragment?.errors) && fragment.errors.length > 0) return undefined
      return fragment?.contents?.items?.[0]
    }
    const wrote = []
    if (plan.writeNative) {
      const row = addFragment(`- id: ${EXECUTOR_NATIVE_ROW}\n  disabled: true\n`)
      if (row === undefined) return done('adopt', 'write-failed', plan.reason, { detail: 'the native-executor row fragment did not parse; nothing was written' })
      document.add(row)
      wrote.push(EXECUTOR_NATIVE_ROW)
    }
    if (plan.writePtc) {
      const row = addFragment(`- id: ${EXECUTOR_PTC_ROW}\n  disabled: false\n`)
      if (row === undefined) return done('adopt', 'write-failed', plan.reason, { detail: 'the ptc-executor row fragment did not parse; nothing was written' })
      document.add(row)
      wrote.push(EXECUTOR_PTC_ROW)
    }

    // Self-check before touching disk: the serialized document must re-parse.
    const serialized = String(document)
    const check = parse(serialized)
    if (Array.isArray(check?.errors) && check.errors.length > 0) {
      return done('adopt', 'write-failed', plan.reason, { detail: 'the edited patch did not re-parse cleanly; nothing was written' })
    }

    try {
      await io.writeFileAtomic(patchPath, serialized)
    } catch (error) {
      return done('adopt', 'write-failed', plan.reason, { detail: `the atomic write failed (${error?.message ?? error}); the previous patch bytes stand` })
    }

    // Verify by re-reading what actually landed on disk.
    let reread
    try {
      reread = parse(await io.readFile(patchPath))
    } catch (error) {
      try { await io.writeFileAtomic(patchPath, before) } catch { /* report the primary failure */ }
      return done('adopt', 'write-failed', plan.reason, { detail: `the verification read failed (${error?.message ?? error}); rolled back to the previous bytes` })
    }
    const after = currentGlobalPtcRows(reread)
    for (const [id, wanted] of WANTED) {
      const fact = id === EXECUTOR_NATIVE_ROW ? after.native : after.ptc
      if (fact?.disabled !== wanted) {
        try { await io.writeFileAtomic(patchPath, before) } catch { /* report the primary failure */ }
        return done('adopt', 'write-failed', plan.reason, { detail: `the written patch did not read back as intended (${id}); rolled back to the previous bytes` })
      }
    }

    // Record ownership ONLY for the rows this switch just wrote. A row that
    // already existed (even with the same value) is the user's and is never
    // claimed — that is what keeps OFF from deleting it.
    try {
      const receipt = await ownership.read()
      const nextRows = { ...receipt.rows }
      for (const id of wrote) {
        const row = id === EXECUTOR_NATIVE_ROW ? after.raw.native : after.raw.ptc
        if (row !== undefined) nextRows[id] = rowFingerprint(row)
      }
      await ownership.write({ version: 1, rows: nextRows })
    } catch (error) {
      // The patch is written and correct; without a receipt the rows simply
      // become unowned (OFF will leave them alone). Report, do not revert.
      return done('adopt', 'adopted', plan.reason, { wrote, detail: `the ownership receipt could not be written (${error?.message ?? error}); OFF will leave these rows alone` })
    }
    return done('adopt', 'adopted', plan.reason, { wrote })
  })
}

/**
 * One line per outcome, terminal-bundle style.
 * @param {{action: string, status: string, reason?: string, detail?: string, wrote?: string[]}} result
 * @returns {string}
 */
export function globalPtcReport(result) {
  if (!result || typeof result !== 'object') return 'global PTC SDK adoption returned nothing'
  if (typeof result.detail === 'string' && result.detail !== '') return `global PTC SDK: ${result.status} — ${result.detail}`
  if (typeof result.reason === 'string' && result.reason !== '') return `global PTC SDK: ${result.reason}`
  return `global PTC SDK: ${result.status}`
}
