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

import { execFile } from 'node:child_process'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
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

/** Only one job at a time: winget serializes on its own state anyway, and two
 *  concurrent installs is how a half-applied catalog happens. */
let activeJob = null

/**
 * The real IO. `run` never rejects: a non-zero exit is data, and a spawn
 * failure becomes a synthetic exit code so callers have one shape to handle.
 * @returns {object}
 */
export function defaultRunnerIo() {
  return {
    run(file, args, timeoutMs) {
      return new Promise((resolve) => {
        execFile(file, args, { windowsHide: true, timeout: timeoutMs || PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
          const output = String(stdout || '') + String(stderr || '')
          if (error) {
            const code = typeof error.code === 'number' ? error.code : -1
            return resolve({ code, output: output || String(error.message || '') })
          }
          resolve({ code: 0, output })
        })
      })
    },
    pathDirs() {
      return String(process.env.PATH || '').split(';').filter(Boolean)
    },
    readdir(dir) {
      return readdirSync(dir)
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

  const exportPath = io.tmpFile('dsh-gitbash-shell-wg-export.json')
  let owned = new Map()
  try {
    await io.run('winget', exportArgv(exportPath), PROBE_TIMEOUT_MS)
    owned = parseExportJson(io.readFile(exportPath), TOOLCHAIN)
  } catch {
    owned = new Map()
  } finally {
    io.remove(exportPath)
  }

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
    finished: false,
    results: [],
  }
  activeJob = job

  // Resolve what winget actually owns BEFORE upgrading: an upgrade must target
  // the installed package id (GNU vs MSVC ripgrep), never the preferred one.
  let owned = new Map()
  if (entries.length > 0) {
    const exportPath = io.tmpFile('dsh-gitbash-shell-wg-export.json')
    try {
      await io.run('winget', exportArgv(exportPath), PROBE_TIMEOUT_MS)
      owned = parseExportJson(io.readFile(exportPath), TOOLCHAIN)
    } catch { owned = new Map() } finally { io.remove(exportPath) }
  }

  for (const tool of entries) {
    job.current = tool.cmd
    if (onChange) onChange(job)
    const installed = owned.get(tool.id)
    const useUpgrade = mode === 'upgrade' || (mode === 'auto' && !!installed)
    const argv = useUpgrade ? upgradeArgv(tool, installed && installed.pkgId) : installArgv(tool)
    let verdict
    try {
      const result = await io.run('winget', argv, INSTALL_TIMEOUT_MS)
      verdict = classifyWingetResult(result.code, result.output)
      // An explicit "install" on something winget already owns is really an
      // upgrade request; retry as one so the user's click does the obvious thing.
      if (!verdict.ok && !useUpgrade && verdict.kind === 'not-found' && installed) {
        const retry = await io.run('winget', upgradeArgv(tool, installed.pkgId), INSTALL_TIMEOUT_MS)
        verdict = classifyWingetResult(retry.code, retry.output)
      }
    } catch (error) {
      verdict = { ok: false, kind: 'failed', detail: String((error && error.message) || error) }
    }
    job.results.push({
      id: tool.id,
      cmd: tool.cmd,
      action: useUpgrade ? 'upgrade' : 'install',
      wingetId: installed ? installed.pkgId : tool.ids[0],
      admin: tool.admin === true,
      ok: verdict.ok,
      kind: verdict.kind,
      detail: verdict.detail,
    })
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

/** Forget a finished job (called when the card closes the progress view). */
export function clearToolJob(id) {
  if (activeJob && (!id || activeJob.id === id)) activeJob = null
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
 *   - a mutating request must carry an Origin or Referer that matches Host.
 * A same-origin GET from the settings page passes; a form/fetch posted by any
 * other page fails on the origin check.
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
  if (origin === '') return { ok: false, reason: 'no-origin' }
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
