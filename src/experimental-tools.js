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
    // Inspect AFTER removing only our registration. dsh 0.2.2 made
    // ctx.tools.view private, so read the public listings instead. They omit
    // names restricted away from this scope; a hidden foreign owner then
    // surfaces through register()'s own conflict error below, which is why the
    // inspection is a fast path rather than the ownership authority.
    let occupied
    try {
      const listed = typeof ctx.tools.schemas === 'function'
        ? ctx.tools.schemas(scope)
        : (typeof ctx.tools.definitions === 'function' ? ctx.tools.definitions(scope) : undefined)
      if (listed === undefined) throw new Error('tool ownership inspection unavailable')
      occupied = listed.some(tool => tool.name === candidate.name)
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
