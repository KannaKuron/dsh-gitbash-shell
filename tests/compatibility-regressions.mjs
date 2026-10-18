import test from 'node:test'
import assert from 'node:assert/strict'
import { terminalDialect } from '../src/terminal-bundle.js'
import { readFileSync } from 'node:fs'
import { rewriteCodePaths, scanCodeLiterals, runCodeHintFor, translateDispatch, dialectApplies, windowsToMsys, rewriteResultPaths, rewriteErrorContent, rewriteErrorMessage } from '../src/index.js'
import { bashDescription, createBashToolModule } from '../src/bash-tool.js'
import { applyToolRouting, toolRoutingHintFor } from '../src/inline-tools.js'
import { pathToolDescription } from '../src/path-tool.js'
import { renderResult, renderBackground, renderJobRead, renderPromoted, processOutcome, parseExitStatus } from '../src/bash-render.js'

const env = { home: 'C:/Users/审计', tmpDir: 'C:/Temp', gitRoot: 'C:/Program Files/Git' }
const sandbox = { mode: 'workspace-write', denied: false, enforcement: 'unconfined' }
const result = { stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000, sandbox }

// These programs only compute string values; no filesystem or subprocess calls.
test('compatibility: complete Unicode paths and hash filenames become native literals', () => {
  for (const [before, after] of [
    ["return '/c/工作/文件#1.txt'", "return 'C:/工作/文件#1.txt'"],
    ['return "/d/café/中文 文件.txt"', 'return "D:/café/中文 文件.txt"'],
    ['return `/c/工作/文件.txt`', 'return `C:/工作/文件.txt`'],
    ["return '~/笔记.txt'", "return 'C:/Users/审计/笔记.txt'"],
  ]) {
    assert.equal(rewriteCodePaths(before, env), after)
    assert.equal(new Function(after)(), new Function(rewriteCodePaths(before, env))())
  }
})

test('compatibility: a legal EOF line comment does not discard earlier paths', () => {
  const source = "return '/c/工作/a.txt'; // '/d/ignored'"
  assert.ok(Array.isArray(scanCodeLiterals(source)))
  assert.equal(rewriteCodePaths(source, env), "return 'C:/工作/a.txt'; // '/d/ignored'")
  for (const broken of ["const p='/c/a'; /* unfinished", "const p='/c/a'; const q='unfinished", "const p='/c/a'; const t=`${a // missing brace"])
    assert.equal(rewriteCodePaths(broken, env), broken, 'uncertain source still abandons the whole rewrite')
})

test('compatibility: tagged templates retain raw and custom-tag semantics', () => {
  for (const source of [
    'return String.raw`/dev/null`',
    'return tag`/c/工作/a`',
    'return tag()`/c/a`',
    'return tags[0]`/c/a`',
    'return (tag)`/c/a`',
    'const of = String.raw; return of`/dev/null`',
    'const await = String.raw; return await`/dev/null`',
    'const yield = String.raw; return yield`/dev/null`',
  ]) assert.equal(rewriteCodePaths(source, env), source)
  const source = 'const p="/c/工作/a"; return [p, String.raw`/dev/null`]'
  assert.deepEqual(new Function(rewriteCodePaths(source, env))(), ['C:/工作/a', '/dev/null'])
  const device = '\\\\' + '.' + '\\' + 'NUL'
  const deviceSource = rewriteCodePaths("return '/dev/null'", env)
  assert.equal(deviceSource, "return '" + device.replace(/\\/g, '\\\\') + "'")
  assert.equal(new Function(deviceSource)(), device)
})

test('compatibility: interpolation, escape sequences and ambiguous slash stay conservative', () => {
  for (const source of ['return `/c/${name}/文件`', "return '/c/a\\u002eb'", "const p='/c/工作/a'; return (4+2) / 2"])
    assert.equal(rewriteCodePaths(source, env), source)
  assert.equal(rewriteCodePaths("return '/c/' + name", env), "return 'C:/' + name")
  const unsafe = "const p='/c/工作/a'; return '~/b'"
  assert.equal(rewriteCodePaths(unsafe, { home: "C:/user's" }), unsafe, 'translation cannot introduce the closing quote')
})

