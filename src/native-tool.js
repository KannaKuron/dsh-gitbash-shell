import { registerExperimentalTool } from './experimental-tools.js'
import { createNativeExecutor } from './native-executor.js'
import { processJob, processSources, ringDelta, renderJobRead } from './bash-render.js'

const typedPath = () => ({ type: 'object', additionalProperties: false, properties: {
  kind: { type: 'string', const: 'path', required: true }, value: { type: 'string', required: true },
} })

/** defineTool's AUTHOR property-map, not a raw object-root JSON schema. */
export function nativeParameters({ background = false, promote = false } = {}) {
  return {
    description: { type: 'string', required: true, description: 'Short description of the intended native operation.' },
    executable: { ...typedPath(), required: true, description: 'Absolute native .exe path. MSYS paths translate only in kind:path values. Bare commands, scripts, .cmd and .bat are unsupported.' },
    argv: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', enum: ['literal', 'path'], required: true }, value: { type: 'string', required: true },
    } }, description: 'Each literal is passed unchanged (including /all, /c, quotes and empty strings); each path must be absolute and is explicitly translated to native Windows spelling. No shell expansion.' },
    cwd: { ...typedPath(), description: 'Absolute typed working directory; omitted means the agent workspace.' },
    entrypoint: { type: 'string', enum: ['native', 'interpreter'], description: 'Default native. Known interpreters require explicit interpreter. Their own command language/quoting is not made safe by direct argv; no automatic script wrapper.' },
    timeoutMs: { type: 'number', description: promote ? 'Foreground wait deadline, default 120000ms, capped at 600000ms; expiry promotes the managed process to a job. Not accepted with run_in_background.' : 'Kill deadline, default 120000ms, capped at 600000ms. Not accepted with run_in_background.' },
    ...(background ? { run_in_background: { type: 'boolean', description: 'Use existing managed Jobs; collect with job_output, stop with job_kill. No tool deadline. Requires an attached job controller.' } } : {}),
    stdoutEncoding: { type: 'string', enum: ['utf8', 'gbk', 'utf16le', 'raw'], description: 'Known producer stdout encoding, default utf8. raw preserves unknown/mixed bytes without claiming reliable text. No auto detection.' },
    stderrEncoding: { type: 'string', enum: ['utf8', 'gbk', 'utf16le', 'raw'], description: 'Known producer stderr encoding, independently selected; default utf8.' },
    errors: { type: 'string', enum: ['replace', 'strict'], description: 'Default replace; strict records decoding failures separately from actual command exit. Never rerun a side-effecting command merely because output decoding failed.' },
  }
}

