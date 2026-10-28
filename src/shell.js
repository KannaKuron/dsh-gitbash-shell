/**
 * dsh-gitbash-shell/shell — the Git Bash executor INSTANCE (route B, v0.39.0).
 *
 * Since route B this class is NOT mounted as the ROOT `ctx.shell` service:
 * the official PowerShell executor keeps that slot untouched (the DSH-Store
 * catalog gate forbids bundle patches that disable official components, and
 * replacing the shell executor IS overriding one). Instead the plugin
 * constructs ONE private instance of this class in a PRIVATE cordis scope
 * (`executorScope.ctx.plugin(GitBashSandboxExecutor)`, src/inline-tools.js)
 * and hands it to the plugin's OWN bash tool (src/bash-tool.js).
 *
 *   - extends @deepseek-ai/dsh-bash-sandbox to inherit policy, denial and
 *     lifecycle semantics; unsupported Windows policy is refused, not weakened;
 *   - overrides `confine` so the inner argv is [git-bash, -c, command];
 *   - overrides run/start ONLY for danger-full-access (the parent's
 *     full-access branch calls LocalBashExecutor.run, which hardcodes the
 *     bare `bash` name), routing through runArgv/startArgv with the same
 *     argv as the confined branch;
 *   - on Windows refuses read-only/workspace-write or unresolved policy before
 *     argv resolution or process start. Historical restricted-token failures
 *     (Win32 error 5 / 0xC0000142, CHANGELOG v0.13.2) are not proof that every
 *     future isolation design is impossible. The matched modern MSYS signal
 *     pipe has an explicit SD; cygheap uses VirtualAlloc, and Core already
 *     supplements TokenDefaultDacl. No verified confined Git Bash is provided
 *     here. experimentalNative defaults ON (refusal); an explicit user opt-out
 *     restores the labelled legacy unconfined route, with truthful facts.
 *     Official file-tool policy is separate and its denials must not be bypassed.
 *
 * Environment inheritance: bash.exe is a direct child (not a login launcher)
 * of the host's managed, credential-scrubbing subprocess provider. The trusted
 * DSH_* snapshot does not exempt it from protected environment rules.
 *
 * Constructed as a cordis class plugin (static inject/Config honoured) —
 * inside an explicitly `ctx.isolate('shell')`-isolated scope, so the base
 * class's service registration never touches the root `ctx.shell` slot.
 * A plain child plugin fiber is NOT a service isolation boundary.
 */

import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'

import { homedir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_GIT_BASH, bashResolutionReport, effectiveConfiguredBashPath, resolveGitBashCached, settingsBashPath } from './bash-path.js'

/** Re-exported for callers that historically read it here (the value now lives in bash-path.js). */
export { DEFAULT_GIT_BASH }
import { loadSchemastery } from './schemastery.js'


/**
 * The plugin row's id, which doubles as the settings namespace on <= 0.1.6 and
 * as the row-config namespace on 0.1.7+ (same string by design).
 */
const SETTINGS_NAMESPACE = 'gitbash-shell'

/**
 * Expand one configured path for the init-script setting (issue #37): trim,
 * drop surrounding quotes a pasted Windows path may carry, and resolve a
 * leading `~` against the home directory. Anything else is returned verbatim —
 * the file is bash's to read, not ours to rewrite.
 * @param value - the raw configured `initScript` string.
 * @returns the path to export as BASH_ENV, or '' when unset.
 */
export function expandHomePath(value) {
  const raw = typeof value === 'string' ? value.trim().replace(/^["']|["']$/g, '') : ''
  if (raw === '') return ''
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2))
  return raw
}

/**
 * Mark one schema field live-editable when the HOST's schemastery supports it.
 *
 * dsh 0.1.7-alpha.1 (`feat(settings): project volatile Config through
 * profile-backed forms`, #4587) made `LocalBashExecutor.Config` declare
 * `cwd`/`timeoutMs`/`maxTimeoutMs`/`maxOutputBytes`/`maxSpillBytes`/`graceMs`
 * with `.volatile()` and read every one of them through `.get()`
 * (`packages/shell/bash-local/src/index.ts:100-107` and its
 * `assertServiceableBashConfig`/`resolve`). A subclass that REDECLARES those
 * fields as plain values therefore throws
 * `TypeError: config.timeoutMs.get is not a function` on the first shell call
 * and takes the whole `ctx.shell` down with it (issue #6, 0.24.2).
 * `SandboxBashExecutor` — our parent — declares no Config of its own: it
 * inherits `LocalBashExecutor`'s verbatim, so this redeclaration IS the
 * executor's contract.
 *
 * The probe keeps one build serving both eras: hosts whose schemastery has
 * `volatile()` (0.1.7+) get the Volatile refs their base class calls `.get()`
 * on, while older hosts — whose base class reads plain values — keep plain
 * ones. Published schemastery 3.18.2 has no `volatile()`, which is exactly why
 * the probe (not an unconditional call) is required.
 */
