/**
 * dsh-gitbash-shell/fastctx-bridge — the `gb_*` file tools over FastCtx (v0.35.0).
 *
 * FastCtx (github.com/yc-duan/fastctx, Apache-2.0) is a local Rust MCP server
 * with context-efficient file tools: batched ranged reads with an output
 * budget, grep with truncation markers, encoding detection that reports
 * candidate encodings instead of guessing. On a Windows host those four
 * abilities are exactly what the official tools lack, so this bridge publishes
 * them as ADDITIONS (`gb_inspect_local_file`, `gb_grep`, `gb_glob`,
 * `gb_replace`) — the official read/grep/glob/edit tools and their file
 * sandbox stay untouched and remain the default recommendation.
 *
 * TRANSPORT. A minimal MCP stdio client (newline-delimited JSON-RPC over the
 * child's stdin/stdout, ~120 lines). The official @deepseek-ai/dsh-mcp-client
 * exists but is a statically-configured plugin ROW: its `command` must be a
 * literal (no resolver runs in the `!!js` sandbox), its names are locked to
 * `mcp__<server>__<raw>`, and it has no per-server tool allowlist — while this
 * bridge needs a payload path resolved from the profile layout, a closed tool
 * set (FastCtx's shell/background tools must never surface), a dialect
 * translation on every path argument, and a stand-down when dsh-ops is
 * present. When the host one day exposes a runtime bridge API, this module is
 * the first thing to retire — tracked in AGENTS.md.
 *
 * THE PAYLOAD. FastCtx itself is never bundled. The bridge probes, in order,
 * the upstream npm payload (`@fastctx/win32-x64`) and the dsh-ops fork payload
 * (`@dsh-ops/fastctx-win32-x64`, the one this plugin declares as an optional
 * dependency, pinned with a recorded provenance). Neither present -> the
 * bridge mounts nothing and says so once. The server is started WITHOUT
 * `--enable-shell`: FastCtx's command/job tools do not exist in this
 * deployment, and `gb_*` stays a pure file-tool surface.
 *
 * NO SANDBOX, STATED. FastCtx reads the real filesystem with no workspace
 * confinement; that is FastCtx's own contract, so every `gb_` description
 * says the file tools remain the sandboxed default and `gb_replace` warns
 * about its cross-file reach.
 */

/** The only FastCtx tools this bridge ever publishes. */
export const FASTCTX_FILE_TOOLS = Object.freeze(['inspect_local_file', 'grep', 'glob', 'replace'])

/** Public names follow the bridge prefix, never the server's own. */
export const GB_PREFIX = 'gb_'
export const gbName = (raw) => GB_PREFIX + raw

// The HOST registry rejects any tool without an `output` contract (issue #18,
// root cause 2) — the frozen schema + text renderer the pwsh7
// definition ships, reused so both families speak one tool-result contract.
import { TOOL_OUTPUT_SCHEMA, renderTextContent } from './inline-tools.js'

/** Payload packages probed, in order: upstream first, the pinned fork second. */
export const PAYLOAD_PACKAGES = Object.freeze([
  { pkg: '@fastctx/win32-x64', exe: 'bin/fastctx.exe' },
  { pkg: '@dsh-ops/fastctx-win32-x64', exe: 'bin/fastctx.exe' },
])

/**
 * Resolve the fastctx executable from the profile's resolution base. Pure in
 * its decisions, I/O through the injected `createRequireFrom`.
 * @returns {{ file: string, source: string } | { file: '', source: '' }}
 */
export function resolveFastctx(ctx, createRequireFrom) {
  let req
  try {
    req = createRequireFrom(ctx?.baseUrl ?? import.meta.url)
  } catch {
    return { file: '', source: '' }
  }
  for (const { pkg, exe } of PAYLOAD_PACKAGES) {
    try {
      const root = req.resolve(`${pkg}/package.json`)
      const { join, dirname } = req('node:path')
      const { existsSync } = req('node:fs')
      const file = join(dirname(root), exe)
      if (existsSync(file)) return { file, source: pkg }
    } catch { /* probe the next payload */ }
  }
  return { file: '', source: '' }
}

