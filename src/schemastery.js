/**
 * dsh-gitbash-shell/schemastery — resolve the ONE schemastery copy whose
 * semantics match the executing host, instead of whichever copy Node finds
 * first.
 *
 * WHY THIS MODULE EXISTS (issue #12). `@deepseek-ai/schemastery` is a peer, so
 * it is resolved by walking UP from this plugin's own file. In a hoisted
 * profile that walk can land on an OLDER copy another dependency hoisted to the
 * profile root — measured on the reporter's machine: 3.18.2, which has no
 * `volatile()` — while the host itself runs the copy installed beside its own
 * shell packages (3.18.4). The executor's base class comes from the HOST's copy
 * of `@deepseek-ai/dsh-bash-sandbox`: on dsh 0.1.7+ it declares its limits with
 * `.volatile()` and reads every one of them through `.get()`
 * (`packages/shell/bash-local/src/index.ts:100-107`, `assertServiceableBashConfig`).
 * A subclass whose Config was built from a `volatile`-less schemastery
 * therefore yields PLAIN values and the first shell call dies with
 * `TypeError: config.timeoutMs.get is not a function`, taking the whole
 * `ctx.shell` down with it. Issue #6 was the same crash from the other
 * direction (an unconditional plain Config); v0.24.4 fixed that with a
 * per-field `schema.volatile` probe, which only helps when the copy we happen
 * to resolve HAS `volatile()`.
 *
 * The choice is therefore driven by the HOST'S BEHAVIOUR, never by our own
 * resolution order. Asking the base class what it resolves `timeoutMs` to is a
 * direct read of "does this host call `.get()`?" — true on 0.1.7+, false on
 * <= 0.1.6 where plain values are the correct answer. Only when the host wants
 * Volatile refs do we insist on a copy that provides them, and only then do we
 * try the parent package's own resolution domain first. An unreadable parent
 * Config keeps the historical behaviour (our own copy, per-field probe), so an
 * unknown host is never made worse.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** The peer whose copy must agree with the host. */
export const SCHEMASTERY_PEER = '@deepseek-ai/schemastery'

/** The package whose resolution domain is authoritative — the executor we extend. */
export const SCHEMASTERY_PARENT = '@deepseek-ai/dsh-bash-sandbox'

const TAG = '[gitbash-shell]'

/** Node's own answer for `specifier` as seen from `base`, or `''` when it fails. */
export function resolveFrom(base, specifier) {
  try {
    return createRequire(base).resolve(specifier)
  } catch {
    return ''
  }
}

/** Whether one loaded module looks like a usable schemastery. */
export function isSchemastery(z) {
  return !!z && typeof z.object === 'function'
}

/** Whether one loaded schemastery can produce Volatile refs. */
export function hasVolatile(z) {
  if (!isSchemastery(z)) return false
  try {
    return typeof z.string().volatile === 'function'
  } catch {
    return false
  }
}

/**
 * Ask the executing host whether it reads its shell limits through `.get()`.
 *
 * `SandboxBashExecutor.Config({})` is the host's OWN schema, built from the
 * host's own schemastery: it resolves `timeoutMs` to a `Volatile` ref exactly
 * when the host declares volatile fields. Behaviour, not internals — no private
 * schema shape is read.
 *
 * @param ParentConfig - the base class's `static Config`, if it has one.
 * @returns `true`/`false` when the host answered, `undefined` when it could not.
 */
export function hostWantsVolatileRefs(ParentConfig) {
  if (typeof ParentConfig !== 'function') return undefined
  try {
    const resolved = ParentConfig({})
    if (!resolved || typeof resolved !== 'object') return undefined
    return typeof resolved.timeoutMs?.get === 'function'
  } catch {
    return undefined
  }
}

/**
 * Pick one already-loaded copy. Pure, so the matrix is testable without a
 * filesystem: the caller supplies the candidates and their resolution order.
 *
 * @param options - the host's answer, our own entry path, and the loaded copies in priority order.
 * @returns the chosen copy (or undefined) and why, for the log line.
 */
