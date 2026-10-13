/** Live registration for agent-owned companions; restrict() accepts global names only. */
export function registerExperimentalTool(ctx, definition, enabled) {
  let unregister
  let closed = false
  const refresh = () => {
    if (closed) return
    unregister?.()
    unregister = undefined
    if (enabled?.() !== false) unregister = ctx.tools.register(definition())
  }
  ctx.effect(() => () => { closed = true; unregister?.(); unregister = undefined })
  ctx.on('loader/volatile-update', paths => {
    if (Array.isArray(paths) && paths.some(path => Array.isArray(path) && path[0] === 'experimentalNative')) refresh()
  })
  refresh()
  return refresh
}