const streamSchema = { type: 'object', additionalProperties: false, properties: {
  text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true }, spillPath: { type: 'string' },
} }
// Core's author DSL supports integer, not numeric minimum keywords; the
// adapter owns non-negative counters and budget validation before execution.
const byteCount = () => ({ type: 'integer', required: true })
const factBoolean = () => ({ type: 'boolean', required: true })
const outputErrorSchema = { type: 'object', additionalProperties: false, properties: {
  code: { type: 'string', required: true }, message: { type: 'string', required: true },
} }
const normalizedEncoding = ['utf-8', 'gbk', 'utf-16le', 'raw']
const artifactSchema = kind => ({ type: 'object', additionalProperties: false, properties: {
  kind: { type: 'string', const: kind, required: true },
  encoding: { type: 'string', ...(kind === 'decoded' ? { const: 'utf-8' } : { enum: normalizedEncoding }), required: true },
  path: { type: 'string' }, bytes: byteCount(), complete: factBoolean(), capReached: factBoolean(), error: outputErrorSchema,
} })
const streamFactsSchema = { type: 'object', additionalProperties: false, properties: {
  encoding: { type: 'string', enum: normalizedEncoding, required: true },
  errors: { type: 'string', enum: ['replace', 'strict'], required: true },
  rawBytes: byteCount(), decodedUtf8Bytes: byteCount(), rawCursor: byteCount(), decodedCursor: byteCount(),
  reliableText: factBoolean(), lossy: factBoolean(), complete: factBoolean(), sourceComplete: factBoolean(),
  aborted: factBoolean(), settled: factBoolean(),
  termination: { type: 'string', enum: ['end', 'close-before-end', 'stream-error', 'missing-pipe', 'spawn-error', 'abort-drain-timeout', 'terminate-drain-timeout', 'exit-drain-timeout', 'provider-error-drain-timeout'] },
  decodeError: outputErrorSchema, streamError: outputErrorSchema, storageError: outputErrorSchema,
  artifact: { type: 'object', additionalProperties: false, required: true, properties: {
    raw: artifactSchema('raw'), decoded: artifactSchema('decoded'),
  } },
  retainedMaxBytes: byteCount(),
} }
// Explicit current adapter DTO, including the two executor-owned degradation
// branches. Optional undefined projection never admits arbitrary output fields.
export const NATIVE_OUTPUT_FACTS_SCHEMA = { oneOf: [
  { type: 'object', additionalProperties: false, properties: {
    stdout: { ...streamFactsSchema, required: true }, stderr: { ...streamFactsSchema, required: true },
    budget: { type: 'object', additionalProperties: false, required: true, properties: {
      maxTotalBytes: byteCount(), reservedMemoryBytes: byteCount(), artifactBytes: byteCount(), maxArtifactBytes: byteCount(),
    } },
  } },
  { type: 'object', additionalProperties: false, properties: { unavailable: { type: 'boolean', const: true, required: true } } },
  { type: 'object', additionalProperties: false, properties: {
    projectionError: { type: 'string', required: true }, reliableText: { type: 'boolean', const: false, required: true },
  } },
] }
const sandboxSchema = { type: 'object', additionalProperties: false, properties: {
  mode: { type: 'string', const: 'danger-full-access', required: true }, denied: { type: 'boolean', const: false, required: true },
} }
const encodingSchema = { type: 'object', additionalProperties: false, properties: {
  stdoutEncoding: { type: 'string', enum: ['utf8', 'gbk', 'utf16le', 'raw'], required: true },
  stderrEncoding: { type: 'string', enum: ['utf8', 'gbk', 'utf16le', 'raw'], required: true },
  errors: { type: 'string', enum: ['replace', 'strict'], required: true },
} }
export const NATIVE_OUTPUT_SCHEMA = {
  oneOf: [
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'foreground', required: true }, cwd: { type: 'string', required: true },
      status: { type: 'string', enum: ['running', 'completed', 'killed'], required: true }, exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
      signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
      timedOut: { type: 'boolean', required: true }, aborted: { type: 'boolean', required: true }, timeoutMs: { type: 'number', required: true },
      stdout: { ...streamSchema, required: true }, stderr: { ...streamSchema, required: true },
      sandbox: { ...sandboxSchema, required: true }, outputFacts: { ...NATIVE_OUTPUT_FACTS_SCHEMA, required: true },
    } },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', enum: ['background', 'promoted'], required: true }, cwd: { type: 'string', required: true },
      jobId: { type: 'string', required: true }, timeoutMs: { type: 'number' }, output: { type: 'string' },
      encoding: { ...encodingSchema, required: true },
    } },
  ],
}

export function renderNativeResult(value) {
  if (value.kind !== 'foreground') return `Native command ${value.kind === 'promoted' ? 'continues after the wait deadline' : 'admitted to managed Jobs'}; job id: ${value.jobId}. Collect with job_output, stop with job_kill.\n${value.output ?? ''}\n[requested encoding: ${JSON.stringify(value.encoding)}; final producer/output facts arrive in job output]`
  const text = value.stdout.text + (value.stderr.text ? `\n[stderr]\n${value.stderr.text}` : '')
  return `${text}\n[exit code: ${value.exitCode ?? 'unknown'}; status: ${value.status}; signal: ${value.signal ?? 'none'}; timedOut: ${value.timedOut}; aborted: ${value.aborted}]\n[native output facts: ${JSON.stringify(value.outputFacts)}]\nOutput decoding/storage problems do not mean the command did not execute; inspect producer exit facts before considering any retry.`
}

