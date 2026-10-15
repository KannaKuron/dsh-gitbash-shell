import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createNativeOutputAdapter } from '../src/native-output.js';

// Contract fixture only. The preview suite separately injects the installed Core
// OutputCollector and actual managed provider. These tests are NOT Jobs/E2E.
class MemoryCollector {
  constructor(cap) { this.cap = cap; this.bytes = Buffer.alloc(0); this.total = 0; }
  push(bytes) { this.total += bytes.length; this.bytes = Buffer.concat([this.bytes, bytes]).subarray(-this.cap || Infinity); }
  snapshot() { return { bytes: Buffer.from(this.bytes), totalBytes: this.total }; }
  seal() {}
}
function harness(options = {}, disposition = { maxBytes: 1024 }) {
  let resolve, reject;
  const outcome = { exitCode: 17, signal: null };
  const real = {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: {}, control: {}, collected: {},
    done: new Promise((yes, no) => { resolve = yes; reject = no; }),
    terminate() { assert.equal(this, real); this.terminated = true; },
    waitForExit(signal) { assert.equal(this, real); return Promise.resolve(signal); },
  };
  const provider = { calls: [], spawn(spec) { assert.equal(this, provider); this.calls.push(spec); return real; } };
  const facade = createNativeOutputAdapter(provider, { OutputCollector: MemoryCollector, drainTimeoutMs: 10, ...options });
  const spec = { argv: ['fixed-producer'], cwd: '.', graceMs: 10, stdio: { stdin: 'ignore', stdout: disposition, stderr: { maxBytes: 1024 } }, signal: options.signal };
  const handle = facade.spawn(spec);
  return { provider, facade, real, handle, spec, outcome, resolve: () => resolve(outcome), reject,
    async finish() { real.stdout.end(); real.stderr.end(); resolve(outcome); return handle.done; } };
}

for (const [label, hex, expected] of [
  ['utf8', 'e4b8adf09f9880', '中😀'], ['gbk', 'd6d0cec4', '中文'], ['utf16le', '2d4e3dd800de', '中😀'],
]) test(`${label}: byte-by-byte ingest and independent normalized cursors`, async () => {
  const h = harness({ stdoutEncoding: label });
  const bytes = Buffer.from(hex, 'hex');
  h.real.stdout.write(bytes.subarray(0, 1));
  assert.deepEqual(h.handle.collected.stdout.readFrom(0), { text: '', nextOffset: 0, lossy: false });
  for (const byte of bytes.subarray(1)) h.real.stdout.write(Buffer.from([byte]));
  const a = h.handle.collected.stdout.readFrom(0), b = h.handle.collected.stdout.readFrom(0);
  assert.deepEqual(a, b);
  assert.equal(a.text, expected);
  assert.equal(a.nextOffset, Buffer.byteLength(expected));
  assert.equal(h.handle.outputFacts().stdout.rawCursor, bytes.length);
  assert.equal(await h.finish(), h.outcome);
  assert.equal(h.handle.outputFacts().stdout.complete, true);
});

test('default replacement and split BOM match Buffer.toString; genuine U+FFFD is not a decode error', async () => {
  for (const hex of ['efbbbfe4b8ad', 'efbfbd', 'e4', 'ff61', 'f09f98', 'eda080']) {
    const h = harness(); const bytes = Buffer.from(hex, 'hex');
    for (const byte of bytes) h.real.stdout.write(Buffer.from([byte]));
    await h.finish();
    assert.equal(h.handle.collected.stdout.readFrom(0).text, bytes.toString('utf8'), hex);
    if (hex === 'efbfbd') assert.equal(h.handle.outputFacts().stdout.decodeError, undefined);
    else if (!hex.startsWith('efbbbf')) assert.ok(h.handle.outputFacts().stdout.decodeError);
  }
});

test('explicit UTF16LE preserves BOM and flushes split surrogate EOF', async () => {
  const h = harness({ stdoutEncoding: 'utf16le' });
  for (const b of Buffer.from('fffe3dd800de', 'hex')) h.real.stdout.write(Buffer.from([b]));
  await h.finish(); assert.equal(h.handle.collected.stdout.readFrom(0).text, '\ufeff😀');
});

