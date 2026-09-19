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
import z from '@deepseek-ai/schemastery'

/** Default Git for Windows bash (forward slashes work on Windows too). */
export const DEFAULT_GIT_BASH = 'C:/Program Files/Git/bin/bash.exe'

/** Log prefix, matching src/index.js. */
const TAG = '[gitbash-shell]'

/** Resolved configuration: the local executor's knobs, plus the Git Bash path. */
export const Config = z.object({
  cwd: z.string(),
  timeoutMs: z.number().default(120000),
  maxTimeoutMs: z.number().default(600000),
  maxOutputBytes: z.number().default(64000),
  maxSpillBytes: z.number().default(64 * 1024 * 1024),
  graceMs: z.number().default(3000),
  bashPath: z.string().default(DEFAULT_GIT_BASH),
})

/** Git Bash executor — mirrors the shipped bash/pwsh sandbox executors. */
export class GitBashSandboxExecutor extends SandboxBashExecutor {
  static inject = ['subprocess', 'sandbox', 'sandboxPolicy']
  static Config = Config

  /** Effective Git Bash path: composition/config value with the default fallback. */
  get bashPath() {
    return this.config.bashPath ?? DEFAULT_GIT_BASH
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
    return this.ctx.sandbox.confine([this.bashPath, '-c', command], policy, signal)
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
   * Full-access path with Git Bash argv: the parent's full-access branch
   * delegates to LocalBashExecutor.run, which hardcodes the bare `bash`
   * name, so override that branch here and keep everything else inherited.
   */
  /**
   * Confined Windows calls cannot use the restricted-token runner (issue
   * #1, see the file header): route them through the unconfined argv path
   * and label the result honestly so callers can tell.
   */
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
  withParityEnv(spec) {
    try {
      const settings = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('settings') : undefined
      const value = settings && typeof settings.get === 'function' ? settings.get('gitbash-shell') : undefined
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

  async run(spec) {
    spec = this.withParityEnv(spec)
    const policy = spec.sandboxPolicy
    if (policy === undefined) return super.run(spec)
    const { mode } = policy
    if (mode === 'danger-full-access') {
      const { result } = GitBashSandboxExecutor.unwrapRunArgv(
        await this.runArgv(spec, [this.bashPath, '-c', spec.command]))
      return { ...result, sandbox: { mode, denied: false } }
    }
    if (process.platform === 'win32') {
      this.warnConfinedUnconfined(mode)
      const { result, spawnRequested } = GitBashSandboxExecutor.unwrapRunArgv(
        await this.runArgv(spec, [this.bashPath, '-c', spec.command]))
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
      const proc = this.startArgv(spec, [this.bashPath, '-c', spec.command])
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