/** One per-agent module. Host packages and the shared path translator are injected. */
export function createNativeToolModule(deps) {
  if (typeof deps.toolsModule?.defineTool !== 'function') throw new Error('gitbash_native: host defineTool capability unavailable')
  return {
    inject: ['tools', 'subprocess', 'shellEnv'],
    apply(ctx) {
      const executor = createNativeExecutor(ctx, deps)
      // No Config gates here: this module is mounted by hand in an agent scope
      // (`scope.ctx.plugin({...module})`), so row/executor Config fields are
      // unreachable and would read as permanently-on dead switches. Background
      // follows the job registry's presence alone; the user-level kill switch
      // is experimentalNative (the official tool-bash keeps its own live
      // enableRunInBackground/promoteOnTimeout on its row).
      const definition = jobs => {
        const background = jobs !== undefined
        const promote = background
        const startJob = (request, exec) => {
          let proc
          let finalFacts = ''
          const sources = processSources(() => proc)
          sources.push({ channel: 'stderr', read(fromByte) {
            const bytes = Buffer.from(finalFacts, 'utf8')
            return { text: bytes.subarray(fromByte).toString('utf8'), nextOffset: bytes.length, lossy: false }
          } })
          const id = jobs.start({ kind: 'gitbash-native', label: request.description,
            ...(exec.agent ? { owner: exec.agent.id } : {}), output: sources,
            run: () => processJob(async signal => {
              proc = await executor.execute(request, exec, { signal, onExpiry: 'none' })
              return proc
            }, async started => {
              // done has already sealed decoding and released this operation's scope.
              const result = await started.result()
              finalFacts = `\n[native producer: exitCode=${result.exitCode}, signal=${result.signal}, status=${result.status}, aborted=${result.aborted}]\n[native output facts: ${JSON.stringify(result.outputFacts)}]\nOutput failure is not command non-execution; do not blindly retry.\n`
              return { status: result.status === 'killed' ? 'killed' : 'completed', detail: `exit code: ${result.exitCode ?? 'unknown'}; output facts retained in job output` }
            }),
          })
          return { id, process: () => proc }
        }
        const execute = async (args, exec) => {
          // prepare resolves policy BEFORE ensure/path/env/artifact work.
          const request = await executor.prepare(args, exec)
          exec.signal?.throwIfAborted()
          if (request.run_in_background && !background) throw new Error('run_in_background is unavailable or disabled; this request was not executed')
          if (request.run_in_background) {
            const attached = startJob(request, exec)
            return { kind: 'background', jobId: attached.id, cwd: request.cwd, encoding: request.output }
          }
          if (promote) {
            // No retry/fallback around admission: a host throwing after starting a
            // producer must not cause a second execution of a side-effecting call.
            const attached = startJob(request, exec)
            const owner = exec.agent?.id
            let view
            try { view = await jobs.wait(attached.id, executor.waitBudget(request), owner, exec.signal) }
            catch (error) {
              jobs.kill(attached.id, owner, 'tool call aborted')
              await jobs.wait(attached.id, 10000, owner)
              throw error
            }
            if (view.status === 'running' || view.status === 'stopping') {
              if (!attached.process()) {
                jobs.kill(attached.id, owner, 'timed out during native preparation')
                await jobs.wait(attached.id, 10000, owner)
                throw new Error(`native preparation timed out; job ${attached.id} was cancelled, inspect job_output before retrying`)
              }
              const read = jobs.read(attached.id, owner)
              // A ring eviction can report gapBefore even when its pull source
              // was lossless. This consuming read must preserve both loss facts.
              const lostOutput = read.lossy || read.chunks.some(chunk => chunk.gapBefore)
              return { kind: 'promoted', jobId: attached.id, cwd: request.cwd, timeoutMs: request.timeoutMs,
                output: renderJobRead(ringDelta(read.chunks), lostOutput, read.job?.output?.spillPaths), encoding: request.output }
            }
            jobs.remove(attached.id, owner)
            if (!attached.process()) throw new Error(view.detail ?? 'native preparation failed before a process handle was available')
            return { kind: 'foreground', ...await attached.process().result() }
          }
          const proc = await executor.execute(request, exec)
          return { kind: 'foreground', ...await proc.result() }
        }
        return deps.toolsModule.defineTool({ name: 'gitbash_native',
          description: 'Choose this tool BEFORE execution for a Windows-native .exe that needs exact literal argv (for example /all or /c without MSYS conversion) or explicitly known independent stdout/stderr encodings. Use an offered shell tool instead for pipelines, redirection, globbing, shell expansion or POSIX scripts; this is direct typed argv through the host managed executor, not shell source. Supply an absolute executable, mark literal arguments unchanged and path arguments explicitly; do not put a whole shell command into argv. Prefer a producer UTF-8 option; declare gbk/utf16le only when known, raw for unknown or mixed bytes. In PTC call this offered SDK binding from inside run_code, not as a direct model tool call. Only actual danger-full-access standing policy is supported; missing/restricted policy is rejected before execution. A policy/access denial is a stop condition, never permission for another-tool retry. Decoding/storage failure preserves producer exit: never blindly repeat side effects. No user env, implicit scripts, .cmd/.bat wrappers, path guessing or encoding auto-detection. Known interpreters require explicit entrypoint:interpreter; common CRT/Node argv is supported, arbitrary interpreter quoting is not guaranteed.',
          parameters: nativeParameters({ background, promote }),
          output: { schema: NATIVE_OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderNativeResult(value) }], presentationMeta: (_args, value) => ({ cwd: value.cwd }) },
          execute,
          presentCall: args => ({ card: 'generic', title: args.description, kind: 'execute', content: [{ type: 'text', text: args.executable.value }] }),
        })
      }
      let currentJobs
      const refresh = registerExperimentalTool(ctx, () => definition(currentJobs), deps.experimentalEnabled, { scope: deps.scope, log: deps.log })
      ctx.inject(['jobs'], jobCtx => {
        currentJobs = jobCtx.jobs
        refresh()
        jobCtx.effect(() => () => {
          currentJobs = undefined
          if (ctx.fiber?.state === 2) refresh()
        })
      })
    },
  }
}
