/**
 * dsh-gitbash-shell — winget toolchain runner (v0.30.0).
 *
 * The host half behind the settings card's "install / upgrade" buttons. Three
 * properties matter more than the feature itself:
 *
 *   1. NOTHING HERE TAKES A PACKAGE ID FROM THE REQUEST. A request names
 *      CATALOG ids (`toolchain.js`), which are mapped to winget ids inside this
 *      module; an unknown id is dropped. The closed catalog is the only thing
 *      that can ever reach winget, and `install`/`upgrade` additionally carry
 *      `--exact --source winget`.
 *   2. EVERY winget CALL IS `execFile` WITH AN ARGV ARRAY. No shell string is
 *      ever built, so no part of a request can become a command.
 *   3. THE ROUTE IS FENCED. Installing software is a real side effect, so the
 *      handler refuses anything that is not a loopback caller with a same-origin
 *      Origin/Referer — a page the user merely visited must not be able to make
 *      their machine install packages.
 *
 * `winget export` is the inventory of record: it is JSON (the localized `list`
 * tables truncate wide ids — measured), it names the exact package the machine
 * has (a GNU-build ripgrep is a different id from the MSVC one — measured), and
 * `--include-versions` carries the installed version.
 *
 * Every process/filesystem fact arrives through the injected `io`, so the whole
 * module is testable without winget, Windows, or a network.
 */

import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  TOOLCHAIN, classifyToolState, classifyWingetResult, describeProvider,
  exportArgv, installArgv, isActionable, listUpgradableArgv, parseExportJson,
  parseUpgradable, scanCommands, toolById, upgradeArgv,
} from './toolchain.js'

/** Hard ceiling on one winget run. A UAC prompt waits for the user, so the
 *  installing entry is given more room than the read-only probes. */
const PROBE_TIMEOUT_MS = 60_000
const INSTALL_TIMEOUT_MS = 15 * 60_000

/** winget's own download-retry chatter (issue #35): when this shows up and the
 *  process is STILL running one window later, the download is wedged — DO
 *  falls back to WinINet, retries, and would otherwise burn the whole 15-minute
 *  ceiling in silence. */
export const NETWORK_RETRY_PATTERN = /failed to download, waiting a bit and retry|0x80072ee2|0x80072efd/i
const NETWORK_RETRY_WINDOW_MS = 120_000
/** Hard cap on the collected output of one run (mirrors the old maxBuffer). */
const OUTPUT_CAP_BYTES = 16 * 1024 * 1024

/** Kill a whole process tree. */
function killTree(child) {
  try {
    if (!child || child.pid === undefined) return
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
  } catch { /* best effort — the verdict does not depend on the kill landing */ }
}

/** Sort a run result that ended through cancel / hard timeout / wedged
 *  download from an ordinary winget failure (issue #35).
 *  Only the run's OWN `cancelled` flag counts here: a cancel that lands AFTER
 *  winget already exited must not rewrite a finished install into a cancelled
 *  one — the loop skips the remaining entries instead. */
function verdictFrom(result) {
  if (result && result.cancelled === true) return { ok: false, kind: 'cancelled', detail: 'cancelled by the user' }
  if (result && result.timedOut === true) return { ok: false, kind: 'timeout', detail: tailLine(result.output) || 'hard timeout' }
  if (result && result.networkRetry === true) return { ok: false, kind: 'network', detail: tailLine(result.output) || 'download retried without progress' }
  return classifyWingetResult(result.code, result.output)
}

/** The freshest full line of a run's output, capped — the one signal a stuck
 *  download actually prints ("Failed to download, waiting a bit and retry"). */
function tailLine(text) {
  const lines = String(text || '').trimEnd().split(/\r?\n/)
  return (lines[lines.length - 1] || '').slice(0, 300)
}

/** Only one job at a time: winget serializes on its own state anyway, and two
 *  concurrent installs is how a half-applied catalog happens. */
let activeJob = null

