/**
 * dsh-gitbash-shell — dsh-ops bash removal from the agent face.
 *
 * THE PROBLEM (user report 2026-10-19, owner decision the same day): with
 * dsh-ops installed, the model sees BOTH a bash tool (ours) and ops_bash
 * (theirs). v0.41.0 answered calls with a pre-execute denial, but the tool
 * stayed VISIBLE — the user: "ops_bash 和 ops_run 直接就看不见了, 不会增加模型
 * 心智负担". Visibility, not denial, is the requirement.
 *
 * WHY DENIAL CANNOT BECOME HIDING (host source, dsh 0.2.1-rc.2, measured):
 * tools.restrict({ deny }) filters only the INHERITED surface — the global
 * layer and every ancestor layer on the scope chain. A scope's OWN
 * registrations sit outside the filter by design ("The scope's own
 * registrations last ... outside the filter above", packages/core/tools
 * src/index.ts view()), and restrict even REFUSES to name them ("names
 * unknown global tool"). dsh-ops publishes ops_bash into each agent's own
 * layer (mountSessionBash -> per-agent registration), so no amount of
 * restricting from our side can hide it. Not registering is the only path.
 *
 * THE SWITCH (dsh-ops 0.5.0, owner decision 2026-11-06): the single
 * `dsh-ops` row owns four built-in mode sections — `minimal`,
 * `standard`, `ptc`, `cordis` — and each accepts `bash: false`
 * (`src/presets/config.ts`: `bash` wins over the legacy
 * `publishBashTool` alias, then defaults to true; the runtime multiplies
 * it with `global.bash`). Setting those four flags is dsh-ops' own
 * supported configuration, not a hack into someone else's plugin.
 *
 * SCOPE (owner decision, 2026-11-06): only the four BUILT-IN modes are
 * touched. `global.bash`, the `presets.<id>` custom bindings and every
 * other dsh-ops setting stay exactly as the user configured them: a custom
 * preset is not ours to police, and the four mode flags are what keep the
 * bash slot ours while this plugin is mounted.
 *
 * WHY THIS MODULE TALKS TO configEditor (same discipline as
 * terminal-shell.js): the write must survive restarts and must be undoable.
 * configEditor.edit(entry, change) is the channel the official settings UI
 * itself persists through — it lands in the profile patch document (official
 * YAML editor, file-locked, comment-preserving) and change returning the
 * INHERITED config makes the editor DELETE the override row again. That gives
 * us a real restore primitive instead of a hand-rolled file edit. The
 * `current` argument is the full effective row config, so the write keeps
 * every unrelated dsh-ops key (panel/tui/discovery/...) intact.
 *
 * OWNERSHIP AND RESTORE (the owner requirement: uninstalling this plugin must
 * give dsh-ops its bash back):
 *   - plugin disabled / uninstalled while dsh runs => our fiber stops => the
 *     dispose hook below runs and lifts the override through the same editor;
 *   - plugin re-enabled => boot re-adopts (idempotent: the plan is a no-op
 *     when every mode already reads false);
 *   - the one uncovered path is uninstalling while dsh is SHUT DOWN (no fiber
 *     ever stops): the override survives, the official settings card shows
 *     "已覆盖 / restore defaults" for exactly this, and flipping it back (or
 *     re-installing and disabling us) restores the row. Documented in the
 *     README; nothing else can be done from inside a stopped process.
 *
 * PRODUCT DECISION (owner, 2026-10-19): while this plugin is installed, the
 * bash tool is OURS — dsh-ops is kept for its file, search and background
 * enhancements only, and there is NO settings switch for this behavior. A
 * user who flips one of the four mode flags back to true in the settings card
 * is overridden again on our next boot; the supported way to use ops_bash is
 * to disable this plugin (which also restores the flags — the dispose hook).
 *
 * HARD RULES:
 *   1. NEVER write when the row is absent — no dsh-ops, nothing to remove.
 *   2. NEVER hand-edit the profile patch file — the official editor only.
 *   3. NEVER claim success without reading the value back.
 *   4. Restore returns the INHERITED value for OUR key only: unrelated
 *      overrides in the same row (the user's own dsh-ops settings) survive.
 *   5. NEVER write to a disabled row or mode section (it publishes nothing);
 *      restore still lifts our value from one the user disabled afterwards.
 */

