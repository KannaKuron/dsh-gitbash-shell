import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { rewriteCodePaths, scanCodeLiterals, runCodeHintFor, translateDispatch, dialectApplies, windowsToMsys } from '../src/index.js'
import { bashDescription } from '../src/bash-tool.js'
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
  new Function('ctx', 'liveSettings', 'dialectApplies', 'windowsToMsys', 'runCodeHintFor', 'GITBASH_ROUTE_ADDENDUM', 'GITBASH_ROUTE_ADDENDUM_NO_PWSH', 'GITBASH_MSYS_ADDENDUM', source.slice(start, end))(
    ctx, { dialect: () => dialect, pwshTool: () => false }, dialectApplies, windowsToMsys, runCodeHintFor, '', '', '')
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
  assert.match(text, /does NOT enforce shell file-write restrictions/)
  assert.match(text, /never use shell to bypass its denial/)
})

test('compatibility: unconfined foreground warning preserves exit parsing and cancellation', () => {
  assert.match(renderResult(result), /unconfined.*NOT enforced/)
  assert.deepEqual(parseExitStatus(renderResult({ ...result, exitCode: 2, timedOut: true })), {
    body: renderResult({ ...result, exitCode: 2, timedOut: true }).replace(/\n\[exit code: 2\]$/, ''), exitCode: 2,
  })
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
  assert.match(renderPromoted({ jobId: 'job1', timeoutMs: 10, output: delta }), /unconfined[\s\S]*moved to background/)
  assert.match(renderJobRead('', true, ['spill'], sandbox, []), /output was dropped[\s\S]*unconfined/)
})