/**
 * The real IO. `run` never rejects: a non-zero exit is data, and a spawn
 * failure becomes a synthetic exit code so callers have one shape to handle.
 *
 * v0.43.0 (issue #35): the old `execFile` buffered the child's whole output,
 * so a wedged winget download looked like "processing" for 15 minutes with
 * nothing to watch and no way out. `spawn` streams instead: `hooks.onOutput`
 * receives each line as it arrives, a hard timeout, an external
 * `cancelActive()` and the download-retry watchdog below all end the run by
 * killing the WHOLE process tree (winget dispatches forwarders / msiexec /
 * DeliveryOptimization children — killing only the parent leaves them), and
 * the result carries `cancelled` / `timedOut` / `networkRetry` so callers can
 * sort those endings from ordinary failures.
 * @param {{ networkRetryWindowMs?: number }} [options]
 * @returns {object}
 */
export function defaultRunnerIo(options = {}) {
  const networkRetryWindowMs = Number(options.networkRetryWindowMs) > 0
    ? Number(options.networkRetryWindowMs)
    : NETWORK_RETRY_WINDOW_MS
  /** The in-flight run: `{ child, flags }`, or null between runs. */
  let current = null
  return {
    run(file, args, timeoutMs, hooks) {
      const onOutput = hooks && typeof hooks.onOutput === 'function' ? hooks.onOutput : null
      return new Promise((resolve) => {
        let settled = false
        const flags = {}
        const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        current = { child, flags }
        let output = ''
        let bytes = 0
        const swallow = (chunk) => {
          bytes += chunk.length
          if (bytes <= OUTPUT_CAP_BYTES) output += chunk.toString('utf8')
          if (onOutput !== null) {
            // Keep only the freshest line (a 300-char tail): the card shows one
            // grey line under the progress, not a log.
            const line = String(chunk).split(/\r?\n/).filter(Boolean).pop()
            if (line) onOutput(line.slice(0, 300))
          }
        }
        child.stdout.on('data', swallow)
        child.stderr.on('data', swallow)
        // The wedged-download watchdog: from the FIRST retry line, a process
        // still alive one window later is not making progress (winget cycles
        // DO → WinINet → "waiting a bit and retry" for minutes). One window,
        // once — a slow but working download never sees it.
        let retryTimer = null
        child.stderr.on('data', (chunk) => {
          if (settled || flags.networkRetry || flags.timedOut || flags.cancelled || retryTimer !== null) return
          if (NETWORK_RETRY_PATTERN.test(String(chunk))) {
            retryTimer = setTimeout(() => {
              retryTimer = null
              if (settled || flags.timedOut || flags.cancelled) return
              flags.networkRetry = true
              killTree(child)
            }, networkRetryWindowMs)
          }
        })
        const timer = setTimeout(() => {
          if (settled || flags.networkRetry || flags.cancelled) return
          flags.timedOut = true
          killTree(child)
        }, timeoutMs || PROBE_TIMEOUT_MS)
        child.on('error', (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null }
          if (current !== null && current.child === child) current = null
          resolve({ code: -1, output: output || String((error && error.message) || error) })
        })
        child.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null }
          if (current !== null && current.child === child) current = null
          resolve({
            code: typeof code === 'number' ? code : -1,
            output,
            ...(flags.cancelled === true ? { cancelled: true } : {}),
            ...(flags.timedOut === true ? { timedOut: true } : {}),
            ...(flags.networkRetry === true ? { networkRetry: true } : {}),
          })
        })
      })
    },
    /** Abort the in-flight run (issue #35). A no-op between runs; the run
     *  resolves with `cancelled: true` once the tree is down. */
    cancelActive() {
      const entry = current
      if (!entry || entry.child.exitCode !== null || entry.child.signalCode !== null) return false
      entry.flags.cancelled = true
      killTree(entry.child)
      return true
    },
    pathDirs() {
      return String(process.env.PATH || '').split(';').filter(Boolean)
    },
    readdir(dir) {
      return readdirSync(dir, { withFileTypes: true })
    },
    isFile(path) {
      try { return statSync(path).isFile() } catch { return false }
    },
    readFile(path) {
      return readFileSync(path, 'utf8')
    },
    tmpFile(name) {
      return join(tmpdir(), name)
    },
    remove(path) {
      try { rmSync(path, { force: true }) } catch { /* best effort */ }
    },
  }
}

