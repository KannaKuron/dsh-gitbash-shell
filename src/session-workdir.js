/** Use the host's current directory; retain the old policy/header seam when absent. */
export async function resolveSessionCwd(ctx, exec, policy) {
  if (exec.agent === undefined) return undefined
  exec.signal?.throwIfAborted()
  const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
  if (service !== undefined) {
    if (typeof service?.ensure !== 'function') throw new TypeError('workingDirectory service does not expose ensure()')
    // Existing service errors must not become a silent downgrade to the original cwd.
    return service.ensure(exec.agent, exec.signal)
  }
  return policy?.workspaceRoot ?? exec.agent.session?.header?.cwd
}
