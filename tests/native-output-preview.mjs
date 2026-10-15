// Read-only installed-Core imports; write fixtures/artifacts ONLY into the
// explicit caller-owned evidence directory. No profile, Jobs or ToolRuntime E2E.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Context } from '@deepseek-ai/cordis';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output';
import { createNativeOutputAdapter } from '../src/native-output.js';

const directory = process.env.DSH_NATIVE_OUTPUT_EVIDENCE_DIR;
assert.ok(directory && path.isAbsolute(directory) && fs.statSync(directory).isDirectory(), 'Set DSH_NATIVE_OUTPUT_EVIDENCE_DIR to an existing authorized evidence directory');
const artifactOptions = { OutputCollector, artifactDirectory: directory, artifactPolicyValidated: true, maxSpillBytes: 64 * 1024, maxTotalBytes: 256 * 1024 };
const observations = [];
function record(name, facts) { observations.push({ name, ...facts }); console.log(JSON.stringify({ name, ...facts })); }
function fake(options = {}, maxBytes = 4) {
  const stdout = new PassThrough(), stderr = new PassThrough();
  let resolve; const outcome = { exitCode: 0, signal: null };
  const real = { stdout, stderr, collected: {}, done: new Promise(yes => { resolve = yes; }), terminate() {}, waitForExit() { return Promise.resolve(true); } };
  const facade = createNativeOutputAdapter({ spawn: () => real }, { ...artifactOptions, ...options });
  const handle = facade.spawn({ stdio: { stdin: 'ignore', stdout: { maxBytes, spill: { maxBytes: 65536 } }, stderr: { maxBytes } }, graceMs: 20 });
  return { stdout, stderr, handle, async finish() { stdout.end(); stderr.end(); resolve(outcome); assert.equal(await handle.done, outcome); return handle.outputFacts(); } };
}
async function withRuntime(run) {
  const root = new Context(); const fiber = root.plugin(LocalSubprocessRuntime); await fiber;
  const runtime = root.get('subprocess');
  // Official isolated-instance test hook; prevent default OS temp preparer.
  runtime.internals.spillDir = directory;
  try { await run(runtime, root); } finally { await fiber.dispose(); }
}
function spawnSpec(code, signal) {
  return { argv: [process.execPath, '-e', code], cwd: directory, graceMs: 100, signal,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 8, spill: { maxBytes: 65536 } }, stderr: { maxBytes: 1024 } } };
}

test('installed collector: normalized UTF8 spill and exact raw artifacts have owner metadata', async () => {
  const h = fake({ stdoutEncoding: 'gbk' });
  const bytes = Buffer.from('d6d0cec4b2e2cad40a', 'hex');
  for (const b of bytes) h.stdout.write(Buffer.from([b]));
  const facts = await h.finish();
  assert.equal(h.handle.collected.stdout.readFrom(0).text, '试\n');
  assert.equal(facts.stdout.rawBytes, 9); assert.equal(facts.stdout.decodedUtf8Bytes, 13);
  assert.equal(facts.stdout.artifact.raw.complete, true); assert.equal(facts.stdout.artifact.decoded.complete, true);
  assert.deepEqual(fs.readFileSync(facts.stdout.artifact.raw.path), bytes);
  assert.equal(fs.readFileSync(facts.stdout.artifact.decoded.path, 'utf8'), '中文测试\n');
  assert.equal(h.handle.collected.stdout.readFrom(0).spillPath, facts.stdout.artifact.decoded.path);
  assert.ok(facts.budget.reservedMemoryBytes + facts.budget.artifactBytes <= facts.budget.maxTotalBytes);
  record('actual exported collector + owned artifact storage', facts);
});

test('raw mode artifact is bounded and explicitly not reliable text', async () => {
  const h = fake({ stdoutEncoding: 'raw', maxSpillBytes: 3 }); h.stdout.write(Buffer.from('d6d0ff00', 'hex'));
  const facts = await h.finish();
  assert.equal(facts.stdout.reliableText, false); assert.equal(facts.stdout.complete, false);
  assert.equal(facts.stdout.artifact.raw.bytes, 3); assert.equal(facts.stdout.artifact.raw.capReached, true);
  assert.deepEqual(fs.readFileSync(facts.stdout.artifact.raw.path), Buffer.from('d6d0ff', 'hex'));
  assert.equal(h.handle.collected.stdout.readFrom(0).text, '');
});