test('compatibility: run_code hints truthfully distinguish codePaths ON and OFF', () => {
  const tools = [{ name: 'run_code' }]
  assert.match(runCodeHintFor(tools, true), /best-effort/)
  assert.match(runCodeHintFor(tools, true), /tagged templates/)
  assert.match(runCodeHintFor(tools, true), /routes or search data/)
  const off = runCodeHintFor(tools, false)
  assert.match(off, /rewriting is OFF/)
  assert.doesNotMatch(off, /are translated.*before the program/)
  assert.equal(runCodeHintFor([{ name: 'bash' }], false), '')
  const args = { code: "return '/c/a'", file_path: '/c/tool-path.txt' }
  const out = translateDispatch({ name: 'run_code', arguments: args }, { codePaths: false }, env)
  assert.equal(out.code, args.code)
  assert.equal(out.file_path, 'C:/tool-path.txt', 'codePaths does not disable typed tool arguments')
  assert.equal(args.file_path, '/c/tool-path.txt', 'caller input is not mutated')
})

test('compatibility: actual prompt listener reads the live codePaths gate', () => {
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  const start = source.indexOf("ctx.on('system-prompt/assemble',")
  const end = source.indexOf("      console.log(TAG + ' prompt-assembly path dialect active", start)
  assert.ok(start >= 0 && end > start)
  let handler
  let dialect = { posixPaths: true, codePaths: true, subagentDialect: true }
  const ctx = { on(name, fn) { assert.equal(name, 'system-prompt/assemble'); handler = fn } }
  new Function('ctx', 'liveSettings', 'dialectApplies', 'windowsToMsys', 'runCodeHintFor', 'applyToolRouting', 'terminalDialect', source.slice(start, end))(
    ctx, { dialect: () => dialect, pwshTool: () => false }, dialectApplies, windowsToMsys, runCodeHintFor, applyToolRouting, terminalDialect)
  const assemble = agent => {
    const assembly = { tools: [{ name: 'run_code' }], contexts: [{ name: 'gitbash-shell:posix-paths', text: 'BASE' }], sections: [] }
    handler(assembly, { agent }, () => {})
    return assembly.contexts[0].text
  }
  assert.match(assemble(), /best-effort/)
  dialect = { ...dialect, codePaths: false }
  assert.match(assemble(), /rewriting is OFF/)
  dialect = { ...dialect, posixPaths: false }
  assert.equal(assemble(), 'BASE')
  dialect = { ...dialect, posixPaths: true, subagentDialect: false }
  assert.equal(assemble({ session: { header: { origin: 'subagent' } } }), 'BASE')
})

test('routing: offered native/path/pwsh tools have explicit pre-execution decision criteria', () => {
  const tools = ['bash', 'gitbash_native', 'gitbash_to_native_path', 'pwsh'].map(name => ({ name }))
  const hint = toolRoutingHintFor(tools, { pwshVisible: true })
  assert.match(hint, /shell syntax, scripts, pipelines, redirection/)
  assert.match(hint, /gitbash_native before execution/)
  assert.match(hint, /exact literal argv.*\/all or \/c/)
  assert.match(hint, /raw for unknown\/mixed bytes/)
  assert.match(hint, /gitbash_to_native_path only for a complete caller-declared/)
  assert.match(hint, /runtime-built value/)
  assert.match(hint, /use the pwsh tool ONLY when PowerShell cmdlets/)
  assert.match(hint, /denial is a stop condition/)
  assert.match(hint, /never blindly repeat a side-effecting command/)
  assert.doesNotMatch(hint, /ALL commands/)
})