test('strict invalid bytes/EOF keep actual successful or nonzero process outcome', async () => {
  for (const hex of ['ff', 'e4']) {
    const h = harness({ errors: 'strict' });
    h.real.stdout.write(Buffer.from(hex, 'hex'));
    h.real.stdout.write(Buffer.alloc(4096, 0xff)); // drain after decode failure
    assert.equal(await h.finish(), h.outcome);
    const facts = h.handle.outputFacts().stdout;
    assert.ok(facts.decodeError); assert.equal(facts.complete, false);
    assert.equal(facts.rawBytes, 4097); assert.equal(facts.reliableText, false);
  }
  const h = harness({ errors: 'strict' }); h.real.stdout.write(Buffer.from([0xe4])); await h.finish();
  assert.ok(h.handle.outputFacts().stdout.decodeError);
});

for (const cap of [0, 1, 3, 4, 5]) test(`tail cap ${cap} discards whole emoji rather than inventing replacement`, async () => {
  const h = harness({}, { maxBytes: cap }); h.real.stdout.write(Buffer.from('A中😀'));
  await h.finish(); const read = h.handle.collected.stdout.readFrom(0);
  assert.equal(read.text, cap >= 4 ? '😀' : '');
  assert.equal(read.nextOffset, 8); assert.equal(read.lossy, true);
  assert.ok(!read.text.includes('\ufffd'));
});

test('reader aligns arbitrary middle-of-scalar cursor and rejects invalid coordinates', async () => {
  const h = harness(); h.real.stdout.write(Buffer.from('中😀Z')); await h.finish();
  assert.deepEqual(h.handle.collected.stdout.readFrom(1), { text: '😀Z', nextOffset: 8, lossy: true });
  for (const cursor of [-1, 0.5, Infinity, 9]) assert.throws(() => h.handle.collected.stdout.readFrom(cursor), RangeError);
});

test('facade preserves provider receiver/stdio/control/outcome; configuration is immutable per operation', async () => {
  const opts = { stdoutEncoding: 'gbk' }; const h = harness(opts); opts.stdoutEncoding = 'utf8';
  assert.equal(h.facade.provider, h.provider);
  assert.equal(h.spec.stdio.stdout.maxBytes, 1024); assert.equal(h.provider.calls[0].stdio.stdout, 'pipe');
  assert.equal(h.handle.stdin, h.real.stdin); assert.equal(h.handle.control, h.real.control);
  h.handle.terminate(); assert.equal(h.real.terminated, true);
  const signal = new AbortController().signal; assert.equal(await h.handle.waitForExit(signal), signal);
  h.real.stdout.write(Buffer.from('d6d0', 'hex')); await h.finish();
  assert.equal(h.handle.collected.stdout.readFrom(0).text, '中');
  const facts = h.handle.outputFacts(); assert.ok(Object.isFrozen(facts.stdout));
  assert.throws(() => { facts.stdout.rawBytes = 0; }, TypeError);
});

test('concurrent streams and operations never share decoder state', async () => {
  const a = harness({ stdoutEncoding: 'gbk' }), b = harness({ stdoutEncoding: 'utf16le' });
  a.real.stdout.write(Buffer.from('d6', 'hex')); b.real.stdout.write(Buffer.from('2d', 'hex'));
  a.real.stderr.write(Buffer.from('😀')); b.real.stderr.write(Buffer.from('中'));
  a.real.stdout.write(Buffer.from('d0', 'hex')); b.real.stdout.write(Buffer.from('4e', 'hex'));
  await Promise.all([a.finish(), b.finish()]);
  for (const h of [a, b]) assert.equal(h.handle.collected.stdout.readFrom(0).text, '中');
  assert.equal(a.handle.collected.stderr.readFrom(0).text, '😀');
  assert.equal(b.handle.collected.stderr.readFrom(0).text, '中');
});

