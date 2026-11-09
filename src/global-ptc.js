/**
 * dsh-gitbash-shell — global PTC SDK adoption (row switch, default OFF).
 *
 * WHY THIS EXISTS
 * A deployment that wants every agent to reach its tools through the PTC
 * `run_code` SDK instead of a per-tool native face needs the ROOT executor
 * switched: `tool-executor-native` off, `tool-executor-ptc` on. That is a
 * profile-patch decision (bundle patches are read BEFORE the profile patch
 * file), and a `preset-minimal` restatement is required on top of it because
 * minimal's `persona.complete: true` erases the SDK at assembly.
 *
 * Hand-editing that patch is exactly what this plugin's own AGENTS.md forbids
 * users to do, so the switch writes it the way the official editor would:
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
 * WHAT IS NEVER DONE
 *  - A row the user wrote with a DIFFERENT value is never overwritten — every
 *    one of those states stands down with a reason (kept-user-choice).
 *  - A non-literal row (for example `disabled: !!js …`) is never replaced by
 *    a literal.
 *  - Nothing is written when the switch is OFF, and OFF never removes rows
 *    the user added.
 *
 * @module dsh-gitbash-shell/global-ptc
 */

import { readPatchRow, findRow } from './terminal-bundle.js'

/** Root executor row that runs each tool natively on the wire. */
export const EXECUTOR_NATIVE_ROW = 'tool-executor-native'
/** Root executor row that runs each tool through the PTC run_code SDK. */
export const EXECUTOR_PTC_ROW = 'tool-executor-ptc'
/** The preset whose complete persona erases the SDK when left at the default. */
export const MINIMAL_PRESET_ROW = 'preset-minimal'

/**
 * Official 0.2.2-rc.1 `preset-minimal` restatement.
 *
 * `complete: true` would restore only the persona after prompt assembly and
 * erase the PTC SDK declarations, so minimal would publish `run_code` without
 * any callable SDK behind it. `complete: false` lets the SDK (and the normal
 * prompt sections) survive. Every other row is kept byte-for-byte aligned with
 * the pinned official preset — re-align this block when DSH is upgraded.
 *
 * Kept as a fragment (not a hand-built node) so what lands on disk reads like
 * the row a careful human would write.
 */
export const MINIMAL_PRESET_FRAGMENT = `- id: preset-minimal
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: minimal
    order: 3
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          prefix: You are a helpful software engineer assistant.
          complete: false
          includeRuntimeContext: false
      - id: tool-fs
        name: '@deepseek-ai/dsh-tool-fs'
        config:
          read: false
          readImage: true
          write: false
          edit: false
      - id: compaction
        name: cordis:group
        group: true
        isolate:
          compaction: true
        config:
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'
          - id: command-compact
            name: '@deepseek-ai/dsh-command-compact'
      - id: persistent-shell
        name: cordis:group
        group: true
        isolate:
          terminals: true
        config:
          - id: pty
            name: '@deepseek-ai/dsh-terminal'
          - id: terminal-bash
            name: '@deepseek-ai/dsh-terminal-bash'
            disabled: !!js process.platform === 'win32'
            config:
              timeoutMs: 300000
          - id: persistent-bash
            name: '@deepseek-ai/dsh-tool-bash-persistent'
            disabled: !!js process.platform === 'win32'
            config:
              timeoutMs: 300000
          - id: terminal-pwsh
            name: '@deepseek-ai/dsh-terminal-bash'
            disabled: !!js process.platform !== 'win32'
            config:
              shellDialect: pwsh
              timeoutMs: 300000
          - id: persistent-pwsh
            name: '@deepseek-ai/dsh-tool-pwsh-persistent'
            disabled: !!js process.platform !== 'win32'
            config:
              timeoutMs: 300000
`

/**
 * Flatten one `preset-minimal` row into the single fact this module decides on.
 * @param {unknown} row - a parsed patch entry.
 * @returns {{complete?: boolean, opaque?: true}|undefined}
 */
export function readMinimalRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined
  const config = row.config
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { opaque: true }
  const plugins = config.plugins
  // A preset row without a plugin list is not the shape we write; refuse to
  // reason about it rather than appending a second, contradictory row.
  if (!Array.isArray(plugins)) return { opaque: true }
  const persona = plugins.find((entry) => entry && typeof entry === 'object' && entry.id === 'persona')
  if (!persona) return { opaque: true }
  const complete = persona?.config?.complete
  if (complete === true) return { complete: true }
  if (complete === false) return { complete: false }
  // Unset is the official default (true), so an absent key is NOT our shape.
  return complete === undefined ? { complete: true } : { opaque: true }
}

