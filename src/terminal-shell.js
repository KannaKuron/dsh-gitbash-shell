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

/**
 * User-visible profile NAME written for Git Bash (v0.29.1).
 *
 * NOT `'bash'`: the official `shellCandidates` still contribute a `bash`
 * candidate that resolves to the WSL launcher on machines whose PATH has
 * `C:\Windows\System32\bash.exe`, and the new-terminal menu then showed TWO
 * entries called `bash` — the user could not tell Git Bash from WSL ("改一下,
 * 新增的gitbash显示名称得是gitbash,不然回合wsl的混了"). This is the
 * `TerminalShell.name` display field only: resolution and execution use
 * `path`/`args`, so renaming changes nothing but the label.
 */
export const TERMINAL_SHELL_NAME = 'Git Bash'

/**
 * Arguments written for Git Bash. `['-i']` is not our invention: the official
 * `profile()` in `packages/api/terminal-controller/src/shells.ts` derives
 * exactly `['-i']` for any shell that is not cmd/pwsh/powershell, and `-i`
 * makes bash read its rc files in the interactive terminal.
 */
export const TERMINAL_SHELL_ARGS = ['-i']

/**
 * The ONLY historical name we may rewrite (v0.29.1). v0.29.0 wrote `'bash'`,
 * which is indistinguishable from the WSL candidate in the new-terminal menu —
 * that entry is ours and we fix it. Any OTHER name (`My Bash`, `Git`, a hand
 * edit) is a user decision and is left completely alone, exactly like a shell
 * path pointing elsewhere: this plugin never rewrites what the user chose.
 */
export const LEGACY_TERMINAL_SHELL_NAME = 'bash'

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
    if (current.name === TERMINAL_SHELL_NAME) {
      return { action: 'unchanged', current, reason: 'the terminal already uses this Git Bash under the right name' }
    }
    // Only OUR OWN legacy default is migrated: v0.29.0 wrote `name: 'bash'`,
    // and that is the entry the user cannot tell apart from the WSL candidate.
    // Every other name is a user decision (or a hand edit) — left untouched.
    if (current.name === LEGACY_TERMINAL_SHELL_NAME) {
      return {
        action: 'rename',
        current,
        shell: { ...current, name: TERMINAL_SHELL_NAME },
        reason: 'the terminal runs this Git Bash under our own legacy label "'
          + LEGACY_TERMINAL_SHELL_NAME + '" — renaming it to "' + TERMINAL_SHELL_NAME
          + '" so it cannot be confused with the WSL candidate',
      }
    }
    return {
      action: 'kept-user-name',
      current,
      reason: 'the terminal runs this Git Bash but you named it "' + current.name
        + '" — a chosen name is never rewritten (and a custom name cannot be confused with the WSL candidate)',
    }
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
  if (plan.action !== 'adopt' && plan.action !== 'rename') {
    return { status: plan.action, current, detail: plan.reason }
  }
  // `rename` keeps the profile the user already has and only rewrites the
  // label; `adopt` writes the full profile. Both go through the same
  // read-back verification below.
  const renamed = plan.action === 'rename'
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
  const pathOk = written !== undefined && normalizeBashPath(written.path) === normalizeBashPath(plan.shell.path)
  const nameOk = written !== undefined && written.name === plan.shell.name
  if (!pathOk || !nameOk) {
    return {
      status: 'write-failed',
      current,
      detail: 'the write did not stick: the terminal row reads '
        + (written === undefined ? '(no shell)' : '"' + written.path + '" as "' + written.name + '"')
        + (pathOk ? '' : ' [path mismatch]') + (nameOk ? '' : ' [name mismatch]'),
    }
  }
  return { status: renamed ? 'renamed' : 'adopted', path: plan.shell.path, current, name: plan.shell.name }
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
      return 'official sidebar terminal switched to Git Bash: ' + result.path + ' (name "' + TERMINAL_SHELL_NAME + '", args -i) — new terminals use it immediately, already-open ones keep their shell'
    case 'renamed':
      return 'official sidebar terminal renamed to "' + TERMINAL_SHELL_NAME + '" (was displaying as "' + (result.current ? result.current.name : '?')
        + '", same Git Bash path ' + result.path + ') — the entry is no longer confusable with the WSL candidate'
    case 'unchanged':
      return 'official sidebar terminal already uses this Git Bash: ' + (result.current ? result.current.path : '') + ' (nothing written)'
    case 'kept-user-choice':
      return 'official sidebar terminal NOT adopted: ' + result.detail
    case 'kept-user-name':
      return 'official sidebar terminal NOT renamed: ' + result.detail
    case 'write-failed':
      return 'official sidebar terminal adoption FAILED — ' + result.detail
        + ' | next steps: (1) the new-terminal shell is UNCHANGED, so dsh keeps its own resolution;'
        + ' (2) set the terminal by hand: add `shell: { path: <git-bash>, name: bash, args: [\'-i\'] }` to the'
        + ' `terminal-controller` row in the profile patch and restart dsh;'
        + ' (3) or turn this plugin\'s "autoTerminalShell" switch off to stop the attempts;'
        + ' (4) the full cause is in the lines above.'
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
