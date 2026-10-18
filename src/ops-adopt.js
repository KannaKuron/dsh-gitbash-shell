/**
 * dsh-gitbash-shell — dsh-ops bash removal from the agent face (v0.42.0).
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
 * THE SWITCH: dsh-ops ships exactly that, as first-class config —
 * publishBashTool (default true). false => mountSessionBash returns before
 * registering, resolveShells reports the bash rung as 'disabled', and the
 * prompt-policy tool table drops the bash row. Setting it is therefore not a
 * hack into someone else's plugin; it is their own supported configuration.
 *
 * WHY THIS MODULE TALKS TO configEditor (same discipline as
 * terminal-shell.js): the write must survive restarts and must be undoable.
 * configEditor.edit(entry, change) is the channel the official settings UI
 * itself persists through — it lands in the profile patch document (official
 * YAML editor, file-locked, comment-preserving) and change returning the
 * INHERITED config makes the editor DELETE the override row again. That gives
 * us a real restore primitive instead of a hand-rolled file edit.
 *
 * OWNERSHIP AND RESTORE (the owner requirement: uninstalling this plugin must
 * give dsh-ops its bash back):
 *   - plugin disabled / uninstalled while dsh runs => our fiber stops => the
 *     dispose hook below runs and lifts the override through the same editor;
 *   - plugin re-enabled => boot re-adopts (idempotent: the plan is a no-op
 *     when the override already reads false);
 *   - the one uncovered path is uninstalling while dsh is SHUT DOWN (no fiber
 *     ever stops): the override survives, the official settings card shows
 *     "已覆盖 / restore defaults" for exactly this, and flipping it back (or
 *     re-installing and disabling us) restores the row. Documented in the
 *     README; nothing else can be done from inside a stopped process.
 *
 * PRODUCT DECISION (owner, 2026-10-19): while this plugin is installed, the
 * bash tool is OURS — dsh-ops is kept for its file, search and background
 * enhancements only, and there is NO settings switch for this behavior. A
 * user who flips publishBashTool back to true in the settings card is
 * overridden again on our next boot; the supported way to use ops_bash is to
 * disable this plugin (which also restores the value — the dispose hook).
 *
 * HARD RULES:
 *   1. NEVER write when the row is absent — no dsh-ops, nothing to remove.
 *   2. NEVER hand-edit the profile patch file — the official editor only.
 *   3. NEVER claim success without reading the value back.
 *   4. Restore returns the INHERITED value for OUR key only: unrelated
 *      overrides in the same row (the user's own dsh-ops settings) survive.
 */

/** The Loader row id of the dsh-ops shell component. */
export const OPS_SHELL_ROW_ID = 'dsh-ops-shell'

/**
 * The effective publishBashTool of the row: the profile patch override wins
 * over the inherited layer value; a missing key means the dsh-ops default
 * (true — it publishes). Treats malformed shapes as the default so a broken
 * hand edit cannot make us believe there is a decision to respect.
 * @param {object} row - one configEditor.configuration() entry.
 * @returns {boolean} the effective value.
 */
export function effectivePublishBashTool(row) {
  const override = row !== null && row !== undefined && row.override !== null && row.override !== undefined
    ? row.override.publishBashTool
    : undefined
  const inherited = row !== null && row !== undefined && row.inherited !== null && row.inherited !== undefined
    ? row.inherited.publishBashTool
    : undefined
  if (typeof override === 'boolean') return override
  if (typeof inherited === 'boolean') return inherited
  return true
}

/**
 * Decide what to do about ops_bash. Pure: every fact arrives as an argument,
 * so the whole matrix (absent / already overridden / off at the source /
 * to-adopt) is unit-testable anywhere.
 * @param {object|undefined} row - the dsh-ops-shell row from
 *   configEditor.configuration(), or undefined when not mounted.
 * @returns {{action: string, reason: string}} the plan.
 */