function live(schema, needsVolatile) {
  // A <=0.1.6 host reads plain values: never hand it a ref it will not `.get()`
  // (issue #12 — the host's own answer wins over what our copy happens to offer).
  if (needsVolatile === false) return schema
  return typeof schema.volatile === 'function' ? schema.volatile() : schema
}

/**
 * Build the executor's Config against a given schemastery module. Exported so
 * the smoke test can drive BOTH eras with a recording stand-in instead of
 * depending on which schemastery happens to be installed here.
 * @param z schemastery module (real one, or the test's recorder).
 * @param needsVolatile - the host's OWN answer from src/schemastery.js: `true`
 *   forces Volatile refs, `false` forces plain values, `undefined` keeps the
 *   per-field probe (the historical behaviour, kept for an unreadable host).
 * @returns the object schema for the `gitbash-executor` row.
 */
export function gitBashShellConfig(z, needsVolatile) {
  return z.object({
    cwd: live(z.string(), needsVolatile),
    timeoutMs: live(z.number().default(120000), needsVolatile),
    maxTimeoutMs: live(z.number().default(600000), needsVolatile),
    maxOutputBytes: live(z.number().default(64000), needsVolatile),
    maxSpillBytes: live(z.number().default(64 * 1024 * 1024), needsVolatile),
    graceMs: live(z.number().default(3000), needsVolatile),
    // Our own knob: the base class neither declares nor `.get()`s it, and
    // `get bashPath()` below reads it as a plain value, so it stays plain.
    //
    // EMPTY means AUTO (v0.28.0, issue #11): the shared resolver walks
    // setting > default install paths > PATH > registry PATH and refuses WSL /
    // MSYS2 / Cygwin. A hard-coded default here is what made a Git installed
    // outside C:/Program Files look like "dsh is broken".
    bashPath: z.string().default(''),
  })
}

/**
 * The schemastery copy that matches the executing host (see src/schemastery.js).
 * Resolving our own way can land on an OLDER copy another dependency hoisted to
 * the profile root — one without `volatile()` — and the executor then declares
 * plain limits for a base class that calls `.get()` on them: every shell call
 * dies with `config.timeoutMs.get is not a function` (issue #12).
 *
 * Deliberately ONE line, and the ONLY top-level await in this module: the smoke
 * harness evaluates this body inside `new Function`, where an await cannot
 * appear, so it swaps exactly this expression for a stub.
 */
const schema = await loadSchemastery({ parentConfig: SandboxBashExecutor.Config })

/** Resolved configuration: the local executor's knobs, plus the Git Bash path. */
export const Config = schema.z ? gitBashShellConfig(schema.z, schema.needsVolatile) : undefined

/** Git Bash executor — mirrors the shipped bash/pwsh sandbox executors. */
export class GitBashSandboxExecutor extends SandboxBashExecutor {
  static inject = ['subprocess', 'sandbox', 'sandboxPolicy']
  static Config = Config

  /**
   * Effective Git Bash path. The configured value wins when it is non-empty
   * (the user's explicit answer is never substituted); otherwise the SHARED
   * resolver decides — the very same result the path-dialect translation layer
   * uses, so "dialect works, executor cannot find bash" (issue #11) is
   * structurally impossible.
   *
   * A failed resolution returns '' — deliberately NOT a substitute shell. Every
   * argv built from it then fails loudly on spawn; `apply()` has already
   * printed the full report, and the client half shows the guided popup.
   */
  get bashPath() {
    return this.bashResolution().path
  }

  /**
   * Resolve the interpreter with the SAME merged explicit tier the main plugin
   * uses (executor row config > `gitbash-shell` settings row > empty = auto),
   * so both halves of the plugin always agree on which bash this process runs.
   * @returns {object} the memoized resolution verdict.
   */
  bashResolution() {
    const configured = effectiveConfiguredBashPath(this.config.bashPath, settingsBashPath(this.ctx))
    return resolveGitBashCached({ configured })
  }

