/**
 * dsh-gitbash-shell — OFFICIAL sidebar terminal adoption (v0.29.0, task-25).
 *
 * THE PROBLEM (user report, Windows 11): dsh's own "new terminal" starts WSL,
 * not Git Bash. `terminal-controller` resolves its shell from
 * `subprocess.terminalEnvironment().defaultShell` when no `shell` is configured,
 * and on that machine the PATH hit for `bash` is
 * `C:\WINDOWS\system32\bash.EXE` — the Microsoft WSL launcher. The agent tools
 * are already ours (`pwsh-sandbox` out, `gitbash-executor` in), but the sidebar
 * terminal is a DIFFERENT row with a different shell resolution, so it kept
 * starting WSL.
 *
 * WHY THIS MODULE TALKS TO `configEditor` AND NOT TO `settings`
 * (measured on dsh 0.1.7-rc.2, probe readout in the task notes):
 *   - `settings.update('terminal', …)` is impossible twice over:
 *     `SettingsService.write()` requires every written path to be VOLATILE
 *     (`volatileForm(schema)` → `undefined` ⇒ "Plugin entry … has no volatile
 *     fields"), and `terminal-controller`'s Config declares `shell` as an
 *     ordinary field. The probe also showed no `terminal` entry at all
 *     ("No configurable plugin entry \"terminal\"").
 *   - `configEditor.edit(entry, change)` is the API the official settings UI
 *     itself persists through, documented as "ordinary fields keep normal
 *     lifecycle rules". The probe wrote `shell` and the RUNNING
 *     `ctx.terminalController.config.shell` carried it on the next read — no
 *     restart. The write lands in the profile patch document through the
 *     official YAML editor (comment-preserving, id-merged, file-locked); we
 *     never hand-edit that file ourselves.
 *
 * HARD RULES (same discipline as §4h):
 *   1. NEVER overwrite an explicit choice. If the terminal already points
 *      somewhere else (another bash, a WSL profile, pwsh), we log and stop —
 *      the user's decision outranks our automation.
 *   2. NEVER write a shell we have not verified. `resolveShell` rejects an
 *      unresolvable path with `SubprocessExecutableNotFoundError` and has NO
 *      fallback, so a bad write would break the new-terminal button outright.
 *      The path written here is always the one `src/bash-path.js` verified
 *      (exists + Git-for-Windows layout + `.windows.` fingerprint + `uname -s`
 *      = MINGW*_NT-*).
 *   3. NEVER claim success without reading the value back. `edit()` resolving
 *      is not proof the row carries our shell, so `adoptTerminalShell` re-reads
 *      `configuration()` and reports `write-failed` when the value is not there
 *      (§4h: no silent false success).
 */

import { normalizeBashPath } from './bash-path.js'

/** The Loader row id of the official terminal controller. */
export const TERMINAL_ROW_ID = 'terminal-controller'

/** Profile name written for Git Bash — matches the official `profile()` output. */
export const TERMINAL_SHELL_NAME = 'bash'

/**
 * Arguments written for Git Bash. `['-i']` is not our invention: the official
 * `profile()` in `packages/api/terminal-controller/src/shells.ts` derives
 * exactly `['-i']` for any shell that is not cmd/pwsh/powershell, and `-i`
 * makes bash read its rc files in the interactive terminal.
 */
export const TERMINAL_SHELL_ARGS = ['-i']

/**
 * The shell profile we write into `terminal-controller`'s config.
 * @param path - verified Git Bash path.
 * @returns the `{ path, name, args }` profile.
 */
export function terminalShellProfile(path) {
  return { path, name: TERMINAL_SHELL_NAME, args: [...TERMINAL_SHELL_ARGS] }
}

/**
 * The effective explicit shell of the terminal row: the user patch's override
 * wins over the composed bundle default (which is usually absent). Treats a
 * malformed shape as "not set" so a broken hand edit cannot make us believe
 * there is a user choice to respect.
 * @param row - one `configEditor.configuration()` entry, or undefined.
 * @returns the current shell profile, or undefined when unset.
 */
export function currentTerminalShell(row) {
  if (row === null || row === undefined) return undefined
  const value = row.override !== null && row.override !== undefined && 'shell' in row.override
    ? row.override.shell
    : (row.inherited === null || row.inherited === undefined ? undefined : row.inherited.shell)
  if (value === null || typeof value !== 'object') return undefined
  const path = value.path
  if (typeof path !== 'string' || path.trim() === '') return undefined
  return {
    path,
    name: typeof value.name === 'string' ? value.name : '',
    args: Array.isArray(value.args) ? value.args : [],
  }
}

/**
 * Decide what to do about the terminal shell. Pure: every fact arrives as an
 * argument, which is why the whole matrix (empty / same / other / disabled /
 * unresolved / non-Windows) is unit-testable anywhere.
 * @param {object} input - decision input.
 * @param {string} input.platform - `process.platform` of the host.
 * @param {boolean} input.enabled - the `autoTerminalShell` switch.
 * @param {string} input.resolved - the verified Git Bash path ('' when unresolved).
 * @param {object} [input.current] - current terminal shell profile, if any.
 * @returns {{action: string, shell?: object, current?: object, reason: string}} the plan.
 */
