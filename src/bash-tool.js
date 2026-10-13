/**
 * dsh-gitbash-shell/bash-tool — the plugin's OWN bash tool (v0.39.0, route B).
 *
 * WHY AN OWN TOOL. Until v0.38.5 the plugin replaced the host `ctx.shell`
 * executor (patch: disable `pwsh-sandbox`, insert a Git Bash executor) and
 * mounted the OFFICIAL `@deepseek-ai/dsh-tool-bash` module per agent, so the
 * model's `bash` tool ran Git Bash through the replaced service. The DSH-Store
 * catalog gate forbids bundle patches that disable official components — and
 * honestly so: replacing the shell executor IS overriding an official
 * component. Route B keeps the official executor exactly where it is and
 * instead ships an OWN tool:
 *
 *   - the executor is a private `GitBashSandboxExecutor` instance constructed
 *     through cordis's own plugin path in a `shell`-isolated scope (never
 *     registered as the ROOT `ctx.shell`, which stays PowerShell); it inherits
 *     the shipped bash-sandbox semantics (deadline, output capture, argv
 *     execution) and points them at Git for Windows' bash.exe;
 *   - the tool definition mirrors `@deepseek-ai/dsh-tool-bash` call-for-call
 *     (schema, output union, background jobs, sandbox escalation, rendering)
 *     with exactly ONE substitution: `ctx.shell.resolve/execute` becomes
 *     `executor.resolve/execute`. The background surface, the promotion on
 *     timeout, the approval escalation and the exit-marker contract are the
 *     official ones, mirrored verbatim in this file and bash-render.js;
 *   - the official `pwsh` tool keeps working against the official executor —
 *     it is REAL PowerShell on this host again, so the fake-tool denial
 *     retires with the executor swap (the tool is merely HIDDEN by default,
 *     a pure product choice driven by the row switch).
 *
 * The module is mounted per agent through cordis's own plugin path
 * (`agent.ctx.plugin(mod)` — the inject declaration must ride the module
 * object, v0.38.4) inside an agent-owned scope, exactly like the official
 * module it replaces, so every registration reverts at agent disposal.
 *
 * Host-package dependencies (`@deepseek-ai/dsh-tools` for `defineTool`,
 * `@deepseek-ai/dsh-sandbox` for the escalation helpers) resolve through the
 * host's own loader channel; when absent the definition degrades to a plain
 * JSON-schema object and the escalation surface is not advertised at all —
 * the tool keeps working, strictly narrower.
 *
 * @module dsh-gitbash-shell/bash-tool
 */

import {
  ESCALATION_TARGETS,
  parseExitStatus,
  renderBackground,
  renderJobRead,
  renderPromoted,
  renderResult,
  processJob,
  processOutcome,
  processSources,
  ringDelta,
} from './bash-render.js'

/** The official abort code (`@deepseek-ai/dsh-tools` TOOL_ABORTED). */
const TOOL_ABORTED = 'ABORTED'

/** Official DSH_* managed-environment prefix (subprocess types.ts:13). */
const DSH_ENV_PREFIX = 'DSH'

/**
 * Resolve a host package through the two proven channels (v0.38.1): the
 * host's own loader first (it reaches inside the desktop app.asar), a plain
 * createRequire second. Mirrors inline-tools' former resolveToolBashEntry.
 * @param {object|undefined} ctx - any host context carrying `loader`/`baseUrl`.
 * @param {string} name - the package to resolve.
 * @returns {Promise<object|undefined>} the module, or undefined when absent.
 */
export async function resolveHostModule(ctx, name) {
  try {
    const internal = ctx?.loader?.internal
    if (internal && typeof internal.import === 'function') {
      const mod = await internal.import(name, ctx?.baseUrl, {})
      if (mod) return mod
    }
  } catch { /* fall through */ }
  try {
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const req = createRequire(ctx?.baseUrl ?? import.meta.url)
    const href = pathToFileURL(req.resolve(name)).href
    return await import(href)
  } catch {
    return undefined
  }
}