  /**
   * The resolved Git Bash path, or a THROW that says exactly what is wrong.
   *
   * The throw is the design (AGENTS.md §4h): with no Git Bash there is no
   * command execution at all — we do not substitute pwsh, cmd, WSL or MSYS2,
   * and we do not let a bare `spawn ENOENT` be the only thing the user sees.
   * The boot log carries the same report (src/index.js) and the client half
   * shows the guided popup with the probed list.
   * @returns {string} the resolved interpreter path.
   */
  requireBashPath() {
    const resolution = this.bashResolution()
    if (!resolution.ok) {
      throw new Error('dsh-gitbash-shell: no Git for Windows bash found, so this command cannot run. '
        + bashResolutionReport(resolution).split('\n').slice(1).join(' | '))
    }
    return resolution.path
  }

  /**
   * Wrap one shell command via the ctx.sandbox provider, substituting Git Bash
   * for the shipped bare `bash` argv.
   *
   * Signature spans both dsh eras: 0.1.6-alpha.1 made the provider's confine
   * async and handed it the caller's abort signal (the base class now calls
   * `this.confine(command, policy, signal)` and awaits it). The predecessor
   * was synchronous and took two arguments. Forwarding the third argument is
   * safe on both — the old provider ignores it and its synchronous return is
   * what the old base class still consumes — while dropping it on the new host
   * would silently detach sandbox preparation from cancellation.
   * @param command - shell source for the confined inner `bash -c`.
   * @param policy - resolved confined execution policy.
   * @param signal - caller deadline/cancellation, forwarded when the host provides one.
   * @returns the provider's exact argv and settlement-classification facts (a promise on dsh >= 0.1.6).
   */
  confine(command, policy, signal) {
    return this.ctx.sandbox.confine([this.requireBashPath(), '-c', command], policy, signal)
  }

  /**
   * Whether the LOADED base class declares an async `start`, probed once
   * (pure). dsh 0.1.6-alpha.1 turned LocalBashExecutor.start into an async
   * method returning Promise<ShellProcess>; before that it returned the live
   * handle directly. This override has to match whichever contract the host
   * actually carries: handing a plain handle to a host that awaits is fine,
   * but handing a Promise to a synchronous host would give it a thenable
   * instead of a process. Shape is probed, never inferred from a version.
   * @returns true when the base class start is an async function.
   */
  static baseStartIsAsync() {
    return typeof SandboxBashExecutor.prototype.start === 'function'
      && SandboxBashExecutor.prototype.start.constructor.name === 'AsyncFunction'
  }

  /**
   * Unwrap `runArgv`'s settlement across dsh eras (pure). 0.1.6-alpha.1
   * changed the protected hook's return value from the bare ShellRunResult to
   * `{ result, spawnRequested }`, where spawnRequested is false when
   * preparation was cancelled before any spawn. Spreading the wrapper as if it
   * were the result would hand the caller an object carrying no exitCode and
   * no streams at all, so it is unwrapped by shape — never by version.
   * @param raw - whatever the loaded `runArgv` resolved to.
   * @returns the bare result plus whether argv ever reached the provider.
   */
  static unwrapRunArgv(raw) {
    if (raw !== null && typeof raw === 'object' && typeof raw.spawnRequested === 'boolean' && raw.result !== undefined) {
      return { result: raw.result, spawnRequested: raw.spawnRequested }
    }
    return { result: raw, spawnRequested: true }
  }

  /** Construct the host's structured refusal when its module was resolved. */
  policyUnavailableError(mode) {
    const knownMode = mode === 'read-only' || mode === 'workspace-write' ? mode : 'unresolved'
    const detail = 'dsh-gitbash-shell does not provide verified Windows Git for Windows confinement. '
      + 'The command was not started; no unconfined fallback is permitted. '
      + 'Do not bypass this refusal with another tool or change permissions automatically.'
      + ' The user can open Settings > Plugins > dsh-gitbash-shell and turn off '
      + '"Experimental native execution / fail-closed" (experimentalNative) to restore the legacy '
      + 'explicitly UNCONFINED Bash behavior, or select danger-full-access in the session access-mode control.'
    if (typeof this.unavailableErrorType === 'function') return new this.unavailableErrorType(knownMode, detail)
    // Direct/older callers without the optional host error export still refuse.
    const error = new Error('sandbox mode "' + knownMode + '" cannot execute Git Bash on this Windows host. ' + detail)
    error.name = 'SandboxUnavailableError'
    error.code = 'SANDBOX_UNAVAILABLE'
    return error
  }

