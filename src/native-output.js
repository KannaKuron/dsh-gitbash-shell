// Private, operation-local adapter over the public subprocess raw-pipe seam.
// No peer imports: the host must inject its exported ./output OutputCollector.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ENCODINGS = Object.freeze({ utf8: 'utf-8', 'utf-8': 'utf-8', gbk: 'gbk', cp936: 'gbk', utf16le: 'utf-16le', 'utf-16le': 'utf-16le', raw: 'raw' });
const freeze = value => Object.freeze(value);
const failure = (error, code) => freeze({ code: String(error?.code ?? code), message: String(error?.message ?? error).slice(0, 400) });
function integer(value, fallback, name, min = 0) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min) throw new TypeError(`${name} must be a safe integer >= ${min}`);
  return result;
}
function encoding(value = 'utf8') {
  const label = ENCODINGS[value];
  if (!label) throw new TypeError(`Unsupported native output encoding: ${value}`);
  if (label !== 'raw') {
    // Probe both replacement and fatal support in the actual host, before spawn.
    new TextDecoder(label, { fatal: false, ignoreBOM: true });
    new TextDecoder(label, { fatal: true, ignoreBOM: true });
  }
  return label;
}
function isCollect(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Number.isSafeInteger(value.maxBytes) && value.maxBytes >= 0
    && Object.keys(value).every(key => key === 'maxBytes' || key === 'spill')
    && (value.spill === undefined || (value.spill !== null && typeof value.spill === 'object'
      && Number.isSafeInteger(value.spill.maxBytes) && value.spill.maxBytes >= 0
      && Object.keys(value.spill).every(key => key === 'maxBytes')));
}
function alignedStart(bytes, start) {
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return start;
}
function alignedEnd(bytes, end) {
  if (end === bytes.length) return end;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return end;
}

/**
 * Construct one immutable operation's provider facade. Create another facade for
 * a different encoding/configuration; no ambient per-agent or global settings.
 *
 * Only known {maxBytes, spill?} stdout/stderr modes opt in. Pipe, inherit and
 * future/unknown modes are delegated unchanged. The real provider still owns
 * execution, abort, termination, range observation, stdin and control.
 *
 * artifactDirectory must ALREADY exist and be owned/authorized by the caller.
 * artifactPolicyValidated is only a misuse guard, NOT a sandbox grant: the
 * native executor must enforce its actual resolved danger-only policy first.
 * This adapter never creates directories, chmods, removes files or grants access.
 * The caller owns artifact retention/removal after all readers have finished.
 *
 * maxTotalBytes bounds adapter-owned byte payload reservations + artifact bytes,
 * not provider/Node pipe buffers, JS object overhead or copies retained by callers.
 * Memory reservation includes tail backing buffers, snapshot/string copies and
 * bounded decode scratch (conservative multipliers). No raw in-memory history.
 * Artifact quotas are SHARED by both streams and by raw + normalized UTF8 files.
 * Readers use normalized UTF8 byte offsets, never raw/source-byte offsets.
 */