test('routing: visibility matrix never recommends an absent companion or hidden pwsh', () => {
  for (let mask = 0; mask < 8; mask++) for (const pwshVisible of [false, true]) {
    const names = ['bash', ...(mask & 1 ? ['gitbash_native'] : []), ...(mask & 2 ? ['gitbash_to_native_path'] : []), ...(mask & 4 ? ['pwsh'] : [])]
    const hint = toolRoutingHintFor(names.map(name => ({ name })), { pwshVisible })
    assert.equal(hint.includes('gitbash_native'), !!(mask & 1))
    assert.equal(hint.includes('gitbash_to_native_path'), !!(mask & 2))
    assert.equal(/\bpwsh\b/.test(hint), !!(mask & 4) && pwshVisible)
    assert.match(hint, /denial is a stop condition/)
  }
  assert.equal(toolRoutingHintFor(undefined), '')
  assert.equal(toolRoutingHintFor([{ name: 'run_code' }]), '')
})

test('routing: replaceable blocks are idempotent and follow live visibility/dialect', () => {
  const bash = { name: 'bash', description: 'BASE' }
  let tools = [bash, { name: 'gitbash_native' }, { name: 'gitbash_to_native_path' }, { name: 'pwsh' }]
  applyToolRouting(tools, { pwshVisible: true, msys: true })
  const first = bash.description
  applyToolRouting(tools, { pwshVisible: true, msys: true })
  assert.equal(bash.description, first)
  assert.match(first, /\/c\/Users/)
  tools = [bash]
  applyToolRouting(tools, { pwshVisible: false, msys: false })
  assert.ok(bash.description.startsWith('BASE'))
  assert.doesNotMatch(bash.description, /gitbash_native|gitbash_to_native_path|\bpwsh\b|\/c\/Users/)
  assert.equal(bash.description.split('[gitbash tool routing]').length, 2)
})

test('routing: PTC-only presentation teaches offered SDK selection without guessed hidden names', () => {
  const tool = { name: 'run_code', description: 'PTC_BASE' }
  applyToolRouting([tool])
  assert.match(tool.description, /await tools\.<name>/)
  assert.match(tool.description, /typed native-executable binding for exact Windows argv/)
  assert.match(tool.description, /complete-path conversion binding/)
  assert.match(tool.description, /If a needed binding is absent, report the missing capability/)
  assert.match(tool.description, /denial is a stop condition/)
  assert.doesNotMatch(tool.description, /gitbash_native|gitbash_to_native_path|\bpwsh\b/)
  const once = tool.description
  applyToolRouting([tool])
  assert.equal(tool.description, once)
})

test('routing: path binding explains Node runtime conversion and explicitly disallows denial retries', () => {
  const text = pathToolDescription()
  assert.match(text, /runtime-built MSYS paths before direct native Node fs\/path/)
  assert.match(text, /result\.native_path/)
  assert.match(text, /Never pass routes, search strings, shell commands or program source/)
  assert.match(text, /inside run_code/)
  assert.match(text, /not a reason to convert the spelling and retry/)
})

test('compatibility: the registered bash description always warns about native boundaries', () => {
  const text = bashDescription()
  assert.match(text, /ipconfig \/all and cmd \/c/)
  assert.match(text, /ipconfig \/\/all or cmd \/\/c/)
  assert.match(text, /Exclusions are prefixes/)
  assert.match(text, /do not disable conversion globally/)
  assert.match(text, /expected effect as well as the exit code/)
  assert.match(text, /decoded as UTF-8/)
  assert.match(text, /CP936\/GBK/)
  assert.match(text, /mixed streams cannot safely be guessed/)
  assert.match(text, /read-only\/workspace-write or unresolved policy is refused before/)
  assert.match(text, /explicitly resolved danger-full-access policy/)
  assert.match(text, /Do not switch tools or permissions automatically to bypass a refusal/)
  assert.doesNotMatch(text, /will use an UNCONFINED|route does NOT enforce/, 'current behaviour must describe refusal, not the retired bypass')
})