/** Export one authoritative inventory into a per-call owned path. Failure is not absence. */
async function readWingetInventory(io) {
  const exportPath = io.tmpFile(`dsh-gitbash-shell-wg-export-${randomUUID()}.json`)
  try {
    const result = await io.run('winget', exportArgv(exportPath), PROBE_TIMEOUT_MS)
    if (result.code !== 0) throw new Error(`export exited with code ${result.code}`)
    const text = io.readFile(exportPath)
    const json = JSON.parse(text)
    if (!json || !Array.isArray(json.Sources) || json.Sources.some(source =>
      !source || typeof source.SourceDetails?.Name !== 'string' || !Array.isArray(source.Packages)
      || source.Packages.some(pkg => !pkg || typeof pkg.PackageIdentifier !== 'string'))) {
      throw new Error('invalid export structure')
    }
    return parseExportJson(text, TOOLCHAIN)
  } catch (error) {
    throw new Error(`winget inventory unavailable: ${error?.message ?? error}`)
  } finally {
    io.remove(exportPath)
  }
}

/**
 * The whole catalog's state in four winget/PATH reads: one `--version` probe,
 * one `export` inventory, one `--upgrade-available` list, one PATH scan.
 * @param {object} io - runner IO.
 * @returns {Promise<object>} the status payload the card renders.
 */
export async function probeToolchain(io) {
  // winget's own probe is async here; probeWinget() in toolchain.js is the
  // synchronous equivalent used by the unit tests.
  const versionRun = await io.run('winget', ['--version'], PROBE_TIMEOUT_MS)
  const versionMatch = String(versionRun.output || '').match(/v?(\d+\.\d+\.\d+)/)
  const wingetOk = versionRun.code === 0 && !!versionMatch

  let hits = new Map()
  try { hits = scanCommands(io, TOOLCHAIN) } catch { hits = new Map() }

  if (!wingetOk) {
    // Without winget nothing can be installed or upgraded; still report what is
    // on the machine so the card explains itself instead of showing an error.
    return {
      winget: { ok: false, version: '' },
      tools: TOOLCHAIN.map((tool) => rowFor(tool, { hits, owned: undefined, upgradable: false, wingetOk: false })),
      sourceNote: '',
    }
  }

  const owned = await readWingetInventory(io)

  let upgradable = new Set()
  try {
    const listed = await io.run('winget', listUpgradableArgv(), PROBE_TIMEOUT_MS)
    upgradable = parseUpgradable(listed.output, TOOLCHAIN)
  } catch {
    upgradable = new Set()
  }

  const tools = TOOLCHAIN.map((tool) => rowFor(tool, { hits, owned: owned.get(tool.id), upgradable: upgradable.has(tool.id), wingetOk: true }))
  return {
    winget: { ok: true, version: versionMatch[1] },
    tools,
    sourceNote: 'winget',
  }
}

/** One card row: the catalog facts plus what this machine actually has. */
function rowFor(tool, facts) {
  const path = facts.hits.get(tool.cmd) || ''
  const owned = facts.owned
  const state = facts.wingetOk
    ? classifyToolState({ hasCommand: path !== '', wingetOwned: !!owned, upgradable: !!facts.upgradable })
    : (path !== '' ? 'external' : 'missing')
  return {
    id: tool.id,
    cmd: tool.cmd,
    group: tool.group,
    admin: tool.admin === true,
    wingetId: owned ? owned.pkgId : tool.ids[0],
    publisher: tool.publisher || '',
    source: tool.source || '',
    note: tool.note || '',
    state,
    actionable: isActionable(state),
    // Present only when the command resolves; for a winget-owned package whose
    // MSI did not add its directory to PATH this stays empty and the row is
    // still `current`, which is the honest description.
    commandPath: path,
    provider: owned ? 'winget' : (path ? describeProvider(path) : ''),
    version: owned && owned.version ? owned.version : '',
  }
}

/**
 * Install or upgrade the requested catalog entries, one at a time, recording
 * progress in the module-level job so the card can poll it. Returns when the
 * whole batch is done; callers that do not want to wait use `startToolJob`.
 * @param {object} io - runner IO.
 * @param {{ action: string, ids: string[] }} request
 * @param {(job: object) => void} [onChange] - called after each entry.
 * @returns {Promise<object>} the finished job.
 */
