/**
 * dsh-gitbash-shell/shell — the Git Bash ctx.shell executor.
 *
 * The shipped Windows host composes `dsh-pwsh-sandbox` as ctx.shell and the
 * platform gates (`!!js process.platform === 'win32'`) disable the bash
 * stack on Windows, because a bare `bash` on Windows resolves to the WSL
 * shim in System32 — or to nothing at all when Git's bin directory is not on
 * PATH. This plugin restores the bash stack on Windows while pointing it at
 * Git for Windows' real bash.exe:
 *
 *   - extends @deepseek-ai/dsh-bash-sandbox so every confined-mode
 *     (read-only / workspace-write) call keeps the exact sandbox policy,
 *     denial, and runner-failure semantics of the shipped stack;
 *   - overrides `confine` so the inner argv is [git-bash, -c, command];
 *   - overrides run/start ONLY for danger-full-access (the parent's
 *     full-access branch calls LocalBashExecutor.run, which hardcodes the
 *     bare `bash` name), routing through runArgv/startArgv with the same
 *     argv as the confined branch;
 *   - on Windows ALSO overrides the confined branch itself (issue #1):
 *     MSYS2 cannot start under the restricted-token sandbox — msys-2.0.dll
 *     init creates its cygheap mapping and signal pipe with DACLs naming
 *     only the user SID, a WRITE_RESTRICTED token's pass-2 write check
 *     demands a restricting-SID ACE, so init dies with Win32 error 5 /
 *     0xC0000142 before argv ever runs (silent fake-success or a hard
 *     crash, every version since 0.6.0; cmd/pwsh are unaffected —
 *     anonymous pipes). OS-level conflict with no in-plugin cure, so
 *     confined Windows calls run Git Bash UNCONFINED, labelled as such in
 *     the result (sandbox.enforcement === 'unconfined') plus a one-time
 *     notice. The fs-tool sandbox policy still applies to file tools.
 *
 * Environment inheritance: bash.exe is spawned as a direct child of the host
 * process (never through the git-bash.exe login launcher), so it inherits the
 * full system environment plus the DSH_* snapshot exactly like the pwsh
 * executor did.
 *
 * Loaded as a class plugin: Cordis constructs it and the ShellExecutor base
 * registers `ctx.shell` (one implementation per context).
 */

import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'

import { DEFAULT_GIT_BASH, bashResolutionReport, effectiveConfiguredBashPath, resolveGitBashCached, settingsBashPath } from './bash-path.js'

/** Re-exported for callers that historically read it here (the value now lives in bash-path.js). */
export { DEFAULT_GIT_BASH }
import { loadSchemastery } from './schemastery.js'


/** Log prefix, matching src/index.js. */
const TAG = '[gitbash-shell]'

/**
 * The plugin row's id, which doubles as the settings namespace on <= 0.1.6 and
 * as the row-config namespace on 0.1.7+ (same string by design).
 */
