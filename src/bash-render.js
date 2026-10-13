/**
 * dsh-gitbash-shell/bash-render — model-facing rendering for the own bash tool.
 *
 * v0.39.0 (route B): the plugin no longer replaces the host `ctx.shell`
 * executor, so it can no longer mount the OFFICIAL `@deepseek-ai/dsh-tool-bash`
 * module (its every execution goes through `ctx.shell`, which stays PowerShell
 * here). Instead the plugin ships its OWN bash tool whose executor is a private
 * `GitBashSandboxExecutor` instance (never registered as a service), and this
 * file mirrors the official tool's rendering contract call-for-call so the
 * model sees the official output shapes, with an explicit unconfined warning:
 *
 *   - `render.ts` of `@deepseek-ai/dsh-tool-bash` (result / promoted / job-read
 *     text shaping), and
 *   - the exit-marker parser of `@deepseek-ai/dsh-shell` (`parseExitStatus`),
 *
 * with the sandbox markers inlined as the exact strings the official
 * `@deepseek-ai/dsh-sandbox` emits (`packages/sandbox/sandbox/src/escalation.ts`).
 * Inlining is deliberate: the markers are stable display text, and pulling a
 * host package at render time would make the model-facing contract depend on a
 * resolution channel that can be absent on exotic layouts. Drift risk is
 * recorded in the smoke suite (marker-format assertions).
 *
 * @module dsh-gitbash-shell/bash-render
 */

/** The official sandbox-denial marker (escalation.ts:71). */
export function sandboxDenialMarker(mode) {
  return `[sandbox: file access denied under ${mode} mode]`
}

/** A capability warning, not a denial or permission to bypass another denial. */
export function sandboxUnconfinedMarker(mode) {
  return `[sandbox: Git Bash is unconfined on Windows — shell file-write restrictions are NOT enforced (requested mode: ${mode}); official file-tool write/edit policy still applies; never bypass its denial through shell]`
}

/** Include the planned execution boundary even before the job has spawned. */
export function renderBackground(jobId, sandbox) {
  const notes = sandboxNotes(sandbox, [])
  return `started background job ${jobId}${notes.length ? '\n' + notes.join('\n') : ''}`
}