test('compatibility: unconfined foreground warning preserves exit parsing and cancellation', () => {
  assert.match(renderResult(result), /unconfined.*NOT enforced/)
  assert.deepEqual(parseExitStatus(renderResult({ ...result, exitCode: 2, timedOut: true })), {
    body: renderResult({ ...result, exitCode: 2, timedOut: true }).replace(/\n\[exit code: 2\]$/, ''), exitCode: 2,
  })
  // Official 0.2.1-alpha.5: exitCode null renders "[exit code: null]" and the
  // parser round-trips it as null (the card model reads explicit null as a
  // failure; the producer already emitted this marker before).
  const ended = renderResult({ ...result, exitCode: null, timedOut: true })
  assert.match(ended, /\[exit code: null\]$/)
  assert.deepEqual(parseExitStatus(ended), { body: ended.replace(/\n\[exit code: null\]$/, ''), exitCode: null })
  const killed = renderResult({ ...result, signal: 'SIGTERM', timedOut: true })
  assert.match(killed, /unconfined/)
  assert.match(killed, /\[killed by signal: SIGTERM\]$/)
  assert.doesNotMatch(renderResult({ ...result, sandbox: { mode: 'danger-full-access', denied: false } }), /unconfined/)
})

test('compatibility: unconfined warnings reach initial/background/promoted feedback', () => {
  assert.match(renderBackground('job1', sandbox), /started background job job1\n.*unconfined/)
  assert.equal(renderBackground('job1'), 'started background job job1')
  const delta = renderJobRead('data', false, [], sandbox, ['workspace-write'])
  assert.match(delta, /data\n.*unconfined/)
  assert.doesNotMatch(delta, /escalation available/, 'unconfined is not a denial or an escalation request')
  assert.match(processOutcome({ status: 'completed', exitCode: 0, sandbox }).detail, /unconfined/)
  const promoted = { jobId: 'job1', timeoutMs: 10, output: 'data', sandbox }
  assert.doesNotMatch(promoted.output, /unconfined/)
  assert.match(renderPromoted(promoted), /data\n.*moved to background[\s\S]*unconfined.*NOT enforced/)
  assert.equal((renderPromoted(promoted).match(/NOT enforced/g) ?? []).length, 1)
  assert.doesNotMatch(renderPromoted({ ...promoted, sandbox: { mode: 'danger-full-access', denied: false } }), /unconfined/)
  assert.doesNotMatch(renderPromoted({ jobId: 'job1', timeoutMs: 10, output: '' }), /sandbox:/)
  assert.match(renderPromoted({ ...promoted, sandbox: { mode: 'read-only', denied: true } }, ['workspace-write']), /sandbox:.*read-only[\s\S]*escalation available/)
  assert.match(renderPromoted({ ...promoted, sandbox: { mode: 'read-only', denied: false, runnerFailed: true } }), /runner itself failed/)
  assert.match(renderPromoted({ ...promoted, output: '' }), /moved to background[\s\S]*unconfined/)
  assert.match(renderJobRead('', true, ['spill'], sandbox, []), /output was dropped[\s\S]*unconfined/)
})

// ── issue #27: the module must survive hosts without a workingDirectory service ──
//
// 0.2.0-rc.2 provides no `workingDirectory` service. A hard inject of it left
// the whole module fiber permanently INACTIVE (apply() never ran, the tool
// never registered, cordis logged nothing) — and the activation log lied.
// The inject list must stay service-minimal; the cwd seam falls back to the
// rc.2-era official resolveWorkdir order (policy root ?? session header).