/** The single Loader row dsh-ops 0.5.0 mounts. */
export const OPS_ROW_ID = 'dsh-ops'

/** The built-in mode sections that can publish ops_bash (0.5.0 shape). */
export const OPS_MODES = Object.freeze(['minimal', 'standard', 'ptc', 'cordis'])

/** @deprecated Use {@link OPS_ROW_ID}; kept for one release of import compatibility. */
export const OPS_SHELL_ROW_ID = OPS_ROW_ID

/** @deprecated Use {@link OPS_MODES}; the row ids no longer exist in 0.5.0. */
export const OPS_MODE_ROW_IDS = Object.freeze(OPS_MODES.map((mode) => 'dsh-ops-mode-' + mode))

/** @deprecated Use {@link OPS_ROW_ID}; the 0.4.x row set is gone. */
export const OPS_SHELL_ROW_IDS = Object.freeze([OPS_ROW_ID])

/** True when a value is a plain record (not an array/null). */
function isRecord(value) {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
}

/**
 * One layer's mode section, or undefined.
 * @param {object|undefined} row - one configEditor.configuration() entry.
 * @param {'override'|'inherited'} layer - which value layer to read.
 * @param {string} mode - one of {@link OPS_MODES}.
 * @returns {object|undefined} the section.
 */
function sectionOf(row, layer, mode) {
  const container = row === null || row === undefined ? undefined : row[layer]
  if (!isRecord(container)) return undefined
  const section = container[mode]
  return isRecord(section) ? section : undefined
}

/**
 * One boolean key of one mode section, undefined when absent/malformed.
 * @param {object|undefined} row - one editor entry.
 * @param {'override'|'inherited'} layer - value layer.
 * @param {string} mode - mode name.
 * @param {string} key - section key.
 * @returns {boolean|undefined} the value.
 */
function boolOf(row, layer, mode, key) {
  const section = sectionOf(row, layer, mode)
  return typeof section?.[key] === 'boolean' ? section[key] : undefined
}

/**
 * The effective `global.bash` switch (override wins over inherited; default true).
 * Exported for the tests and for future diagnostics; the plan itself deliberately
 * does NOT skip on it: the four mode flags are what keep ownership stable if the
 * user re-enables the global switch without restarting dsh.
 * @param {object|undefined} row - one editor entry.
 * @returns {boolean} the value.
 */
export function effectiveGlobalBash(row) {
  const override = row !== null && row !== undefined && isRecord(row.override) ? row.override.global : undefined
  if (isRecord(override) && typeof override.bash === 'boolean') return override.bash
  const inherited = row !== null && row !== undefined && isRecord(row.inherited) ? row.inherited.global : undefined
  if (isRecord(inherited) && typeof inherited.bash === 'boolean') return inherited.bash
  return true
}

/**
 * The effective bash flag of one mode: dsh-ops multiplies the mode flag with
 * `global.bash`. A missing mode flag means the dsh-ops default (true).
 * @param {object|undefined} row - one editor entry.
 * @param {string} mode - mode name.
 * @returns {boolean} the value.
 */
export function effectiveModeBash(row, mode) {
  const override = boolOf(row, 'override', mode, 'bash')
  if (override !== undefined) return override && effectiveGlobalBash(row)
  const inherited = boolOf(row, 'inherited', mode, 'bash')
  if (inherited !== undefined) return inherited && effectiveGlobalBash(row)
  return effectiveGlobalBash(row)
}

/**
 * The effective enabled flag of one mode section (default true).
 * @param {object|undefined} row - one editor entry.
 * @param {string} mode - mode name.
 * @returns {boolean} the value.
 */