test('unknown/raw/inherit stdio modes are not rewritten or consumed', async () => {
  for (const mode of ['pipe', 'inherit', { kind: 'future', maxBytes: 4 }, { maxBytes: 4, future: true }]) {
    const h = harness({}, mode); assert.equal(h.provider.calls[0].stdio.stdout, mode);
    assert.equal(h.handle.stdout, h.real.stdout); await h.finish();
  }
  const provider = { spawn: spec => spec }; const f = createNativeOutputAdapter(provider, { OutputCollector: MemoryCollector });
  const spec = { stdio: { stdout: 'pipe', stderr: 'inherit' } }; assert.equal(f.spawn(spec), spec);
});

for (const reason of ['error', 'close', 'exit-timeout', 'abort']) test(`${reason}: bounded output settlement, no lost process exit`, async () => {
  const abort = new AbortController(); const h = harness({ signal: abort.signal });
  h.real.stdout.write(Buffer.from([0xe4]));
  if (reason === 'error') h.real.stdout.emit('error', new Error('controlled stream fault'));
  if (reason === 'close') h.real.stdout.destroy();
  if (reason === 'abort') abort.abort();
  h.real.stderr.end(); h.resolve();
  assert.equal(await h.handle.done, h.outcome);
  assert.equal(h.handle.outputFacts().stdout.settled, true);
  assert.equal(h.handle.outputFacts().stdout.sourceComplete, false);
  assert.ok(h.handle.outputFacts().stdout.decodeError);
  assert.equal(h.real.stdout.destroyed, true);
});

test('abort seals output without waiting for a never-settling provider, done still belongs to provider', async () => {
  const abort = new AbortController(); const h = harness({ signal: abort.signal }); abort.abort();
  await h.handle.outputSettled; assert.equal(h.handle.outputFacts().stderr.termination, 'abort-drain-timeout');
  h.resolve(); assert.equal(await h.handle.done, h.outcome);
});

test('provider rejection retains original error identity after bounded drain', async () => {
  const h = harness(); const error = new Error('real provider failed'); h.reject(error);
  await assert.rejects(h.handle.done, value => value === error);
  assert.equal(h.handle.outputFacts().stdout.settled, true);
});

test('collector push/read/seal errors are facts, never provider failures', async () => {
  for (const method of ['push', 'snapshot', 'seal']) {
    class Broken extends MemoryCollector { [method]() { throw new Error(`controlled ${method}`); } }
    const h = harness({ OutputCollector: Broken }); h.real.stdout.write(Buffer.from('fixed'));
    assert.equal(await h.finish(), h.outcome);
    assert.equal(h.handle.collected.stdout.readFrom(0).lossy, true);
    assert.ok(h.handle.outputFacts().stdout.storageError);
  }
});

test('raw mode does not manufacture trustworthy text or decode guesses', async () => {
  const h = harness({ stdoutEncoding: 'raw' }); h.real.stdout.write(Buffer.from('d6d0ff', 'hex')); await h.finish();
  assert.deepEqual(h.handle.collected.stdout.readFrom(0), { text: '', nextOffset: 0, lossy: true });
  const f = h.handle.outputFacts().stdout; assert.equal(f.rawBytes, 3); assert.equal(f.reliableText, false); assert.equal(f.complete, false);
});

test('budget bounds retained copies even for giant input; zero implicit artifact writes', async () => {
  const h = harness({ maxTotalBytes: 1024, maxSpillBytes: 1024 }, { maxBytes: 1_000_000, spill: { maxBytes: 1_000_000 } });
  h.real.stdout.write(Buffer.alloc(100_000, 65)); await h.finish(); const f = h.handle.outputFacts();
  assert.equal(f.stdout.rawBytes, 100_000); assert.ok(f.stdout.retainedMaxBytes <= 8);
  assert.ok(f.budget.reservedMemoryBytes + f.budget.artifactBytes <= 1024);
  assert.deepEqual(f.stdout.artifact, {}); assert.equal(f.stdout.lossy, true);
});