/**
 * One MCP stdio connection. Requests carry incrementing ids; responses are
 * matched by id; the server's stderr is captured for the error report. Every
 * call has a deadline. NOT thread-safe — the harness serializes tool calls.
 */
export class McpStdio {
  constructor({ file, args = [], timeoutMs = 60_000, log = () => {} }) {
    this.file = file
    this.args = args
    this.timeoutMs = timeoutMs
    this.log = log
    this.child = undefined
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.stderrTail = ''
    this.dead = false
  }

  /** Spawn the server and run the MCP initialize handshake. */
  async start() {
    const { spawn } = await import('node:child_process')
    this.child = spawn(this.file, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this.#onChunk(chunk))
    this.child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000)
    })
    this.child.on('exit', (code) => {
      this.dead = true
      for (const [, { reject }] of [...this.pending]) {
        reject(new Error(`the FastCtx server exited (code ${code ?? 'null'})`))
      }
      this.pending.clear()
    })
    await this.#request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-gitbash-shell', version: '0.35.0' },
    })
    this.#notify('notifications/initialized')
    return this
  }

  /** List the server's tools: [{ name, description, inputSchema }]. */
  async listTools() {
    const result = await this.#request('tools/list', {})
    return Array.isArray(result?.tools) ? result.tools : []
  }

  /** Call one tool; returns the raw MCP result ({ content, isError? }). */
  async callTool(rawName, args) {
    return this.#request('tools/call', { name: rawName, arguments: args ?? {} })
  }

  /** Whether the transport is gone (a later call re-launches via the mount). */
  get isDead() { return this.dead }

  async close() {
    this.dead = true
    const child = this.child
    this.child = undefined
    for (const [, { reject }] of [...this.pending]) {
      reject(new Error('the FastCtx bridge was stopped'))
    }
    this.pending.clear()
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill() } catch { /* already gone */ }
    }
  }

  #onChunk(chunk) {
    this.buffer += chunk
    let at = this.buffer.indexOf('\n')
    while (at !== -1) {
      const line = this.buffer.slice(0, at).trim()
      this.buffer = this.buffer.slice(at + 1)
      if (line !== '') this.#onLine(line)
      at = this.buffer.indexOf('\n')
    }
  }

  #onLine(line) {
    let message
    try { message = JSON.parse(line) } catch { return /* not JSON: ignore */ }
    const id = message?.id
    if (id !== undefined && this.pending.has(id)) {
      const { resolve, reject, timer } = this.pending.get(id)
      clearTimeout(timer)
      this.pending.delete(id)
      if (message.error) reject(new Error(String(message.error.message ?? JSON.stringify(message.error))))
      else resolve(message.result)
    }
  }

  #send(frame) {
    if (!this.child || this.dead) throw new Error('the FastCtx server is not running')
    this.child.stdin.write(JSON.stringify(frame) + '\n')
  }

  #notify(method, params) {
    this.#send({ jsonrpc: '2.0', method, ...params !== undefined ? { params } : {} })
  }

  #request(method, params) {
    if (!this.child || this.dead) return Promise.reject(new Error('the FastCtx server is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.#send({ jsonrpc: '2.0', id, method, ...params !== undefined ? { params } : {} })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }
}

/**
 * Translate the path-bearing fields of one gb_* argument object, MSYS ->
 * Windows, using the SAME mount table the official file tools get. Handles
 * the fastctx shapes: `path`, `file_path`, `files[].path`, and an absolute
 * glob `pattern`. Pure.
 */
export function translateFastctxArgs(args, msysToWin) {
  if (!msysToWin || !args || typeof args !== 'object') return args
  const translate = (value) => (typeof value === 'string' ? msysToWin(value) : value)
  const out = { ...args }
  for (const field of ['path', 'file_path', 'workdir']) {
    if (typeof out[field] === 'string') out[field] = translate(out[field])
  }
  if (Array.isArray(out.files)) {
    out.files = out.files.map((entry) => (entry && typeof entry === 'object' && typeof entry.path === 'string'
      ? { ...entry, path: translate(entry.path) }
      : entry))
  }
  // A glob pattern that is absolute (starts with a drive root or /) is
  // translated whole; a relative pattern must stay relative.
  if (typeof out.pattern === 'string' && /^[/~]/.test(out.pattern)) {
    out.pattern = translate(out.pattern)
  }
  return out
}

/**
 * Render one MCP result as the text the model reads, with the dialect echo
 * applied to the text blocks. Mirrors the host's own MCP projection closely
 * enough for these four tools: text blocks joined, non-text blocks named.
 * Pure.
 */
export function renderFastctxResult(rawName, result, echo) {
  const content = Array.isArray(result?.content) ? result.content : []
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else parts.push(`[unsupported MCP content block: ${String(block?.type ?? 'unknown')}]`)
  }
  let text = parts.join('\n')
  if (text === '') text = `(${gbName(rawName)} returned no content)`
  if (echo) text = echo(text)
  const header = result?.isError === true ? `${gbName(rawName)} failed: ` : ''
  return header + text
}

