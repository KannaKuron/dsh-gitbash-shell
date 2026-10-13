/**
 * dsh-gitbash-shell/path-tool — the EXPLICIT full-value MSYS→native converter
 * (`gitbash_to_native_path`, 2026-10-13, compat-implementation task
 * IMPL-PATH-HELPER).
 *
 * WHY. run_code hands a program's path STRINGS to native Node, and the legacy
 * codePaths literal rewrite can only ever guess which literals are paths
 * (research REPORT.md: route/search data still gets corrupted, dynamic values
 * are out of reach by design). The explicit alternative: the CALLER decides a
 * complete value is a path and converts it AT RUNTIME through one tool:
 *
 *     const r = await tools.gitbash_to_native_path({ msys_path: p })
 *     await fs.readFile(r.native_path, 'utf8')
 *
 * Contract (mirrors the approved research fixture `fixture_to_native`):
 *   - the parameter is named `msys_path` ON PURPOSE: the automatic
 *     tools/execute path-field rewrite only touches the whitelisted
 *     `file_path`/`path`/`workdir` fields (src/index.js
 *     TRANSLATABLE_PATH_FIELDS), so the raw MSYS value reaches this tool
 *     intact and the conversion is the tool's own explicit job;
 *   - the value goes through the SHARED `translateMsysPath` + a FRESH
 *     `buildTranslateEnv(...)` per call (injected, never copied here) — drive
 *     roots, ~, $HOME-style variables, /tmp, /dev/null and the Git install
 *     mounts resolve exactly like every other translated face of the plugin;
 *   - NO filesystem I/O, NO existence check, NO permission grant, NO global
 *     env seeding: the caller's own runtime policy still governs what the
 *     converted path may touch;
 *   - already Windows-native (drive-letter/UNC) or cwd-relative values are
 *     returned unchanged — declared here, in the description;
 *   - a POSIX-looking value that NO mount maps, or whose needed mount fact is
 *     unavailable, is REJECTED with an explicit error: returning the POSIX
 *     spelling as `native_path` would be a silent lie;
 *   - empty / NUL-byte / URL-shaped values are rejected outright; Unicode,
 *     `#` and spaces inside a path are preserved byte for byte;
 *   - the tool is INDEPENDENT of the automatic dialect switches
 *     (posixPaths/codePaths/virtualMounts): whether it is registered at all
 *     (and the Windows-only gate) is the main wiring's decision — this module
 *     carries no Config and reads no dialect state.
 *
 * Mounting follows the bash-tool pattern: `createPathToolModule(deps)` returns
 * a cordis module ({ inject, apply }) that the main wiring mounts inside an
 * agent-owned scope; registration reverts through the scope's effect on
 * disposal. There are NO top-level static `@deepseek-ai/*` imports — the host
 * `defineTool` and the shared translator ride the deps bag (v0.24.3 lesson: a
 * failed static peer import silently drops the whole plugin row).
 *
 * The SUCCESS result is `{ native_path }`, a shape the result-echo layer
 * never rewrites (rewriteResultPaths is keyed on the official tools' names
 * and path metadata fields, not on this tool), so the native value cannot be
 * translated back behind the caller's back.
 *
 * @module dsh-gitbash-shell/path-tool
 */

/** The registered tool name. */
export const PATH_TOOL_NAME = 'gitbash_to_native_path'

/** Windows drive-letter absolute: `C:/x`, `C:\x` (drive-relative `C:` is NOT). */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/

/** A `scheme:` prefix — `https:`, `file:`, `app:`, … (single-letter `C:` excluded). */
const URL_SCHEME = /^([A-Za-z][A-Za-z0-9+.\-]*):/

const NUL_BYTE = '\0'

/**
 * Whether the value is ALREADY in a native Windows spelling (drive-letter
 * absolute or UNC, both slash styles). Pure.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isWindowsNativeValue(value) {
  return typeof value === 'string'
    && (WINDOWS_ABSOLUTE.test(value) || value.startsWith('\\\\') || value.startsWith('//'))
}

/**
 * Whether the value LOOKS like it needs MSYS mount resolution (POSIX root,
 * home shorthand or a leading variable). A match does NOT promise a mapping
 * exists — only that a passthrough would be a guess. Pure.
 * @param {unknown} value
 * @returns {boolean}
 */
export function looksPosixValue(value) {
  return typeof value === 'string'
    && (value.startsWith('/') || value.startsWith('~') || value.startsWith('$'))
}

/**
 * One honest line about which mount facts the conversion could see. `null`
 * means the wiring turned mounts off; `undefined` means the wiring did not
 * expose facts at all.
 */
function factSummary(env) {
  if (env === null) return 'mount facts unavailable (virtual mounts are off)'
  if (!env || typeof env !== 'object') return 'mount facts not exposed by this wiring'
  return `mount facts: home=${env.home ? 'yes' : 'no'} tmpDir=${env.tmpDir ? 'yes' : 'no'} gitRoot=${env.gitRoot ? 'yes' : 'no'}`
}