test('late stream error during bounded shutdown is absorbed, EOF flush runs once', async () => {
  const h = harness(); h.real.stdout.write(Buffer.from([0xe4]));
  h.real.stdout.emit('error', new Error('first error'));
  h.real.stdout.emit('error', new Error('late error before close'));
  await h.finish();
  assert.equal(h.handle.collected.stdout.readFrom(0).text, '\ufffd');
  assert.equal(h.handle.outputFacts().stdout.streamError.message, 'first error');
  assert.equal(h.real.stdout.listenerCount('data'), 0);
});

test('pre-aborted signal and missing provider pipe settle without losing outcome', async () => {
  const abort = new AbortController(); abort.abort();
  const h = harness({ signal: abort.signal }); h.resolve();
  assert.equal(await h.handle.done, h.outcome); assert.equal(h.handle.outputFacts().stdout.aborted, true);
  const outcome = { exitCode: 0, signal: null };
  const facade = createNativeOutputAdapter({ spawn: () => ({ done: Promise.resolve(outcome), collected: {} }) }, { OutputCollector: MemoryCollector });
  const handle = facade.spawn({ stdio: { stdout: { maxBytes: 4 }, stderr: 'inherit' } });
  assert.equal(await handle.done, outcome); assert.equal(handle.outputFacts().stdout.termination, 'missing-pipe');
});

test('direct terminate marks unfinished output aborted with bounded drain, but completed cleanup is inert', { timeout: 1000 }, async () => {
  for (const state of ['pipes-open', 'pipes-ended', 'complete']) {
    const h = harness(); h.real.stdout.write(Buffer.from('READY'));
    if (state === 'pipes-ended') { h.real.stdout.end(); h.real.stderr.end(); await h.handle.outputSettled; }
    if (state === 'complete') await h.finish();
    const before = h.handle.outputFacts();
    h.handle.terminate(); h.handle.terminate();
    assert.equal(h.real.terminated, true);
    if (state === 'complete') {
      assert.deepEqual(h.handle.outputFacts(), before);
      assert.equal(h.handle.outputFacts().stdout.complete, true);
    } else {
      assert.equal(h.handle.outputFacts().stdout.aborted, true);
      assert.equal(h.handle.outputFacts().stdout.complete, false);
      await h.handle.outputSettled; // provider is deliberately not resolved yet
      if (state === 'pipes-open') assert.equal(h.handle.outputFacts().stdout.termination, 'terminate-drain-timeout');
      h.resolve(); assert.equal(await h.handle.done, h.outcome);
    }
  }
});

test('synchronous spawn failure retains identity; no implicit storage preparation', () => {
  const error = new Error('controlled spawn failure');
  const facade = createNativeOutputAdapter({ spawn() { throw error; } }, { OutputCollector: MemoryCollector });
  assert.throws(() => facade.spawn({ stdio: { stdout: { maxBytes: 4 }, stderr: 'inherit' } }), value => value === error);
});

test('actual-host encoding capability is checked before any spawn', () => {
  const Original = globalThis.TextDecoder; let calls = 0;
  globalThis.TextDecoder = class extends Original { constructor(label, options) { if (label === 'gbk') throw new Error('simulated small-ICU unsupported encoding'); super(label, options); } };
  try { assert.throws(() => createNativeOutputAdapter({ spawn() { calls++; } }, { OutputCollector: MemoryCollector, stdoutEncoding: 'gbk' }), /small-ICU/); }
  finally { globalThis.TextDecoder = Original; }
  assert.equal(calls, 0);
});

test('capability/options/policy checks run before provider spawn', () => {
  let calls = 0; const p = { spawn() { calls++; } };
  for (const options of [{ stdoutEncoding: 'auto' }, { stdoutEncoding: 'no-such-encoding' }, { errors: 'ignore' }, { maxTotalBytes: 1 }, { drainTimeoutMs: Infinity }, { artifactDirectory: '/not-authorized' }]) {
    assert.throws(() => createNativeOutputAdapter(p, { OutputCollector: MemoryCollector, ...options }));
  }
  assert.equal(calls, 0);
});
