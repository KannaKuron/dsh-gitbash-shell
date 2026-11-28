import { resolveHostModule } from './bash-tool.js'
let scopeModule = await resolveHostModule(undefined, '@deepseek-ai/dsh-scope')

export async function prepareToolOwnership(ctx) {
  const host = await resolveHostModule(ctx, '@deepseek-ai/dsh-scope')
  if (typeof host?.scopeChainOf === 'function') scopeModule = host
}

/** Inspect each owner's own view: a child's mask must not erase ownership.
 *
 * alpha.3 removed `schemas()`/`definitions()`; `getAll(scope)` is the public
 * root view. A PTC root lists only run_code, so bindings stay invisible here —
 * callers treat the duplicate-registration error as the fallback signal.
 */
export function toolNameOccupied(registry, name, scope) {
  if (typeof registry?.getAll !== 'function') throw new Error('tool ownership inspection unavailable')
  const names = (listed) => Array.isArray(listed) ? listed.map(tool => tool?.name) : undefined
  const global = names(registry.getAll())
  if (global === undefined) throw new Error('tool ownership inspection unavailable')
  if (global.includes(name)) return true
  if (scope === undefined) return false
  if (typeof scopeModule?.scopeChainOf !== 'function') throw new Error('host scope ownership inspection unavailable')
  for (const owner of scopeModule.scopeChainOf(scope)) {
    const listed = names(registry.getAll(owner))
    if (listed === undefined) throw new Error('tool ownership inspection unavailable')
    if (listed.includes(name)) return true
  }
  return false
}