function issue27Fixture({ withWorkingDirectory }) {
  const definitions = new Map()
  let executed
  const executor = {
    sandboxMode: 'workspace-write',
    resolve: (request) => ({ ...request, timeoutMs: 1000 }),
    execute: async (spec) => {
      executed = spec
      return {
        result: async () => ({ stdout: { text: 'ok', truncated: false }, stderr: { text: '', truncated: false }, exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000, sandbox: { mode: 'workspace-write', denied: false, enforcement: 'unconfined' } }),
      }
    },
  }
  const services = new Map([
    ['sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: 'D:/work/ws' }) }],
  ])
  if (withWorkingDirectory) services.set('workingDirectory', { ensure: async () => 'C:/ensured/session-cwd' })
  const ctx = {
    get: (name) => services.get(name),
    inject: (_names, _fn) => {},
    systemPrompt: { section() {}, getSectionOrder: () => 100 },
    shellEnv: { collect: () => ({}) },
    tools: { register: (definition) => definitions.set(definition.name, definition) },
  }
  const logs = []
  const module = createBashToolModule({ executor, toolsModule: undefined, sandboxModule: undefined, llmModule: undefined, log: (message) => logs.push(message) })
  const exec = { agent: { session: { header: { cwd: 'D:/work/ws' } } }, signal: new AbortController().signal, callId: 'i27' }
  return { module, ctx, definitions, executor, getExecuted: () => executed, logs, exec }
}

test('compatibility: a host WITHOUT workingDirectory still registers bash and falls back to the session cwd (issue #27)', async () => {
  const { module, ctx, definitions, getExecuted, exec } = issue27Fixture({ withWorkingDirectory: false })
  assert.deepEqual(module.inject, ['tools', 'systemPrompt', 'shellEnv'], 'the inject list must not name services older hosts lack')
  module.apply(ctx, {})
  assert.ok(definitions.has('bash'), 'apply must register bash without workingDirectory present')
  const value = await definitions.get('bash').execute({ command: 'echo x', description: 'issue 27 cwd fallback' }, exec)
  assert.equal(value.isError ?? false, false)
  assert.equal(getExecuted().workdir, 'D:/work/ws', 'cwd falls back to policy root / session header, not the host process directory')
})

test('compatibility: a host WITH workingDirectory keeps the ensure() seam (issue #27, modern path)', async () => {
  const { module, ctx, definitions, getExecuted, exec } = issue27Fixture({ withWorkingDirectory: true })
  module.apply(ctx, {})
  await definitions.get('bash').execute({ command: 'echo x', description: 'issue 27 modern cwd' }, exec)
  assert.equal(getExecuted().workdir, 'C:/ensured/session-cwd', 'ensure() stays the primary cwd source on modern hosts')
})

test('compatibility: activation success requires a registry read-back, never a bare log (issue #27 false positive)', () => {
  const inlineTools = readFileSync(new URL('../src/inline-tools.js', import.meta.url), 'utf8')
  const bashTool = readFileSync(new URL('../src/bash-tool.js', import.meta.url), 'utf8')
  assert.doesNotMatch(bashTool, /inject: \['tools', 'systemPrompt', 'shellEnv', 'workingDirectory'\]/)
  assert.match(inlineTools, /did not register for this agent/, 'the miss THROWS so the catch logs it and the finally disposes the scope (PR #28 shape)')
  assert.match(inlineTools, /schemas\?\.\(agent\)/, 'the activated log line must be gated on a schemas read-back')
  assert.match(inlineTools, /includes\('bash'\) === false/)
  assert.match(inlineTools, /retained = true[\s\S]*activated for this agent/, 'retained (scope ownership) may only be set after the read-back passes')
})

// ── dsh-ops 0.3.0 interop (v0.39.4): one dialect across BOTH tool families ──
//
// dsh-ops 0.3.0 replaced its FastCtx file tools with native ops_* tools whose
// path contract is plain node:path (relative to the session cwd, or absolute
// Windows). Our dialect teaches the model /c/ everywhere — so the translation
// layer converts on the way in (arguments), and echoes on the way out
// (results, error content). ops_bash stays their tool; our `bash` is the
// dialect carrier and is not retired.

test('interop: ops_* arguments translate — root, operations[].path/to, protect[]', () => {
  const args = {
    root: '/c/work/proj',
    operations: [
      { op: 'copy', path: '/c/work/a.txt', to: '/c/work/b.txt' },
      { op: 'remove', path: 'relative/keep.txt' },
    ],
    protect: ['/c/work/keep', 'relative/also-keep'],
  }
  const out = translateDispatch({ name: 'ops_batch', arguments: args }, { posixPaths: true }, env)
  assert.equal(out.root, 'C:/work/proj', '/c/ maps through the env drive root')
  assert.deepEqual(out.operations[0], { op: 'copy', path: 'C:/work/a.txt', to: 'C:/work/b.txt' })
  assert.equal(out.operations[1].path, 'relative/keep.txt', 'relative paths are not ours to touch')
  assert.deepEqual(out.protect, ['C:/work/keep', 'relative/also-keep'])
  assert.equal(args.root, '/c/work/proj', 'caller input is not mutated')
  // The posixPaths gate lives in the tools/execute WRAPPER (dialect.posixPaths
  // && dialectApplies), not inside translateDispatch — lock that wiring:
  const hostSource = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(hostSource, /if \(dialect\.posixPaths && dialectApplies\(dialect, exec && exec\.agent\)\) \{[\s\S]*?translateDispatch\(exec, dialect, env\)/, 'the wrapper gates the whole argument face on the live posixPaths switch')
})

test('interop: ops_* results echo back in /c/ — items[].path, matches[].path, root', () => {
  const winEnv = { home: 'C:/Users/u', tmpDir: 'C:/Temp', gitRoot: 'C:/Program Files/Git' }
  const glob = rewriteResultPaths('ops_glob', { status: 'completed', items: [{ path: 'D:\\work\\a.ts' }, { path: 'D:\\work\\b.ts' }] }, winEnv)
  assert.deepEqual(glob.items.map((item) => item.path), ['/d/work/a.ts', '/d/work/b.ts'])
  const grep = rewriteResultPaths('ops_grep', { matches: [{ path: 'D:\\work\\a.ts', line: 3, text: 'x' }] }, winEnv)
  assert.equal(grep.matches[0].path, '/d/work/a.ts')
  assert.equal(grep.matches[0].text, 'x', 'non-path payload stays verbatim')
  const inspect = rewriteResultPaths('ops_inspect_local_file', { items: [{ path: 'D:\\work\\a.txt', line: 1, text: 'hello' }] }, winEnv)
  assert.equal(inspect.items[0].path, '/d/work/a.txt')
  const batch = rewriteResultPaths('ops_batch', { root: 'D:\\work\\proj', status: 'completed', detailsRef: 'res-1' }, winEnv)
  assert.equal(batch.root, '/d/work/proj')
  assert.equal(batch.detailsRef, 'res-1', 'reference ids are opaque, never rewritten')
  const noPaths = { status: 'completed', changed: 2 }
  assert.equal(rewriteResultPaths('ops_replace', noPaths, winEnv), noPaths, 'no path fields -> returned untouched')
})

test('interop: ops_* failures answer in /c/ too (error content and message)', () => {
  const winEnv = { home: 'C:/Users/u', tmpDir: 'C:/Temp', gitRoot: 'C:/Program Files/Git' }
  const content = rewriteErrorContent([{ type: 'text', text: 'outside workspace root: D:\\work\\secret.txt' }], { env: winEnv })
  assert.match(content[0].text, /\/d\/work\/secret\.txt/)
  const message = rewriteErrorMessage('path escapes the workspace: D:\\work\\secret.txt', { env: winEnv })
  assert.match(message, /\/d\/work\/secret\.txt/)
})