export async function runToolJob(io, request, onChange) {
  // 'auto' (what the card sends) lets the inventory decide per entry: a package
  // winget already owns is UPGRADED, anything else is INSTALLED. An explicit
  // 'install'/'upgrade' still wins when a caller states one.
  const requested = request && typeof request.action === 'string' ? request.action : 'auto'
  const mode = requested === 'install' || requested === 'upgrade' ? requested : 'auto'
  const wanted = Array.isArray(request && request.ids) ? request.ids : []
  // Map request ids onto the CLOSED catalog; unknown ids are dropped, never
  // forwarded. Duplicates collapse so a request cannot install twice.
  const entries = [...new Set(wanted)].map((id) => toolById(id)).filter(Boolean)

  const job = {
    id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8),
    action: mode,
    total: entries.length,
    done: 0,
    current: '',
    // v0.43.0 (issue #35): observability + cancellation. `currentSince` times
    // the entry in flight, `lastOutput` mirrors the freshest winget line,
    // `cancelled` is set by cancelToolJob(), and `io` is kept so the cancel
    // path can reach the process tree. The route's snapshot picks fields
    // explicitly, so the io reference never reaches the wire.
    startedAt: Date.now(),
    currentSince: 0,
    lastOutput: '',
    cancelled: false,
    finished: false,
    results: [],
    io,
  }
  activeJob = job

  // Resolve what winget actually owns BEFORE upgrading: an upgrade must target
  // the installed package id (GNU vs MSVC ripgrep), never the preferred one.
  let owned = new Map()
  if (entries.length > 0) {
    try {
      owned = await readWingetInventory(io)
    } catch (error) {
      if (job.cancelled) {
        // The cancel landed while the inventory was being read: nothing was
        // attempted, so nothing may be reported as a failure.
        job.results = entries.map((tool) => ({
          id: tool.id, cmd: tool.cmd, action: mode === 'upgrade' ? 'upgrade' : 'install',
          wingetId: tool.ids[0], admin: tool.admin === true, ok: false, kind: 'skipped',
          detail: 'cancelled before this entry started',
        }))
        job.done = entries.length
        job.current = ''
        job.finished = true
        if (onChange) onChange(job)
        return job
      }
      // Do not choose a preferred build or start an installer from an unknown inventory.
      job.results = entries.map(tool => ({
        id: tool.id, cmd: tool.cmd, action: mode === 'upgrade' ? 'upgrade' : 'install',
        wingetId: tool.ids[0], admin: tool.admin === true, ok: false, kind: 'failed',
        detail: `${error?.message ?? error}; no install or upgrade was attempted`,
      }))
      job.done = entries.length
      job.finished = true
      if (onChange) onChange(job)
      return job
    }
  }

  for (const tool of entries) {
    const installed = owned.get(tool.id)
    const useUpgrade = mode === 'upgrade' || (mode === 'auto' && !!installed)
    const base = {
      id: tool.id,
      cmd: tool.cmd,
      action: useUpgrade ? 'upgrade' : 'install',
      wingetId: installed ? installed.pkgId : tool.ids[0],
      admin: tool.admin === true,
    }
    // A cancel lands between entries too: the remaining ones are skipped, not
    // failed (issue #35) — the user asked to stop, not to be told it broke.
    if (job.cancelled) {
      job.results.push({ ...base, ok: false, kind: 'skipped', detail: 'cancelled before this entry started' })
      job.done += 1
      if (onChange) onChange(job)
      continue
    }
    job.current = tool.cmd
    job.currentSince = Date.now()
    if (onChange) onChange(job)
    const argv = useUpgrade ? upgradeArgv(tool, installed && installed.pkgId) : installArgv(tool)
    const hooks = { onOutput: (line) => { job.lastOutput = line } }
    let verdict
    try {
      const result = await io.run('winget', argv, INSTALL_TIMEOUT_MS, hooks)
      verdict = verdictFrom(result)
      // An explicit "install" on something winget already owns is really an
      // upgrade request; retry as one so the user's click does the obvious thing.
      if (!verdict.ok && !useUpgrade && verdict.kind === 'not-found' && installed && !job.cancelled) {
        const retry = await io.run('winget', upgradeArgv(tool, installed.pkgId), INSTALL_TIMEOUT_MS, hooks)
        verdict = verdictFrom(retry)
      }
    } catch (error) {
      verdict = { ok: false, kind: 'failed', detail: String((error && error.message) || error) }
    }
    job.results.push({ ...base, ok: verdict.ok, kind: verdict.kind, detail: verdict.detail })
    job.done += 1
    if (onChange) onChange(job)
  }

  job.current = ''
  job.finished = true
  if (onChange) onChange(job)
  return job
}

