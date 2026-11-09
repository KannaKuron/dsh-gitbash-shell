import { toolNameOccupied } from './tool-ownership.js'
/**
 * dsh-gitbash-shell/inline-tools — runtime shell-tool patching for the OFFICIAL
 * presets on Windows (v0.35.0; route B since v0.39.0).
 *
 * WHY THIS EXISTS. The official preset rows compose their tool set at boot
 * (`tool-bash` disabled on win32, `tool-pwsh` enabled), and the patch layer
 * CANNOT reach them: `applyEntryPatches`' id map only descends into rows that
 * carry `group: true` (vendor/include/src/index.ts buildMap), while a preset
 * declaration is a plain row whose `config.plugins` is opaque data. Rewriting
 * the declaration's whole `config` would freeze the official row list at our
 * restatement instant. So the fix runs at the tool layer, where the official
 * contract explicitly invites per-agent variants:
 *
 *   - the tools registry REJECTS same-scope duplicate names but points at this
 *     exact path for variants ("for a per-agent variant, register through that
 *     agent's `agent.ctx` instead", packages/core/tools/src/index.ts);
 *   - `agent/created` fires once per agent with the composed tool face
 *     reachable through `ctx.get('tools').schemas(agent)`.
 *
 * ROUTE B (v0.39.0, the DSH-Store-compliant architecture). The plugin no
 * longer replaces the host `ctx.shell` executor, so the OFFICIAL tool-bash
 * module — whose every execution goes through `ctx.shell`, i.e. PowerShell
 * here — is OFF the table. Instead one reconcile per agent reads the face and
 * acts on three facts:
 *
 *   1. `pwsh` present + `bash` absent  -> register the plugin's OWN `bash`
 *      tool (src/bash-tool.js) in an agent-owned scope. It executes through a
 *      PRIVATE GitBashSandboxExecutor instance (constructed once per process
 *      in a shell-isolated cordis scope, never registered as the ROOT shell), and mirrors
 *      the official tool's schema, background jobs, escalation and rendering
 *      call-for-call.
 *   2. `ops_*` tools present (dsh-ops installed) -> our FastCtx bridge stands
 *      down, the pwsh hiding stands down (dsh-ops owns the host-pwsh story),
 *      and a bash tool they already publish means ours is not registered.
 *   3. `pwshTool` switch OFF (the default) -> the REAL host `pwsh` tool is
 *      hidden per agent (`tools.restrict`) and denied at the call layer. With
 *      route B the host pwsh is REAL PowerShell again — hiding it is a pure
 *      product choice (bash-first host), not a safety denial, and flipping
 *      the switch surfaces it unchanged.
 *
 * Everything here is Windows-only by caller gate; on other hosts the module
 * loads but mounts nothing.
 */

/** FastCtx-bridge shared output contract (unchanged since v0.35.0). */
export const TOOL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    content: { type: 'array', items: {} },
    structuredContent: {},
  },
  required: ['content'],
  additionalProperties: false,
})

/**
 * Render the `{ content: [...] }` execute value into text blocks. Non-text
 * blocks and non-string text fields are skipped; empty content renders as one
 * empty text block rather than an empty array, so the card never loses its
 * placeholder.
 */
export function renderTextContent(value) {
  const blocks = Array.isArray(value?.content) ? value.content : []
  const text = blocks
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .filter((line) => line !== '')
    .join('\n')
  return [{ type: 'text', text }]
}

/**
 * Answer for one observed tool face. Pure.
 * @param {string[]|undefined} names - the agent's composed tool names.
 * @param {{ pwshVisible?: boolean }} [options] - whether the row switch shows
 *   the (real) host pwsh tool; defaults to hidden.
 */
export function inlineNeeds(names, { pwshVisible } = {}) {
  const set = new Set(Array.isArray(names) ? names : [])
  const has = (name) => set.has(name)
  return {
    // A pwsh tool without a bash tool is the official win32 composition on
    // this host: our own bash tool must be patched in.
    needsBash: has('pwsh') && !has('bash'),
    // The real pwsh tool is hidden while the row switch is off (the default):
    // the product answer is bash-first. dsh-ops co-install hands the whole
    // host-shell story over to dsh-ops (checked by the caller).
    hidePwsh: has('pwsh') && pwshVisible !== true,
    // dsh-ops publishes file/search tools under the ops_ prefix. When they are
    // here, our FastCtx bridge would be a duplicate.
    opsPresent: has('ops_inspect_local_file') || has('ops_grep') || has('ops_bash'),
  }
}

