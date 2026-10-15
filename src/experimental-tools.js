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
    // Inspect AFTER removing only our registration. Include restricted names
    // when the host exposes them: a hidden foreign tool is still another owner.
    let occupied
    try {
      const view = typeof ctx.tools.view === 'function' ? ctx.tools.view(scope) : undefined
      if (typeof view?.knownNames?.has === 'function') {
        occupied = view.knownNames.has(candidate.name)
      } else if (typeof ctx.tools.schemas === 'function') {
        occupied = ctx.tools.schemas(scope).some(tool => tool.name === candidate.name)
      } else {
        throw new Error('tool ownership inspection unavailable')
      }
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