export function effectiveModeEnabled(row, mode) {
  const override = boolOf(row, 'override', mode, 'enabled')
  if (override !== undefined) return override
  const inherited = boolOf(row, 'inherited', mode, 'enabled')
  return inherited === undefined ? true : inherited
}

/**
 * Decide what to do about ops_bash FOR ONE ROW. Pure: every fact arrives as
 * an argument, so the whole matrix (absent / per-mode present / off at the
 * source / disabled / to-adopt) is unit-testable anywhere.
 * @param {object|undefined} row - one row from configEditor.configuration(),
 *   or undefined when not mounted.
 * @returns {{action: string, reason: string, modes: object[]}} the plan.
 */
export function planOpsAdopt(row) {
  if (row === undefined || row === null) {
    return { action: 'skip-row-absent', reason: 'the dsh-ops row is not mounted in this profile', modes: [] }
  }
  if (row.entry?.options?.disabled === true) {
    return {
      action: 'skip-disabled',
      reason: 'the dsh-ops row is disabled, so it publishes no bash tool',
      modes: OPS_MODES.map((mode) => ({ mode, action: 'skip-disabled', reason: 'the dsh-ops row is disabled' })),
    }
  }
  const modes = OPS_MODES.map((mode) => {
    if (!effectiveModeEnabled(row, mode)) {
      return { mode, action: 'skip-disabled-mode', reason: 'the ' + mode + ' section is disabled, so it publishes no bash tool' }
    }
    const overrideBash = boolOf(row, 'override', mode, 'bash')
    if (overrideBash === false) {
      return { mode, action: 'present', reason: 'the ' + mode + ' section already sets bash=false' }
    }
    if (overrideBash === undefined && boolOf(row, 'inherited', mode, 'bash') === false) {
      return { mode, action: 'unchanged-inherited-off', reason: 'bash is false at the configuration source for ' + mode + '; nothing to override' }
    }
    return {
      mode,
      action: 'adopt',
      reason: 'dsh-ops would publish bash for ' + mode + '; the owner decision is one bash per face and it is ours',
    }
  })
  if (modes.some((mode) => mode.action === 'adopt')) {
    return { action: 'adopt', reason: 'at least one dsh-ops mode would publish bash next to ours', modes }
  }
  if (modes.some((mode) => mode.action === 'present')) {
    return { action: 'present', reason: 'every publishing dsh-ops mode already sets bash=false', modes }
  }
  if (modes.some((mode) => mode.action === 'unchanged-inherited-off')) {
    return { action: 'unchanged-inherited-off', reason: 'every publishing dsh-ops mode is already off at the source', modes }
  }
  return { action: 'skip-disabled-modes', reason: 'every dsh-ops mode section is disabled', modes }
}

/**
 * The row id of one editor entry, '' when the shape is malformed.
 * @param {object|undefined} row - one configEditor.configuration() entry.
 * @returns {string} the id.
 */
function rowIdOf(row) {
  const id = row?.entry?.options?.id
  return typeof id === 'string' ? id : ''
}

/**
 * The dsh-ops row in an editor view (0.5.0 has exactly one).
 * @param {object} editor - ctx.configEditor (or a stand-in in tests).
 * @returns {object[]} the rows (possibly empty).
 */
function opsRowsOf(editor) {
  const rows = editor.configuration()
  if (!Array.isArray(rows)) return []
  return rows.filter((candidate) => rowIdOf(candidate) === OPS_ROW_ID)
}

/**
 * Read one row back by id, or undefined when it vanished.
 * @param {object} editor - ctx.configEditor (or a stand-in in tests).
 * @param {string} id - the row id.
 * @returns {object|undefined} the fresh row.
 */
function freshRowOf(editor, id) {
  const rows = editor.configuration()
  return Array.isArray(rows) ? rows.find((candidate) => rowIdOf(candidate) === id) : undefined
}

/**
 * Flatten the plan into per-mode result rows (the log and the tests read these).
 * @param {object} row - the editor entry.
 * @param {object} plan - a planOpsAdopt result.
 * @returns {object[]} one entry per mode.
 */