/**
 * The dsh-ops shell pair (v0.41.0, owner decision): while this plugin's own
 * bash owns a session, those two names are DENIED for the agent. The list is
 * dsh-ops's own published surface - lib/policy.js builds every public name as
 * TOOL_PREFIX + raw with TOOL_PREFIX = "ops_", and the shell-class raw names
 * are "run" (one-shot shell) and "bash" (in-process shell). Their file/search
 * (ops_inspect_local_file, ops_grep, ops_glob, ops_replace), background-job
 * (ops_run_background, ops_job_*) and batch surfaces stay untouched - the
 * owner's call: installing dsh-ops buys its enhancements, not a second bash.
 */
export const OPS_SHELL_TOOLS = Object.freeze(['ops_bash', 'ops_run'])

/**
 * The deny reason for an ops shell call on an agent our bash owns (route B
 * wording): the tool exists, the host just routes shells elsewhere - the
 * sentence names the owner and keeps the agent inside the offered face.
 */
export function deniedOpsShellReason() {
  return 'the dsh-ops shell tools are denied on this host: dsh-gitbash-shell owns the shell (its own Git Bash bash tool). Use the bash tool for commands; the other ops_* tools (files, search, background jobs) are unaffected.'
}

export { GITBASH_ROUTE_ADDENDUM, GITBASH_ROUTE_ADDENDUM_NO_PWSH, GITBASH_MSYS_ADDENDUM, toolRoutingHintFor, applyToolRouting } from './tool-routing.js'

/**
 * The deny reason for a hidden pwsh call (route B wording): the tool is REAL
 * PowerShell on this host, just hidden by the row switch — the sentence says
 * so and points at the switch instead of calling the tool a lie.
 */
export function hiddenPwshDenyReason() {
  return 'the pwsh tool is hidden on this host by the dsh-gitbash-shell settings (pwsh tool switch, off by default). Use the bash tool for commands. If you need Windows-native work (registry, services, WMI), ask the user to enable the pwsh tool on the dsh-gitbash-shell settings card.'
}

/** The host packages the own bash tool consumes, resolved once per process. */
const HOST_MODULES = [
  ['toolsModule', '@deepseek-ai/dsh-tools'],
  ['sandboxModule', '@deepseek-ai/dsh-sandbox'],
  ['llmModule', '@deepseek-ai/dsh-llm'],
]

/**
 * Mount the executor through the host class-plugin path. A plugin fiber owns
 * effects, but does NOT create a service namespace: ShellExecutor's constructor
 * still provides `shell`. Isolate ONLY that service, retaining the host's
 * subprocess/sandbox/policy dependencies and leaving the official shell intact.
 *
 * The empty scope does not inject shell, so read its active provider through
 * get(), not the property-access path that requires an inject declaration.
 */
