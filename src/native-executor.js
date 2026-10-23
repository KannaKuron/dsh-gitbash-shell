import path from 'node:path'
import { resolveSessionCwd } from './session-workdir.js'

// No host peer imports here: the owner supplies modules via its host loader.
const KEYS = new Set(['description', 'executable', 'argv', 'cwd', 'timeoutMs', 'run_in_background', 'entrypoint', 'stdoutEncoding', 'stderrEncoding', 'errors'])
const ENCODINGS = new Set(['utf8', 'gbk', 'utf16le', 'raw'])
// A usability guard for known names, NOT executable attestation or a sandbox:
// a renamed/custom .exe may implement its own language. Direct argv is not a
// promise about arbitrary Windows parsers, even after explicit opt-in.
const INTERPRETERS = /^(?:cmd|powershell|pwsh|bash|sh|dash|zsh|fish|wsl|wscript|cscript|mshta|node|nodejs|pythonw?(?:\d+(?:\.\d+)*)?|pypy(?:\d+)?|py|perl|ruby|php|lua|javaw?|jshell|dotnet|csi|tclsh|wish|rscript|busybox|deno|bun)(?:\.exe)?$/i
export const NATIVE_TIMEOUT_MS = 120000
export const NATIVE_MAX_TIMEOUT_MS = 600000

function object(value, label, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label}: expected an object`)
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${label}: unsupported field ${key}`)
}
function string(value, label, empty = false) {
  if (typeof value !== 'string' || (!empty && value.trim() === '') || value.includes('\0')) throw new TypeError(`${label}: expected ${empty ? 'a' : 'a non-empty'} NUL-free string`)
  return value
}

/** Only explicitly typed paths cross the existing mount translator. No argv guessing. */
export function nativePath(input, translateMsysPath, platform = process.platform, label = 'path') {
  object(input, label, new Set(['kind', 'value']))
  if (input.kind !== 'path') throw new TypeError(`${label}: kind must be path`)
  const value = string(input.value, label)
  // Reject expansion prefixes, not literal characters inside absolute paths.
  if (/^(?:[~$]|%[^%]+%)/.test(value)) throw new TypeError(`${label}: variable and home expansion are not supported; use an absolute path`)
  if (platform !== 'win32') throw new Error('gitbash_native currently supports only the Windows local execution world')
  // A rooted Windows path without a drive is not absolute in this contract.
  const absolute = v => /^[a-z]:[\\/]/i.test(v) || /^\\\\[^\\]+\\[^\\]+/.test(v) || /^\/\/[^/]+\/[^/]+/.test(v)
  const translated = absolute(value) ? value : typeof translateMsysPath === 'function' ? translateMsysPath(value) : value
  if (typeof translated !== 'string' || translated.includes('\0') || !absolute(translated)) throw new TypeError(`${label}: unresolved or non-absolute typed path`)
  return path.win32.normalize(translated)
}

