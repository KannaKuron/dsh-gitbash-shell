/**
 * dsh-gitbash-shell/inline-tools — runtime shell-tool patching for the OFFICIAL
 * presets on Windows (v0.35.0).
 *
 * WHY THIS EXISTS. The official preset rows compose their tool set at boot
 * (`tool-bash` disabled on win32, `tool-pwsh` enabled), and the patch layer
 * CANNOT reach them: `applyEntryPatches`' id map only descends into rows that
 * carry `group: true` (vendor/include/src/index.ts buildMap), while a preset
 * declaration is a plain row whose `config.plugins` is opaque data. Rewriting
 * the declaration's whole `config` would freeze the official row list at our
 * restatement instant — every future official row addition would be invisible
 * until we hand-synced. So the fix runs at the tool layer instead, where the
 * official contract explicitly invites per-agent variants:
 *
 *   - the tools registry REJECTS same-scope duplicate names but points at this
 *     exact path for variants ("for a per-agent variant, register through that
 *     agent's `agent.ctx` instead", packages/core/tools/src/index.ts);
 *   - `agent/created` fires once per agent with the composed tool face
 *     reachable through `ctx.get('tools').schemas(agent)`.
 *
 * One reconcile per agent reads the face and acts on three facts:
 *
 *   1. `pwsh` present + `bash` absent  -> activate the OFFICIAL
 *      @deepseek-ai/dsh-tool-bash module inside an agent-owned scope (full
 *      official behaviour: jobs, approval escalation, rendering — zero
 *      behaviour is re-implemented here) and deny the fake `pwsh` (its
 *      executor is ctx.shell, which on this host IS Git Bash — a pwsh tool
 *      that runs bash is a lie to the model);
 *   2. `ops_*` tools present (dsh-ops installed) -> our FastCtx bridge and
 *      gitbash_pwsh stand down; the official bash activation still runs, the
 *      two command surfaces are complements, not duplicates;
 *   3. `bash` already present (variant presets on, or a future official
 *      change) -> touch nothing, so the variantPresets switch and this path
 *      are mutually exclusive BY OBSERVATION, with no explicit lock.
 *
 * Everything here is Windows-only by caller gate; on other hosts the module
 * loads but mounts nothing.
 */

/**
 * The tool-result contract the HOST registry requires from every registered
 * tool (issue #18, root cause 2): `register()` throws
 * `must declare output { schema, render, presentationMeta? }` unless the
 * definition carries an `output` whose `schema` passes
 * `assertSupportedJsonSchema` and whose `render` is a function. Both of this
 * plugin's tool families return `{ content: [{ type: 'text', text }] }` from
 * `execute`, so the schema and the text renderer below are shared verbatim
 * with the FastCtx bridge — the same frozen shape dsh-ops ships for its own
 * MCP-backed tools (proven on real Windows hosts).
 */
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
 * @param {unknown} value - the execute return value.
 * @returns {Array<{ type: string, text: string }>} content blocks for the host renderer.
 */
export function renderTextContent(value) {
  const blocks = Array.isArray(value?.content) ? value.content : []
  const text = blocks
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .filter((line) => line !== '')
    .join('\n')
  return [{ type: 'text', text }]
}

/** Answer for one observed tool face. Pure. */
export function inlineNeeds(names) {
  const set = new Set(Array.isArray(names) ? names : [])
  const has = (name) => set.has(name)
  return {
    // A pwsh tool without a bash tool is the official win32 composition on
    // this host: bash must be patched in, and the pwsh tool would execute
    // Git Bash through ctx.shell (a lying name) — deny it.
    needsBash: has('pwsh') && !has('bash'),
    denyPwsh: has('pwsh') && !has('bash'),
    // dsh-ops publishes file/search tools under the ops_ prefix. When they are
    // here, our FastCtx bridge and pwsh replacement would be duplicates.
    opsPresent: has('ops_inspect_local_file') || has('ops_grep') || has('ops_bash'),
  }
}

/**
 * The routing addendum appended to the `bash` tool's description through the
 * system-prompt assemble waterfall. ALWAYS applied — it states shell routing,
 * which holds regardless of the path dialect a delegate sees.
 */
export const GITBASH_ROUTE_ADDENDUM = [
  'Prefer this bash tool for ALL commands; use a PowerShell tool ONLY when a Windows-native capability (cmdlets, registry, services, WMI) is truly required.',
  'Fix failed bash commands in bash — never switch shells mid-task, never embed `pwsh -Command` inside a bash command (variable expansion and output encoding break there).',
].join('\n')

