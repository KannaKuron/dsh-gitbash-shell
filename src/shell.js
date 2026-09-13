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
   * @param command - shell source for the confined inner `bash -c`.
   * @param policy - resolved confined execution policy.
   * @returns the provider's exact argv and settlement-classification facts.
   */
  confine(command, policy) {
    return this.ctx.sandbox.confine([this.bashPath, '-c', command], policy)
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
  async run(spec) {
    const policy = spec.sandboxPolicy
    if (policy === undefined) return super.run(spec)
    const { mode } = policy
    if (mode === 'danger-full-access') {
      const result = await this.runArgv(spec, [this.bashPath, '-c', spec.command])
      return { ...result, sandbox: { mode, denied: false } }
    }
    if (process.platform === 'win32') {
      this.warnConfinedUnconfined(mode)
      const result = await this.runArgv(spec, [this.bashPath, '-c', spec.command])
      return { ...result, sandbox: { mode, denied: false, enforcement: 'unconfined' } }
    }
    return super.run(spec)
  }

  start(spec) {
    const policy = spec.sandboxPolicy
    if (policy === undefined) return super.start(spec)
    const { mode } = policy
    if (mode === 'danger-full-access') {
      const proc = this.startArgv(spec, [this.bashPath, '-c', spec.command])
      proc.sandbox = { mode, denied: false }
      return proc
    }
    if (process.platform === 'win32') {
      this.warnConfinedUnconfined(mode)
      const proc = this.startArgv(spec, [this.bashPath, '-c', spec.command])
      proc.sandbox = { mode, denied: false, enforcement: 'unconfined' }
      return proc
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