function resultRowsOf(row, plan) {
  const id = rowIdOf(row) || OPS_ROW_ID
  return plan.modes.map((mode) => ({ id, mode: mode.mode, action: mode.action, reason: mode.reason }))
}

/**
 * Apply the plan through the official config editor, then READ EVERY MODE
 * BACK. Absent rows are skipped, never written; disabled rows/modes are never
 * written.
 * @param {object} editor - ctx.configEditor (or a stand-in in tests).
 * @returns {Promise<{status: string, rows: object[], detail?: string}>} the
 *   outcome; the caller logs it — this function never lies about success and
 *   never throws for an expected condition.
 */
export async function adoptOpsBashRemoval(editor) {
  if (editor === null || editor === undefined || typeof editor.configuration !== 'function') {
    return { status: 'skip-row-absent', rows: [], detail: 'the config editor is unavailable, so the dsh-ops row cannot be configured' }
  }
  const rows = opsRowsOf(editor)
  if (rows.length === 0) {
    return { status: 'skip-row-absent', rows: [], detail: 'no dsh-ops row is mounted in this profile' }
  }
  const plans = rows.map((row) => ({ row, plan: planOpsAdopt(row) }))
  const results = plans.flatMap(({ row, plan }) => resultRowsOf(row, plan))
  const targets = plans.flatMap(({ row, plan }) => plan.modes
    .filter((mode) => mode.action === 'adopt')
    .map((mode) => ({ row, mode: mode.mode })))
  if (targets.length > 0 && typeof editor.edit !== 'function') {
    return { status: 'write-failed', rows: results, detail: 'the config editor exposes no edit()' }
  }
  for (const { row } of plans) {
    const modes = targets.filter((target) => target.row === row).map((target) => target.mode)
    if (modes.length === 0) continue
    const id = rowIdOf(row)
    try {
      await editor.edit(row.entry, (current) => {
        const next = isRecord(current) ? { ...current } : {}
        for (const mode of modes) {
          const section = isRecord(next[mode]) ? { ...next[mode] } : {}
          section.bash = false
          next[mode] = section
        }
        return next
      })
    } catch (error) {
      return {
        status: 'write-failed',
        rows: results,
        detail: 'the official config editor refused the write for ' + id + ': ' + (error && error.message ? error.message : String(error)),
      }
    }
  }
  // Read back: edit() resolving is NOT proof the row now carries our value.
  for (const { row, mode } of targets) {
    const id = rowIdOf(row)
    let after
    try {
      after = freshRowOf(editor, id)
    } catch (error) {
      return {
        status: 'write-failed',
        rows: results,
        detail: 'the write succeeded but reading ' + id + ' back failed: ' + (error && error.message ? error.message : String(error)),
      }
    }
    if (after === undefined || after.override === null || after.override === undefined || after.override?.[mode]?.bash !== false) {
      return {
        status: 'write-failed',
        rows: results,
        detail: 'the write did not stick on ' + id + ' (' + mode + '): it does not read bash=false'
          + (after === undefined ? ' (the row vanished during the write)' : ''),
      }
    }
  }
  if (targets.length > 0) return { status: 'adopted', rows: results }
  if (results.some((result) => result.action === 'present')) return { status: 'present', rows: results }
  if (results.some((result) => result.action === 'unchanged-inherited-off')) return { status: 'unchanged-inherited-off', rows: results }
  if (results.some((result) => result.action === 'skip-disabled-mode')) return { status: 'skip-disabled-modes', rows: results }
  return { status: 'skip-disabled-rows', rows: results, detail: 'the dsh-ops row is disabled' }
}

/**
 * Lift our mode overrides so dsh-ops follows its own settings again. Runs from
 * the fiber dispose hook (plugin disabled / uninstalled while dsh runs). Only
 * OUR key is touched: unrelated overrides in the same row survive.
 * @param {object} editor - ctx.configEditor (or a stand-in in tests).
 * @returns {Promise<{status: string, rows: object[], detail?: string}>} the outcome.
 */