/**
 * Convert ONE caller-declared full path value. Pure: string surgery only,
 * the translator (the shared translateMsysPath composed with a fresh mount
 * fact bag) is injected, nothing is probed here.
 *
 * Rejections are explicit and non-guessing:
 *   - EMPTY       — not a non-empty string;
 *   - NUL_BYTE    — a NUL byte anywhere in the value;
 *   - URL         — a multi-letter scheme prefix (`https:…`, `file:…`);
 *   - NO_MOUNT_MAPPING — POSIX-looking but the shared mount table returned it
 *     unchanged: either no mount maps it or a needed fact is missing. The
 *     POSIX spelling is NEVER returned as `native_path`.
 *
 * @param {unknown} value - the complete value the caller has decided is a path.
 * @param {{ translate?: (value: string, env?: object|null) => unknown,
 *           env?: object|null }} [options] - the injected shared translator
 *   and this call's fresh mount-fact bag (for the rejection diagnostics).
 * @returns {{ ok: true, native_path: string,
 *             status: 'converted'|'passthrough', kind: string }
 *          | { ok: false, code: string, message: string }}
 */
export function convertMsysToNative(value, { translate, env } = {}) {
  // The code rides the message: the registry carries only error.message to
  // the model/bridge, so the rejection class must survive that one face.
  const reject = (code, body) => ({ ok: false, code, message: `${PATH_TOOL_NAME} [${code}]: ${body}` })
  if (typeof value !== 'string' || value.trim().length === 0) {
    return reject('EMPTY', 'msys_path must be a non-empty string')
  }
  if (value.includes(NUL_BYTE)) {
    return reject('NUL_BYTE', 'msys_path contains a NUL byte; a single filesystem path is required')
  }
  const scheme = URL_SCHEME.exec(value)
  if (scheme && scheme[1].length >= 2) {
    return reject('URL', `msys_path looks like a URL (scheme '${scheme[1]}'); explicit conversion accepts a single filesystem path only`)
  }
  // Already native or cwd-relative: an honest, DECLARED passthrough — the
  // description promises this, so no mount facts are consulted at all.
  if (isWindowsNativeValue(value)) {
    return { ok: true, native_path: value, status: 'passthrough', kind: 'windows-native' }
  }
  if (!looksPosixValue(value)) {
    return { ok: true, native_path: value, status: 'passthrough', kind: 'cwd-relative' }
  }
  if (typeof translate !== 'function') {
    return reject('NO_TRANSLATOR', `no shared translator is wired; refusing to guess a native form for ${JSON.stringify(value)}`)
  }
  let translated
  try {
    translated = translate(value, env ?? null)
  } catch (error) {
    return reject('TRANSLATE_FAILED', `the shared translator failed for ${JSON.stringify(value)}: ${error?.message ?? error}`)
  }
  if (typeof translated !== 'string' || translated.length === 0) {
    return reject('TRANSLATE_FAILED', `the shared translator returned a non-string for ${JSON.stringify(value)}`)
  }
  if (translated !== value) {
    return { ok: true, native_path: translated, status: 'converted', kind: 'msys' }
  }
  return reject('NO_MOUNT_MAPPING', `no MSYS mount mapping for ${JSON.stringify(value)} (${factSummary(env)}). Refusing to return the POSIX spelling as a native path — resolve the mount fact or convert the value at its source.`)
}

/** The model-facing contract (kept in one place for both definition shapes). */
export function pathToolDescription() {
  return 'Explicitly convert one complete caller-declared path value from the MSYS/Git Bash dialect '
    + '(/c/-style drive roots, ~, $HOME-style variables, /tmp, /dev/null, Git installation mounts) '
    + 'to its native Windows form and return { native_path }. Call this ONLY when the full value is '
    + 'already known to be a single filesystem path — the tool never inspects surrounding data and never guesses. '
    + 'Pure string conversion through the plugin\'s shared mount table: no filesystem I/O, no existence check, '
    + 'no permission grant; your runtime policy still governs the converted path. Values that are already '
    + 'Windows-native (drive-letter or UNC) or cwd-relative are returned unchanged, by design. A POSIX-looking '
    + 'value that no mount maps — or whose needed mount fact is unavailable — is REJECTED with an explicit error '
    + 'instead of a misleading passthrough. Independent of the automatic dialect switches; the parameter is named '
    + 'msys_path so the automatic path-field rewrite leaves it untouched. '
    + 'Use it for runtime-built MSYS paths before direct native Node fs/path I/O: '
    + 'await the result and pass result.native_path, never the original MSYS string. '
    + 'Already-native/cwd-relative Node values or ordinary translated tool path fields need no conversion. '
    + 'Never pass routes, search strings, shell commands or program source. '
    + 'In PTC invoke this offered SDK binding from inside run_code. A file policy/access denial is a stop condition, '
    + 'not a reason to convert the spelling and retry through Node or another tool.'
}

