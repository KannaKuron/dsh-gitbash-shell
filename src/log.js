/**
 * Server-side log policy (issue #46): a healthy dsh web start is silent.
 * Informational lines — routes armed, presets registered, adoption reports —
 * are debug output, enabled only with DSH_GITBASH_DEBUG=1. Real problems
 * (failed wiring, unresolved capabilities, refused requests) always go to
 * stderr through console.warn, so they remain visible without the flag.
 */
const DEBUG = (() => {
  const value = String(process.env.DSH_GITBASH_DEBUG ?? '').toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
})()

/** Normal lifecycle chatter: silent unless DSH_GITBASH_DEBUG is on. */
export function debugLog(message) {
  if (DEBUG) console.log(message)
}

/** A degraded feature, a failed wiring step, or a refused security fence. */
export function problemLog(message) {
  console.warn(message)
}

/** Test seam: whether informational logging is enabled for this process. */
export function debugEnabled() {
  return DEBUG
}