export function createNativeOutputAdapter(provider, options = {}) {
  if (!provider || typeof provider.spawn !== 'function') throw new TypeError('A real subprocess provider is required');
  if (typeof options.OutputCollector !== 'function') throw new TypeError('Inject the host OutputCollector from its public ./output export');
  const config = freeze({
    OutputCollector: options.OutputCollector,
    stdoutEncoding: encoding(options.stdoutEncoding),
    stderrEncoding: encoding(options.stderrEncoding),
    errors: options.errors ?? 'replace',
    maxSpillBytes: integer(options.maxSpillBytes, 8 * 1024 * 1024, 'maxSpillBytes'),
    maxTotalBytes: integer(options.maxTotalBytes, 16 * 1024 * 1024, 'maxTotalBytes', 1024),
    drainTimeoutMs: integer(options.drainTimeoutMs, 250, 'drainTimeoutMs', 1),
    artifactDirectory: options.artifactDirectory,
  });
  if (!['replace', 'strict'].includes(config.errors)) throw new TypeError('errors must be replace or strict');
  if (config.drainTimeoutMs > 2_147_483_647) throw new TypeError('drainTimeoutMs exceeds Node timer range');
  if (config.artifactDirectory !== undefined) {
    if (options.artifactPolicyValidated !== true) throw new Error('Native output artifacts require caller policy validation');
    if (typeof config.artifactDirectory !== 'string' || !path.isAbsolute(config.artifactDirectory)) throw new TypeError('artifactDirectory must be absolute');
    if (!fs.statSync(config.artifactDirectory).isDirectory()) throw new TypeError('artifactDirectory must already be a directory');
  }

  function spawn(spec) {
    const names = ['stdout', 'stderr'].filter(name => isCollect(spec.stdio?.[name]));
    if (!names.length) return provider.spawn(spec);
    // Capture mutable caller dispositions before invoking the real provider.
    const modes = Object.fromEntries(names.map(name => [name, freeze({ maxBytes: spec.stdio[name].maxBytes, spillMax: spec.stdio[name].spill?.maxBytes })]));
    const scratchBytes = Math.max(1, Math.min(1024, Math.floor(config.maxTotalBytes / 256)));
    const baseReservation = scratchBytes * 64 + 256 * names.length;
    const tailShare = Math.max(0, Math.floor((config.maxTotalBytes - baseReservation) / (16 * names.length)));
    const caps = Object.fromEntries(names.map(name => [name, Math.min(modes[name].maxBytes, tailShare)]));
    const reservedMemoryBytes = baseReservation + names.reduce((sum, name) => sum + caps[name] * 16, 0);
    const budget = { artifactBytes: 0, limit: Math.min(config.maxSpillBytes, config.maxTotalBytes - reservedMemoryBytes) };
    const owners = names.map(name => makeOwner(name, modes[name], caps[name], config, budget, scratchBytes));
    const stdio = { ...spec.stdio };
    for (const name of names) stdio[name] = 'pipe';
    let real;
    try { real = provider.spawn({ ...spec, stdio }); }
    catch (error) { for (const owner of owners) owner.finish('spawn-error'); throw error; }
    for (const owner of owners) owner.attach(real[owner.name]);
    let timer;
    let processSettled = false;
    const armDrain = reason => {
      if (timer || owners.every(owner => owner.isSettled())) return;
      timer = setTimeout(() => { for (const owner of owners) owner.finish(reason); }, config.drainTimeoutMs);
    };
    const onAbort = () => {
      for (const owner of owners) owner.markAborted();
      armDrain('abort-drain-timeout');
    };
    const signal = spec.signal;
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const outputSettled = Promise.all(owners.map(owner => owner.settled)).then(() => {
      clearTimeout(timer);
    });
    // Observe success AND rejection immediately. Decoding/storage NEVER changes
    // process outcome or converts a successful side-effecting process into a
    // provider failure that might invite an unsafe retry.
    const done = Promise.resolve(real.done).then(async outcome => {
      processSettled = true;
      armDrain('exit-drain-timeout');
      await outputSettled;
      signal?.removeEventListener('abort', onAbort);
      return outcome;
    }, async error => {
      processSettled = true;
      armDrain('provider-error-drain-timeout');
      await outputSettled;
      signal?.removeEventListener('abort', onAbort);
      throw error;
    });
    const collected = { ...real.collected };
    for (const owner of owners) collected[owner.name] = owner.reader;
    const additions = {
      done, outputSettled, collected: freeze(collected),
      terminate(...args) {
        // Direct kill/dispose need not abort spec.signal. Record interruption
        // before delegating, but never retroactively spoil a completed result
        // merely because an owner invokes idempotent cleanup after settlement.
        if (!processSettled || !owners.every(owner => owner.isSettled())) {
          for (const owner of owners) owner.markAborted();
          armDrain('terminate-drain-timeout');
        }
        return real.terminate(...args);
      },
      outputFacts: () => freeze({
        ...Object.fromEntries(owners.map(owner => [owner.name, owner.facts()])),
        budget: freeze({ maxTotalBytes: config.maxTotalBytes, reservedMemoryBytes, artifactBytes: budget.artifactBytes, maxArtifactBytes: budget.limit }),
      }),
      ...Object.fromEntries(names.map(name => [name, undefined])),
    };
    return delegate(real, additions);
  }
  return delegate(provider, { spawn, provider, outputConfig: config });
}

// Bind unknown methods to their REAL receiver (including private-field methods).
// Do not mutate provider/handle identity or their service registration.
function delegate(real, additions) {
  return new Proxy(Object.create(null), {
    get(_target, key) {
      if (Object.hasOwn(additions, key)) return additions[key];
      const value = Reflect.get(real, key, real);
      return typeof value === 'function' ? value.bind(real) : value;
    },
    has: (_target, key) => Object.hasOwn(additions, key) || key in real,
    set() { return false; },
  });
}

