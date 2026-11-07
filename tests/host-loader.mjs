// Read-only resolution into an explicitly selected installed DSH host. Nothing
// is installed into, patched in, or started from that host's production profile.
import { registerHooks, createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const hostDir = process.env.DSH_PREVIEW_HOST_DIR
if (!hostDir) throw new Error('Set DSH_PREVIEW_HOST_DIR to the installed DSH host directory containing package.json and node_modules')
const hostRequire = createRequire(pathToFileURL(join(resolve(hostDir), 'package.json')))
// Synchronous require.resolve participates in registerHooks too. Delegate its
// nested resolution to Node instead of recursively redirecting the same request.
let resolvingHost = false
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!resolvingHost && specifier.startsWith('@deepseek-ai/')) {
      resolvingHost = true
      try { return { url: pathToFileURL(hostRequire.resolve(specifier)).href, shortCircuit: true } }
      finally { resolvingHost = false }
    }
    return nextResolve(specifier, context)
  },
})