/** The sandbox honesty line appended to every gb_* description. */
const FASTCTX_SANDBOX_NOTE = 'FastCtx reads the real filesystem with no workspace confinement: for sandboxed work prefer the official read/grep/glob/edit tools, which stay the default.'

/**
 * Mount the bridge. `deps`:
 *   - platform        -> process.platform (win32 only mounts)
 *   - enabled()       -> the row switch (fastctxTools)
 *   - createRequireFrom(ctx) -> the profile resolution seam
 *   - tools(ctx)      -> the host tool registry (or undefined)
 *   - msysToWin(path) -> argument dialect translation
 *   - echo(text)      -> result dialect echo, or undefined (off)
 *   - log(message)    -> the plugin's tagged logger
 *
 * The surface publishes at the FIRST agent creation and re-decides on every
 * later one: dsh-ops appearing (ops_* tools in the face) withdraws gb_* for
 * the rest of the process — duplicates would only teach the model two names
 * for one job.
 */
export function mountFastctx(ctx, deps) {
  const { platform, enabled, createRequireFrom, tools, msysToWin, echo, log } = deps
  if (platform !== 'win32') return
  let disposer = undefined
  let client = undefined
  let decided = false
  let withdrawnByOps = false

  const unpublish = (reason) => {
    if (disposer) {
      try { disposer() } catch { /* already gone */ }
      disposer = undefined
    }
    if (reason) log(reason)
  }

  const callWithReconnect = async (rawName, args) => {
    if (client === undefined || client.isDead) {
      const { file } = resolveFastctx(ctx, createRequireFrom)
      if (file === '') throw new Error('the FastCtx payload is not installed; repair the profile dependencies (frozen install) and retry')
      client = await new McpStdio({ file, log }).start()
    }
    return client.callTool(rawName, args)
  }

  const publish = async () => {
    if (disposer || decided && withdrawnByOps) return
    const registry = tools(ctx)
    if (!registry || typeof registry.register !== 'function') return
    const { file, source } = resolveFastctx(ctx, createRequireFrom)
    if (file === '') {
      log('FastCtx payload not found (probed ' + PAYLOAD_PACKAGES.map((p) => p.pkg).join(', ') + '); gb_* tools stay unpublished')
      decided = true
      withdrawnByOps = true // nothing to publish either way; stop re-deciding
      return
    }
    const fresh = new McpStdio({ file, log })
    let toolList
    try {
      await fresh.start()
      toolList = await fresh.listTools()
    } catch (error) {
      try { await fresh.close() } catch { /* best effort */ }
      log(`FastCtx server start failed (${source}): ${error?.message ?? error}; gb_* tools stay unpublished`)
      decided = true
      withdrawnByOps = true
      return
    }
    await fresh.close()
    client = undefined // the first call re-launches lazily; boot stays cheap
    const wanted = toolList.filter((tool) => FASTCTX_FILE_TOOLS.includes(String(tool?.name)))
    const registered = []
    const registeredNames = []
    for (const tool of wanted) {
      const rawName = String(tool.name)
      const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} }
      // Ignore-rule transparency (v0.38.5, the field smoke report): the three
      // "find files" surfaces disagree by default — the official glob ignores
      // nothing, gb_grep honors .gitignore and skips .git, while gb_glob only
      // honors a bare .ignore file and keeps .git visible. State it on the
      // tools the model sees, instead of letting mixed usage produce
      // surprising result sets.
      const ignoreNote = rawName === 'glob'
        ? '\nIgnore rules: this tool only honors a bare .ignore file and does NOT hide .git — use gb_grep (honors .gitignore) or the official glob when those semantics are wanted.'
        : rawName === 'grep'
          ? '\nIgnore rules: this tool honors .gitignore and skips .git — unlike gb_glob (bare .ignore only) and the official glob (ignores nothing).'
          : ''
      try {
        const dispose = registry.register({
          name: gbName(rawName),
          description: `${String(tool.description ?? rawName)}\n${FASTCTX_SANDBOX_NOTE}${ignoreNote}`,
          parameters: schema,
          output: {
            schema: TOOL_OUTPUT_SCHEMA,
            render: (_args, value) => renderTextContent(value),
          },
          async execute(args) {
            // Fail LOUD on malformed patterns (v0.38.5, the field smoke
            // report): the upstream server silently treats a non-string
            // pattern as "everything", which turns a typo into a full-tree
            // result set — a silent wrong answer is worse than an error.
            if ((rawName === 'glob' || rawName === 'replace') && args !== null && typeof args === 'object' && 'pattern' in args) {
              const pattern = args.pattern
              if (typeof pattern !== 'string' || pattern.trim() === '') {
                throw new Error(`invalid arguments: ${gbName(rawName)} pattern must be a non-empty string (got ${pattern === null ? 'null' : typeof pattern})`)
              }
            }
            const translated = translateFastctxArgs(args, msysToWin)
            const result = await callWithReconnect(rawName, translated)
            return { content: [{ type: 'text', text: renderFastctxResult(rawName, result, echo) }] }
          },
        })
        if (typeof dispose === 'function') {
          registered.push(dispose)
          registeredNames.push(gbName(rawName))
        }
      } catch (error) {
        log(`${gbName(rawName)} registration failed: ${error?.message ?? error}`)
      }
    }
    if (registered.length === 0) {
      log('FastCtx published none of the known file tools; nothing registered')
      decided = true
      withdrawnByOps = true
      return
    }
    disposer = () => { for (const dispose of registered) dispose() }
    log(`FastCtx bridge active (${source}): ${registeredNames.join(', ')}`)
  }

  const reconcile = (agent) => {
    if (!enabled()) { unpublish('FastCtx bridge disabled by the fastctxTools switch'); decided = true; withdrawnByOps = true; return }
    if (decided && withdrawnByOps) return
    let names = []
    try {
      names = (tools(ctx)?.schemas?.(agent) ?? []).map((schema) => schema.name).filter((name) => typeof name === 'string')
    } catch { /* a broken face reads as empty */ }
    if (names.some((name) => name === 'ops_inspect_local_file' || name === 'ops_grep' || name === 'ops_bash')) {
      if (!withdrawnByOps) {
        withdrawnByOps = true
        decided = true
        unpublish('dsh-ops detected (ops_* tools present): the gb_* surface stands down')
      }
      return
    }
    void publish().catch((error) => log(`FastCtx bridge mount failed: ${error?.message ?? error}`))
  }

  try {
    ctx.on('agent/created', ({ agent } = {}) => { try { reconcile(agent) } catch { /* never break agent creation */ } })
  } catch (error) {
    log(`FastCtx bridge wiring failed: ${error?.message ?? error}`)
    return
  }
  ctx.effect(() => () => {
    unpublish()
    if (client) { void client.close().catch(() => {}) }
  }, 'dsh-gitbash-shell: FastCtx bridge')
}