/** Strict request validation is also applied outside ToolRuntime. */
export function parseNativeRequest(args, { translateMsysPath, platform = process.platform, sessionCwd } = {}) {
  object(args, 'gitbash_native', KEYS)
  const description = string(args.description, 'description')
  const executable = nativePath(args.executable, translateMsysPath, platform, 'executable')
  if (!/\.exe$/i.test(executable)) throw new TypeError('executable: only native .exe files are supported; .cmd/.bat and script files are never wrapped')
  const entrypoint = args.entrypoint ?? 'native'
  if (!['native', 'interpreter'].includes(entrypoint)) throw new TypeError('entrypoint: expected native or interpreter')
  if (INTERPRETERS.test(path.win32.basename(executable)) && entrypoint !== 'interpreter') throw new TypeError('executable: a known interpreter requires explicit entrypoint: interpreter; its language and quoting remain your responsibility')
  if (!Array.isArray(args.argv) || args.argv.length > 4096) throw new TypeError('argv: expected an array of at most 4096 typed arguments')
  const argv = args.argv.map((arg, index) => {
    object(arg, `argv[${index}]`, new Set(['kind', 'value']))
    if (arg.kind === 'literal') return string(arg.value, `argv[${index}].value`, true)
    if (arg.kind === 'path') return nativePath(arg, translateMsysPath, platform, `argv[${index}]`)
    throw new TypeError(`argv[${index}]: kind must be literal or path`)
  })
  // Conservative bound before the provider's Windows command-line serialization.
  if ([executable, ...argv].reduce((n, arg) => n + arg.length * 2 + 3, 0) > 30000) throw new TypeError('argv: conservative Windows command-line size limit exceeded')
  const cwd = nativePath(args.cwd ?? { kind: 'path', value: sessionCwd }, translateMsysPath, platform, 'cwd')
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) throw new TypeError('timeoutMs: expected a positive finite number')
  if (args.run_in_background !== undefined && typeof args.run_in_background !== 'boolean') throw new TypeError('run_in_background: expected boolean')
  if (args.run_in_background === true && args.timeoutMs !== undefined) throw new TypeError('timeoutMs is not supported with run_in_background; managed jobs have no tool deadline')
  const stdoutEncoding = args.stdoutEncoding ?? 'utf8'
  const stderrEncoding = args.stderrEncoding ?? 'utf8'
  const errors = args.errors ?? 'replace'
  if (!ENCODINGS.has(stdoutEncoding) || !ENCODINGS.has(stderrEncoding)) throw new TypeError('encoding: expected utf8, gbk, utf16le or raw; auto is not supported')
  if (!['replace', 'strict'].includes(errors)) throw new TypeError('errors: expected replace or strict')
  return Object.freeze({ description, executable, argv: Object.freeze(argv), cwd, entrypoint,
    timeoutMs: Math.min(args.timeoutMs ?? NATIVE_TIMEOUT_MS, NATIVE_MAX_TIMEOUT_MS),
    run_in_background: args.run_in_background === true,
    output: Object.freeze({ stdoutEncoding, stderrEncoding, errors }),
  })
}

/** Resolve the *call's* standing policy, never the composition default. */
export function requireNativePolicy(ctx, exec, sandboxModule) {
  const service = ctx.get('sandboxPolicy')
  const policy = service?.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session })
  if (!policy || policy.mode !== 'danger-full-access') {
    const detail = 'gitbash_native has no confined backend adapter. This entry refuses read-only, workspace-write and missing policy before spawn or artifact creation; do not bypass a denied operation. The user can select danger-full-access in the session access-mode control, or turn off Experimental native execution / fail-closed (experimentalNative) in Settings > Plugins > dsh-gitbash-shell to disable native/path tools and restore explicitly UNCONFINED legacy Bash.'
    if (typeof sandboxModule?.SandboxUnavailableError === 'function') throw new sandboxModule.SandboxUnavailableError(policy?.mode ?? 'unknown', detail)
    throw Object.assign(new Error(detail), { code: 'SANDBOX_UNAVAILABLE' })
  }
  return policy
}

function checkedDshEnv(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('shellEnv.collect must return managed environment facts')
  const seen = new Set()
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!/^DSH_/i.test(key) || key.includes('=') || key.includes('\0') || seen.has(key.toUpperCase())) throw new TypeError('shellEnv: invalid or conflicting managed environment key')
    result[key] = string(entry, 'shellEnv managed fact', true)
    seen.add(key.toUpperCase())
  }
  return Object.freeze(result)
}

function preparationTimeout() {
  return Object.assign(new Error('gitbash_native preparation timed out before spawn; no native producer was started'), { code: 'NATIVE_PREPARATION_TIMEOUT' })
}
function cancellation(parent, timeoutMs) {
  const controller = new AbortController()
  const forward = () => controller.abort(parent.reason)
  parent?.addEventListener('abort', forward, { once: true })
  if (parent?.aborted) forward()
  let timer
  if (timeoutMs <= 0) controller.abort(preparationTimeout())
  else timer = setTimeout(() => controller.abort(preparationTimeout()), timeoutMs)
  return { controller, signal: controller.signal,
    stopDeadline() { clearTimeout(timer) },
    dispose() { clearTimeout(timer); parent?.removeEventListener('abort', forward) },
  }
}
async function whileActive(work, signal) {
  signal.throwIfAborted()
  let abort
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work() }), interrupted]) }
  finally { signal.removeEventListener('abort', abort) }
}

/**
 * Per-operation private Core executor. Only this operation's scope and handle are
 * owned here. In particular, disposing it never disposes the root subprocess.
 * Prepared requests are private capabilities, not caller-supplied policy DTOs.
 */
