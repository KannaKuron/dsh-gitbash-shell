/** Read the host's current directory, retaining the pre-alpha.2 execution seam. */
export async function resolveSessionCwd(ctx, exec, policy) {
  if (exec.agent === undefined) return undefined
  exec.signal?.throwIfAborted()
  const service = ctx.get('workingDirectory')
  if (service !== undefined) {
    if (typeof service?.ensure !== 'function') throw new TypeError('workingDirectory service does not expose ensure()')
    // Do not hide validation, recovery, cancellation or provider failures.
    return service.ensure(exec.agent, exec.signal)
  }
  return policy?.workspaceRoot ?? exec.agent.session?.header?.cwd
}
