// Real installed-Core coverage for the explicit path converter. Actual host
// exports resolved through tests/host-loader.mjs: ToolRuntime → the retained
// run_code transport → NodePtcRuntime → LocalSubprocessRuntime → a real Node
// child doing real node:fs reads. The new module is REGISTERED through
// createPathToolModule (no mock capture, no inline source slicing), the model
// programs read ONLY the single owned input file created in this run's unique
// evidence directory, and nothing outside that directory is written.
//
// Registry contract (discovered here, locked by these tests): in ToolRuntime
// mode 'ptc' ONLY `run_code` is callable directly — every tool assertion runs
// inside a run_code program through the real PTC sub-dispatch, which is also
// the surface the model actually uses.
//
// Run (working directory = the repo):
//   DSH_PREVIEW_HOST_DIR='C:/Program Files/DSH NEXT/resources/app' \
//     node --import ./tests/host-loader.mjs --import ./tests/preview-env.mjs --test tests/path-preview.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { NodePtcRuntime } from '@deepseek-ai/dsh-ptc-runtime-node'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'

import * as helpers from '../src/index.js'
import { createPathToolModule, PATH_TOOL_NAME } from '../src/path-tool.js'

const rootDir = process.env.DSH_PATH_EVIDENCE_DIR
assert.ok(rootDir && isAbsolute(rootDir) && existsSync(rootDir) && statSync(rootDir).isDirectory(),
  'Set DSH_PATH_EVIDENCE_DIR to an existing caller-owned evidence directory, or preload tests/preview-env.mjs')