/**
 * The dialect addendum (MSYS facts) — appended ONLY while this plugin's path
 * dialect is on for the assembling agent, because it describes the /c/ world
 * the dialect creates.
 */
export const GITBASH_MSYS_ADDENDUM = 'This bash is Git for Windows (MSYS): paths use drive roots (/c/Users/...), and ~, /tmp, /dev/null and /usr/... resolve exactly as Git Bash resolves them.'

/** @deprecated composed form kept for tests: route + MSYS sentences. */
export const GITBASH_BASH_ADDENDUM = GITBASH_ROUTE_ADDENDUM + '\n' + GITBASH_MSYS_ADDENDUM

/** The pwsh-replacement tool's model-facing description. */
export function gitbashPwshDescription() {
  return 'Run a command in Windows PowerShell 7 (pwsh). Use ONLY when a Windows-native capability '
    + '(cmdlets, registry, services, WMI, scheduled tasks) is required — for everything else prefer the bash tool. '
    + 'Each call uses a fresh shell; set workdir explicitly. Paths inside command must be Windows form (C:/... or C:\\\\...). '
    + 'For scripts longer than about 1 KB, or containing quotes/backslashes/non-ASCII text, write the script to a file first '
    + 'and pass script_path instead. Output is UTF-8; long output is truncated with the full text saved to a reported file. '
    + 'Fix failed pwsh commands here; do not switch shells or mix PowerShell syntax into bash commands.'
}

/**
 * Resolve the host's own PowerShell 7 — never a bundled payload, never
 * Windows PowerShell 5.1. Mirrors the probe order the official pwsh resolver
 * documents (well-known install locations, then PATH), WITHOUT its 5.1
 * fallback: if no pwsh 7 exists the caller simply does not publish the tool.
 * Pure I/O via the injected `exists` so the candidate matrix is testable.
 * @returns {string} an absolute pwsh.exe path, or '' when absent.
 */
export function resolveHostPwsh7({ env = process.env, exists, platform = process.platform } = {}) {
  if (platform !== 'win32') return ''
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = env.LOCALAPPDATA ?? env.LocalAppData ?? ''
  const userProfile = env.USERPROFILE ?? ''
  const candidates = [
    `${programFiles}\\PowerShell\\7\\pwsh.exe`,
    `${programFiles}\\PowerShell\\7-preview\\pwsh.exe`,
    `${programFilesX86}\\PowerShell\\7\\pwsh.exe`,
    localAppData === '' ? '' : `${localAppData}\\Microsoft\\WindowsApps\\pwsh.exe`,
    userProfile === '' ? '' : `${userProfile}\\scoop\\shims\\pwsh.exe`,
    'C:\\ProgramData\\chocolatey\\bin\\pwsh.exe',
  ].filter((entry) => entry !== '')
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  // PATH last: a PATH hit may be a store alias or shim, so it ranks below the
  // well-known installs but still beats "no tool at all".
  const pathValue = env.PATH ?? env.Path ?? ''
  for (const dir of pathValue.split(';')) {
    const clean = dir.trim().replace(/^"(.*)"$/, '$1')
    if (clean === '') continue
    const candidate = `${clean.replace(/[\\/]+$/, '')}\\pwsh.exe`
    if (exists(candidate)) return candidate
  }
  return ''
}

/** Arguments `gitbash_pwsh` accepts — strict: anything else is rejected. */
export const PWSH_ARGUMENTS = Object.freeze(['command', 'script_path', 'workdir', 'timeoutMs'])

const PWSH_DEFAULT_TIMEOUT_MS = 120_000
const PWSH_MAX_TIMEOUT_MS = 600_000

/**
 * Build the argv for one pwsh invocation. `command` and `script_path` are
 * exclusive; a script path keeps the script's bytes OUT of the tool-call JSON
 * entirely (the whole point of the dsh-ops issue #7 lesson: long heredoc-heavy
 * commands inside one JSON string raise the malformed-tool-call rate and burn
 * a whole model turn). Pure.
 */