function makeOwner(name, mode, cap, config, budget, scratchBytes) {
  const label = config[`${name}Encoding`];
  const collector = new config.OutputCollector(cap, `native-${name}`); // no host-private spill fields
  const decoder = label === 'raw' ? undefined : new TextDecoder(label, { fatal: config.errors === 'strict', ignoreBOM: true });
  // A fatal validator distinguishes actual invalid bytes from a legitimate U+FFFD.
  let validator = label === 'raw' || config.errors === 'strict' ? undefined : new TextDecoder(label, { fatal: true, ignoreBOM: true });
  let rawBytes = 0, decodedUtf8Bytes = 0, decodeError, storageError, streamError;
  let settled = false, naturalEOF = false, aborted = false, termination, stream, stopText = false;
  let resolveSettled;
  const settledPromise = new Promise(resolve => { resolveSettled = resolve; });
  const artifacts = {};
  function recordStorage(error) { storageError ??= failure(error, 'NATIVE_OUTPUT_STORAGE'); }
  function artifact(kind) {
    if (!config.artifactDirectory) return undefined;
    return artifacts[kind] ??= { kind, encoding: kind === 'raw' ? label : 'utf-8', bytes: 0, capReached: false, error: undefined, path: undefined, fd: undefined, sealed: false };
  }
  function writeArtifact(kind, bytes) {
    const target = artifact(kind);
    if (!target || !bytes.length || target.error || target.capReached) return;
    const streamLimit = kind === 'decoded' ? Math.min(mode.spillMax ?? config.maxSpillBytes, config.maxSpillBytes) : config.maxSpillBytes;
    let length = Math.min(bytes.length, Math.max(0, budget.limit - budget.artifactBytes), Math.max(0, streamLimit - target.bytes));
    if (kind === 'decoded') length = alignedEnd(bytes, length);
    if (length < bytes.length) target.capReached = true;
    if (!length) return;
    try {
      if (target.fd === undefined) {
        const filename = path.join(config.artifactDirectory, `native-${randomUUID()}-${name}-${kind}.${kind === 'raw' ? 'bin' : 'utf8.log'}`);
        target.fd = fs.openSync(filename, 'wx', 0o600);
        target.path = filename;
      }
      let offset = 0;
      while (offset < length) {
        const written = fs.writeSync(target.fd, bytes, offset, length - offset);
        if (!Number.isSafeInteger(written) || written <= 0) throw new Error('Native artifact write made no progress');
        offset += written;
        target.bytes += written;
        budget.artifactBytes += written;
      }
    } catch (error) { target.error = failure(error, 'NATIVE_OUTPUT_SPILL'); recordStorage(error); }
  }
  function publish(text) {
    if (!text) return;
    const bytes = Buffer.from(text, 'utf8');
    decodedUtf8Bytes += bytes.length;
    writeArtifact('decoded', bytes);
    if (stopText) return;
    try {
      // Bound backing allocations, too: OutputCollector may retain subarray tails.
      // Every push owns a small copy, never a view of the provider's giant chunk.
      const step = Math.max(1, Math.min(scratchBytes, cap || 1));
      for (let offset = 0; offset < bytes.length; offset += step) {
        const slice = bytes.subarray(offset, offset + step);
        // Unpooled storage prevents a one-byte retained tail pinning an 8KiB slab.
        const owned = Buffer.allocUnsafeSlow(slice.length);
        owned.set(slice);
        collector.push(owned);
      }
    } catch (error) { recordStorage(error); stopText = true; }
  }
  function ingest(chunk) {
    if (settled) return;
    if (!(chunk instanceof Uint8Array)) {
      streamError ??= failure(new Error('Raw pipe emitted non-byte data (setEncoding must not be used)'), 'NATIVE_OUTPUT_NOT_BYTES');
      finish('stream-error');
      return;
    }
    rawBytes += chunk.byteLength;
    // Never decode a giant incoming chunk in one allocation. Borrow raw slices;
    // output/string scratch is bounded even after an error or artifact cap.
    for (let offset = 0; offset < chunk.byteLength; offset += scratchBytes) {
      const bytes = chunk.subarray(offset, offset + scratchBytes);
      writeArtifact('raw', bytes);
      if (!decoder || (decodeError && config.errors === 'strict')) continue;
      if (validator) {
        try { validator.decode(bytes, { stream: true }); }
        catch (error) { decodeError ??= failure(error, 'NATIVE_OUTPUT_DECODE'); validator = undefined; }
      }
      try { publish(decoder.decode(bytes, { stream: true })); }
      catch (error) { decodeError ??= failure(error, 'NATIVE_OUTPUT_DECODE'); }
    }
  }
  function finish(reason) {
    if (settled) return;
    settled = true;
    termination = reason;
    naturalEOF = reason === 'end';
    if (validator) {
      try { validator.decode(); }
      catch (error) { decodeError ??= failure(error, 'NATIVE_OUTPUT_DECODE'); }
    }
    if (decoder && !(decodeError && config.errors === 'strict')) {
      try { publish(decoder.decode()); }
      catch (error) { decodeError ??= failure(error, 'NATIVE_OUTPUT_DECODE'); }
    }
    try { collector.seal(); } catch (error) { recordStorage(error); }
    for (const target of Object.values(artifacts)) {
      if (target.fd !== undefined) {
        try { fs.closeSync(target.fd); }
        catch (error) { target.error ??= failure(error, 'NATIVE_OUTPUT_SPILL_CLOSE'); recordStorage(error); }
        target.fd = undefined;
      }
      target.sealed = true;
    }
    if (stream) {
      stream.removeListener('data', ingest);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onClose);
      // Keep a harmless error sink until close: destroy can schedule a late
      // error, which must not become an uncaught exception after settlement.
      if (stream.closed) stream.removeListener('error', onError);
      else stream.once('close', () => stream.removeListener('error', onError));
      if (!naturalEOF && !stream.destroyed) stream.destroy();
    }
    resolveSettled();
  }
  const onEnd = () => finish('end');
  const onClose = () => finish('close-before-end');
  const onError = error => { if (!settled) { streamError ??= failure(error, 'NATIVE_OUTPUT_STREAM'); finish('stream-error'); } };
  function artifactFacts() {
    return freeze(Object.fromEntries(Object.entries(artifacts).map(([kind, target]) => [kind, freeze({
      kind, encoding: target.encoding, path: target.path, bytes: target.bytes,
      complete: target.sealed && naturalEOF && !aborted && !target.error && !target.capReached && (kind === 'raw' || !decodeError),
      capReached: target.capReached, error: target.error,
    })])));
  }
  const reader = freeze({ readFrom(fromByte) {
    if (!Number.isSafeInteger(fromByte) || fromByte < 0 || fromByte > decodedUtf8Bytes) throw new RangeError('Expected a normalized UTF8 cursor between zero and decodedUtf8Bytes');
    let snapshot;
    try { snapshot = collector.snapshot(); }
    catch (error) { recordStorage(error); return { text: '', nextOffset: decodedUtf8Bytes, lossy: true }; }
    const start = snapshot.totalBytes - snapshot.bytes.length;
    const requested = Math.max(0, fromByte - start);
    const aligned = alignedStart(snapshot.bytes, requested);
    const spill = artifactFacts().decoded;
    return {
      text: snapshot.bytes.subarray(aligned).toString('utf8'),
      nextOffset: decodedUtf8Bytes,
      lossy: label === 'raw' || !!decodeError || !!storageError || fromByte < start || aligned !== requested,
      // Only finalized COMPLETE normalized text can be called a full-output path.
      ...(spill?.complete && spill.path ? { spillPath: spill.path } : {}),
    };
  } });
  return {
    name, reader, settled: settledPromise, finish, isSettled: () => settled,
    markAborted() { aborted = true; },
    attach(value) {
      stream = value;
      if (!stream || typeof stream.on !== 'function') {
        stream = undefined;
        streamError = failure(new Error('Provider did not expose requested raw pipe'), 'NATIVE_OUTPUT_PIPE_MISSING');
        finish('missing-pipe');
        return;
      }
      stream.on('error', onError);
      stream.once('end', onEnd);
      stream.once('close', onClose);
      stream.on('data', ingest);
      if (stream.readableEnded) finish('end');
      else if (stream.destroyed || stream.closed) finish('close-before-end');
    },
    facts() {
      const artifact = artifactFacts();
      const lossy = reader.readFrom(0).lossy;
      return freeze({
        encoding: label, errors: config.errors, rawBytes, decodedUtf8Bytes,
        rawCursor: rawBytes, decodedCursor: decodedUtf8Bytes,
        reliableText: label !== 'raw' && !decodeError && !streamError && !storageError,
        lossy, complete: naturalEOF && !aborted && !streamError && !decodeError && !storageError && (label !== 'raw' || artifact.raw?.complete === true),
        sourceComplete: naturalEOF, aborted, settled, termination, decodeError, streamError, storageError, artifact,
        retainedMaxBytes: cap,
      });
    },
  };
}
