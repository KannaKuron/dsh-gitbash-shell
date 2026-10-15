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
 * The routing addendum appended to the `bash` tool's description through the
 * system-prompt assemble waterfall. TWO variants (v0.37.0, user decision):
 * the pwsh tool is hidden by default, and a routing sentence that names a tool
 * the agent cannot see only teaches the model to call a hidden name. The ON
 * variant names `pwsh` (the REAL PowerShell tool, real again since route B —
 * the official executor stays in place); the OFF variant states bash-only
 * routing. Both hold regardless of the path dialect a delegate sees.
 */
export const GITBASH_ROUTE_ADDENDUM = [
  'Prefer this bash tool for shell syntax, scripts, pipelines, redirection, globbing and POSIX utilities; use the pwsh tool ONLY when PowerShell cmdlets, registry, services or WMI are truly required.',
  'Fix failed bash syntax in bash; never embed `pwsh -Command` inside a bash command as a workaround (variable expansion and output encoding break there). Choose a separately offered native route for its documented purpose before execution, never as a policy-denial retry.',
].join('\n')

/** The bash-only routing variant, used while the pwsh switch is off (the default). */
export const GITBASH_ROUTE_ADDENDUM_NO_PWSH = [
  'Prefer this bash tool for shell syntax, scripts, pipelines, redirection, globbing and POSIX utilities — it is this host\'s shell.',
  'Fix failed bash syntax in bash; no PowerShell tool is offered here. Do not invent a hidden tool or embed another interpreter as a workaround.',
].join('\n')

/**
 * The dialect addendum (MSYS facts) — appended ONLY while this plugin's path
 * dialect is on for the assembling agent, because it describes the /c/ world
 * the dialect creates.
 */
export const GITBASH_MSYS_ADDENDUM = 'This bash is Git for Windows (MSYS): paths use drive roots (/c/Users/...), and ~, /tmp, /dev/null and /usr/... resolve exactly as Git Bash resolves them.'

const ROUTING_START = '\n[gitbash tool routing]\n'
const ROUTING_END = '\n[/gitbash tool routing]'
const ROUTING_SAFETY = 'Choose the execution route before running. A policy/access denial is a stop condition: never switch tools, shells or permissions to bypass it. A decoding/display failure does not mean the command failed to run; preserve its exit facts and never blindly repeat a side-effecting command. Do not guess unknown or mixed encodings.'
const PTC_ROUTING = 'Inside run_code, call only bindings actually offered by the current SDK with await tools.<name>(...). Select by their descriptions: shell execution for shell syntax/pipelines; an offered typed native-executable binding for exact Windows argv or explicitly known per-stream encodings; an offered complete-path conversion binding before passing an MSYS value to Node fs/path. These are different operations, not substitutes for permissions. Never pass routes, search text or source code to a path converter. Program strings do not perform shell expansion. If a needed binding is absent, report the missing capability; do not invent its name. ' + ROUTING_SAFETY

/** Model guidance names only tools in this assembly, not a switch's intent. */
export function toolRoutingHintFor(tools, { pwshVisible = false } = {}) {
  const names = new Set((Array.isArray(tools) ? tools : []).map(tool => tool?.name))
  if (!names.has('bash')) return ''
  const lines = [pwshVisible && names.has('pwsh') ? GITBASH_ROUTE_ADDENDUM : GITBASH_ROUTE_ADDENDUM_NO_PWSH]
  if (names.has('gitbash_native')) lines.push('Use gitbash_native before execution when a Windows .exe needs exact literal argv such as /all or /c without MSYS conversion, or independently declared stdout/stderr encodings. Supply an absolute executable, mark each argument literal or path, and select only a known encoding (raw for unknown/mixed bytes). It does not implement shell pipelines, expansion or .cmd/.bat wrappers; only resolved danger-full-access can execute it.')
  if (names.has('gitbash_to_native_path')) lines.push('Use gitbash_to_native_path only for a complete caller-declared MSYS filesystem path that a native Node fs/path API needs, especially a runtime-built value. Read native_path from the result. Never convert routes, search strings or shell/program source. Already-native or cwd-relative Node paths need no conversion; ordinary tool path fields already use their own translation. Conversion grants no access.')
  lines.push(ROUTING_SAFETY)
  return lines.join('\n')
}

