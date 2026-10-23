/**
 * dsh-gitbash-shell — terminal toolchain cancel / timeout / network endings
 * (v0.43.0, issue #35).
 *
 * youyv's report: a wedged winget download left the card "processing" for the
 * whole 15-minute ceiling with no cancel and no signal, `clear` dropped the
 * lock while winget kept running, and an execFile timeout surfaced as a plain
 * failure. These tests pin the replacement contract:
 *
 *   - `cancelToolJob()` marks the job, kills the tree, the entry in flight
 *     ends `cancelled`, the rest end `skipped` — never `failed`;
 *   - `clearToolJob()` on an UNFINISHED job is now the same as cancelling it;
 *   - `defaultRunnerIo.run` labels hard timeouts (`timedOut`) and wedged
 *     downloads (`networkRetry`, via NETWORK_RETRY_PATTERN + a window), and
 *     streams the freshest line through `hooks.onOutput`;
 *   - the route snapshot carries startedAt/currentSince/lastOutput/cancelled
 *     and the POST ?action=cancel branch exists (source assertions).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  NETWORK_RETRY_PATTERN, cancelToolJob, clearToolJob, currentToolJob,
  defaultRunnerIo, runToolJob,
} from '../src/tool-runner.js'

const indexSource = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
const clientSource = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

/** A minimal winget export that parseExportJson accepts. */
const EXPORT_JSON = JSON.stringify({
  Sources: [{ SourceDetails: { Name: 'winget' }, Packages: [] }],
})

/**
 * Scripted IO: every `run` hangs until the test resolves it through
 * `settle()`, `cancelActive()` mirrors the host's kill-the-tree semantics.
 * Dispatch on argv[0]: the inventory `export` succeeds from EXPORT_JSON,
 * installs/upgrades hang.
 */
function scriptedIo(opts = {}) {
  const io = {
    calls: [],
    cancelled: false,
    pending: null,
    cancelActive() {
      io.cancelled = true
      const settle = io.pending
      io.pending = null
      if (settle) settle({ code: 1, output: 'terminated', cancelled: true })
    },
    run(file, args, timeoutMs, hooks) {
      io.calls.push(String(args[0]))
      if (io.cancelled) return Promise.resolve({ code: 1, output: 'cancelled', cancelled: true })
      return new Promise((resolve) => {
        if (String(args[0]) === 'export' && opts.hangExport !== true) {
          resolve({ code: 0, output: '' })
          return
        }
        io.pending = resolve
      })
    },
    pathDirs: () => [],
    readdir: () => [],
    isFile: () => false,
    readFile: () => EXPORT_JSON,
    tmpFile: (name) => '/tmp/' + name,
    remove: () => {},
  }
  return io
}

const TOOL_IDS = require_catalog_ids()