  /**
   * Full access uses explicit Git Bash argv. Windows restricted or unresolved
   * policy fails BEFORE argv resolution, job admission or spawning; disclosure
   * of an unconfined route is not permission to weaken the requested policy.
   * Non-Windows restricted calls retain the parent's actual sandbox path.
   * @returns `{ mode, unconfined: false }`, or undefined to inherit.
   */
  gitBashRoute(spec) {
    const mode = spec.sandboxPolicy?.mode
    if (mode === 'danger-full-access') return { mode, unconfined: false }
    if (process.platform === 'win32') {
      if (this.experimentalEnabled?.() !== false) throw this.policyUnavailableError(mode)
      // Exact legacy opt-out: unresolved policy still delegates to the host.
      if (mode !== undefined) return { mode, unconfined: true }
    }
    return undefined
  }

  warnConfinedUnconfined(mode) {
    if (this._warnedUnconfined) return
    this._warnedUnconfined = true
    console.log('dsh-gitbash-shell: experimentalNative is OFF. Requested mode ' + mode
      + ' uses an UNCONFINED Git Bash route: shell file-write restrictions are NOT enforced. '
      + 'Official file-tool policy is separate; never bypass its denial through shell.')
  }

  routeSandbox(route) {
    if (route.unconfined) this.warnConfinedUnconfined(route.mode)
    return { mode: route.mode, denied: false, ...(route.unconfined ? { enforcement: 'unconfined' } : {}) }
  }

  /**
   * Label one execution handle's foreground result without changing its
   * identity (the parent's `decorateResult` is private to the shipped class, so
   * the same memoized in-place wrapper lives here).
   * @param ex the handle returned by `executeArgv`.
   * @param sandbox sandbox facts to stamp onto the result.
   * @returns the same handle, with `result()` mapped.
   */
  static decorateExecution(ex, sandbox) {
    // Background reads/outcomes inspect the handle before result() settles.
    ex.sandbox = sandbox
    const base = ex.result.bind(ex)
    let decorated
    ex.result = () => {
      decorated ??= base().then((result) => ({ ...result, sandbox }))
      return decorated
    }
    return ex
  }

  /**
   * dsh 0.1.7 execution entry point (the shipped `ShellExecutor` now declares
   * `execute(spec): Promise<ShellExecution>`; `run`/`start` were removed and
   * background work is an `onExpiry: 'none'` execution the caller stops
   * waiting on). Overriding it is what keeps the two Git Bash substitutions
   * alive on the new host: without it the full-access branch spawns the bare
   * `bash` name hardcoded in `LocalBashExecutor.execute`, and a Windows
   * confined call goes back through the restricted-token runner MSYS2 cannot
   * survive.
   * On hosts without `execute` (<= 0.1.6) this method is never called by the
   * runtime; it delegates to `run` so the class still behaves if it is.
   * @param spec resolved execution settings and caller-owned command metadata.
   * @returns the live execution handle.
   */
  async execute(spec) {
    if (typeof super.execute !== 'function') return this.run(spec)
    const route = this.gitBashRoute(spec)
    const routed = this.withInitScript(this.withParityEnv(spec))
    if (route === undefined) return super.execute(routed)
    const argv = [this.requireBashPath(), '-c', routed.command]
    const sandbox = this.routeSandbox(route)
    // `executeArgv` is the shipped helper for exactly this: run an explicit
    // argv with the executor's own lifecycle, output and deadline semantics.
    return Promise.resolve(this.executeArgv(routed, argv))
      .then((ex) => GitBashSandboxExecutor.decorateExecution(ex, sandbox))
  }

