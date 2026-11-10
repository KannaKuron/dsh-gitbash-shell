/**
 * dsh-gitbash-shell/schemastery — resolve the ONE schemastery copy whose
 * semantics match the executing host, instead of whichever copy Node finds
 * first.
 *
 * WHY THIS MODULE EXISTS (issue #12). `@deepseek-ai/schemastery` is a peer, so
 * it is resolved by walking UP from this plugin's own file. In a hoisted
 * profile that walk can land on an OLDER copy another dependency hoisted to the
 * profile root — one without `volatile()` — while the host itself runs the copy
 * installed beside its own shell packages. The executor's base class comes from
 * the HOST's copy of `@deepseek-ai/dsh-bash-sandbox`, and on dsh >=0.2.2-rc.1 it
 * declares its limits with `.volatile()` and reads every one of them through
 * `.get()`. A subclass whose Config was built from a `volatile`-less
 * schemastery therefore yields PLAIN values and the first shell call dies with
 * `TypeError: config.timeoutMs.get is not a function`, taking the whole
 * `ctx.shell` down with it.
 *
 * The choice is therefore semantic, not version-based: prefer our own copy
 * whenever it can produce Volatile refs, and redirect to the copy resolved
 * beside the shell packages only when it cannot. No `volatile()` anywhere is
 * reported as a fail-loud configuration error instead of a mystery TypeError.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { debugLog } from './log.js'

/** The peer whose copy must agree with the host. */
export const SCHEMASTERY_PEER = '@deepseek-ai/schemastery'

/** The package whose resolution domain is authoritative — the executor we extend. */
export const SCHEMASTERY_PARENT = '@deepseek-ai/dsh-bash-sandbox'

const TAG = '[gitbash-shell]'

/** Node's own answer for `specifier` as seen from `base`, or '' when it fails. */
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
 * Pick one already-loaded copy. Pure, so the matrix is testable without a
 * filesystem: the caller supplies the candidates and their resolution order.
 *
 * @param options - our own entry path and the loaded copies in priority order.
 * @returns the chosen copy (or undefined) and why, for the log line.
 */
export function chooseCopy({ ownEntry, copies }) {
  const own = copies.find((copy) => copy.entry === ownEntry)
  if (copies.length === 0) return { chosen: undefined, reason: 'unresolved' }
  // Our own copy is the historical answer: keep it whenever it can serve, and
  // redirect ONLY when it cannot (that redirection is the whole point of #12).
  if (own !== undefined && hasVolatile(own.z)) return { chosen: own, reason: 'own-volatile' }
  const capable = copies.find((copy) => hasVolatile(copy.z))
  return capable
    ? { chosen: capable, reason: 'redirected' }
    : { chosen: own ?? copies[0], reason: 'no-volatile-anywhere' }
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
 * @returns the chosen module (or undefined), where it came from, and the reason.
 */
export async function loadSchemastery() {
  if (cached !== null) return cached
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

  const { chosen, reason } = chooseCopy({ ownEntry, copies })
  const usable = chosen !== undefined && hasVolatile(chosen.z)
  const result = { z: usable ? chosen.z : undefined, source: usable ? chosen.where : '', entry: usable ? chosen.entry : '', reason }
  cached = result

  if (result.z === undefined) {
    console.warn(`${TAG} no resolvable ${SCHEMASTERY_PEER} provides volatile(); the executor Config and the row Config surface are absent (tried: ${wanted.map((w) => `${w.where} -> ${w.entry}`).join('; ') || 'nothing resolved'}). Install a dsh whose schemastery matches its own shell packages.`)
  } else if (reason === 'redirected') {
    debugLog(`${TAG} ${SCHEMASTERY_PEER} taken from the shell packages instead of this plugin's own resolution: ${chosen.entry}`)
  }
  return result
}

/** Test seam: forget the cached answer. */
export function resetSchemasteryCache() {
  cached = null
}
