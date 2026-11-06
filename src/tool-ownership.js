import { resolveHostModule } from './bash-tool.js'
let scopeModule = await resolveHostModule(undefined, '@deepseek-ai/dsh-scope')

export async function prepareToolOwnership(ctx) {
  const host = await resolveHostModule(ctx, '@deepseek-ai/dsh-scope')
  if (typeof host?.scopeChainOf === 'function') scopeModule = host
}

/** Inspect each owner's own view: a child's mask must not erase ownership. */
export function toolNameOccupied(registry, name, scope) {
  if (typeof registry?.schemas !== 'function') throw new Error('tool ownership inspection unavailable')
  const global = registry.schemas()
  if (!Array.isArray(global)) throw new Error('tool ownership inspection unavailable')
  if (global.some(tool => tool.name === name)) return true
  if (scope === undefined) return false
  if (typeof scopeModule?.scopeChainOf !== 'function') throw new Error('host scope ownership inspection unavailable')
  for (const owner of scopeModule.scopeChainOf(scope)) {
    const listed = registry.schemas(owner)
    if (!Array.isArray(listed)) throw new Error('tool ownership inspection unavailable')
    if (listed.some(tool => tool.name === name)) return true
  }
  return false
}