/** Add a replaceable, idempotent block; a reused assembly follows visibility. */
export function applyToolRouting(tools, { pwshVisible = false, msys = false } = {}) {
  if (!Array.isArray(tools)) return
  for (const tool of tools) {
    if (!tool || typeof tool.description !== 'string' || !['bash', 'run_code'].includes(tool.name)) continue
    let description = tool.description
    const start = description.indexOf(ROUTING_START)
    const end = start < 0 ? -1 : description.indexOf(ROUTING_END, start)
    if (end >= 0) description = description.slice(0, start) + description.slice(end + ROUTING_END.length)
    const hint = tool.name === 'bash'
      ? toolRoutingHintFor(tools, { pwshVisible }) + (msys ? '\n' + GITBASH_MSYS_ADDENDUM : '')
      : PTC_ROUTING
    tool.description = description + ROUTING_START + hint + ROUTING_END
  }
}

/** @deprecated composed form kept for tests: route + MSYS sentences. */
export const GITBASH_BASH_ADDENDUM = GITBASH_ROUTE_ADDENDUM + '\n' + GITBASH_MSYS_ADDENDUM

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
  const newState = () => ({ timer: undefined, scope: undefined, denyPwsh: undefined, pending: undefined, controller: new AbortController() })
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
      const fiber = scope.ctx.plugin(module)
      await untilDisposed(fiber, state.controller.signal)
      if (!isLive(agent, state)) return
      // An INACTIVE fiber resolves its await() without ever running apply()
      // (issue #27): awaiting the plugin proves nothing, so read the registry
      // back before claiming success. A miss THROWS — the catch below logs the
      // explicit activation failure and the finally disposes this half-mounted
      // scope instead of leaking it for the agent's lifetime (shape credit:
      // KouzakiUmi's PR #28).
      const registeredNames = scope.ctx.get !== undefined
        ? ((scope.ctx.get('tools')?.schemas?.(agent) ?? []).map((schema) => schema && typeof schema.name === 'string' ? schema.name : ''))
        : []
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
        }
      }
      retained = true
      log('own bash tool activated for this agent (Git Bash execution; official pwsh tool real but hidden by default)')
    } catch (error) {
      if (isLive(agent, state)) log(`own bash tool activation failed for this agent: ${error?.message ?? error}`)
    } finally {
      if (scope && !retained) {
        if (state.scope === scope) state.scope = undefined
        await scope.dispose()
      }
    }
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
    if (previous?.timer) { clearTimeout(previous.timer); previous.timer = undefined }
    if (previous?.denyPwsh) { previous.denyPwsh(); previous.denyPwsh = undefined }
    const names = faceNames(agent)
    // The composed face may not be wired yet at created-time. Retry bounded:
    // a face with NEITHER tool carries no verdict. Five tries at 250ms, then
    // give up quietly — a slower composition simply gets no inline patch.
    if (attempt < 5 && !names.includes('bash') && !names.includes('pwsh')) {
      const timer = setTimeout(() => { try { reconcile(agent, { attempt: attempt + 1 }) } catch { /* never crash on a timer */ } }, 250)
      timer.unref?.()
      const state = tracked.get(agent)
      if (state) state.timer = timer
      else tracked.set(agent, { ...newState(), timer })
      return
    }
    const pwshVisible = deps.pwshEnabled?.() === true
    const needs = inlineNeeds(names, { pwshVisible })
    if (needs.opsPresent) opsSeen = true
    let state = tracked.get(agent)
    if (state?.timer) { clearTimeout(state.timer); state.timer = undefined }
    if (!state) {
      state = newState()
      tracked.set(agent, state)
    }
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
    if (needs.needsBash && !state.scope) {
      startBash(agent, state)
    }
  }

  const teardown = async (agent) => {
    const state = tracked.get(agent)
    if (!state) return
    tracked.delete(agent)
    state.controller.abort(new Error('inline bash agent disposed'))
    if (state.timer) clearTimeout(state.timer)
    if (state.denyPwsh) { state.denyPwsh(); state.denyPwsh = undefined }
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
    ctx.on('agent/created', ({ agent } = {}) => { try { reconcile(agent) } catch { /* never break agent creation */ } })
    ctx.on('agent/disposed', ({ agent } = {}) => teardown(agent).catch((error) => {
      log(`agent bash tool cleanup failed: ${error?.message ?? error}`)
    }))
    ctx.on('loader/volatile-update', (paths) => {
      if (!Array.isArray(paths) || !paths.some((path) => Array.isArray(path) && ['pwshTool', 'experimentalNative'].includes(path[0]))) return
      for (const agent of tracked.keys()) {
        try { reconcile(agent) } catch (error) { log(`pwsh switch update failed: ${error?.message ?? error}`) }
      }
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
        if (exec?.name === 'pwsh' && !opsSeen && deps.pwshEnabled?.() !== true) {
          return { kind: 'deny', reason: hiddenPwshDenyReason() }
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