/** The official same-turn escalation hint (escalation.ts:84). */
export function escalationHintMarker(subject) {
  return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`
}

/** The official escalation targets (escalation.ts:41). */
export const ESCALATION_TARGETS = Object.freeze(['workspace-write', 'danger-full-access'])

/**
 * The official exit-status parse (dsh-shell render.ts:37): the LAST marker
 * line anchors the split between the output body and the exit pill.
 * @param {string} text - the rendered result text.
 * @returns {{ body: string, exitCode?: number, signal?: string }}
 */
export function parseExitStatus(text) {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal && signal[1] !== undefined) return { body: text.slice(0, signal.index), signal: signal[1] }
  const exit = /\n\[exit code: (\d+)\]$/.exec(text)
  if (exit && exit[1] !== undefined) return { body: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  return { body: text, exitCode: 0 }
}

/** Append the truncation notice (with the full-output spill path) to a stream's text. */
function streamText(output) {
  if (!output || output.truncated !== true) return output ? output.text : ''
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/**
 * Shape one finished run into the text the model sees: stdout, then a marked
 * stderr section, then exit-status markers. Non-zero exits are reported, not
 * errored — the model decides how to react; only infrastructure failures
 * (spawn errors, aborts) surface as isError results. Mirrors the official
 * `renderResult` (tool-bash render.ts:28).
 * @param {object} result - the completed foreground run from the executor.
 * @param {string[]} [escalationModes] - the escalation targets this composition advertises.
 * @returns {string} the model-facing text.
 */
export function renderResult(result, escalationModes = []) {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)

  let body = out
  if (err.length > 0) {
    // Single newline between sections (stdout usually ends with one already).
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'

  const markers = []
  // Keep the exit marker last because parseExitStatus anchors there.
  if (result.sandbox && result.sandbox.denied) {
    markers.push(sandboxDenialMarker(result.sandbox.mode))
    if (escalationModes.length > 0) markers.push(escalationHintMarker('command'))
  }
  if (result.sandbox?.enforcement === 'unconfined') markers.push(sandboxUnconfinedMarker(result.sandbox.mode))
  // A command may trap SIGTERM and exit 0 after timeout; still report interruption.
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  // A kill from outside the call (the human stopping its job) is not a
  // command failure: the reason tells the model not to retry.
  if (result.stopped !== undefined) markers.push(`[stopped: ${result.stopped}]`)
  if (result.signal !== null && result.signal !== undefined) {
    markers.push(`[killed by signal: ${result.signal}]`)
  } else if (result.exitCode !== 0) {
    markers.push(`[exit code: ${result.exitCode}]`)
  }
  if (markers.length === 0) return body

  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/**
 * Shape a foreground call that stopped waiting into the text the model sees.
 * Mirrors the official `renderPromoted` (tool-bash render.ts:77).
 * @param {{ jobId: string, timeoutMs: number, output: string }} promoted
 * @returns {string}
 */
export function renderPromoted(promoted) {
  const body = promoted.output.length > 0
    ? (promoted.output.endsWith('\n') ? promoted.output : `${promoted.output}\n`)
    : ''
  return `${body}[still running after ${promoted.timeoutMs}ms; moved to background job ${promoted.jobId}]\n`
    + 'The command keeps running in the background. You will be notified when it finishes; '
    + 'read newer output with job_output, stop it with job_kill.'
}

/**
 * Sandbox facts worth the terminal detail: a runner that never ran the
 * command, or a denial (with the escalation hint this composition offers).
 * Mirrors background.ts:21 `sandboxNotes`.
 */
function sandboxNotes(sandbox, escalationModes) {
  if (sandbox && sandbox.runnerFailed) {
    return [`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`]
  }
  if (sandbox && sandbox.denied) {
    const notes = [sandboxDenialMarker(sandbox.mode)]
    if (escalationModes.length > 0) notes.push(escalationHintMarker('command'))
    return notes
  }
  if (sandbox?.enforcement === 'unconfined') return [sandboxUnconfinedMarker(sandbox.mode)]
  return []
}

/**
 * Map a settled background process onto the generic job-outcome vocabulary.
 * Mirrors background.ts:44 `processOutcome`.
 * @param {object} proc - the settled process handle.
 * @param {string[]} [escalationModes]
 * @returns {object} the outcome for the `ctx.jobs` registration.
 */
export function processOutcome(proc, escalationModes = []) {
  const base = proc.status === 'killed'
    ? { status: 'killed', detail: proc.signal !== null && proc.signal !== undefined ? `signal: ${proc.signal}` : 'killed before exit' }
    : { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
  const notes = sandboxNotes(proc.sandbox, escalationModes)
  return notes.length === 0 ? base : { ...base, detail: `${base.detail}; ${notes.join(' ')}` }
}

/**
 * The process's non-consuming stream readers as registry pull sources; they
 * bind lazily because the process is spawned inside the starter, after the
 * registry admitted the job. Mirrors background.ts:67 `processSources`.
 * @param {() => object|undefined} proc - the settled process accessor.
 * @returns {Array<object>} one source per stream, stdout first.
 */
export function processSources(proc) {
  const source = (channel) => ({
    channel,
    read: (fromByte) => {
      const live = proc()
      return live === undefined || !live.observed
        ? { text: '', nextOffset: fromByte, lossy: false }
        : live.observed[channel].readFrom(fromByte)
    },
  })
  return [source('stdout'), source('stderr')]
}

/**
 * The ring chunks of one consuming registry read as the shell tools render a
 * process read: stdout chunks in order, then every stderr chunk in one
 * `[stderr]` section. Mirrors background.ts:86 `ringDelta`.
 * @param {Array<{ channel: string, text: string }>} chunks
 * @returns {string}
 */
export function ringDelta(chunks) {
  const list = Array.isArray(chunks) ? chunks : []
  const out = list.filter((chunk) => chunk.channel !== 'stderr').map((chunk) => chunk.text).join('')
  const err = list.filter((chunk) => chunk.channel === 'stderr').map((chunk) => chunk.text).join('')
  const separator = out.length > 0 && !out.endsWith('\n') ? '\n' : ''
  return out + (err.length > 0 ? `${separator}[stderr]\n${err}` : '')
}

/**
 * Shape the one consuming registry read a foreground call embeds in its
 * result when it stops waiting. Mirrors render.ts:99 `renderJobRead`.
 */
export function renderJobRead(delta, lossy, spillPaths, sandbox, escalationModes = []) {
  const notices = []
  if (lossy) {
    const paths = Array.isArray(spillPaths) ? spillPaths : []
    notices.push(`[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(', ') : '(unavailable)'}]`)
  }
  notices.push(...sandboxNotes(sandbox, escalationModes))
  if (notices.length === 0) return delta
  return `${delta}${delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''}${notices.join('\n')}`
}

/**
 * Adapt asynchronous shell preparation after job admission without exposing a
 * partial process. Mirrors background.ts:99 `processJob`.
 * @param {(signal: AbortSignal) => Promise<object>} start
 * @param {(proc: object) => object} outcome
 * @returns {{ cancel: (reason: string) => void, done: Promise<object> }}
 */
export function processJob(start, outcome) {
  const controller = new AbortController()
  let process
  const done = (async () => {
    try {
      process = await start(controller.signal)
      try {
        if (controller.signal.aborted) process.kill()
      } finally {
        await process.done
      }
      return outcome(process)
    } catch (error) {
      return {
        status: controller.signal.aborted && process === undefined ? 'killed' : 'failed',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  })()
  return {
    cancel: (reason) => {
      if (controller.signal.aborted) return
      controller.abort(reason)
      if (process && typeof process.kill === 'function') process.kill()
    },
    done,
  }
}