export function chooseCopy({ needsVolatile, ownEntry, copies }) {
  const own = copies.find((copy) => copy.entry === ownEntry)
  if (copies.length === 0) return { chosen: undefined, reason: 'unresolved' }
  if (needsVolatile === false) {
    // <= 0.1.6 reads plain values: the historical answer is the correct one.
    return { chosen: own ?? copies[0], reason: 'host-plain' }
  }
  if (needsVolatile === true) {
    // Our own copy is the historical answer: keep it whenever it can serve, and
    // redirect ONLY when it cannot (that redirection is the whole point of #12).
    if (own !== undefined && hasVolatile(own.z)) return { chosen: own, reason: 'host-volatile' }
    const capable = copies.find((copy) => hasVolatile(copy.z))
    return capable
      ? { chosen: capable, reason: 'host-volatile-redirected' }
      : { chosen: own ?? copies[0], reason: 'no-volatile-anywhere' }
  }
  // The host could not answer: keep the pre-#12 behaviour (our own copy) rather
  // than guessing a semantics change on its behalf.
  return { chosen: own ?? copies[0], reason: 'host-unknown' }
}

/** Load one module by absolute entry path. */
async function loadAt(entry) {
  const mod = await import(pathToFileURL(entry).href)
  return mod?.default ?? mod
}

/** One process-wide answer: the module graph does not change under us. */
let cached = null

/**
 * Resolve, load, and cache the schemastery copy that matches the executing host.
 *
 * @param options - `parentConfig` is the executor base class's `static Config`.
 * @returns the chosen module (or undefined), where it came from, the host's answer, and the reason.
 */
export async function loadSchemastery({ parentConfig } = {}) {
  if (cached !== null) return cached
  const needsVolatile = hostWantsVolatileRefs(parentConfig)
  const ownEntry = resolveFrom(import.meta.url, SCHEMASTERY_PEER)

  const wanted = []
  const parentEntry = resolveFrom(import.meta.url, SCHEMASTERY_PARENT)
  if (parentEntry !== '') {
    const beside = resolveFrom(parentEntry, SCHEMASTERY_PEER)
    if (beside !== '' && beside !== ownEntry) wanted.push({ where: 'the shell packages', entry: beside })
  }
  if (ownEntry !== '') wanted.push({ where: 'this plugin', entry: ownEntry })

  const copies = []
  for (const candidate of wanted) {
    try {
      const z = await loadAt(candidate.entry)
      if (isSchemastery(z)) copies.push({ where: candidate.where, entry: candidate.entry, z })
    } catch { /* try the next domain */ }
  }

  const { chosen, reason } = chooseCopy({ needsVolatile, ownEntry, copies })
  const result = { z: chosen?.z, source: chosen?.where ?? '', entry: chosen?.entry ?? '', needsVolatile, reason }
  cached = result

  if (result.z === undefined) {
    console.warn(`${TAG} ${SCHEMASTERY_PEER} is not resolvable from this plugin or from ${SCHEMASTERY_PARENT}; the row Config surface is absent`)
  } else if (reason === 'no-volatile-anywhere') {
    // The one case the plugin cannot paper over: the host calls `.get()` on
    // plain values, so every shell call would fail. Say so where the user will
    // see it, instead of leaving a mystery TypeError.
    console.warn(
      `${TAG} this host reads its shell limits through .get() but NO resolvable ${SCHEMASTERY_PEER} provides volatile()`
      + ` (tried: ${wanted.map((w) => `${w.where} -> ${w.entry}`).join('; ') || 'nothing resolved'}).`
      + ' Shell calls will fail with "config.timeoutMs.get is not a function"; install a dsh whose schemastery matches its own shell packages.',
    )
  } else if (chosen.where === 'the shell packages') {
    console.log(`${TAG} ${SCHEMASTERY_PEER} taken from the shell packages instead of this plugin's own resolution (${reason}): ${chosen.entry}`)
  }
  return result
}

/** Test seam: forget the cached answer. */
export function resetSchemasteryCache() {
  cached = null
}
