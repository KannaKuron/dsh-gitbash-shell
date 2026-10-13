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
 *      in a private cordis scope, never registered as a service), and mirrors
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
  'Prefer this bash tool for ALL commands; use the pwsh tool ONLY when a Windows-native capability (cmdlets, registry, services, WMI) is truly required.',
  'Fix failed bash commands in bash — never switch shells mid-task, never embed `pwsh -Command` inside a bash command (variable expansion and output encoding break there).',
].join('\n')

/** The bash-only routing variant, used while the pwsh switch is off (the default). */
export const GITBASH_ROUTE_ADDENDUM_NO_PWSH = [
  'Prefer this bash tool for ALL commands — it is this host\'s shell.',
  'Fix failed commands in bash; there is no PowerShell tool on this host.',
].join('\n')

/**
 * The dialect addendum (MSYS facts) — appended ONLY while this plugin's path
 * dialect is on for the assembling agent, because it describes the /c/ world
 * the dialect creates.
 */
export const GITBASH_MSYS_ADDENDUM = 'This bash is Git for Windows (MSYS): paths use drive roots (/c/Users/...), and ~, /tmp, /dev/null and /usr/... resolve exactly as Git Bash resolves them.'

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
  /** agent -> { timer, scope, denyPwsh }; named `tracked` because `agents` above is the host service */
  const tracked = new Map()
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
   * by the effect registered at the bottom of this function.
   */
  const bashOncePromise = async () => {
    if (bashOnce) return bashOnce
    bashOnce = (async () => {
      const { GitBashSandboxExecutor } = await import('./shell.js')
      if (!GitBashSandboxExecutor) throw new Error('executor class unavailable')
      if (!GitBashSandboxExecutor.Config) {
        throw new Error('executor Config unavailable (schemastery unresolved; see the schemastery log lines above)')
      }
      if (typeof createScope !== 'function') throw new Error('no createScope seam')
      const executorScope = createScope(ctx)
      if (executorScope.fiber) { try { await executorScope.fiber } catch { /* disposed */ } }
      const mountTimeout = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('executor scope mount timed out (a required service may be absent in this composition)')), 8000)
        timer.unref?.()
      })
      const fiber = executorScope.ctx.plugin(GitBashSandboxExecutor)
      const executor = await Promise.race([
        (async () => { await fiber; return executorScope.ctx.shell })(),
        mountTimeout,
      ])
      if (!executor || typeof executor.resolve !== 'function' || typeof executor.execute !== 'function') {
        throw new Error('executor instance did not expose resolve()/execute()')
      }
      const hostModules = {}
      for (const [key, name] of HOST_MODULES) {
        try {
          hostModules[key] = await resolveHostModule(ctx, name)
        } catch { hostModules[key] = undefined }
      }
      const { createBashToolModule } = await import('./bash-tool.js')
      const module = createBashToolModule({ executor, log, ...hostModules })
      return { executor, executorScope, module }
    })()
    bashOnce.catch(() => { bashOnce = undefined })
    return bashOnce
  }

  /** Register the own bash tool inside one agent-owned scope. */
  const provideBash = async (agent, state) => {
    if (state.scope) return
    try {
      const { executor, module } = await bashOncePromise()
      log(`own bash tool ready (private Git Bash executor at ${executor.bashPath || '(unresolved)'}; official pwsh executor untouched)`)
      const scope = createScope(agent.ctx)
      // Same asynchronous-fiber shape the official module needed: wait for
      // the apply callback to capture scope.ctx before touching its tools.
      if (scope.fiber) { try { await scope.fiber } catch { /* disposed */ } }
      const registry = scope.ctx?.tools
      if (!registry || typeof scope.ctx.plugin !== 'function') {
        void scope.dispose().catch(() => {})
        return
      }
      const fiber = scope.ctx.plugin(module)
      await fiber
      state.scope = scope
      log('own bash tool activated for this agent (Git Bash execution; official pwsh tool real but hidden by default)')
    } catch (error) {
      log(`own bash tool activation failed for this agent: ${error?.message ?? error}`)
    }
  }

  const reconcile = (agent, { attempt = 0 } = {}) => {
    if (!agent?.ctx) return
    const names = faceNames(agent)
    // The composed face may not be wired yet at created-time. Retry bounded:
    // a face with NEITHER tool carries no verdict. Five tries at 250ms, then
    // give up quietly — a slower composition simply gets no inline patch.
    if (attempt < 5 && !names.includes('bash') && !names.includes('pwsh')) {
      const timer = setTimeout(() => { try { reconcile(agent, { attempt: attempt + 1 }) } catch { /* never crash on a timer */ } }, 250)
      timer.unref?.()
      const state = tracked.get(agent)
      if (state) state.timer = timer
      else tracked.set(agent, { timer, scope: undefined, denyPwsh: undefined })
      return
    }
    const pwshVisible = deps.pwshEnabled?.() === true
    const needs = inlineNeeds(names, { pwshVisible })
    if (needs.opsPresent) opsSeen = true
    let state = tracked.get(agent)
    if (state?.timer) { clearTimeout(state.timer); state.timer = undefined }
    if (!state) {
      state = { timer: undefined, scope: undefined, denyPwsh: undefined }
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
      void provideBash(agent, state)
    }
  }

  const teardown = (agent) => {
    const state = tracked.get(agent)
    if (!state) return
    tracked.delete(agent)
    if (state.timer) clearTimeout(state.timer)
    if (state.denyPwsh) { try { state.denyPwsh() } catch { /* already lifted */ } }
    if (state.scope) { void state.scope.dispose().catch(() => {}) }
  }

  try {
    ctx.on('agent/created', ({ agent } = {}) => { try { reconcile(agent) } catch { /* never break agent creation */ } })
    ctx.on('agent/disposed', ({ agent } = {}) => { try { teardown(agent) } catch { /* never break disposal */ } })
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

  ctx.effect(() => () => {
    for (const agent of [...tracked.keys()]) teardown(agent)
    tracked.clear()
    if (bashOnce) {
      void Promise.resolve(bashOnce).then(({ executorScope } = {}) => {
        try { executorScope?.dispose?.() } catch { /* already gone */ }
      }).catch(() => {})
      bashOnce = undefined
    }
  }, 'dsh-gitbash-shell: inline tool patching')
}

// The host-package resolution channel lives in bash-tool.js; import it for
// local use AND re-export it so the host half (and the tests) see ONE
// implementation.
import { resolveHostModule } from './bash-tool.js'
export { resolveHostModule }