function require_catalog_ids() {
  // The catalog is the closed vocabulary; pick two real ids from it.
  const source = readFileSync(new URL('../src/toolchain.js', import.meta.url), 'utf8')
  const ids = [...source.matchAll(/\{ id: '([a-z0-9-]+)', cmd:/g)].map((m) => m[1])
  assert.ok(ids.length >= 2, 'the catalog must expose at least two ids')
  return ids.slice(0, 2)
}

test('cancel marks the in-flight entry cancelled and the rest skipped', async () => {
  const io = scriptedIo()
  const promise = runToolJob(io, { action: 'auto', ids: TOOL_IDS })
  // Wait for the first install to be pending, then cancel.
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(io.calls[0], 'export', 'the inventory read comes first')
  const job = cancelToolJob('')
  assert.equal(job.cancelled, true)
  assert.equal(io.cancelled, true, 'cancel reaches the process tree through io')
  const finished = await promise
  assert.equal(finished.finished, true)
  assert.equal(finished.cancelled, true)
  assert.equal(finished.results.length, TOOL_IDS.length)
  assert.equal(finished.results[0].kind, 'cancelled')
  assert.equal(finished.results[0].ok, false)
  for (const entry of finished.results.slice(1)) {
    assert.equal(entry.kind, 'skipped', 'remaining entries are skipped, not failed')
    assert.equal(entry.ok, false)
  }
})

test('clearToolJob on an unfinished job now cancels it instead of dropping the lock', async () => {
  const io = scriptedIo()
  const promise = runToolJob(io, { action: 'auto', ids: TOOL_IDS })
  await new Promise((resolve) => setTimeout(resolve, 10))
  clearToolJob('')
  assert.equal(io.cancelled, true, 'mid-run clear must reach the running tree (issue #35)')
  const finished = await promise
  assert.equal(finished.cancelled, true)
  // A finished job is forgotten by the same call.
  clearToolJob('')
  assert.equal(currentToolJob(), null)
})

test('a cancel landing during the inventory read skips every entry', async () => {
  const io = scriptedIo({ hangExport: true })
  const promise = runToolJob(io, { action: 'auto', ids: TOOL_IDS })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(io.calls[0], 'export')
  cancelToolJob('')
  const finished = await promise
  assert.equal(finished.finished, true)
  assert.equal(finished.results.length, TOOL_IDS.length)
  for (const entry of finished.results) {
    assert.equal(entry.kind, 'skipped', 'nothing was attempted, nothing is failed')
  }
})

test('verdict endings sort timeout and wedged downloads from plain failures', async () => {
  const io = scriptedIo()
  // Drive verdictFrom indirectly: settle the first install with each ending.
  const promise = runToolJob(io, { action: 'auto', ids: TOOL_IDS.slice(0, 1) })
  await new Promise((resolve) => setTimeout(resolve, 10))
  io.pending({ code: -1, output: ' installer exited', timedOut: true })
  const finished = await promise
  assert.equal(finished.results[0].kind, 'timeout')
  assert.ok(finished.results[0].detail.includes('installer exited'))
})

test('defaultRunnerIo: hard timeout ends the tree and labels the run', async () => {
  const io = defaultRunnerIo({ networkRetryWindowMs: 60_000 })
  const result = await io.run(process.execPath, ['--input-type=module', '-e', 'setInterval(()=>{},50)'], 120)
  assert.equal(result.timedOut, true)
  assert.equal(result.code, -1)
  assert.equal(result.cancelled, undefined)
})

test('defaultRunnerIo: cancelActive ends the run with cancelled', async () => {
  const io = defaultRunnerIo({ networkRetryWindowMs: 60_000 })
  const promise = io.run(process.execPath, ['-e', 'setInterval(()=>{},50)'], 30_000)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(io.cancelActive(), true)
  const result = await promise
  assert.equal(result.cancelled, true)
  assert.equal(result.timedOut, undefined)
})

test('defaultRunnerIo: the wedged-download watchdog fires after the window', async () => {
  const io = defaultRunnerIo({ networkRetryWindowMs: 150 })
  const script = "console.error('Failed to download, waiting a bit and retry.'); setInterval(()=>{},50)"
  const result = await io.run(process.execPath, ['-e', script], 30_000)
  assert.equal(result.networkRetry, true)
  assert.equal(result.code, -1)
})

test('defaultRunnerIo: a healthy run is unlabeled and onOutput sees the last line', async () => {
  const io = defaultRunnerIo({ networkRetryWindowMs: 60_000 })
  const seen = []
  const result = await io.run(process.execPath, ['-e', "console.error('line one'); console.error('final line')"], 15_000, {
    onOutput: (line) => seen.push(line),
  })
  assert.equal(result.code, 0)
  assert.equal(result.timedOut, undefined)
  assert.equal(result.networkRetry, undefined)
  assert.equal(seen[seen.length - 1], 'final line')
  // The retry chatter alone must NOT trip a run that finished inside the window.
  const quick = await io.run(process.execPath, ['-e', "console.error('Failed to download, waiting a bit and retry.')"], 15_000)
  assert.equal(quick.networkRetry, undefined)
  assert.equal(quick.code, 0)
})

test('defaultRunnerIo: a spawn failure stays a synthetic non-zero exit', async () => {
  const io = defaultRunnerIo({})
  const result = await io.run('definitely-not-a-real-binary-xyz', [], 5_000)
  assert.equal(result.code, -1)
  assert.equal(typeof result.output, 'string')
})

test('the route exposes cancel and the extended snapshot (source assertions)', () => {
  assert.ok(indexSource.includes("action === 'cancel'"), 'the POST ?action=cancel branch exists')
  assert.ok(indexSource.includes('cancelToolJob'), 'the route imports cancelToolJob')
  assert.ok(indexSource.includes('startedAt: job.startedAt'), 'the snapshot carries startedAt')
  assert.ok(indexSource.includes('currentSince: job.currentSince'), 'the snapshot carries currentSince')
  assert.ok(indexSource.includes('lastOutput: job.lastOutput'), 'the snapshot carries lastOutput')
  assert.ok(indexSource.includes('cancelled: job.cancelled === true'), 'the snapshot carries cancelled')
})

test('the card renders cancel, elapsed, the tail line and per-kind verdicts', () => {
  assert.ok(clientSource.includes('?action=cancel'), 'the card posts ?action=cancel')
  assert.ok(clientSource.includes('formatElapsed('), 'elapsed time helper is wired')
  assert.ok(clientSource.includes('gb-toolTail'), 'the freshest winget line is rendered')
  assert.ok(clientSource.includes('tools.kind.cancelled'), 'cancelled verdict copy is wired')
  assert.ok(clientSource.includes('tools.kind.skipped'), 'skipped verdict copy is wired')
  assert.ok(clientSource.includes('tools.kind.timeout'), 'timeout verdict copy is wired')
  assert.ok(clientSource.includes('tools.kind.network'), 'network verdict copy is wired')
  assert.ok(clientSource.includes('tools.cancelledNote'), 'the finished-cancelled note is wired')
  // Skipped entries never print a failure detail line.
  assert.ok(clientSource.includes('entry.kind !== "skipped"'))
})