export async function mountPrivateExecutor(ctx, GitBashSandboxExecutor, createScope, { timeoutMs = 8000 } = {}) {
  const executorScope = createScope(ctx.isolate('shell'))
  let timer
  try {
    const mountTimeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('executor scope mount timed out (a required service may be absent in this composition)')), timeoutMs)
    })
    const executor = await Promise.race([
      (async () => {
        if (executorScope.fiber) await executorScope.fiber
        const fiber = executorScope.ctx.plugin(GitBashSandboxExecutor)
        await fiber
        const executor = executorScope.ctx.get('shell')
        const sandboxModule = await resolveHostModule(executorScope.ctx, '@deepseek-ai/dsh-sandbox')
        if (typeof sandboxModule?.SandboxUnavailableError === 'function') {
          executor.unavailableErrorType = sandboxModule.SandboxUnavailableError
        }
        return executor
      })(),
      mountTimeout,
    ])
    if (!executor || typeof executor.resolve !== 'function' || typeof executor.execute !== 'function') {
      throw new Error('executor instance did not expose resolve()/execute()')
    }
    return { executor, executorScope }
  } catch (error) {
    await executorScope.dispose()
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Mount the per-agent reconcile. `deps`:
 *   - tools(ctx)       -> the host tool registry (or undefined)
 *   - agents(ctx)      -> the host agents service (or undefined)
 *   - createScope(fn)  -> cordis createScope
 *   - pwshEnabled()    -> the row switch; TRUE shows the real host pwsh tool,
 *                         false/undefined (default) hides it
 *   - log(message)     -> the plugin's tagged logger
 *
 * Registration decisions re-run on EVERY agent creation AND once at mount
 * time for every ALREADY-LIVE agent (the dsh-ops-proven shape): this row can
 * activate long after agents exist. A second, INDEPENDENT layer guards the
 * call itself through `tools/pre-execute`: visibility restriction can lose a
 * race.
 */
export function mountInlineTools(ctx, deps) {
  const { tools, agents, createScope, pwshEnabled, log } = deps
  /** Per-agent mounts, masks and cancellation; `agents` above is the host service. */
  const tracked = new Map()
  const pending = new Set()
  const controller = new AbortController()
  let closed = false
  const isLive = (agent, state) => !closed && tracked.get(agent) === state && !state.controller.signal.aborted
  const newState = () => ({ retry: undefined, scope: undefined, denyPwsh: undefined, denyOpsShell: undefined, pending: undefined, native: undefined, nativeFailed: false, controller: new AbortController(), toolFace: undefined })
  // Every retry attempt owns one record. Detaching stops the timer without
  // resolving; settling is separate so a REPLACEMENT reconcile can make the
  // old created promise await its own Bash mount instead of resolving early.
  const detachRetry = (state, retry) => {
    if (!retry || retry.detached) return retry
    retry.detached = true
    if (retry.timer) clearTimeout(retry.timer)
    retry.timer = undefined
    if (state.retry === retry) state.retry = undefined
    return retry
  }
  const settleRetry = (state, retry) => {
    if (!retry || retry.settled) return
    retry.settled = true
    detachRetry(state, retry)
    retry.resolve()
  }
  const cancelRetry = (state) => {
    if (state?.retry) settleRetry(state, state.retry)
  }
  const followRetry = (state, retry, result) => {
    if (!retry) return result
    return Promise.resolve(result)
      .catch(() => { /* registration failures never fail agent creation */ })
      .finally(() => settleRetry(state, retry))
  }
  // toolFace freezes the switch values this agent was created under, so a live
  // settings edit cannot reshape a running face.
  const experimentalEnabled = () => deps.experimentalEnabled?.() !== false
  // Loader imports cannot be cancelled, but no continuation may outlive its
  // owner. Join our cancelled continuations without waiting on a stuck loader.
  const untilDisposed = async (promise, signal) => {
    signal.throwIfAborted()
    let abort
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
    })
    try { return await Promise.race([promise, cancelled]) }
    finally { signal.removeEventListener('abort', abort) }
  }
  /** Resolved once per process: { executor, executorScope, module }. */
  let bashOnce
  /** Set as soon as any face shows ops_* tools (the call-layer guard reads it). */
  let opsSeen = false

  const faceNames = (agent) => {
    try {
      const registry = tools(ctx)
      return (registry?.schemas?.(agent) ?? []).map((schema) => schema.name).filter((name) => typeof name === 'string')
    } catch {
      return []
    }
  }

  /**
   * Construct the private executor and the own bash-tool module ONCE per
   * process. The executor mounts through cordis's own class-plugin path in a
   * PRIVATE scope (`ctx.plugin(class)` honours the static inject/Config
   * declarations — the §4k schemastery semantics come for free), so it never
   * touches the root `ctx.shell` service slot the official pwsh executor
   * owns. The executor scope lives for the plugin's lifetime and is disposed
   * by the ownership effect registered before lifecycle wiring.
   */
  const bashOncePromise = async () => {
    controller.signal.throwIfAborted()
    if (bashOnce) return bashOnce
    const mounting = (async () => {
      let executorScope
      try {
        const { GitBashSandboxExecutor } = await untilDisposed(import('./shell.js'), controller.signal)
        if (!GitBashSandboxExecutor) throw new Error('executor class unavailable')
        if (!GitBashSandboxExecutor.Config) {
          throw new Error('executor Config unavailable (schemastery unresolved; see the schemastery log lines above)')
        }
        if (typeof createScope !== 'function') throw new Error('no createScope seam')
        controller.signal.throwIfAborted()
        const mounted = await mountPrivateExecutor(ctx, GitBashSandboxExecutor, createScope)
        mounted.executor.experimentalEnabled = experimentalEnabled
        executorScope = mounted.executorScope
        controller.signal.throwIfAborted()
        const hostModules = {}
        for (const [key, name] of HOST_MODULES) {
          hostModules[key] = await untilDisposed(resolveHostModule(ctx, name), controller.signal)
        }
        const { createBashToolModule } = await untilDisposed(import('./bash-tool.js'), controller.signal)
        const module = createBashToolModule({ executor: mounted.executor, log, ...hostModules })
        const extraModules = []
        if (typeof deps.translatePath === 'function') {
          const { createPathToolModule, PATH_TOOL_NAME } = await untilDisposed(import('./path-tool.js'), controller.signal)
          extraModules.push({ name: PATH_TOOL_NAME, create: scope => createPathToolModule({
            toolsModule: hostModules.toolsModule, translate: deps.translatePath, experimentalEnabled, log, scope,
          }) })
          try {
            const localBashModule = await untilDisposed(resolveHostModule(ctx, '@deepseek-ai/dsh-bash-local'), controller.signal)
            const outputModule = await untilDisposed(resolveHostModule(ctx, '@deepseek-ai/dsh-subprocess-local/output'), controller.signal)
            if (typeof localBashModule?.LocalBashExecutor !== 'function'
              || typeof outputModule?.OutputCollector !== 'function') {
              throw new Error('public native executor/OutputCollector capability unavailable')
            }
            const { createNativeOutputAdapter } = await untilDisposed(import('./native-output.js'), controller.signal)
            const { createNativeToolModule } = await untilDisposed(import('./native-tool.js'), controller.signal)
            extraModules.push({ name: 'gitbash_native', create: scope => createNativeToolModule({
              toolsModule: hostModules.toolsModule, sandboxModule: hostModules.sandboxModule,
              localBashModule, createScope, translateMsysPath: deps.translatePath,
              createNativeOutputAdapter, outputOptions: { OutputCollector: outputModule?.OutputCollector },
              createArtifactDirectory: deps.createArtifactDirectory, experimentalEnabled, log, scope,
              slot: tracked.get(scope)?.native,
            }) })
          } catch (error) {
            if (controller.signal.aborted) throw error
            log(`native tool capability unavailable; bash/path tools remain available: ${error?.message ?? error}`)
          }
        }
        return { executor: mounted.executor, executorScope, module, extraModules }
      } catch (error) {
        if (executorScope) await executorScope.dispose()
        throw error
      }
    })()
    bashOnce = mounting
    mounting.catch(() => { if (bashOnce === mounting) bashOnce = undefined })
    return mounting
  }

  /** Register the own bash tool inside one agent-owned scope. */
  const provideBash = async (agent, state) => {
    let scope
    let retained = false
    try {
      const { executor, module, extraModules } = await untilDisposed(bashOncePromise(), state.controller.signal)
      if (!isLive(agent, state)) return
      log(`own bash tool ready (private Git Bash executor at ${executor.bashPath || '(unresolved)'}; official pwsh executor untouched)`)
      scope = createScope(agent.ctx)
      state.scope = scope // Own the scope BEFORE either asynchronous mount.
      // Same asynchronous-fiber shape the official module needed: wait for
      // the apply callback to capture scope.ctx before touching its tools.
      if (scope.fiber) await untilDisposed(scope.fiber, state.controller.signal)
      if (!isLive(agent, state)) return
      const registry = scope.ctx?.get('tools')
      if (!registry || typeof scope.ctx.plugin !== 'function') return
      const fiber = scope.ctx.plugin({ ...module, apply(toolCtx, config) {
        return module.apply(toolCtx, { ...config, routing: {
          scope: agent,
          options: () => ({ pwshVisible: state.toolFace.pwshVisible, ...deps.routingOptions?.(agent) }),
        } })
      } })
      await untilDisposed(fiber, state.controller.signal)
      if (!isLive(agent, state)) return
      // An INACTIVE fiber resolves its await() without ever running apply()
      // (issue #27): awaiting the plugin proves nothing, so read the registry
      // back before claiming success. A miss THROWS — the catch below logs the
      // explicit activation failure and the finally disposes this half-mounted
      // scope instead of leaking it for the agent's lifetime (shape credit:
      // KouzakiUmi's PR #28).
      const registeredNames = (scope.ctx.get('tools')?.schemas?.(agent) ?? [])
        .map((schema) => schema && typeof schema.name === 'string' ? schema.name : '')
      if (registeredNames.includes('bash') === false) {
        throw new Error('bash tool did not register for this agent (module fiber INACTIVE — this host lacks an injected service the module requires — or the tools read-back is unavailable); bash is NOT available in this session, please report this with your dsh version (issue #27)')
      }
      for (const extra of extraModules ?? []) {
        let extraFiber
        try {
          let applied = false
          const module = extra.create(agent)
          extraFiber = scope.ctx.plugin({ ...module, async apply(extraCtx, config) {
            await module.apply(extraCtx, config)
            applied = true
          } })
          await untilDisposed(extraFiber, state.controller.signal)
          if (!isLive(agent, state)) return
          if (!applied) {
            throw new Error(`${extra.name} scope inactive (a required service may be missing)`)
          }
          // Registration/stand-down is reported by the shared live registrar.
          log(`${extra.name} scope ready; registration follows experimentalNative and existing owners`)
        } catch (error) {
          if (!isLive(agent, state)) return
          await extraFiber?.dispose()
          log(`${extra.name} activation failed; bash remains available: ${error?.message ?? error}`)
          // A failed native mount must not leave the eager slot behind: the
          // tool would be visible but unusable for the agent's whole life.
          if (extra.name === 'gitbash_native') failNativeSlot(state, error)
        }
      }
      // v0.41.0 (owner decision): while OUR bash owns the session, the ops
      // shell pair is denied by name - installing dsh-ops buys its file,
      // search and background enhancements, not a second bash. Through the
      // AGENT's scoped context, the exact shape the pwsh hide uses (issue
      // #18: the root context throws "requires a scoped context"). Only the
      // names actually in the face are listed, so a future dsh-ops rename
      // degrades to "no denial", never to a wrong deny list. On failure the
      // ops tools stay - our bash remains the routing answer either way.
      const opsShell = faceNames(agent).filter((name) => OPS_SHELL_TOOLS.includes(name))
      if (opsShell.length > 0) {
        try {
          const deny = agent.ctx?.tools?.restrict?.({ deny: [...opsShell] })
          if (typeof deny === 'function') {
            state.denyOpsShell = deny
            log('ops shell tools denied for this agent (' + opsShell.join(', ') + '): this host\'s bash is ours; their file/search/background tools stay')
          }
        } catch (error) {
          log('ops shell denial failed (their shell tools stay available): ' + (error?.message ?? error))
        }
      }
      retained = true
      log('own bash tool activated for this agent (Git Bash execution; official pwsh tool real but hidden by default)')
    } catch (error) {
      if (isLive(agent, state)) {
        log(`own bash tool activation failed for this agent: ${error?.message ?? error}`)
        // The eager slot advertised the native tool before this mount. If the
        // mount itself failed, withdraw it instead of keeping a ghost.
        failNativeSlot(state, error)
      }
    } finally {
      if (scope && !retained) {
        if (state.scope === scope) state.scope = undefined
        await scope.dispose()
      }
    }
  }

  /**
   * EAGER STABLE SLOT (issue #38). The native tool used to be registered only
   * after an async module mount, so step 1 of every turn saw one tool fewer
   * than step 2 and the provider prompt prefix was invalidated. This registers
   * the real host definition synchronously at agent/created; the real native
   * module later installs its executor UNDER THE SAME REGISTRATION. The name,
   * schema and description are produced by the same nativeToolDefinition()
   * builder in both places, so the model-facing face never changes.
   *
   * Only created when the host already exposes the jobs service: the
   * background surface must be fixed before step 1, and re-registering later
   * is exactly the churn this fixes. If native capability is missing we
   * advertise nothing.
   */
  const NATIVE_SLOT_WAIT_MS = 15000
  const waitForNativeSlot = (slot, signal) => new Promise((resolve, reject) => {
    if (slot.impl) return resolve()
    if (slot.error) return reject(slot.error)
    if (signal?.aborted) return reject(signal.reason ?? new Error('tool call aborted'))
    let settled = false
    let timer
    const onAbort = () => fail(signal.reason ?? new Error('tool call aborted'))
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    timer = setTimeout(() => fail(new Error('gitbash_native is still initializing; retry after this step')), NATIVE_SLOT_WAIT_MS)
    timer.unref?.()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    slot.ready.then(() => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }, fail)
  })

  const ensureNativeSlot = (agent, state) => {
    if (state.native || state.nativeFailed || !deps.nativeContract || state.toolFace?.experimental === false) return
    let jobs
    try { jobs = agent.ctx?.get?.('jobs') } catch { jobs = undefined }
    if (!jobs) return
    // A foreign or earlier owner of the name wins: never shadow a tool we did
    // not create.
    try { if (toolNameOccupied(tools(ctx), 'gitbash_native', agent)) return }
    catch (error) { log(`gitbash_native eager slot skipped: ${error?.message ?? error}`); return }
    let resolveReady
    let rejectReady
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    ready.catch(() => { /* a slot nobody calls must not become an unhandled rejection */ })
    let slot
    const execute = async (args, exec) => {
      if (slot.error) throw slot.error
      if (!slot.impl) await waitForNativeSlot(slot, exec?.signal)
      if (slot.error) throw slot.error
      if (!slot.impl) throw new Error('gitbash_native is not ready in this session')
      return slot.impl(args, exec)
    }
    let definition
    try {
      definition = deps.nativeContract({ background: true, execute })
    } catch (error) {
      state.nativeFailed = true
      log('gitbash_native eager slot creation failed; the legacy late path stays in use: ' + (error?.message ?? error))
      return
    }
    let disposer
    try {
      disposer = agent.ctx.tools.register(definition)
      if (typeof disposer !== 'function') throw new Error('tools.register returned no disposer')
    } catch (error) {
      state.nativeFailed = true
      log('gitbash_native eager slot registration failed; the legacy late path stays in use: ' + (error?.message ?? error))
      return
    }
    slot = {
      background: true, impl: null, error: null, installed: false, disposed: false,
      ready,
      install(realDefinition) {
        if (slot.disposed || slot.installed) return
        const realExecute = realDefinition?.execute
        if (typeof realExecute !== 'function') {
          slot.fail(new Error('gitbash_native real executor definition is invalid'))
          return
        }
        slot.impl = realExecute
        slot.installed = true
        resolveReady()
      },
      fail(error) {
        if (slot.disposed || slot.error) return
        slot.error = error instanceof Error ? error : new Error(String(error))
        rejectReady(slot.error)
      },
      dispose() {
        if (slot.disposed) return
        slot.disposed = true
        try { disposer() } catch { /* registration already gone */ }
        rejectReady(new Error('gitbash_native was withdrawn from this session'))
      },
    }
    state.native = slot
    log('gitbash_native eager slot registered for this agent (stable from step 1; the real executor installs behind it)')
  }

  const disposeNativeSlot = (state) => {
    const slot = state.native
    if (!slot) return
    state.native = undefined
    slot.dispose()
  }

  /** A broken native mount must never leave a ghost tool in the face. */
  const failNativeSlot = (state, reason) => {
    const slot = state.native
    if (!slot) return
    state.native = undefined
    state.nativeFailed = true
    const error = reason instanceof Error ? reason : new Error(String(reason))
    slot.fail(error)
    slot.dispose()
    log('gitbash_native eager slot withdrawn: ' + error.message)
  }

  const startBash = (agent, state) => {
    if (state.scope || state.pending || !isLive(agent, state)) return
    const task = provideBash(agent, state)
    state.pending = task
    pending.add(task)
    void task.finally(() => {
      pending.delete(task)
      if (state.pending === task) state.pending = undefined
    }).catch((error) => log(`own bash tool cleanup failed: ${error?.message ?? error}`))
  }

  const reconcile = (agent, { attempt = 0 } = {}) => {
    if (closed || !agent?.ctx) return
    // Undo ONLY our mask before observing the face. schemas() filters a
    // restricted-away pwsh, so it cannot tell us what an ON flip must restore.
    const previous = tracked.get(agent)
    // A new reconcile supersedes a pending timer, but the OLD created promise
    // must follow THIS reconcile's result (including an async bash mount).
    // Only dispose may settle a waiting retry without a ready replacement.
    const interrupted = previous?.retry && !previous.retry.settled
      ? detachRetry(previous, previous.retry)
      : undefined
    if (previous?.denyPwsh) { previous.denyPwsh(); previous.denyPwsh = undefined }
    if (previous?.denyOpsShell) { previous.denyOpsShell(); previous.denyOpsShell = undefined }
    const names = faceNames(agent)
    // The composed face may not be wired yet at created-time. Retry bounded:
    // a face with NEITHER tool carries no verdict. Five tries at 250ms, then
    // give up quietly — a slower composition simply gets no inline patch.
    if (attempt < 5 && !names.includes('bash') && !names.includes('pwsh')) {
      // Hand the retry chain back to the caller. `agent/created` is SERIAL and
      // awaits whatever the listener returns, so a bare `return` admitted the
      // agent against a face that was not wired yet (review P2). Resolve only
      // after the retried reconcile settles, so the chain is awaited end to end.
      const state = tracked.get(agent) ?? newState()
      if (!tracked.has(agent)) tracked.set(agent, state)
      const waiting = new Promise((resolve) => {
        const retry = { timer: undefined, resolve, settled: false, detached: false }
        state.retry = retry
        retry.timer = setTimeout(() => {
          if (retry.settled) return
          // This record is now FIRING, not pending. Detach it before recursing
          // so the next reconcile cannot cancel/resolve its own continuation
          // before the new face (or a later attempt) has been observed.
          detachRetry(state, retry)
          Promise.resolve()
            .then(() => reconcile(agent, { attempt: attempt + 1 }))
            .catch(() => { /* never crash on a timer */ })
            .finally(() => settleRetry(state, retry))
        }, 250)
        retry.timer.unref?.()
      })
      return followRetry(state, interrupted, waiting)
    }
    let state = tracked.get(agent)
    if (!state) {
      state = newState()
      tracked.set(agent, state)
    }
    // Freeze the face-shaping switches at this agent's first observation. They
    // are volatile row fields, so the host hands an edit to the LIVE row;
    // re-reading them here reshaped faces that were already in use (turning the
    // pwsh switch off withdrew the own bash tool). The frozen value lasts for this
    // agent's whole life; the settings card asks for a restart.
    if (state.toolFace === undefined) state.toolFace = {
      pwshVisible: deps.pwshEnabled?.() === true,
      experimental: deps.experimentalEnabled?.() !== false,
    }
    const pwshVisible = state.toolFace.pwshVisible === true
    const needs = inlineNeeds(names, { pwshVisible })
    if (needs.opsPresent) opsSeen = true
    // The pwsh face (route B): the host tool is REAL PowerShell now, so the
    // default is a product-level HIDE, not a safety denial.
    //   dsh-ops present  -> hands off entirely (their host-pwsh story stands).
    //   switch OFF       -> hide the tool for this agent (tools.restrict).
    //   switch ON        -> leave the real tool visible, untouched.
    if (needs.hidePwsh && !needs.opsPresent) {
      if (!state.denyPwsh) {
        // Through the AGENT's scoped context (`agent.ctx.tools`, the dsh-ops
        // -proven shape): on the ROOT context the host throws "requires a
        // scoped context" and the restriction silently never exists (issue
        // #18, root cause 3).
        try {
          const deny = agent.ctx?.tools?.restrict?.({ deny: ['pwsh'] })
          if (typeof deny === 'function') state.denyPwsh = deny
        } catch (error) {
          log(`pwsh hide failed: ${error?.message ?? error}`)
        }
      }
    }
    // A face WITHOUT pwsh is not the official win32 composition: something
    // masked the host tool away, and the only such mask in the wild is a
    // preset gate (`tools.restrict({ allow })`, e.g. the pure-chat preset).
    // Our bash lives in an AGENT-OWNED scope, and scoped registrations stay
    // visible through masks by contract — so a registration made while the
    // face was still settling would leak a shell into that preset for the
    // rest of the agent's life. `names` above is the PRE-MASK observation
    // (our own deny was lifted first), so it is authoritative: stand down.
    if (names.length > 0 && !names.includes('pwsh') && state.scope) {
      const withdrawn = state.scope
      state.scope = undefined
      if (state.denyOpsShell) { state.denyOpsShell(); state.denyOpsShell = undefined }
      void Promise.resolve(withdrawn.dispose()).catch((error) => log(`own bash withdrawal failed: ${error?.message ?? error}`))
      log('own bash tool withdrawn for this agent (the tool face carries no pwsh: a preset mask owns the tool set)')
    }
    // Eager native slot: create it while the agent is still settling, so the
    // tool exists before step 1 assembles its face. Once created it is kept
    // stable for the agent's lifetime; a face that no longer needs our bash
    // withdraws it.
    const nativeWanted = state.toolFace?.experimental !== false && (needs.needsBash || state.scope !== undefined || state.pending !== undefined)
    if (!nativeWanted) disposeNativeSlot(state)
    else if (!state.native && !state.nativeFailed) ensureNativeSlot(agent, state)
    if (needs.needsBash && !state.scope) {
      startBash(agent, state)
    }
    // v0.41.0: keep the ops shell denial attached while our bash owns the
    // agent. The mask was undone above for observation; an agent that is
    // already owned (state.scope, including one still mounting - provideBash
    // claims the scope before its asynchronous stages) gets the denial
    // re-attached here, so a reconcile fired by a switch flip or a re-show
    // never leaves the pair visible.
    if (state.scope && !state.denyOpsShell) {
      const opsShell = names.filter((name) => OPS_SHELL_TOOLS.includes(name))
      if (opsShell.length > 0) {
        try {
          const deny = agent.ctx?.tools?.restrict?.({ deny: [...opsShell] })
          if (typeof deny === 'function') {
            state.denyOpsShell = deny
            log('ops shell tools denied for this agent (' + opsShell.join(', ') + ')')
          }
        } catch (error) {
          log('ops shell denial failed (their shell tools stay available): ' + (error?.message ?? error))
        }
      }
    }
    // The own bash mount is ASYNCHRONOUS (private executor import, class-plugin
    // mount in the agent scope, registry read-back). Hand the in-flight task
    // back so the SERIAL `agent/created` emission can WAIT for it: the global
    // PTC executor resolves its SDK right after creation, and a listener that
    // returned nothing let that first admission see a face without bash (step
    // 1 missing, step 2 present). When a scope is already owned (or no bash is
    // wanted) there is nothing to wait for.
    return followRetry(state, interrupted, state.pending)
  }

  const teardown = async (agent) => {
    const state = tracked.get(agent)
    if (!state) return
    tracked.delete(agent)
    cancelRetry(state)
    state.controller.abort(new Error('inline bash agent disposed'))
    disposeNativeSlot(state)
    if (state.denyPwsh) { state.denyPwsh(); state.denyPwsh = undefined }
    if (state.denyOpsShell) { state.denyOpsShell(); state.denyOpsShell = undefined }
    await Promise.all([state.scope?.dispose(), state.pending])
  }

  // Register ownership before the sweep starts asynchronous work. A cancelled
  // loader continuation and every per-agent mount must settle before disposal.
  ctx.effect(() => async () => {
    closed = true
    const mounting = bashOnce
    controller.abort(new Error('inline bash plugin disposed'))
    await Promise.all([
      ...[...tracked.keys()].map(teardown),
      ...pending,
      mounting?.then(({ executorScope }) => executorScope.dispose(), () => {}),
    ])
    tracked.clear()
    bashOnce = undefined
  }, 'dsh-gitbash-shell: inline tool patching')

  try {
    // RETURN the reconcile promise. DSH announces a new agent through the
    // SERIAL `agent/created` event (`@deepseek-ai/dsh-agent` announce() awaits
    // `ctx.serial(carrier, 'agent/created', …)`), so the returned promise makes
    // `agents.create()` wait for this agent's own bash registration. Without
    // it the global PTC executor resolved its SDK on a face that did not carry
    // bash yet (step 1 missing, step 2 present).
    ctx.on('agent/created', ({ agent } = {}) => {
      try {
        const pending = reconcile(agent)
        // Wait for the registration, but never turn a registration failure
        // into a failed `agents.create()`: provideBash already logs its own
        // failures, and the host's serial emission rejects the whole
        // announcement when a listener rejects.
        return pending && typeof pending.then === 'function' ? pending.catch(() => {}) : pending
      } catch { /* never break agent creation */ }
    })
    ctx.on('agent/disposed', ({ agent } = {}) => teardown(agent).catch((error) => {
      log(`agent bash tool cleanup failed: ${error?.message ?? error}`)
    }))
    // A tool-face switch edit arrives as a volatile update on the LIVE row.
    // Re-reconciling every tracked agent from here reshaped faces that were
    // already in use (it could withdraw the own bash tool). Keep the face an
    // agent was created with and say what applies a new one.
    ctx.on('loader/volatile-update', (paths) => {
      if (!Array.isArray(paths)) return
      const flipped = paths
        .filter((path) => Array.isArray(path) && ['pwshTool', 'experimentalNative'].includes(path[0]))
        .map((path) => path[0])
      if (flipped.length === 0) return
      log(`tool-face switch changed (${flipped.join(', ')}): running agents keep their tool face; a new session or a DSH restart applies the new value`)
    })
    // MOUNT-TIME SWEEP (v0.35.2): agents that already exist when this row
    // mounts never fire agent/created. Same shape the proven dsh-ops denial
    // uses.
    for (const agent of agents?.(ctx)?.list?.() ?? []) {
      try { reconcile(agent) } catch { /* one broken agent never blocks the rest */ }
    }
    // CALL-LAYER GUARD (v0.35.2, second independent layer; route B wording):
    // while the row switch hides the real pwsh tool, a `pwsh` call that slips
    // past a visibility race is denied with the switch named. With the switch
    // ON the REAL tool answers for itself.
    ctx.on('tools/pre-execute', (exec, next) => {
      try {
        // THE FACE CAN SETTLE AFTER `agent/created` (Unreleased). Preset rows
        // and plugin tools keep registering while the Loader walks the tree,
        // so on a slow boot the bounded retry above can burn through its five
        // 250ms attempts on an empty face and be FINAL: the agent then never
        // gets its bash and keeps a visible (but denied) pwsh. The first tool
        // call is the first moment the face is guaranteed to be settled, so
        // re-run the decision there while this agent still owns no bash scope.
        // Idempotent: once the scope exists this branch never fires again.
        const lazyAgent = exec?.agent
        const lazyState = lazyAgent ? tracked.get(lazyAgent) : undefined
        if (lazyState && !lazyState.scope && !lazyState.pending) {
          try { reconcile(lazyAgent) } catch (error) { log(`lazy re-reconcile failed: ${error?.message ?? error}`) }
        }
        // Judge the call by the face this agent was created with, never by the
        // live switch.
        const livePwshOff = deps.pwshEnabled?.() !== true
        const frozenFace = exec?.agent ? tracked.get(exec.agent)?.toolFace : undefined
        const pwshOff = frozenFace === undefined ? livePwshOff : frozenFace.pwshVisible !== true
        if (exec?.name === 'pwsh' && !opsSeen && pwshOff) {
          return { kind: 'deny', reason: hiddenPwshDenyReason() }
        }
        // v0.41.0, second independent layer for the ops shell pair: while our
        // bash owns this agent, a call that slips past the visibility
        // restriction is denied by name - same reasoning as the pwsh guard
        // above.
        if (OPS_SHELL_TOOLS.includes(exec?.name) && tracked.get(exec?.agent)?.scope) {
          return { kind: 'deny', reason: deniedOpsShellReason() }
        }
      } catch { /* never block the waterfall */ }
      return next()
    })
  } catch (error) {
    log(`agent lifecycle wiring failed: ${error?.message ?? error}`)
    return
  }

}

// The host-package resolution channel lives in bash-tool.js; import it for
// local use AND re-export it so the host half (and the tests) see ONE
// implementation.
import { resolveHostModule } from './bash-tool.js'
export { resolveHostModule }