  /**
   * Linux-parity environment for the MODEL's shell (v0.21.1). The official
   * shell-env registry accepts DSH_* facts only — registering anything else
   * throws and takes the whole contribution (including DSH_PATH_DIALECT) down
   * with it — so non-DSH parity facts are merged into the trusted dshEnv map
   * HERE, right before the spawn. Windows Git defaults to core.autocrlf=true,
   * so an LF file the model writes comes back CRLF after a checkout (scripts
   * break on the stray \r); a Linux guest has autocrlf unset. "input"
   * (v0.22.0) is the value that actually matches Linux HERE: it normalizes
   * CRLF to LF on the way into the index without ever writing CRLF, so a
   * worktree a Windows checkout left CRLF reads as CLEAN — with "false" the
   * same repository showed every line of every file as modified and git add
   * staged that churn — while core.eol=lf keeps checkouts on LF.
   * GIT_CONFIG_* are per-invocation settings: only the commands this
   * executor runs see them, and a repository's .gitattributes still wins.
   * @param {object} spec the shell request
   * @returns {object} the request with the parity facts merged in
   */
  /**
   * The plugin row's live dialect settings. The settings service exposes only
   * `describe()` / `update()`, so the row Config's projected values come from
   * the form descriptors (the same read dsh-agent-lang uses for the `locale`
   * namespace).
   * @returns the row's settings object, or undefined when unavailable.
   */
  dialectSettings() {
    try {
      const settings = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('settings') : undefined
      if (settings === undefined || settings === null) return undefined
      if (typeof settings.describe === 'function') {
        const entry = settings.describe().find((row) => row !== null && typeof row === 'object' && row.ns === SETTINGS_NAMESPACE)
        return entry === undefined ? undefined : entry.value
      }
      return undefined
    } catch {
      return undefined
    }
  }

  withParityEnv(spec) {
    try {
      const value = this.dialectSettings()
      if (!value || value.posixPaths !== true || value.gitAutocrlf === false) return spec
      const dshEnv = {
        ...(spec.dshEnv === undefined ? {} : spec.dshEnv),
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'core.autocrlf',
        GIT_CONFIG_VALUE_0: 'input',
        GIT_CONFIG_KEY_1: 'core.eol',
        GIT_CONFIG_VALUE_1: 'lf',
      }
      return { ...spec, dshEnv }
    } catch {
      return spec
    }
  }

  /**
   * Merge the user's bash init script into the trusted env as `BASH_ENV`
   * (issue #37, v0.45.0). `bash -c` sources `BASH_ENV` for every
   * non-interactive shell — the shell's own hook, so no `-l` and none of its
   * side effects (cd $HOME, PATH reordering, profile output in stdout). The
   * reported case is fnm/nvm initialization: `eval "$(fnm env)"` in the file
   * makes node/npm visible to every tool call.
   *
   * Empty = never set (default, behavior unchanged). `~` expands to the home
   * directory; a missing file is silently ignored by bash, so nothing here
   * fails a command because the setting points at a typo — the command simply
   * runs without the hook, exactly as before this setting existed.
   * @param spec the shell request
   * @returns the request with BASH_ENV merged in when a script is configured
   */
  withInitScript(spec) {
    try {
      const value = this.dialectSettings()
      const configured = value && typeof value.initScript === 'string' ? expandHomePath(value.initScript) : ''
      if (configured === '') return spec
      const dshEnv = { ...(spec.dshEnv === undefined ? {} : spec.dshEnv), BASH_ENV: configured }
      return { ...spec, dshEnv }
    } catch {
      return spec
    }
  }

  /**
   * 0.1.6-era full-access path with Git Bash argv: the parent's full-access
   * branch delegates to LocalBashExecutor.run, which hardcodes the bare `bash`
   * name, so override that branch here and keep everything else inherited.
   * On 0.1.7+ the runtime calls `execute` above instead; this stays as the
   * old-era entry point.
   */
  async run(spec) {
    const route = this.gitBashRoute(spec)
    spec = this.withInitScript(this.withParityEnv(spec))
    if (route === undefined) return super.run(spec)
    if (route.unconfined) this.warnConfinedUnconfined(route.mode)
    const { result, spawnRequested } = GitBashSandboxExecutor.unwrapRunArgv(
      await this.runArgv(spec, [this.requireBashPath(), '-c', spec.command]))
    return { ...result, sandbox: this.routeSandbox({ ...route, unconfined: route.unconfined && spawnRequested }) }
  }

  start(spec) {
    let route
    try { route = this.gitBashRoute(spec) }
    catch (error) {
      if (GitBashSandboxExecutor.baseStartIsAsync()) return Promise.reject(error)
      throw error
    }
    spec = this.withInitScript(this.withParityEnv(spec))
    if (route === undefined) return super.start(spec)
    const proc = this.startArgv(spec, [this.requireBashPath(), '-c', spec.command])
    const label = (handle) => { handle.sandbox = this.routeSandbox(route); return handle }
    // Preserve the old host's synchronous/async start contract, including its
    // refusal shape; modern execute() callers never enter this legacy method.
    return GitBashSandboxExecutor.baseStartIsAsync() ? Promise.resolve(proc).then(label) : label(proc)
  }
}

export default GitBashSandboxExecutor