/** Start a job in the background and hand back its id immediately. */
export function startToolJob(io, request) {
  if (activeJob && !activeJob.finished) return { started: false, job: activeJob }
  // Each entry records its own verdict; this catch only stops a failure inside
  // the runner from becoming an unhandled rejection.
  const promise = runToolJob(io, request).catch(() => activeJob)
  return { started: true, promise }
}

/** The job the card should be showing, or null. */
export function currentToolJob() {
  return activeJob
}

/**
 * Cancel the active job: mark it, then kill the whole winget process tree so
 * the in-flight entry ends immediately and the loop marks the rest skipped
 * (issue #35). A no-op on a finished or missing job, or on an id mismatch.
 * @param {string} [id] - when given, only that job is cancelled.
 * @returns {object} the (possibly unchanged) current job.
 */
export function cancelToolJob(id) {
  const job = activeJob
  if (!job || job.finished) return currentToolJob()
  if (id && job.id !== id) return job
  job.cancelled = true
  try { if (job.io && typeof job.io.cancelActive === 'function') job.io.cancelActive() } catch { /* best effort */ }
  return job
}

/** Forget a finished job (called when the card closes the progress view).
 *  Closing it MID-RUN now cancels instead: the old clear just dropped the
 *  activeJob lock and let a second job race the still-running winget — a
 *  half-applied catalog was one click away (issue #35). */
export function clearToolJob(id) {
  const job = activeJob
  if (!job) return
  if (!job.finished) {
    cancelToolJob(id)
    return
  }
  if (!id || job.id === id) activeJob = null
}

// ── request fencing ─────────────────────────────────────────────────────────

/** Loopback in every spelling a Node socket reports on Windows. */
export function isLoopbackAddress(address) {
  const value = String(address || '')
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1' || value.startsWith('127.')
}

/**
 * Whether an Origin/Referer value belongs to the same host the request arrived
 * on. A browser always sends one of them on a cross-site request, so a mismatch
 * is exactly the CSRF case this fence exists for.
 * @param {string} value - the Origin or Referer header.
 * @param {string} host - the request's Host header.
 * @returns {boolean}
 */
export function isSameOriginValue(value, host) {
  if (typeof value !== 'string' || value === '') return false
  let origin
  try { origin = new URL(value).host } catch { return false }
  const expected = String(host || '').toLowerCase()
  if (expected === '') return false
  return origin.toLowerCase() === expected
}

/**
 * The fence for the tools route. Installing is a side effect, so:
 *   - the peer must be loopback (a LAN or tunnel client never gets to install);
 *   - a mutating request that CARRIES an Origin or Referer must match Host.
 * A same-origin GET from the settings page passes; a form/fetch posted by any
 * other page fails on the origin check.
 * A mutating request with NO origin header passes the origin half (issue #33):
 * the desktop Electron renderer's same-origin fetch sends no Origin/Referer,
 * and browsers attach Origin to every mutating request — same-site and
 * cross-site alike — so a missing header cannot be web-page CSRF; it can only
 * come from a non-browser client, which could forge a same-origin header just
 * as easily. The loopback requirement stays (the real fence) and a carried
 * cross-origin value is still refused.
 * @param {{ method?: string, headers?: object, socket?: object }} req
 * @returns {{ ok: boolean, reason: string }}
 */
export function fenceToolRequest(req) {
  const socket = req && req.socket ? req.socket : {}
  if (!isLoopbackAddress(socket.remoteAddress)) return { ok: false, reason: 'not-loopback' }
  const method = String((req && req.method) || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return { ok: true, reason: '' }
  const headers = (req && req.headers) || {}
  const host = headers.host || ''
  const origin = headers.origin || headers.referer || ''
  if (origin === '') return { ok: true, reason: '' }
  if (!isSameOriginValue(origin, host)) return { ok: false, reason: 'cross-origin' }
  return { ok: true, reason: '' }
}

/**
 * Read a JSON request body with a hard size cap. Returns null on anything that
 * is not a small JSON object, so the caller answers 400 instead of guessing.
 * @param {object} req - the request stream.
 * @param {number} [limit] - byte ceiling.
 * @returns {Promise<object|null>}
 */
export function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    const fail = () => { resolve(null); try { req.destroy() } catch { /* ignore */ } }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) return fail()
      chunks.push(chunk)
    })
    req.on('error', () => resolve(null))
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null)
      } catch { resolve(null) }
    })
  })
}