/**
 * Pure decision: should (and how exactly) the profile patch adopt the global
 * PTC executor for this host?
 *
 * One action plus one human reason, every state enumerable and testable —
 * mirroring `planTerminalBundleAdopt`.
 *
 * @param {{enabled?: boolean, rows?: {native?: object, ptc?: object, minimal?: object}}} input
 *   `rows` are the FLATTENED facts (`readPatchRow` / `readMinimalRow` output).
 * @returns {{action: string, reason: string, writeNative?: boolean, writePtc?: boolean, writeMinimal?: boolean}}
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
  const minimal = rows?.minimal

  // A non-literal value is somebody's condition, not our setting.
  if (native?.opaque === true || ptc?.opaque === true || minimal?.opaque === true) {
    return {
      action: 'kept-user-choice',
      reason: 'a root executor or preset row carries a non-literal value (for example !!js) — not replacing an explicit condition with a literal',
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
  if (minimal !== undefined && minimal.complete !== false) {
    return {
      action: 'kept-user-choice',
      reason: 'a user-written preset-minimal row keeps a complete persona; restating it would overwrite that choice',
    }
  }

  const writeNative = native === undefined
  const writePtc = ptc === undefined
  const writeMinimal = minimal === undefined
  if (!writeNative && !writePtc && !writeMinimal) {
    return {
      action: 'unchanged',
      reason: 'the profile patch already runs every agent through the global PTC SDK (native off, ptc on, minimal restated with complete:false)',
    }
  }
  return {
    action: 'adopt',
    reason: `writing the global PTC SDK overrides (${[
      writeNative ? 'native off' : undefined,
      writePtc ? 'ptc on' : undefined,
      writeMinimal ? 'minimal restated' : undefined,
    ].filter(Boolean).join(', ')})`,
    writeNative,
    writePtc,
    writeMinimal,
  }
}

/**
 * Extract the current override rows for the three ids this module owns.
 * @param {object} yaml - the eemeli yaml module (unused, kept for symmetry).
 * @param {object} document - a yaml parseDocument result.
 * @returns {{native?: object, ptc?: object, minimal?: object, indices?: {native: number, ptc: number, minimal: number}}}
 */
export function currentGlobalPtcRows(yaml, document) {
  const out = {}
  const indices = { native: -1, ptc: -1, minimal: -1 }
  const items = document?.contents?.items
  if (!Array.isArray(items)) return { ...out, indices }

  items.forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const id = typeof item.get === 'function' ? item.get('id') : item.id
    if (id === EXECUTOR_NATIVE_ROW) {
      indices.native = index
      out.native = readPatchRow(toPlain(item))
    } else if (id === EXECUTOR_PTC_ROW) {
      indices.ptc = index
      out.ptc = readPatchRow(toPlain(item))
    } else if (id === MINIMAL_PRESET_ROW) {
      indices.minimal = index
      out.minimal = readMinimalRow(toPlain(item))
    }
  })
  return { ...out, indices }
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

  const { indices } = currentGlobalPtcRows(yamlModule, document)

  // LIFT: remove only rows whose value is EXACTLY ours. A row the user edited
  // since is left alone — turning the switch off must not delete their work.
  if (lift === true) {
    const snapshot = currentGlobalPtcRows(yamlModule, document)
    const remove = []
    if (snapshot.native?.disabled === true) remove.push(indices.native)
    if (snapshot.ptc?.disabled === false) remove.push(indices.ptc)
    if (snapshot.minimal?.complete === false) remove.push(indices.minimal)
    if (remove.length === 0) {
      return done('unchanged', 'unchanged', 'no global PTC rows of ours are present; nothing changed')
    }
    document.contents.flow = false
    // Splice from the highest index down so earlier indices still hold.
    for (const index of remove.sort((a, b) => b - a)) {
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
    // Verify by re-reading what landed on disk.
    try {
      const reread = parse(await io.readFile(patchPath))
      const rows = currentGlobalPtcRows(yamlModule, reread)
      if (rows.native?.disabled === true || rows.ptc?.disabled === false || rows.minimal?.complete === false) {
        await io.writeFileAtomic(patchPath, before)
        return done('lift', 'write-failed', undefined, { detail: 'the written patch still carries a global PTC override; rolled back to the previous bytes' })
      }
    } catch (error) {
      try { await io.writeFileAtomic(patchPath, before) } catch { /* report the primary failure */ }
      return done('lift', 'write-failed', undefined, { detail: `the verification read failed (${error?.message ?? error}); rolled back to the previous bytes` })
    }
    return done('lift', 'lifted', 'removed the global PTC rows this switch wrote', { wrote: ['lift'] })
  }

  // ADOPT
  const rows = currentGlobalPtcRows(yamlModule, document)
  const plan = planGlobalPtcAdopt({ enabled, rows })
  if (plan.action !== 'adopt') return done(plan.action, plan.action, plan.reason)

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
  if (plan.writeMinimal) {
    const row = addFragment(MINIMAL_PRESET_FRAGMENT)
    if (row === undefined) return done('adopt', 'write-failed', plan.reason, { detail: 'the preset-minimal fragment did not parse; nothing was written' })
    document.add(row)
    wrote.push(MINIMAL_PRESET_ROW)
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
  try {
    const reread = parse(await io.readFile(patchPath))
    const after = currentGlobalPtcRows(yamlModule, reread)
    const nativeOk = after.native?.disabled === true
    const ptcOk = after.ptc?.disabled === false
    const minimalOk = after.minimal?.complete === false
    if (!nativeOk || !ptcOk || !minimalOk) {
      await io.writeFileAtomic(patchPath, before)
      return done('adopt', 'write-failed', plan.reason, { detail: 'the written patch did not read back as intended; rolled back to the previous bytes' })
    }
  } catch (error) {
    try { await io.writeFileAtomic(patchPath, before) } catch { /* report the primary failure */ }
    return done('adopt', 'write-failed', plan.reason, { detail: `the verification read failed (${error?.message ?? error}); rolled back to the previous bytes` })
  }

  return done('adopt', 'adopted', plan.reason, { wrote })
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