export function createNativeExecutor(ctx, deps) {
  const { localBashModule, sandboxModule, createScope, translateMsysPath, createNativeOutputAdapter, outputOptions = {} } = deps
  const LocalBashExecutor = localBashModule?.LocalBashExecutor
  if (typeof LocalBashExecutor !== 'function' || typeof createScope !== 'function' || typeof createNativeOutputAdapter !== 'function') throw new Error('gitbash_native: required host executor/output/scope capability is unavailable')
  const prepared = new WeakMap()
  const requireEnabled = () => {
    if (deps.experimentalEnabled?.() === false) throw new Error('gitbash_native is disabled by experimentalNative. Enable Experimental native execution / fail-closed in Settings > Plugins > dsh-gitbash-shell.')
  }
  const remaining = request => request.timeoutMs - (Date.now() - prepared.get(request))
  return {
    waitBudget: request => Math.max(1, remaining(request)),
    async prepare(args, exec) {
      requireEnabled()
      const policy = requireNativePolicy(ctx, exec, sandboxModule)
      exec.signal?.throwIfAborted()
      if (args?.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) throw new TypeError('timeoutMs: expected a positive finite number')
      const startedAt = Date.now()
      const timeoutMs = Math.min(args?.timeoutMs ?? NATIVE_TIMEOUT_MS, NATIVE_MAX_TIMEOUT_MS)
      const preparation = cancellation(exec.signal, timeoutMs)
      try {
        const sessionCwd = await whileActive(() => resolveSessionCwd(ctx, { ...exec, signal: preparation.signal }, policy), preparation.signal)
        requireEnabled()
        preparation.signal.throwIfAborted()
        const request = parseNativeRequest(args, { translateMsysPath, sessionCwd, platform: deps.platform ?? process.platform })
        const value = Object.freeze({ ...request, dshEnv: checkedDshEnv(ctx.shellEnv.collect(exec)) })
        prepared.set(value, startedAt)
        return value
      } finally { preparation.dispose() }
    },
    async execute(request, exec, { signal = exec.signal, onExpiry = 'kill' } = {}) {
      requireEnabled()
      const policy = requireNativePolicy(ctx, exec, sandboxModule)
      if (!prepared.has(request)) throw new TypeError('gitbash_native: request must be prepared by this executor')
      if (!['kill', 'none'].includes(onExpiry)) throw new TypeError('invalid native expiry mode')
      signal?.throwIfAborted()
      const provider = ctx.get('subprocess')
      if (typeof provider?.spawn !== 'function') throw new Error('gitbash_native: subprocess provider unavailable')
      // Jobs registrations survive the tool fiber. Their operation scopes belong
      // directly to the agent, not to a disposable tool registration fiber.
      const owner = exec.agent?.ctx ?? ctx
      const operation = cancellation(signal, remaining(request))
      let scope
      let handle
      let scopeDisposed = false
      let producerSettled = false
      let proc
      let resultPromise
      const cancel = reason => {
        if (producerSettled || operation.signal.aborted) return false
        operation.controller.abort(Object.assign(new Error(reason), { code: 'NATIVE_OPERATION_CANCELLED' }))
        return true
      }
      // OutputCollector DTOs may contain optional undefined fields. ToolRuntime
      // requires lossless JSON, so project the adapter's facts at this boundary.
      // Even a facts projection problem must not erase a producer's real exit.
      const outputFacts = () => {
        try { return JSON.parse(JSON.stringify(handle?.outputFacts?.() ?? { unavailable: true })) }
        catch (error) { return { projectionError: String(error?.message ?? error), reliableText: false } }
      }
      const release = async () => {
        if (scopeDisposed) return
        scopeDisposed = true
        try { await scope?.dispose() } finally { operation.dispose() }
      }
      try {
        operation.signal.throwIfAborted()
        scope = createScope(owner.isolate('shell').isolate('subprocess'))
        if (scope.fiber) await whileActive(() => scope.fiber, operation.signal)
        operation.signal.throwIfAborted()
        // Install ownership cancellation before any further preparation await.
        scope.ctx.effect(() => async () => {
          if (!producerSettled) cancel('native execution owner disposed')
          if (!handle) return
          handle.terminate()
          if (typeof handle.waitForExit === 'function') await handle.waitForExit(AbortSignal.timeout(5000))
        })
        requireEnabled()
        requireNativePolicy(ctx, exec, sandboxModule)
        const outputConfig = { ...outputOptions, ...request.output, artifactPolicyValidated: true }
        // Capability/encoding validation is pure and precedes directory creation.
        createNativeOutputAdapter(provider, { ...outputConfig, artifactDirectory: undefined })
        if (outputConfig.artifactDirectory === undefined) {
          if (typeof deps.createArtifactDirectory !== 'function') throw new Error('gitbash_native: no trusted artifact directory owner is configured')
          requireEnabled()
          requireNativePolicy(ctx, exec, sandboxModule)
          operation.signal.throwIfAborted()
          outputConfig.artifactDirectory = await whileActive(async () => {
            const directory = await deps.createArtifactDirectory(request, { ...exec, signal: operation.signal }, operation.signal)
            if (operation.signal.aborted) {
              // The directory owner retains late results under its normal retention
              // policy. Never spawn from a late callback or delete a path still
              // potentially owned/referenced by that trusted asynchronous producer.
              deps.log?.(`gitbash_native: cancelled preparation retained its late artifact directory under owner retention: ${String(directory)}`)
            }
            return directory
          }, operation.signal)
          if (typeof outputConfig.artifactDirectory !== 'string') throw new Error('gitbash_native: artifact directory owner did not return a path')
        }
        requireNativePolicy(ctx, exec, sandboxModule)
        operation.signal.throwIfAborted()
        requireEnabled()
        const adapter = createNativeOutputAdapter(provider, outputConfig)
        const facade = { spawn(spec) {
          requireEnabled()
          requireNativePolicy(ctx, exec, sandboxModule)
          spec.signal?.throwIfAborted()
          handle = adapter.spawn(spec)
          return handle
        } }
        scope.ctx.provide('subprocess', facade)
        const mounted = scope.ctx.plugin(LocalBashExecutor)
        await whileActive(() => mounted, operation.signal)
        requireEnabled()
        operation.signal.throwIfAborted()
        const executor = scope.ctx.get('shell')
        if (typeof executor?.executeArgv !== 'function') throw new Error('gitbash_native: host executeArgv contract is unavailable')
        const budget = remaining(request)
        if (budget <= 0) throw preparationTimeout()
        const spec = executor.resolve({ command: request.description, workdir: request.cwd, timeoutMs: onExpiry === 'kill' ? budget : request.timeoutMs,
          signal: operation.signal, onExpiry, dshEnv: request.dshEnv, sandboxPolicy: policy })
        // Core owns runtime kill deadlines. For Jobs, onExpiry:none keeps running
        // after the bounded preparation phase and the caller's promotion deadline.
        operation.stopDeadline()
        proc = await executor.executeArgv(spec, [request.executable, ...request.argv])
        const originalResult = proc.result.bind(proc)
        const originalDone = proc.done
        // Keep the original producer exit/status even when decoding/storage fails.
        const result = () => resultPromise ??= originalResult().then(value => ({ ...value, status: proc.status, timeoutMs: request.timeoutMs,
          cwd: request.cwd, sandbox: { mode: policy.mode, denied: false },
          outputFacts: outputFacts(),
        }))
        const finished = originalDone.then(async () => {
          // Normal settlement must not be relabelled as an owner cancellation
          // merely because its now-finished execution scope is being released.
          producerSettled = true
          try { await result() } catch { /* result() preserves provider rejection */ }
          await release()
        }, async error => { producerSettled = true; await release(); throw error })
        // Ensure lifecycle cleanup is observed even before a foreground reader attaches.
        finished.catch(() => {})
        return { get status() { return proc.status }, get exitCode() { return proc.exitCode }, get signal() { return proc.signal },
          observed: proc.observed, readOutput: () => proc.readOutput(), kill: () => {
            if (proc.status !== 'running') return false
            cancel('native execution explicitly killed')
            return proc.kill()
          },
          done: finished, result: async () => { await finished; return result() },
          outputFacts,
          sandbox: { mode: policy.mode, denied: false },
        }
      } catch (error) {
        await release()
        throw error
      }
    },
  }
}