export function planTerminalAdopt({ platform, enabled, resolved, current }) {
  if (platform !== 'win32') return { action: 'skip-platform', reason: 'not a Windows host; the official terminal keeps its own shell' }
  if (enabled !== true) return { action: 'skip-disabled', reason: 'the autoTerminalShell switch is off' }
  if (typeof resolved !== 'string' || resolved.trim() === '') {
    return { action: 'skip-unresolved', reason: 'no verified Git Bash to offer (see the bash resolution report)' }
  }
  if (current === undefined || current === null) {
    return { action: 'adopt', shell: terminalShellProfile(resolved.trim()), reason: 'the terminal has no shell configured; offering the verified Git Bash' }
  }
  if (normalizeBashPath(current.path) === normalizeBashPath(resolved)) {
    return { action: 'unchanged', current, reason: 'the terminal already uses this Git Bash' }
  }
  return {
    action: 'kept-user-choice',
    current,
    reason: 'the terminal shell points at "' + current.path + '" — an explicit choice is never overwritten; clear that field (Settings → the terminal row) to let Git Bash take over',
  }
}

/**
 * Apply the plan through the official config editor, then READ THE VALUE BACK.
 * @param {object} editor - `ctx.configEditor` (or a stand-in in tests).
 * @param {object} options - adoption options.
 * @param {string} options.platform - host platform.
 * @param {boolean} options.enabled - `autoTerminalShell` switch.
 * @param {string} options.resolved - verified Git Bash path ('' when unresolved).
 * @returns {Promise<{status: string, action?: string, path?: string, current?: object, detail?: string}>}
 *   the outcome; `status` is one of the plan actions plus `skip-row-absent`
 *   and `write-failed`. The caller logs it — this function never lies about
 *   success and never throws for an expected condition.
 */
export async function adoptTerminalShell(editor, { platform, enabled, resolved }) {
  if (editor === null || editor === undefined || typeof editor.configuration !== 'function') {
    return { status: 'skip-row-absent', detail: 'the config editor is unavailable, so the terminal row cannot be configured' }
  }
  const rows = editor.configuration()
  const row = Array.isArray(rows) ? rows.find((candidate) => candidate.entry?.options?.id === TERMINAL_ROW_ID) : undefined
  if (row === undefined) {
    return { status: 'skip-row-absent', detail: 'the "' + TERMINAL_ROW_ID + '" row is not mounted in this profile' }
  }
  const current = currentTerminalShell(row)
  const plan = planTerminalAdopt({ platform, enabled, resolved, current })
  if (plan.action !== 'adopt') {
    return { status: plan.action, current, detail: plan.reason }
  }
  if (typeof editor.edit !== 'function') {
    return { status: 'write-failed', current, detail: 'the config editor exposes no edit()' }
  }
  try {
    await editor.edit(row.entry, (raw) => ({ ...raw, shell: plan.shell }))
  } catch (error) {
    return { status: 'write-failed', current, detail: 'the official config editor refused the write: ' + (error && error.message ? error.message : String(error)) }
  }
  // Read back: `edit()` resolving is NOT proof the row now carries our shell.
  let after
  try {
    const rowsAfter = editor.configuration()
    after = Array.isArray(rowsAfter) ? rowsAfter.find((candidate) => candidate.entry?.options?.id === TERMINAL_ROW_ID) : undefined
  } catch (error) {
    return { status: 'write-failed', current, detail: 'the write succeeded but reading it back failed: ' + (error && error.message ? error.message : String(error)) }
  }
  const written = currentTerminalShell(after)
  if (written === undefined || normalizeBashPath(written.path) !== normalizeBashPath(plan.shell.path)) {
    return {
      status: 'write-failed',
      current,
      detail: 'the write did not stick: the terminal row reads ' + (written === undefined ? '(no shell)' : '"' + written.path + '"'),
    }
  }
  return { status: 'adopted', path: plan.shell.path, current }
}

/**
 * The one-line log for an adoption outcome (the caller prints it). Kept here so
 * the wording stays identical between the boot path and the tests.
 * @param {object} result - an {@link adoptTerminalShell} result.
 * @returns {string} the log line, without the plugin tag.
 */
export function terminalAdoptReport(result) {
  switch (result.status) {
    case 'adopted':
      return 'official sidebar terminal switched to Git Bash: ' + result.path + ' (name bash, args -i) — new terminals use it immediately, already-open ones keep their shell'
    case 'unchanged':
      return 'official sidebar terminal already uses this Git Bash: ' + (result.current ? result.current.path : '') + ' (nothing written)'
    case 'kept-user-choice':
      return 'official sidebar terminal NOT adopted: ' + result.detail
    case 'write-failed':
      return 'official sidebar terminal adoption FAILED — ' + result.detail + ' (nothing was substituted; set "shell" for the terminal row by hand if you need it)'
    case 'skip-disabled':
      return 'official sidebar terminal adoption is off (autoTerminalShell = false) — the new-terminal shell stays whatever dsh resolves'
    case 'skip-unresolved':
      return 'official sidebar terminal adoption skipped: no verified Git Bash (nothing is substituted)'
    case 'skip-platform':
      return 'official sidebar terminal adoption applies to Windows only'
    default:
      return 'official sidebar terminal adoption skipped: ' + (result.detail ?? result.status)
  }
}