export function pwshArgv(pwsh, args, { msysToWin } = {}) {
  const hasCommand = typeof args.command === 'string' && args.command.trim() !== ''
  const hasScript = typeof args.script_path === 'string' && args.script_path.trim() !== ''
  if (hasCommand === hasScript) return { error: 'provide exactly one of command or script_path' }
  if (hasScript) {
    const raw = /** @type {string} */ (args.script_path)
    // The model speaks MSYS (our prompt dialect); pwsh needs a Windows path.
    const script = msysToWin ? msysToWin(raw) : raw
    return { argv: [pwsh, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', script] }
  }
  return { argv: [pwsh, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', /** @type {string} */ (args.command)] }
}

/**
 * Validate one gitbash_pwsh call's arguments. Strict like ops_bash: an
 * undeclared key is a hard error (the host bash/pwsh tools accept
 * `run_in_background`; this tool does not, and a silent ignore would leave a
 * server occupying the call until timeout). Pure.
 * @returns {string|undefined} an error message, or undefined when valid.
 */
export function validatePwshArgs(args) {
  if (args === undefined || args === null || typeof args !== 'object' || Array.isArray(args)) {
    return 'invalid arguments: expected an object'
  }
  const unknown = Object.keys(args).filter((key) => !PWSH_ARGUMENTS.includes(key))
  if (unknown.length > 0) {
    return `invalid arguments: unknown key(s) ${unknown.map((key) => JSON.stringify(key)).join(', ')}; this tool accepts ${PWSH_ARGUMENTS.join(', ')}`
  }
  const hasCommand = typeof args.command === 'string' && args.command.trim() !== ''
  const hasScript = typeof args.script_path === 'string' && args.script_path.trim() !== ''
  if (hasCommand === hasScript) return 'invalid pwsh input: provide exactly one of command or script_path'
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    return 'invalid timeoutMs: expected a positive number'
  }
  if (args.timeoutMs !== undefined && /** @type {number} */ (args.timeoutMs) > PWSH_MAX_TIMEOUT_MS) {
    return `invalid timeoutMs: must be no greater than ${PWSH_MAX_TIMEOUT_MS}`
  }
  return undefined
}

/**
 * Resolve the OFFICIAL @deepseek-ai/dsh-tool-bash module entry from the
 * host's own resolution base (the same seam probeHostExtras uses). Returns
 * the absolute entry URL, or '' when the host does not ship the package.
 */
export async function resolveToolBashEntry(ctx) {
  try {
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const req = createRequire(ctx?.baseUrl ?? import.meta.url)
    return pathToFileURL(req.resolve('@deepseek-ai/dsh-tool-bash')).href
  } catch {
    return ''
  }
}

/**
 * Activate the OFFICIAL tool-bash inside one agent-owned scope: a child scope
 * of the agent's context keeps every registration (tool, prompt section,
 * effect) revertible at agent disposal, and the scoped-layer tool shadows the
 * (absent) global one exactly the way the registry's own error message
 * prescribes for per-agent variants. The official module is loaded ONCE per
 * process; each agent gets a fresh scope and a fresh apply().
 */
export async function activateOfficialBash(agent, toolBashHref, createScopeFn, log) {
  let mod
  try {
    mod = await import(toolBashHref)
  } catch (error) {
    log(`official tool-bash module import failed: ${error?.message ?? error}`)
    return undefined
  }
  if (!mod || typeof mod.apply !== 'function') {
    log('official tool-bash module has no apply(); activation skipped')
    return undefined
  }
  const scope = createScopeFn(agent.ctx)
  try {
    await mod.apply(scope.ctx, {})
    return scope
  } catch (error) {
    try { await scope.dispose() } catch { /* best effort */ }
    log(`official tool-bash activation failed: ${error?.message ?? error}`)
    return undefined
  }
}

/**
 * Mount the per-agent reconcile. `deps`:
 *   - tools(ctx)       -> the host tool registry (or undefined)
 *   - agents(ctx)      -> the host agents service (or undefined)
 *   - createScope(fn)  -> cordis createScope
 *   - allowed(session) -> danger-full-access verdict for the pwsh channel
 *   - echo(text)       -> result dialect echo (Windows -> MSYS), or undefined
 *   - spawn(spec)      -> the host subprocess seam, or undefined
 *   - pwshPath         -> resolved host pwsh 7, or '' (tool not published)
 *   - pwshEnabled()    -> the row switch for publishing the pwsh tool
 *   - log(message)     -> the plugin's tagged logger
 *
 * Registration decisions re-run on EVERY agent creation AND once at mount
 * time for every ALREADY-LIVE agent (the dsh-ops-proven shape,
 * `installHostShellDenial`): this row can activate long after agents exist —
 * a plugin hot-reload, or a host whose sessions resumed before this bundle
 * row finished mounting — and an agent/created-only listener leaves every
 * such agent with the fake pwsh and no bash, which is exactly the Windows
 * field report behind this block. A second, INDEPENDENT layer guards the
 * call itself through `tools/pre-execute`: visibility restriction can lose a
 * race, and a lying pwsh that reaches its executor still runs Git Bash.
 */
export function mountInlineTools(ctx, deps) {
  const { tools, agents, createScope, allowed, spawn, pwshPath, echo, log } = deps
  /** agent -> { timer, scope, denyPwsh }; named `tracked` because `agents` above is the host service */
  const tracked = new Map()
  let pwshPublished = false
  let pwshDisposer = undefined
  let toolBashHrefPromise

  const faceNames = (agent) => {
    try {
      const registry = tools(ctx)
      return (registry?.schemas?.(agent) ?? []).map((schema) => schema.name).filter((name) => typeof name === 'string')
    } catch {
      return []
    }
  }

  const unpublishPwsh = () => {
    if (pwshDisposer) {
      try { pwshDisposer() } catch { /* already gone */ }
      pwshDisposer = undefined
    }
    pwshPublished = false
  }

  const publishPwsh = () => {
    if (pwshPublished) return
    if (typeof spawn !== 'function' || !pwshPath) return
    if (deps.pwshEnabled && deps.pwshEnabled() !== true) return
    const registry = tools(ctx)
    if (!registry || typeof registry.register !== 'function') return
    try {
      const disposer = registry.register(gitbashPwshDefinition({ pwsh: pwshPath, spawn, allowed, msysToWin: deps.msysToWin, echo }))
      pwshDisposer = typeof disposer === 'function' ? disposer : undefined
      pwshPublished = true
      log(`pwsh replacement published (pwsh 7 at ${pwshPath}; the host pwsh tool is denied on this host — its executor is Git Bash)`)
    } catch (error) {
      log(`pwsh replacement registration failed: ${error?.message ?? error}`)
    }
  }

  const reconcile = (agent, { attempt = 0 } = {}) => {
    if (!agent?.ctx) return
    const names = faceNames(agent)
    // The composed face may not be wired yet at created-time. Retry bounded:
    // a face with NEITHER tool carries no verdict, and guessing would deny a
    // real pwsh or duplicate a real bash. Five tries at 250ms, then give up
    // quietly — a slower composition simply gets no inline patch this boot.
    if (attempt < 5 && !names.includes('bash') && !names.includes('pwsh')) {
      const timer = setTimeout(() => { try { reconcile(agent, { attempt: attempt + 1 }) } catch { /* never crash on a timer */ } }, 250)
      timer.unref?.()
      const state = tracked.get(agent)
      if (state) state.timer = timer
      else tracked.set(agent, { timer, scope: undefined, denyPwsh: undefined })
      return
    }
    const needs = inlineNeeds(names)
    let state = tracked.get(agent)
    if (state?.timer) { clearTimeout(state.timer); state.timer = undefined }
    if (!state) {
      state = { timer: undefined, scope: undefined, denyPwsh: undefined }
      tracked.set(agent, state)
    }
    if (needs.denyPwsh && !state.denyPwsh) {
      // Deny the fake pwsh first: restrict is per-agent and idempotent, and
      // the lying tool must never be callable, not even for the milliseconds
      // before the bash tool lands. The call MUST go through the AGENT's
      // scoped context (`agent.ctx.tools`, the dsh-ops-proven shape): on the
      // ROOT context the host throws "requires a scoped context" and the
      // deny silently never exists (issue #18, root cause 3).
      try {
        const deny = agent.ctx?.tools?.restrict?.({ deny: ['pwsh'] })
        if (typeof deny === 'function') state.denyPwsh = deny
      } catch (error) {
        log(`fake-pwsh deny failed: ${error?.message ?? error}`)
      }
    }
    if (needs.needsBash && !state.scope) {
      if (toolBashHrefPromise === undefined) toolBashHrefPromise = resolveToolBashEntry(ctx)
      void toolBashHrefPromise.then(async (href) => {
        if (href === '') {
          log('official @deepseek-ai/dsh-tool-bash is not resolvable from the host base; bash stays absent for this agent')
          return
        }
        const scope = await activateOfficialBash(agent, href, createScope, log)
        if (scope && tracked.get(agent) === state) {
          state.scope = scope
          log('official bash tool activated for this agent (Git Bash host; fake pwsh denied)')
        }
      }).catch(() => { /* logged inside activateOfficialBash */ })
    }
    // The pwsh replacement follows the ops_ presence: dsh-ops already ships a
    // PowerShell story through the HOST pwsh tool — which our own deny would
    // otherwise silence — so ours fills that gap instead of duplicating tools.
    // The row switch is re-read per reconcile too, so a flip lands at the
    // next agent (or on the next event after a hot toggle).
    if (needs.opsPresent || (deps.pwshEnabled && deps.pwshEnabled() !== true)) unpublishPwsh()
    else publishPwsh()
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
    // MOUNT-TIME SWEEP (v0.35.2, the Windows field report): agents that
    // already exist when this row mounts never fire agent/created — a plugin
    // hot-reload or a host that resumed sessions before this bundle row
    // finished mounting would otherwise keep the fake pwsh and no bash on
    // every live agent. Same shape the proven dsh-ops denial uses.
    for (const agent of agents?.(ctx)?.list?.() ?? []) {
      try { reconcile(agent) } catch { /* one broken agent never blocks the rest */ }
    }
    // CALL-LAYER GUARD (v0.35.2, second independent layer): even when the
    // per-agent visibility restriction loses a race, a `pwsh` call that
    // reaches its executor runs Git Bash (ctx.shell IS Git Bash on this
    // host). Deny at dispatch and name the replacements.
    ctx.on('tools/pre-execute', (exec, next) => {
      try {
        if (exec?.name === 'pwsh') {
          return { kind: 'deny', reason: 'the host pwsh tool would run Git Bash on this host (its executor was replaced). Use the bash tool for commands, or gitbash_pwsh for Windows-native work (registry, services, WMI).' }
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
    unpublishPwsh()
  }, 'dsh-gitbash-shell: inline tool patching')
}

/**
 * The pwsh-replacement tool definition, bound to a resolved pwsh 7.
 *
 * It spawns through the HOST's `ctx.subprocess` service (credential scrub +
 * process governance + output spill are the service's own guarantees; the
 * bash executors consume the same seam). There is deliberately NO file
 * sandbox on this channel — the tool is published only to danger-full-access
 * sessions and says so in the error it raises elsewhere.
 * @param {object} options
 * @param {string} options.pwsh - resolved pwsh.exe path.
 * @param {(spec: object) => { done: Promise<object>, collected?: object }} options.spawn - the host subprocess seam.
 * @param {(session: object|undefined) => boolean} options.allowed - per-session permission verdict.
 * @param {(path: string) => string} [options.msysToWin] - argument dialect translation (MSYS -> Windows), the same mount table the file tools use.
 * @param {(text: string) => string} [options.echo] - result dialect echo (Windows -> MSYS), gated by the caller.
 */
export function gitbashPwshDefinition({ pwsh, spawn, allowed, msysToWin, echo }) {
  return {
    name: 'gitbash_pwsh',
    description: gitbashPwshDescription(),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Short PowerShell command; for long or multi-line scripts use script_path.' },
        script_path: { type: 'string', description: 'Existing script path; use instead of command for long or multi-line scripts.' },
        workdir: { type: 'string', description: 'Working directory; defaults to the session workspace when omitted.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds; the command is killed on expiry. Defaults to 120000.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => renderTextContent(value),
    },
    async execute(args, exec) {
      const invalid = validatePwshArgs(args)
      if (invalid) throw new Error(invalid)
      if (!allowed(exec?.agent?.session)) {
        throw new Error('gitbash_pwsh requires danger-full-access for this session; this channel has no file sandbox.')
      }
      const built = pwshArgv(pwsh, args, { msysToWin })
      if (built.error) throw new Error(built.error)
      const timeoutMs = args.timeoutMs === undefined ? PWSH_DEFAULT_TIMEOUT_MS : args.timeoutMs
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error(`command timed out after ${timeoutMs}ms`)), timeoutMs)
      timer.unref?.()
      try {
        const handle = spawn({
          argv: built.argv,
          cwd: typeof args.workdir === 'string' && args.workdir !== '' ? args.workdir : undefined,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 64_000, spill: { maxBytes: 64 * 1024 * 1024 } },
            stderr: { maxBytes: 64_000, spill: { maxBytes: 64 * 1024 * 1024 } },
          },
          signal: controller.signal,
        })
        const outcome = await handle.done
        const streamText = (reader) => {
          if (reader === undefined || typeof reader.readFrom !== 'function') return ''
          const read = reader.readFrom(0)
          const text = read.text ?? ''
          return echo ? echo(text) : text
        }
        const stdout = streamText(handle.collected?.stdout)
        const stderr = streamText(handle.collected?.stderr)
        let body = stdout
        if (stderr !== '') body += (body !== '' && !body.endsWith('\n') ? '\n' : '') + '[stderr]\n' + stderr
        if (body === '') body = '(no output)'
        const markers = []
        if (outcome?.signal !== undefined && outcome?.signal !== null) markers.push(`[signal: ${outcome.signal}]`)
        if (outcome?.exitCode !== undefined && outcome?.exitCode !== null && outcome.exitCode !== 0) markers.push(`[exit code: ${outcome.exitCode}]`)
        return { content: [{ type: 'text', text: [body, ...markers].join('\n') }] }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