const dir = mkdtempSync(join(rootDir, 'path-preview-'))
const nativeFile = join(dir, '输入#2.txt').replaceAll('\\', '/')
const msysFile = nativeFile.replace(/^([A-Za-z]):\//, (_, drive) => '/' + drive.toLowerCase() + '/')
const text = 'PATH_PREVIEW_中文_SENTINEL'
writeFileSync(nativeFile, text, { encoding: 'utf8', flag: 'wx' })

// Controlled mount facts: the helper is the REAL shared one, only the fact
// bag is a controlled literal (same discipline as the approved research
// fixture — deterministic, no secret-environment reads). The real fresh
// buildTranslateEnv composition gets its own scoped instance below.
const env = { home: dir, tmpDir: join(dir, 'owned-tmp').replaceAll('\\', '/'), gitRoot: 'C:/Program Files/Git' }
const translate = (value) => helpers.translateMsysPath(value, env)

test('path preview: gitbash_to_native_path on the real engine', async t => {
  const cleanup = []          // services + runtime fibers, disposed in finally
  const logs = []
  let confinementCalls = 0
  const policy = { mode: 'danger-full-access', workspaceRoot: dir }
  const root = new Context()
  const mount = async (module, config) => {
    const fiber = root.plugin(module, config)
    cleanup.push(() => fiber.dispose())
    await fiber
    return fiber
  }
  const j = JSON.stringify
  const runCode = async (name, code, extra = {}) => {
    const original = { description: 'Path preview: exercise gitbash_to_native_path on the real engine', code, ...extra }
    const result = await root.get('tools').execute({
      name: 'run_code', callId: 'path-preview-' + name, arguments: original, signal: new AbortController().signal,
    })
    // sourceFrozen: the registry must hand the program through untouched.
    assert.equal(original.code, code, j(result))
    return result
  }
  const call = `await tools.${PATH_TOOL_NAME}`
  const rows = []
  const pass = (name, detail = {}) => { rows.push({ name, passed: true, ...detail }); console.log('PASS ' + name) }
  try {
    for (const [name, value] of Object.entries({
      fs: { processPathFromHostPath: value => value },
      sandboxPolicy: { defaultMode: policy.mode, resolve: () => policy },
      sandbox: { async confine() { confinementCalls++; throw new Error('path preview must not change OS confinement') } },
      workingDirectory: { ensure: async () => dir },
    })) cleanup.push(root.provide(name, value))

    await mount(LocalSubprocessRuntime)
    await mount(NodePtcRuntime, { timeoutMs: 4000, maxTimeoutMs: 10000, maxOutputBytes: 1048576, maxMessageBytes: 2097152, maxPendingCalls: 16, maxOldGenerationSizeMb: 128, graceMs: 1000,
      launch: { kind: 'node-script', executable: process.execPath } })
    await mount(SystemPrompt)
    await mount(ToolRuntime, { mode: 'ptc' })
    // The module UNDER TEST: real defineTool, real registry, owned scope.
    const mainFiber = await mount(createPathToolModule({
      toolsModule: { defineTool },
      translate,
      log: (message) => logs.push(message),
    }))

    await t.test('converted owned input through the real PTC sub-dispatch', async () => {
      const program = `const p=${j(msysFile)}; const r=${call}({msys_path:p}); return { native: r.native_path };`
      const result = await runCode('converted-owned-input', program)
      assert.ok(!result.isError, j(result))
      assert.equal(result.value.result.native, nativeFile)
      pass('converted-owned-input', { native: result.value.result.native })
    })

    await t.test('unicode / # / spaces preserved through the real schema layer', async () => {
      const program = `const r=${call}({msys_path:${j('/c/我的#目录/文件 1.txt')}}); return { native: r.native_path };`
      const result = await runCode('unicode-hash-space', program)
      assert.ok(!result.isError, j(result))
      assert.equal(result.value.result.native, 'C:/我的#目录/文件 1.txt')
      pass('unicode-hash-space-preserved')
    })

    await t.test('already-native and cwd-relative passthrough stay verbatim', async () => {
      const program = `return {`
        + ` win: (${call}({msys_path:${j('C:\\Users\\x\\y.txt')}})).native_path,`
        + ` rel: (${call}({msys_path:${j('docs/file.txt')}})).native_path };`
      const result = await runCode('passthrough', program)
      assert.ok(!result.isError, j(result))
      assert.deepEqual(result.value.result, { win: 'C:\\Users\\x\\y.txt', rel: 'docs/file.txt' })
      pass('native-and-cwd-relative-passthrough')
    })

    await t.test('registry rejections: empty, NUL, URL, unmapped POSIX mount', async () => {
      const cases = ['', 'a\0b', 'https://example.com/x', '/opt/tool']
      const codes = ['EMPTY', 'NUL_BYTE', 'URL', 'NO_MOUNT_MAPPING']
      const program = `const cases=${j(cases)}; const out=[];`
        + `for (const value of cases) { try { await ${call}({msys_path:value}); out.push('NO_THROW'); }`
        + `catch (e) { out.push(String(e?.message ?? e)) } } return { out };`
      const result = await runCode('rejections', program)
      assert.ok(!result.isError, j(result))
      result.value.result.out.forEach((message, index) => {
        assert.match(message, new RegExp('\\[' + codes[index] + '\\]'))
        assert.doesNotMatch(message, /"native_path"/)
      })
      pass('registry-rejections')
    })

    await t.test('run_code: explicit full-value helper drives REAL node:fs on the owned input', async () => {
      const suffix = msysFile.slice(3)
      const program = `const drive=${j(msysFile[1])}; const p='/' + drive + '/' + ${j(suffix)};`
        + `const r = ${call}({msys_path:p});`
        + `const fs = await import('node:fs/promises');`
        + `return { text: await fs.readFile(r.native_path,'utf8'), native: r.native_path, route: '/c/users', tag: String.raw\`/dev/null\` };`
      const result = await runCode('explicit-helper-real-fs', program)
      assert.ok(!result.isError, j(result))
      assert.equal(result.value.result.text, text)
      assert.equal(result.value.result.native, nativeFile)
      // Non-path data stays untouched: no global guessing rides along.
      assert.equal(result.value.result.route, '/c/users')
      assert.equal(result.value.result.tag, '/dev/null')
      pass('run-code-explicit-helper-real-fs', { native: result.value.result.native })
    })

    await t.test('run_code: rejection surfaces as a catchable program error', async () => {
      const program = `try { ${call}({msys_path:''}); return 'NO_THROW'; }`
        + `catch (e) { return { caught: String(e?.message ?? e) } }`
      const result = await runCode('rejection-caught', program)
      assert.ok(!result.isError, j(result))
      assert.match(result.value.result.caught, /\[EMPTY\]/)
      assert.match(result.value.result.caught, /msys_path must be a non-empty string/)
      pass('run-code-rejection-caught')
    })

    await t.test('disposing the owning scope unregisters the tool on the real registry', async () => {
      await mainFiber.dispose()
      const program = `try { ${call}({msys_path:${j(msysFile)}}); return 'STILL_CALLABLE'; }`
        + `catch (e) { return { caught: String(e?.message ?? e) } }`
      const result = await runCode('scope-disposal', program)
      assert.ok(!result.isError, j(result))
      // Both real unregistration surfaces are accepted: the bridge either
      // reports the unknown tool or the dynamic `tools.` binding lost the name.
      assert.match(result.value.result.caught, new RegExp('unknown tool "' + PATH_TOOL_NAME + '"|is not a function'))
      pass('scope-disposal-unregisters')
    })

    await t.test('second dep shape (raw helper + real fresh buildTranslateEnv) re-mounts cleanly', async () => {
      // The name is free again after the scoped disposal above: the raw-helper
      // + fresh real buildTranslateEnv composition converts on the real machine.
      const fiber = await mount(createPathToolModule({
        toolsModule: { defineTool },
        translateMsysPath: helpers.translateMsysPath,
        buildEnv: () => helpers.buildTranslateEnv(''),
        log: (message) => logs.push(message),
      }))
      const program = `const r=${call}({msys_path:${j(msysFile)}}); return { native: r.native_path };`
      const result = await runCode('buildenv-dep-shape', program)
      assert.ok(!result.isError, j(result))
      assert.equal(result.value.result.native, nativeFile)
      await fiber.dispose()
      const program2 = `try { ${call}({msys_path:${j(msysFile)}}); return 'STILL_CALLABLE'; }`
        + `catch (e) { return { caught: String(e?.message ?? e) } }`
      const after = await runCode('buildenv-disposed', program2)
      assert.ok(!after.isError, j(after))
      assert.match(after.value.result.caught, /unknown tool|is not a function/)
      pass('buildenv-dep-shape-and-scoped-dispose')
    })

    assert.equal(confinementCalls, 0)
    assert.ok(logs.length >= 2, 'both registrations logged')
    const evidence = {
      fixture: 'actual-installed-ToolRuntime-to-NodePtcRuntime-to-LocalSubprocessRuntime; module registered via createPathToolModule; tool asserted through run_code sub-dispatch (mode ptc allows only run_code directly)',
      toolName: PATH_TOOL_NAME,
      testNode: process.version,
      directory: dir,
      sourceCaptureOnly: false,
      realWorkerAndFsRead: true,
      productionGui: false,
      fullPluginApply: false,
      permissionMode: policy.mode,
      sandboxConfineCalls: confinementCalls,
      dialectGates: 'none — the tool is independent of posixPaths/codePaths by contract',
      rows,
    }
    writeFileSync(join(dir, 'results.json'), j(evidence) + '\n', { flag: 'wx' })
    assert.equal(rows.length, 8)
    console.log(j({ directory: dir, passed: rows.length, evidence: join(dir, 'results.json') }))
  } finally {
    for (const off of cleanup.reverse()) {
      try { await off() } catch { /* a fiber the disposal test already ended */ }
    }
  }
})