/**
 * The official bash description plus unavoidable Git for Windows boundaries.
 * @returns {string}
 */
export function bashDescription() {
  return 'Execute a bash command (`bash -c`) and return its stdout/stderr. '
    + 'Each call runs in a fresh shell; pass `workdir` instead of using `cd`. '
    + `Managed \`$${DSH_ENV_PREFIX}*\` variables expose current harness environment facts. `
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
    + 'Provide `description` before `command` in the arguments. '
    + 'Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked. '
    + 'An unset variable expands to an empty string, so guard variables in such paths with `${VAR:?}`. '
    + 'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]`, a policy denial: do not retry another way. '
    + 'Git for Windows (MSYS) converts path-looking arguments when invoking native Windows programs: ipconfig /all and cmd /c may break; use ipconfig //all or cmd //c, or a per-command MSYS2_ARG_CONV_EXCL prefix. '
    + 'Exclusions are prefixes: excluding /c also excludes /c/... paths, so use native drive-letter paths for those arguments; do not disable conversion globally. Verify the expected effect as well as the exit code. '
    + 'Output is decoded as UTF-8; native Windows programs may emit OEM/ANSI bytes (for example CP936/GBK) and display garbled text. Use a program UTF-8 option or explicit known-encoding conversion before capture; locale variables alone do not fix native output, and mixed streams cannot safely be guessed or decoded globally as GBK. '
    + 'On Windows, this Git Bash route does NOT enforce shell file-write restrictions in read-only/workspace-write mode (unconfined). Official file-tool write/edit policy is separate; never use shell to bypass its denial.'
}

/** The official foreground/present call view (index.ts:108). */
function presentBashCall(args) {
  if (args.run_in_background === true) {
    return {
      card: 'generic',
      title: args.command,
      kind: 'execute',
      rawInput: args.command,
      content: [{ type: 'text', text: args.description }],
    }
  }
  return {
    card: 'terminal',
    title: args.command,
    description: args.description,
    ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
  }
}

/** The official completed-result presentation (index.ts:130). */
function presentBashResult(args, result) {
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  const raw = block.text
  const isBackground = typeof args === 'object' && args !== null && args.run_in_background === true
  const isPromoted = result.value && result.value.kind === 'promoted'
  if (isBackground || isPromoted || result.isError) {
    return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }] }
  }
  const { body, ...exit } = parseExitStatus(raw)
  return { card: 'terminal', output: body, ...exit }
}

/** The official relative-workdir resolution (index.ts:146). */
function resolveWorkdir(modelWorkdir, sessionCwd) {
  if (modelWorkdir === undefined) return sessionCwd
  if (sessionCwd !== undefined && !modelWorkdir.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(modelWorkdir) && !modelWorkdir.startsWith('\\\\')) {
    return `${sessionCwd}/${modelWorkdir}`
  }
  return modelWorkdir
}

/** Detach the executor DTO into plain JSON data (index.ts:155). */
function canonicalBashResult(result, cwd) {
  const output = (stream) => ({
    text: stream.text,
    truncated: stream.truncated,
    ...(stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {}),
  })
  return {
    cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
    ...(result.sandbox !== undefined ? {
      sandbox: {
        mode: result.sandbox.mode,
        denied: result.sandbox.denied,
        ...(result.sandbox.enforcement !== undefined ? { enforcement: result.sandbox.enforcement } : {}),
        ...(result.sandbox.runnerFailed !== undefined ? { runnerFailed: result.sandbox.runnerFailed } : {}),
      },
    } : {}),
  }
}

/** The structured abort the foreground paths throw when the caller cancels the call. */
function toolAborted(HarnessError) {
  if (typeof HarnessError === 'function') {
    const error = new HarnessError('tool call aborted', TOOL_ABORTED)
    error.name = 'AbortError'
    return error
  }
  const error = new Error('tool call aborted')
  error.code = TOOL_ABORTED
  error.name = 'AbortError'
  return error
}