export function planOpsAdopt(row) {
  if (row === undefined || row === null) {
    return { action: 'skip-row-absent', reason: 'the dsh-ops shell row is not mounted in this profile' }
  }
  const overrideValue = row.override !== null && row.override !== undefined ? row.override.publishBashTool : undefined
  if (typeof overrideValue === 'boolean' && overrideValue === false) {
    return { action: 'present', reason: 'the row override already sets publishBashTool=false' }
  }
  if (typeof overrideValue !== 'boolean' && effectivePublishBashTool(row) === false) {
    return { action: 'unchanged-inherited-off', reason: 'publishBashTool is false at the configuration source (the dsh-ops settings); nothing to override' }
  }
  return {
    action: 'adopt',
    reason: 'the dsh-ops bash would run next to ours; the owner decision is one bash per face and it is ours',
  }
}

/**
 * Find the dsh-ops shell row in an editor view, or undefined.
 * @param {object} editor - ctx.configEditor (or a stand-in in tests).
 * @returns {object|undefined} the row.
 */
function opsRowOf(editor) {
  const rows = editor.configuration()
  return Array.isArray(rows) ? rows.find((candidate) => candidate.entry?.options?.id === OPS_SHELL_ROW_ID) : undefined
}

/**
 * Apply the plan through the official config editor, then READ THE VALUE BACK.
 * @param {object} editor - ctx.configEditor (or a stand-in in tests).
 * @returns {Promise<{status: string, detail?: string}>} the outcome; the caller
 *   logs it — this function never lies about success and never throws for an
 *   expected condition.
 */
export async function adoptOpsBashRemoval(editor) {
  if (editor === null || editor === undefined || typeof editor.configuration !== 'function') {
    return { status: 'skip-row-absent', detail: 'the config editor is unavailable, so the dsh-ops row cannot be configured' }
  }
  const row = opsRowOf(editor)
  const plan = planOpsAdopt(row)
  if (plan.action !== 'adopt') return { status: plan.action, detail: plan.reason }
  if (typeof editor.edit !== 'function') {
    return { status: 'write-failed', detail: 'the config editor exposes no edit()' }
  }
  try {
    await editor.edit(row.entry, (raw) => ({ ...raw, publishBashTool: false }))
  } catch (error) {
    return { status: 'write-failed', detail: 'the official config editor refused the write: ' + (error && error.message ? error.message : String(error)) }
  }
  // Read back: edit() resolving is NOT proof the row now carries our value.
  let after
  try {
    after = opsRowOf(editor)
  } catch (error) {
    return { status: 'write-failed', detail: 'the write succeeded but reading it back failed: ' + (error && error.message ? error.message : String(error)) }
  }
  if (after === undefined || after.override === null || after.override === undefined || after.override.publishBashTool !== false) {
    return {
      status: 'write-failed',
      detail: 'the write did not stick: the dsh-ops row does not read publishBashTool=false'
        + (after === undefined ? ' (the row vanished during the write)' : ''),
    }
  }
  return { status: 'adopted' }
}

/**
 * Lift our override so dsh-ops follows its own settings again. Runs from the
 * fiber dispose hook (plugin disabled / uninstalled while dsh runs). Only OUR
 * key is touched: unrelated overrides in the same row survive.
 * @param {object} editor - ctx.configEditor (or a stand-in in tests).
 * @returns {Promise<{status: string, detail?: string}>} the outcome.
 */