test('shared budget includes BOTH streams and raw plus normalized disk bytes', async () => {
  const h = fake({ maxTotalBytes: 4096, maxSpillBytes: 512 });
  h.stdout.write(Buffer.from('😀'.repeat(1000))); h.stderr.write(Buffer.alloc(1000, 65));
  const facts = await h.finish();
  assert.ok(facts.budget.artifactBytes <= 512);
  assert.ok(facts.budget.reservedMemoryBytes + facts.budget.artifactBytes <= 4096);
  assert.equal(facts.stdout.rawBytes, 4000); assert.equal(facts.stderr.rawBytes, 1000);
  assert.ok(facts.stdout.artifact.raw.capReached || facts.stdout.artifact.decoded.capReached);
  assert.equal(h.handle.collected.stdout.readFrom(0).spillPath, undefined);
  for (const stream of [facts.stdout, facts.stderr]) for (const artifact of Object.values(stream.artifact)) {
    if (artifact.path && artifact.kind === 'decoded') assert.ok(!fs.readFileSync(artifact.path, 'utf8').includes('\ufffd'));
  }
  record('bounded combined disk/memory payload budget', facts);
});

for (const operation of ['openSync', 'writeSync', 'closeSync']) test(`controlled ${operation} failure preserves exit, seals and reports partial artifact`, async () => {
  const original = fs[operation];
  const h = fake();
  let injected = 0;
  fs[operation] = function (...args) {
    if (operation === 'closeSync') original.apply(this, args); // really close before simulating delayed writeback failure
    injected++;
    throw Object.assign(new Error(`controlled ${operation} fault`), { code: 'EIO' });
  };
  let facts;
  try { h.stdout.write(Buffer.from('controlled spill\n')); facts = await h.finish(); }
  finally { fs[operation] = original; }
  assert.ok(injected); assert.ok(facts.stdout.storageError);
  assert.equal(facts.stdout.complete, false);
  assert.equal(h.handle.collected.stdout.readFrom(0).spillPath, undefined);
  for (const artifact of Object.values(facts.stdout.artifact)) assert.equal(artifact.complete, false);
  record(`injected ${operation} fault (not actual disk exhaustion)`, { stdout: facts.stdout });
});

test('installed rawPipe provider preserves exact fixed bytes without facade mutation', async () => withRuntime(async runtime => {
  const spec = spawnSpec("process.stdout.write(Buffer.from('d6d0cec4','hex'));process.stderr.write(Buffer.from('f09f9880','hex'))");
  spec.stdio.stdout = 'pipe'; spec.stdio.stderr = 'pipe';
  const handle = runtime.spawn(spec); const chunks = { stdout: [], stderr: [] };
  for (const name of ['stdout', 'stderr']) handle[name].on('data', bytes => chunks[name].push(bytes));
  const outcome = await handle.done; const quiet = await handle.waitForExit(AbortSignal.timeout(2000));
  assert.equal(outcome.exitCode, 0); assert.equal(quiet, true);
  assert.equal(Buffer.concat(chunks.stdout).toString('hex'), 'd6d0cec4');
  assert.equal(Buffer.concat(chunks.stderr).toString('hex'), 'f09f9880');
  record('actual installed Core rawPipe baseline', { outcome, rangeQuiet: quiet, stdoutHex: Buffer.concat(chunks.stdout).toString('hex') });
}));

test('installed provider + adapter: independent fixed encodings and unchanged provider registration', async () => withRuntime(async (runtime, root) => {
  const originalEntry = root.reflect.store[root[Context.isolate].subprocess];
  const facade = createNativeOutputAdapter(runtime, { ...artifactOptions, stdoutEncoding: 'gbk', stderrEncoding: 'utf16le', errors: 'strict' });
  const handle = facade.spawn(spawnSpec("process.stdout.write(Buffer.from('d6d0cec4','hex'));process.stderr.write(Buffer.from('3dd800de','hex'))"));
  const outcome = await handle.done; const quiet = await handle.waitForExit(AbortSignal.timeout(2000));
  assert.equal(outcome.exitCode, 0); assert.equal(quiet, true);
  assert.equal(handle.collected.stdout.readFrom(0).text, '中文');
  assert.equal(handle.collected.stderr.readFrom(0).text, '😀');
  // Cordis can bind a fresh method/service proxy on each get: compare the
  // registered service entry, not transient bound-function reference identity.
  assert.equal(root.reflect.store[root[Context.isolate].subprocess], originalEntry);
  assert.equal(facade.provider, runtime);
  assert.equal(handle.outputFacts().stdout.complete, true);
  const beforeCleanup = handle.outputFacts();
  handle.terminate();
  assert.deepEqual(handle.outputFacts(), beforeCleanup, 'normal post-settlement cleanup must not mark output aborted');
  record('actual installed Core adapter normal outcome', { outcome, rangeQuiet: quiet, facts: handle.outputFacts() });
}));