const MSYS_PATH_PARAM_DESCRIPTION = 'The complete value to convert, as one single MSYS/Git Bash path '
  + '(drive root /c/, ~, $HOME-style variable, /tmp, /dev/null or a Git install mount). '
  + 'Pass the FULL value only; the tool performs no I/O and no permission grant.'

/**
 * Build the tool definition in whichever dialect the host supports: the real
 * `defineTool` author schema when the host module is available (parameters is
 * a property map with `required: true` on the property; the output object
 * declares `additionalProperties: false` explicitly and marks every property
 * required), or an equivalent plain JSON-schema object otherwise. Both shapes
 * share ONE execute body.
 * @param {object} deps
 * @param {object|undefined} [deps.toolsModule] - `@deepseek-ai/dsh-tools` (defineTool).
 * @param {(value: string, env?: object|null) => unknown} [deps.translate] -
 *   the shared translator, already composed fresh by the wiring.
 * @param {(value: string, env: object|null) => unknown} [deps.translateMsysPath] -
 *   alternative to `translate`: the raw shared helper.
 * @param {() => object|null|undefined} [deps.buildEnv] - fresh mount-facts
 *   reader (buildTranslateEnv composition); called once per tool call.
 * @param {(message: string) => void} [deps.log]
 * @returns {object} a registry-ready definition.
 */
export function buildPathToolDefinition({ toolsModule, translate, translateMsysPath, buildEnv, log = () => {} } = {}) {
  const convertValue = typeof translate === 'function'
    ? (value, env) => translate(value, env)
    : typeof translateMsysPath === 'function'
      ? (value, env) => translateMsysPath(value, env)
      : undefined
  if (!convertValue) {
    throw new Error('path-tool: a shared translator is required — pass translate (fresh composed) or translateMsysPath; the tool never copies the mount table')
  }
  const execute = (args) => {
    // Fresh facts per call: the same lazy discipline as every other
    // translation consumer (a settings bashPath change must be visible on
    // the next call without a re-mount).
    const env = typeof buildEnv === 'function' ? buildEnv() : undefined
    const outcome = convertMsysToNative(args?.msys_path, { translate: convertValue, env })
    if (!outcome.ok) throw new Error(outcome.message)
    return { native_path: outcome.native_path }
  }
  if (typeof toolsModule?.defineTool === 'function') {
    return toolsModule.defineTool({
      name: PATH_TOOL_NAME,
      description: pathToolDescription(),
      parameters: {
        msys_path: { type: 'string', required: true, description: MSYS_PATH_PARAM_DESCRIPTION },
      },
      output: {
        schema: {
          type: 'object',
          properties: { native_path: { type: 'string', required: true } },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: true,
      execute,
    })
  }
  log('path-tool: @deepseek-ai/dsh-tools not resolvable; building a plain JSON-schema definition')
  return {
    name: PATH_TOOL_NAME,
    description: pathToolDescription(),
    parameters: {
      type: 'object',
      properties: { msys_path: { type: 'string', description: MSYS_PATH_PARAM_DESCRIPTION } },
      required: ['msys_path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { native_path: { type: 'string' } },
        required: ['native_path'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute,
  }
}

/**
 * Build the cordis module the main wiring mounts inside an agent-owned scope.
 * The tool registration is owned by the mounting scope: it reverts through
 * the scope's effect at disposal, exactly like the bash-tool module's.
 * Windows-only availability, agent gating and any dialect/config gate are the
 * MAIN WIRING's decisions — this module carries none.
 *
 * Deps (final interface):
 *   - toolsModule:      `@deepseek-ai/dsh-tools` when resolvable (defineTool);
 *                       absent ⇒ plain JSON-schema definition, same surface.
 *   - translate:        (value) => native, the shared translateMsysPath
 *                       composed fresh per call by the wiring, OR
 *   - translateMsysPath + buildEnv: the raw shared helper plus a fresh
 *                       mount-facts reader `() => buildTranslateEnv(...)`;
 *                       buildEnv is called once per tool call.
 *   - log:              optional (message) => void.
 *
 * @param {object} [deps]
 * @returns {{ inject: string[], apply: (ctx: object) => void }}
 */
export function createPathToolModule(deps = {}) {
  const definition = buildPathToolDefinition(deps)
  return {
    inject: ['tools'],
    apply(ctx) {
      if (typeof ctx?.tools?.register !== 'function') {
        throw new Error('path-tool: ctx.tools.register is unavailable; cannot own the tool registration')
      }
      const unregister = ctx.tools.register(definition)
      if (typeof unregister === 'function') {
        ctx.effect?.(() => () => {
          try {
            unregister()
          } catch { /* the scope is already rolling back */ }
        })
      }
      ;(typeof deps.log === 'function' ? deps.log : () => {})(
        `${PATH_TOOL_NAME} registered (explicit full-value MSYS→native conversion, no I/O)`,
      )
    },
  }
}