/** Canonical background-handle properties (index.ts:196). */
const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: 'string', required: true, const: 'background' },
  jobId: { type: 'string', required: true },
  cwd: { type: 'string', required: true },
  sandbox: {
    type: 'object', additionalProperties: false,
    properties: {
      mode: { type: 'string', required: true },
      denied: { type: 'boolean', required: true },
      enforcement: { type: 'string' },
    },
  },
}

/** The official output union, with optional background sandbox facts. */
function outputSchemaSpec() {
  return {
    oneOf: [
      { type: 'object', additionalProperties: false, properties: { ...BACKGROUND_OUTPUT_PROPERTIES } },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'promoted' },
          cwd: { type: 'string', required: true },
          jobId: { type: 'string', required: true },
          timeoutMs: { type: 'number', required: true },
          output: { type: 'string', required: true },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'foreground' },
          cwd: { type: 'string', required: true },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean', required: true },
          aborted: { type: 'boolean', required: true },
          stopped: { type: 'string' },
          timeoutMs: { type: 'number', required: true },
          stdout: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              text: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
              spillPath: { type: 'string' },
            },
          },
          stderr: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              text: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
              spillPath: { type: 'string' },
            },
          },
          sandbox: {
            type: 'object', additionalProperties: false,
            properties: {
              mode: { type: 'string', required: true },
              denied: { type: 'boolean', required: true },
              enforcement: { type: 'string' },
              runnerFailed: { type: 'boolean' },
            },
          },
        },
      },
    ],
  }
}

/** Convert key-level spec flags at every depth, including union branches. */
function schemaSpecToJson(spec) {
  const { required: marker, ...out } = spec
  if (Array.isArray(marker)) out.required = [...marker]
  if (spec.properties !== undefined) {
    const required = Array.isArray(marker) ? [...marker] : []
    out.properties = {}
    for (const [key, value] of Object.entries(spec.properties)) {
      if (value.required === true && !required.includes(key)) required.push(key)
      out.properties[key] = schemaSpecToJson(value)
    }
    if (required.length > 0) out.required = required
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(spec[key])) out[key] = spec[key].map(schemaSpecToJson)
  }
  if (spec.items !== undefined) out.items = schemaSpecToJson(spec.items)
  return out
}

/** Plain JSON-schema variant of the same union (fallback when defineTool is absent). */
function outputSchemaJson() {
  return schemaSpecToJson(outputSchemaSpec())
}