test('installed provider successful side effect sentinel survives strict decoder failure', async () => withRuntime(async runtime => {
  const facade = createNativeOutputAdapter(runtime, { ...artifactOptions, errors: 'strict' });
  const handle = facade.spawn(spawnSpec("process.stderr.write('FIXED_SIDE_EFFECT_SENTINEL');process.stdout.write(Buffer.from([255]));process.exitCode=0"));
  const outcome = await handle.done; const quiet = await handle.waitForExit(AbortSignal.timeout(2000));
  assert.equal(outcome.exitCode, 0); assert.equal(quiet, true);
  assert.equal(handle.collected.stderr.readFrom(0).text, 'FIXED_SIDE_EFFECT_SENTINEL');
  assert.ok(handle.outputFacts().stdout.decodeError);
  assert.equal(handle.outputFacts().stdout.artifact.raw.complete, true);
  record('actual successful process + independent decodeError (no retry)', { outcome, rangeQuiet: quiet, facts: handle.outputFacts() });
}));

test('installed managed cancellation is forwarded; output settles and process range goes quiet', async () => withRuntime(async runtime => {
  const abort = new AbortController();
  const facade = createNativeOutputAdapter(runtime, { ...artifactOptions, drainTimeoutMs: 200 });
  const spec = spawnSpec("process.stdout.write('READY');setTimeout(()=>process.stdout.write('LATE'),2000);setInterval(()=>{},1000)", abort.signal);
  spec.stdio.stdout.maxBytes = 1024;
  const handle = facade.spawn(spec);
  let cancelledAfterReady = false;
  const poll = setInterval(() => {
    if (handle.collected.stdout.readFrom(0).text.includes('READY')) { cancelledAfterReady = true; abort.abort(new Error('controlled caller cancellation')); clearInterval(poll); }
  }, 5);
  const safety = setTimeout(() => { abort.abort(); handle.terminate(); }, 3000);
  try {
    const outcome = await handle.done; const quiet = await handle.waitForExit(AbortSignal.timeout(2000));
    assert.equal(cancelledAfterReady, true); assert.equal(quiet, true);
    const text = handle.collected.stdout.readFrom(0).text;
    assert.ok(text.includes('READY')); assert.ok(!text.includes('LATE'));
    assert.equal(handle.outputFacts().stdout.aborted, true);
    assert.equal(handle.outputFacts().stdout.complete, false);
    record('actual installed Core cancellation (not Jobs/promotion E2E)', { outcome, rangeQuiet: quiet, facts: handle.outputFacts() });
  } finally { clearInterval(poll); clearTimeout(safety); }
}));

test('installed direct terminate without signal abort marks captured artifacts incomplete', { timeout: 5000 }, async () => withRuntime(async runtime => {
  const abort = new AbortController();
  const facade = createNativeOutputAdapter(runtime, { ...artifactOptions, drainTimeoutMs: 200 });
  const spec = spawnSpec("process.stdout.write('READY');setTimeout(()=>process.stdout.write('LATE'),2000);setInterval(()=>{},1000)", abort.signal);
  spec.stdio.stdout.maxBytes = 1024;
  const handle = facade.spawn(spec);
  let terminatedAfterReady = false;
  const poll = setInterval(() => {
    if (handle.collected.stdout.readFrom(0).text.includes('READY')) {
      terminatedAfterReady = true; handle.terminate(); clearInterval(poll);
    }
  }, 5);
  const safety = setTimeout(() => handle.terminate(), 3000);
  try {
    const outcome = await handle.done; const quiet = await handle.waitForExit(AbortSignal.timeout(1000));
    assert.equal(terminatedAfterReady, true); assert.equal(abort.signal.aborted, false); assert.equal(quiet, true);
    const facts = handle.outputFacts();
    assert.equal(facts.stdout.aborted, true); assert.equal(facts.stdout.complete, false);
    assert.equal(facts.stdout.artifact.raw.complete, false); assert.equal(facts.stdout.artifact.decoded.complete, false);
    assert.equal(handle.collected.stdout.readFrom(0).spillPath, undefined);
    const text = handle.collected.stdout.readFrom(0).text;
    assert.ok(text.includes('READY')); assert.ok(!text.includes('LATE'));
    handle.terminate(); assert.deepEqual(handle.outputFacts(), facts);
    record('actual installed Core direct terminate, external signal remains un-aborted', { outcome, rangeQuiet: quiet, facts });
  } finally { clearInterval(poll); clearTimeout(safety); }
}));

test('write structured preview observations inside authorized evidence directory', () => {
  fs.writeFileSync(path.join(directory, 'preview-observations.json'), JSON.stringify({ node: process.version, scope: 'isolated installed Core rawPipe/provider plus exported collector; NOT production Jobs/ToolRuntime/E2E', observations }, null, 2) + '\n');
});