export async function restoreOpsBash(editor) {
  if (editor === null || editor === undefined || typeof editor.configuration !== 'function') {
    return { status: 'restore-failed', rows: [], detail: 'the config editor is unavailable, so the override cannot be lifted' }
  }
  const rows = opsRowsOf(editor)
  if (rows.length === 0) {
    return { status: 'skip-row-absent', rows: [], detail: 'no dsh-ops row is mounted — nothing to restore' }
  }
  // Only modes where OUR value is in force are touched. A mode the user flipped
  // back ON afterwards is their own later choice — leave it exactly where it is.
  const results = []
  const targets = []
  for (const row of rows) {
    const id = rowIdOf(row)
    for (const mode of OPS_MODES) {
      const overrideBash = boolOf(row, 'override', mode, 'bash')
      if (overrideBash === undefined) {
        results.push({ id, mode, action: 'unchanged', reason: 'no bash override to lift in ' + mode })
        continue
      }
      if (overrideBash !== false) {
        results.push({ id, mode, action: 'unchanged', reason: 'the ' + mode + ' override reads bash=true — a later choice of the user, left alone' })
        continue
      }
      results.push({ id, mode, action: 'restore' })
      targets.push({ row, mode })
    }
  }
  if (targets.length === 0) {
    return { status: 'unchanged', rows: results, detail: results.map((row) => row.mode + ': ' + row.reason).join('; ') }
  }
  if (typeof editor.edit !== 'function') {
    return { status: 'restore-failed', rows: results, detail: 'the config editor exposes no edit()' }
  }
  for (const row of rows) {
    const modes = targets.filter((target) => target.row === row).map((target) => target.mode)
    if (modes.length === 0) continue
    const id = rowIdOf(row)
    try {
      await editor.edit(row.entry, (current, inherited) => {
        const next = isRecord(current) ? { ...current } : {}
        for (const mode of modes) {
          const section = isRecord(next[mode]) ? { ...next[mode] } : {}
          const inheritedSection = isRecord(inherited) && isRecord(inherited[mode]) ? inherited[mode] : undefined
          if (inheritedSection !== undefined && Object.hasOwn(inheritedSection, 'bash')) {
            section.bash = inheritedSection.bash
          } else {
            delete section.bash
          }
          if (Object.keys(section).length === 0) delete next[mode]
          else next[mode] = section
        }
        return next
      })
    } catch (error) {
      return {
        status: 'restore-failed',
        rows: results,
        detail: 'the official config editor refused the restore for ' + id + ': ' + (error && error.message ? error.message : String(error)),
      }
    }
  }
  for (const { row, mode } of targets) {
    const id = rowIdOf(row)
    let after
    try {
      after = freshRowOf(editor, id)
    } catch (error) {
      return {
        status: 'restore-failed',
        rows: results,
        detail: 'the restore succeeded but reading ' + id + ' back failed: ' + (error && error.message ? error.message : String(error)),
      }
    }
    const left = boolOf(after, 'override', mode, 'bash')
    const inheritedBash = boolOf(after, 'inherited', mode, 'bash')
    // A false that equals the inherited value is the restored state, not a
    // leftover override; only a false that disagrees with the source is a
    // failed lift.
    if (left === false && inheritedBash !== false) {
      return { status: 'restore-failed', rows: results, detail: 'the restore did not stick on ' + id + ' (' + mode + '): it still reads bash=false' }
    }
  }
  return { status: 'restored', rows: results }
}

/**
 * The row ids one result touched, for the log line.
 * @param {object} result - an adopt/restore result.
 * @returns {string} comma-joined ids, or ''.
 */
export function opsRowList(result) {
  const rows = Array.isArray(result?.rows) ? result.rows : []
  return [...new Set(rows.map((row) => row.id).filter((id) => typeof id === 'string' && id !== ''))].join(', ')
}