/** The official args validation (index.ts:73). */
function validateBashArgs(args, effectiveMode, validateEscalation) {
  if (typeof args.command !== 'string' || args.command.trim().length === 0) {
    throw new Error('invalid command: expected a non-empty string')
  }
  if (typeof args.description !== 'string' || args.description.trim().length === 0) {
    throw new Error('invalid description: expected a non-empty string')
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
  if (args.sandbox_permissions !== undefined && args.sandbox_permissions === effectiveMode) return
  const justification = args.sandbox_permissions === undefined && args.justification !== undefined && args.justification.trim() === ''
    ? undefined
    : args.justification
  if (typeof validateEscalation === 'function') {
    validateEscalation(args.sandbox_permissions, justification)
  } else if (args.sandbox_permissions !== undefined) {
    throw new Error('sandbox_permissions is not available in this composition (no sandbox helper)')
  }
}

/**
 * Build the module object for one agent scope. The executor instance is
 * constructed ONCE per process (private scope) and shared read-only; the
 * host-package modules are resolved once per process too.
 * @param {object} options
 * @param {object} options.executor - the private GitBashSandboxExecutor instance.
 * @param {object|undefined} [options.toolsModule] - `@deepseek-ai/dsh-tools` (defineTool), when resolvable.
 * @param {object|undefined} [options.sandboxModule] - `@deepseek-ai/dsh-sandbox` (escalation helpers), when resolvable.
 * @param {object|undefined} [options.llmModule] - `@deepseek-ai/dsh-llm` (HarnessError), when resolvable.
 * @param {(message: string) => void} options.log
 * @returns {{ inject: string[], apply: (ctx: object, config?: object) => void }}
 */
export function createBashToolModule({ executor, toolsModule, sandboxModule, llmModule, log }) {
  if (!executor || typeof executor.resolve !== 'function' || typeof executor.execute !== 'function') {
    throw new Error('bash-tool: an executor with resolve()/execute() is required')
  }
  const defineTool = typeof toolsModule?.defineTool === 'function' ? toolsModule.defineTool : undefined
  const approveEscalation = typeof sandboxModule?.approveEscalation === 'function' ? sandboxModule.approveEscalation : undefined
  const validateEscalationArgs = typeof sandboxModule?.validateEscalationArgs === 'function' ? sandboxModule.validateEscalationArgs : undefined
  const sandboxPermissionsDescription = typeof sandboxModule?.sandboxPermissionsDescription === 'function'
    ? sandboxModule.sandboxPermissionsDescription
    : (subject) => `The narrowest wider sandbox mode for a one-shot retry of the exact ${subject} the sandbox just denied; the retry asks the user for approval.`

  return {
    inject: ['tools', 'systemPrompt', 'shellEnv', 'workingDirectory'],
    apply(ctx, config = {}) {
      const backgroundEnabled = config?.enableRunInBackground ?? true
      const promoteOnTimeout = (config?.promoteOnTimeout ?? true) && backgroundEnabled
      // The capability fact rides the executor's constructor read of
      // `ctx.sandboxPolicy.defaultMode` — the same source the official
      // tool-bash uses through `ctx.shell.sandboxMode`.
      const defaultMode = executor.sandboxMode
      const escalationReady = defaultMode !== undefined && typeof approveEscalation === 'function'
      const escalationModes = escalationReady ? ESCALATION_TARGETS : []
      // Missing approval helpers narrow escalation, not the session's standing policy.
      const resolveSandboxPolicy = (exec) => {
        if (defaultMode === undefined) return undefined
        const policy = ctx.get('sandboxPolicy')
        return policy ? policy.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session }) : undefined
      }

      const approveBashEscalation = async (mode, justification, exec, standingPolicy) => {
        if (!escalationReady) {
          throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)')
        }
        const effectiveMode = standingPolicy.mode
        return approveEscalation(
          { requestedMode: mode, justification, effectiveMode, subject: 'command' },
          { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName: 'bash', signal: exec.signal },
        )
      }

      // Cross-call guidance belongs in the prompt rather than one-call schema prose.
      try {
        ctx.systemPrompt.section({
          name: 'tool:bash',
          order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
          text: 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.',
        })
      } catch (error) {
        log(`bash tool prompt section failed: ${error?.message ?? error}`)
      }

      /** One registration of the `bash` tool (index.ts:262, shell → executor). */
      const bashTool = (jobs) => {
        const background = jobs !== undefined
        const promote = background && promoteOnTimeout

        const startJob = (registry, args, exec, spec) => {
          let proc
          let stopped
          const id = registry.start({
            kind: 'bash',
            label: args.command,
            ...(exec.agent ? { owner: exec.agent.id } : {}),
            output: processSources(() => proc),
            run: () => {
              const hooks = processJob(
                async (signal) => {
                  proc = await executor.execute({ ...spec, signal })
                  return proc
                },
                (started) => processOutcome(started, escalationModes),
              )
              return {
                done: hooks.done,
                cancel: (reason) => {
                  stopped = reason
                  hooks.cancel(reason)
                },
              }
            },
          })
          return { id, process: () => proc, stopped: () => stopped }
        }

        const waitOnJob = async (registry, attached, exec, spec) => {
          const owner = exec.agent?.id
          const timeoutMs = spec.timeoutMs
          const stop = async (reason) => {
            registry.kill(attached.id, owner, reason)
            const settled = await registry.wait(attached.id, timeoutMs, owner)
            if (settled.status !== 'running' && settled.status !== 'stopping') registry.remove(attached.id, owner)
            return settled
          }
          let view
          try {
            view = await registry.wait(attached.id, timeoutMs, owner, exec.signal)
          } catch {
            await stop('tool call aborted')
            throw toolAborted(llmModule?.HarnessError)
          }
          if ((view.status === 'running' || view.status === 'stopping') && attached.process() === undefined) {
            await stop('timed out during preparation')
            return {
              kind: 'foreground',
              cwd: spec.workdir,
              exitCode: null,
              signal: null,
              timedOut: true,
              aborted: false,
              timeoutMs,
              stdout: { text: '', truncated: false },
              stderr: { text: '', truncated: false },
              ...(spec.sandboxPolicy !== undefined ? { sandbox: { mode: spec.sandboxPolicy.mode, denied: false } } : {}),
            }
          }
          if (view.status === 'running' || view.status === 'stopping') {
            const read = registry.read(attached.id, owner)
            return {
              kind: 'promoted',
              cwd: spec.workdir,
              jobId: attached.id,
              timeoutMs,
              output: renderJobRead(
                ringDelta(read.chunks), read.lossy, read.job.output.spillPaths ?? [], attached.process()?.sandbox, escalationModes,
              ),
            }
          }
          registry.remove(attached.id, owner)
          const process = attached.process()
          if (process === undefined) throw new Error(view.detail)
          const result = await process.result()
          const stopped = attached.stopped()
          return { kind: 'foreground', ...canonicalBashResult(result, spec.workdir), ...(stopped !== undefined ? { stopped } : {}) }
        }

        /** The parameter spec in the defineTool dialect (index.ts:370). */
        const parametersSpec = () => ({
          description: {
            type: 'string',
            required: true,
            description: 'Clear, concise description of what this command does in active voice, '
              + '5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; '
              + '"git status" → "Show working tree status"; "npm install" → "Install package dependencies".',
          },
          command: { type: 'string', required: true, description: 'The bash command to execute.' },
          timeoutMs: {
            type: 'number',
            description: promote
              ? 'Timeout in milliseconds. The executor applies its configured default and cap; on expiry the command moves to the background as a job instead of being killed.'
              : 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.',
          },
          workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.' },
          ...(background ? {
            run_in_background: { type: 'boolean', description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.' },
          } : {}),
          ...(escalationModes.length > 0 ? {
            sandbox_permissions: {
              type: 'string',
              enum: [...escalationModes],
              description: sandboxPermissionsDescription('command'),
            },
            justification: {
              type: 'string',
              description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access. '
                + 'Use the language of the user’s current request.',
            },
          } : {}),
        })

        /** The execute body, identical across both definition shapes (index.ts:477). */
        const executeBody = async (args, exec) => {
          const standingPolicy = resolveSandboxPolicy(exec)
          validateBashArgs(args, standingPolicy?.mode, validateEscalationArgs)
          const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
            ? await approveBashEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
            : undefined
          const policy = approvedMode === undefined
            ? standingPolicy
            : { ...standingPolicy, mode: approvedMode }
          const cwd = exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
          const workdir = resolveWorkdir(args.workdir, cwd)
          const dshEnv = ctx.shellEnv.collect(exec)
          const request = {
            command: args.command,
            ...(workdir !== undefined ? { workdir } : {}),
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
            dshEnv,
            ...(policy !== undefined ? { sandboxPolicy: policy } : {}),
          }
          if (args.run_in_background === true) {
            if (!backgroundEnabled) {
              throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
            }
            if (jobs === undefined) {
              throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
            }
            if (exec.signal.aborted) throw toolAborted(llmModule?.HarnessError)
            const spec = executor.resolve({ ...request, onExpiry: 'none' })
            // The job may still be preparing: expose the planned route, not a
            // claim that the command has already run or been confined.
            const route = typeof executor.gitBashRoute === 'function' ? executor.gitBashRoute(spec) : undefined
            const sandbox = route === undefined ? undefined : {
              mode: route.mode, denied: false,
              ...(route.unconfined ? { enforcement: 'unconfined' } : {}),
            }
            return { kind: 'background', jobId: startJob(jobs, args, exec, spec).id, cwd: spec.workdir,
              ...(sandbox === undefined ? {} : { sandbox }) }
          }
          if (jobs !== undefined && promote) {
            const spec = executor.resolve({ ...request, onExpiry: 'none' })
            let attached
            try {
              attached = startJob(jobs, args, exec, spec)
            } catch (error) {
              ctx.logger?.warn?.(`bash: job registration refused, running in the foreground with the timeout kill instead: ${String(error)}`)
            }
            if (attached !== undefined) return waitOnJob(jobs, attached, exec, spec)
          }
          const spec = executor.resolve({ ...request, signal: exec.signal })
          const foreground = await executor.execute(spec)
          const result = await foreground.result()
          if (result.aborted) throw toolAborted(llmModule?.HarnessError)
          return { kind: 'foreground', ...canonicalBashResult(result, spec.workdir) }
        }

        if (typeof defineTool === 'function') {
          return defineTool({
            name: 'bash',
            description: bashDescription(),
            parameters: parametersSpec(),
            output: {
              schema: outputSchemaSpec(),
              render: (_args, value) => [{
                type: 'text',
                text: value.kind === 'background'
                  ? renderBackground(value.jobId, value.sandbox)
                  : value.kind === 'promoted'
                    ? renderPromoted(value)
                    : renderResult(value, escalationModes),
              }],
              presentationMeta: (_args, value) => ({ cwd: value.cwd }),
            },
            execute: executeBody,
            presentCall: presentBashCall,
            presentResult: presentBashResult,
          })
        }
        // Plain-object fallback: same surface, JSON-schema dialect, no arg
        // soft-validation wrapper (the registry still validates against the
        // declared schema). Only reachable on hosts where the loader channel
        // cannot reach `@deepseek-ai/dsh-tools`.
        log('bash tool: @deepseek-ai/dsh-tools not resolvable; registering a plain definition')
        return {
          name: 'bash',
          description: bashDescription(),
          // No additionalProperties:false — the official spec lets undeclared
          // keys reach execute too, where enableRunInBackground enforces them
          // ("Undeclared keys are allowed, so schema omission also needs
          // enforcement", index.ts:498).
          parameters: schemaSpecToJson({ type: 'object', properties: parametersSpec() }),
          output: {
            schema: outputSchemaJson(),
            render: (_args, value) => [{
              type: 'text',
              text: value.kind === 'background'
                ? renderBackground(value.jobId, value.sandbox)
                : value.kind === 'promoted'
                  ? renderPromoted(value)
                  : renderResult(value, escalationModes),
            }],
            presentationMeta: (_args, value) => ({ cwd: value.cwd }),
          },
          execute: executeBody,
          presentCall: presentBashCall,
          presentResult: presentBashResult,
        }
      }

      // The background surface follows the registry (index.ts:536), verbatim.
      if (!backgroundEnabled) {
        ctx.tools.register(bashTool(undefined))
        return
      }
      let foregroundOnly = ctx.get('jobs') === undefined ? ctx.tools.register(bashTool(undefined)) : undefined
      ctx.inject(['jobs'], (jobCtx) => {
        foregroundOnly?.()
        foregroundOnly = undefined
        const unregister = ctx.tools.register(bashTool(jobCtx.jobs))
        jobCtx.effect(() => () => {
          unregister()
          try {
            // Cordis FiberState.ACTIVE is the numeric enum member 2.
            if (ctx.fiber?.state === 2) foregroundOnly = ctx.tools.register(bashTool(undefined))
          } catch { /* the scope is going away */ }
        })
      })
    },
  }
}
