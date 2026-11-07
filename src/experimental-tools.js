import { toolNameOccupied } from './tool-ownership.js'
/** Live registration for agent-owned companions; restrict() accepts global names only. */
export function registerExperimentalTool(ctx, definition, enabled, { scope, log = () => {} } = {}) {
  let unregister
  let closed = false
  const refresh = () => {
    if (closed) return
    unregister?.()
    unregister = undefined
    if (enabled?.() === false) return
    const candidate = definition()
    // Global and ancestor registrations remain owned even when hidden here.
    let occupied
    try {
      occupied = toolNameOccupied(ctx.tools, candidate.name, scope)
    } catch (error) {
      log(`${candidate.name} registration skipped: ${error?.message ?? error}`)
      return
    }
    if (occupied) {
      log(`${candidate.name} registration skipped: an existing tool owns this name`)
      return
    }
    try {
      unregister = ctx.tools.register(candidate)
    } catch (error) {
      // A registration conflict must not abort a volatile update or prevent
      // another companion's refresh. Other failures remain explicit in logs.
      log(`${candidate.name} registration failed: ${error?.message ?? error}`)
      return
    }
    log(`${candidate.name} registered in the agent-owned scope`)
  }
  ctx.effect(() => () => { closed = true; unregister?.(); unregister = undefined })
  ctx.on('loader/volatile-update', paths => {
    if (Array.isArray(paths) && paths.some(path => Array.isArray(path) && path[0] === 'experimentalNative')) refresh()
  })
  refresh()
  return refresh
}