export async function restoreOpsBash(editor) {
  if (editor === null || editor === undefined || typeof editor.configuration !== 'function') {
    return { status: 'restore-failed', detail: 'the config editor is unavailable, so the override cannot be lifted' }
  }
  const row = opsRowOf(editor)
  if (row === undefined) {
    return { status: 'skip-row-absent', detail: 'the dsh-ops shell row is no longer mounted — nothing to restore' }
  }
  const overrideValue = row.override !== null && row.override !== undefined ? row.override.publishBashTool : undefined
  if (typeof overrideValue !== 'boolean') {
    return { status: 'unchanged', detail: 'no publishBashTool override to lift' }
  }
  if (overrideValue !== false) {
    // Somebody (the user, through the settings card) turned it back ON after
    // us. Lifting that would REPLACE their choice with the inherited default —
    // leave their value exactly where it is.
    return { status: 'unchanged', detail: 'the override reads publishBashTool=true — a later choice of the user, left alone' }
  }
  if (typeof editor.edit !== 'function') {
    return { status: 'restore-failed', detail: 'the config editor exposes no edit()' }
  }
  try {
    await editor.edit(row.entry, (raw, inherited) => {
      const next = { ...raw }
      if (inherited !== null && inherited !== undefined && Object.hasOwn(inherited, 'publishBashTool')) {
        next.publishBashTool = inherited.publishBashTool
      } else {
        delete next.publishBashTool
      }
      return next
    })
  } catch (error) {
    return { status: 'restore-failed', detail: 'the official config editor refused the restore: ' + (error && error.message ? error.message : String(error)) }
  }
  let after
  try {
    after = opsRowOf(editor)
  } catch (error) {
    return { status: 'restore-failed', detail: 'the restore succeeded but reading it back failed: ' + (error && error.message ? error.message : String(error)) }
  }
  const left = after !== undefined && after.override !== null && after.override !== undefined ? after.override.publishBashTool : undefined
  if (typeof left === 'boolean' && left === false) {
    return { status: 'restore-failed', detail: 'the restore did not stick: the row still reads publishBashTool=false' }
  }
  return { status: 'restored' }
}

/**
 * The one-line log for an adoption outcome (the caller prints it). Kept here
 * so the wording stays identical between the boot path and the tests.
 * @param {object} result - an adoptOpsBashRemoval result.
 * @returns {string} the log line, without the plugin tag.
 */
export function opsAdoptReport(result) {
  switch (result.status) {
    case 'adopted':
      return 'dsh-ops bash removed from the agent face (publishBashTool=false through the official config editor): the host cannot hide own-layer tools, so dsh-ops must simply not register it — disable this plugin any time you want ops_bash back (the removal is lifted automatically)'
    case 'present':
      return 'dsh-ops bash already removed: the dsh-ops-shell row override already reads publishBashTool=false (nothing written)'
    case 'unchanged-inherited-off':
      return 'dsh-ops bash already off at the source: publishBashTool=false in the dsh-ops configuration (nothing written)'
    case 'skip-row-absent':
      return 'dsh-ops bash removal skipped: ' + (result.detail ?? 'the dsh-ops shell row is not mounted')
    case 'write-failed':
      return 'dsh-ops bash removal FAILED — ' + (result.detail ?? '')
        + ' | next steps: ops_bash stays VISIBLE and our pre-execute denial keeps answering its calls;'
        + ' retry by restarting dsh, or set publishBashTool=false on the dsh-ops-shell row by hand'
        + ' (Settings -> the dsh-ops card -> publishBashTool), or turn to the README for the manual patch row.'
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
  switch (result.status) {
    case 'restored':
      return 'dsh-ops bash setting restored: the publishBashTool override is lifted, ops_bash follows the dsh-ops settings again'
    case 'unchanged':
      return 'dsh-ops bash restore not needed: ' + (result.detail ?? 'no override of ours to lift')
    case 'skip-row-absent':
      return 'dsh-ops bash restore skipped: ' + (result.detail ?? 'the dsh-ops shell row is gone')
    case 'restore-failed':
      return 'dsh-ops bash restore FAILED — ' + (result.detail ?? '')
        + ' | the dsh-ops-shell override may survive this plugin: lift it by hand'
        + ' (Settings -> the dsh-ops card -> restore defaults) if ops_bash should come back.'
    default:
      return 'dsh-ops bash restore skipped: ' + (result.detail ?? result.status)
  }
}