/**
 * The mode names one result touched (filtered by action when asked).
 * @param {object} result - an adopt/restore result.
 * @param {string[]} [actions] - only these actions; all when omitted.
 * @returns {string} slash-joined mode names, or ''.
 */
export function opsModeList(result, actions) {
  const rows = Array.isArray(result?.rows) ? result.rows : []
  const allowed = Array.isArray(actions) ? actions : null
  const modes = rows
    .filter((row) => allowed === null || allowed.includes(row.action))
    .map((row) => row.mode)
    .filter((mode) => typeof mode === 'string' && mode !== '')
  return [...new Set(modes)].join('/')
}

/**
 * The one-line log for an adoption outcome (the caller prints it). Kept here
 * so the wording stays identical between the boot path and the tests.
 * @param {object} result - an adoptOpsBashRemoval result.
 * @returns {string} the log line, without the plugin tag.
 */
export function opsAdoptReport(result) {
  const listed = opsRowList(result)
  const modes = opsModeList(result, ['adopt', 'present', 'unchanged-inherited-off', 'skip-disabled-mode']) || OPS_MODES.join('/')
  switch (result.status) {
    case 'adopted':
      return 'dsh-ops bash removed from the agent face (bash=false on ' + modes + ' of ' + (listed || OPS_ROW_ID) + ' through the official config editor): the host cannot hide own-layer tools, so dsh-ops must simply not register it — disable this plugin any time you want ops_bash back (the removal is lifted automatically)'
    case 'present':
      return 'dsh-ops bash already removed: ' + modes + ' already read bash=false (nothing written)'
    case 'unchanged-inherited-off':
      return 'dsh-ops bash already off at the source: bash=false in the dsh-ops configuration of ' + (modes || listed) + ' (nothing written)'
    case 'skip-disabled-rows':
    case 'skip-disabled':
      return 'dsh-ops bash removal not needed: ' + (result.detail ?? 'the dsh-ops row is disabled')
    case 'skip-disabled-modes':
      return 'dsh-ops bash removal not needed: ' + (result.detail ?? 'every dsh-ops built-in mode section is disabled')
    case 'skip-row-absent':
      return 'dsh-ops bash removal skipped: ' + (result.detail ?? 'the dsh-ops row is not mounted')
    case 'write-failed':
      return 'dsh-ops bash removal FAILED — ' + (result.detail ?? '')
        + ' | next steps: ops_bash stays VISIBLE and our pre-execute denial keeps answering its calls;'
        + ' retry by restarting dsh, or set bash=false on the dsh-ops built-in modes by hand'
        + ' (Settings -> the dsh-ops card -> minimal/standard/ptc/cordis), or turn to the README for the manual patch row.'
    default:
      return 'dsh-ops bash removal skipped: ' + (result.detail ?? result.status)
  }
}

/**
 * The one-line log for a restore outcome (the caller prints it).
 * @param {object} result - a restoreOpsBash result.
 * @returns {string} the log line, without the plugin tag.
 */
export function opsRestoreReport(result) {
  const listed = opsRowList(result)
  const modes = opsModeList(result, ['restore']) || OPS_MODES.join('/')
  switch (result.status) {
    case 'restored':
      return 'dsh-ops bash setting restored: the bash override is lifted on ' + modes + ' of ' + (listed || OPS_ROW_ID) + ', ops_bash follows the dsh-ops settings again'
    case 'unchanged':
      return 'dsh-ops bash restore not needed: ' + (result.detail ?? 'no override of ours to lift')
    case 'skip-row-absent':
      return 'dsh-ops bash restore skipped: ' + (result.detail ?? 'the dsh-ops row is gone')
    case 'restore-failed':
      return 'dsh-ops bash restore FAILED — ' + (result.detail ?? '')
        + ' | the dsh-ops override may survive this plugin: lift it by hand'
        + ' (Settings -> the dsh-ops card -> restore defaults) if ops_bash should come back.'
    default:
      return 'dsh-ops bash restore skipped: ' + (result.detail ?? result.status)
  }
}