const SETTINGS_NAMESPACE = 'gitbash-shell'

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
    return SandboxBashExecutor.prototype.start.constructor.name === 'AsyncFunction'
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

  /**
   * Decide whether one spec takes the Git Bash argv path, and how to label it
   * (pure). Full access always does — the shipped executor hardcodes the bare
   * `bash` name there. A Windows confined call does too (issue #1: MSYS2 cannot
   * start under the restricted-token runner). Everything else inherits the
   * parent's sandbox path, which already runs Git Bash because `confine` below
   * substitutes the argv.
   * @param spec the shell request.
   * @returns `{ mode, unconfined }`, or undefined to inherit the parent path.
   */
  gitBashRoute(spec) {
    const policy = spec.sandboxPolicy
    const mode = policy === undefined ? undefined : policy.mode
    if (mode === undefined) return undefined
    if (mode === 'danger-full-access') return { mode, unconfined: false }
    if (process.platform === 'win32') return { mode, unconfined: true }
    return undefined
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
  execute(spec) {
    if (typeof super.execute !== 'function') return this.run(spec)
    const routed = this.withParityEnv(spec)
    const route = this.gitBashRoute(routed)
    if (route === undefined) return super.execute(routed)
    const argv = [this.requireBashPath(), '-c', routed.command]
    if (route.unconfined) this.warnConfinedUnconfined(route.mode)
    const sandbox = route.unconfined
      ? { mode: route.mode, denied: false, enforcement: 'unconfined' }
      : { mode: route.mode, denied: false }
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
   * The plugin row's live dialect settings, across eras. dsh 0.1.7 replaced the
   * settings namespace API: the service still exists but exposes only
   * `describe()` / `update()` — `get(ns)` is gone — so the old read silently
   * returned undefined on the new host and the Linux-parity env below never
   * applied. The new era reads the row Config's projected values from the form
   * descriptors (the same read dsh-agent-lang uses for the `locale` namespace).
   * @returns the row's settings object, or undefined when unavailable.
   */
  dialectSettings() {
    try {
      const settings = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('settings') : undefined
      if (settings === undefined || settings === null) return undefined
      if (typeof settings.get === 'function') return settings.get(SETTINGS_NAMESPACE)
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
   * 0.1.6-era full-access path with Git Bash argv: the parent's full-access
   * branch delegates to LocalBashExecutor.run, which hardcodes the bare `bash`
   * name, so override that branch here and keep everything else inherited.
   * On 0.1.7+ the runtime calls `execute` above instead; this stays as the
   * old-era entry point.
   */
  async run(spec) {
    spec = this.withParityEnv(spec)
    const policy = spec.sandboxPolicy
    if (policy === undefined) return super.run(spec)
    const { mode } = policy
    if (mode === 'danger-full-access') {
      const { result } = GitBashSandboxExecutor.unwrapRunArgv(
        await this.runArgv(spec, [this.requireBashPath(), '-c', spec.command]))
      return { ...result, sandbox: { mode, denied: false } }
    }
    if (process.platform === 'win32') {
      this.warnConfinedUnconfined(mode)
      const { result, spawnRequested } = GitBashSandboxExecutor.unwrapRunArgv(
        await this.runArgv(spec, [this.requireBashPath(), '-c', spec.command]))
      // No spawn means no argv ran, so there is nothing to label as
      // unconfined; the parent reports the same bare sandbox facts there.
      return { ...result, sandbox: spawnRequested ? { mode, denied: false, enforcement: 'unconfined' } : { mode, denied: false } }
    }
    return super.run(spec)
  }

  start(spec) {
    spec = this.withParityEnv(spec)
    const policy = spec.sandboxPolicy
    if (policy === undefined) return super.start(spec)
    const { mode } = policy
    const fullAccess = mode === 'danger-full-access'
    if (fullAccess || process.platform === 'win32') {
      if (!fullAccess) this.warnConfinedUnconfined(mode)
      const proc = this.startArgv(spec, [this.requireBashPath(), '-c', spec.command])
      proc.sandbox = fullAccess ? { mode, denied: false } : { mode, denied: false, enforcement: 'unconfined' }
      // Match the loaded base contract: the async one (dsh >= 0.1.6) is
      // awaited by its callers, the synchronous one is consumed directly.
      return GitBashSandboxExecutor.baseStartIsAsync() ? Promise.resolve(proc) : proc
    }
    return super.start(spec)
  }

  /** One-per-instance notice that confined Windows calls run unconfined. */
  warnConfinedUnconfined(mode) {
    if (this._warnedUnconfined) return
    this._warnedUnconfined = true
    console.log(TAG + ' Windows: MSYS2 cannot start under the restricted-token sandbox (msys-2.0.dll init: cygheap/signal-pipe DACLs carry no restricting-SID ACE -> Win32 error 5 / 0xC0000142; issue #1). Confined call (' + mode + ') ran Git Bash UNCONFINED; the fs-tool sandbox policy still applies.')
  }
}

export default GitBashSandboxExecutor
