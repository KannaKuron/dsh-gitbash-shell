import { prepareToolOwnership } from './tool-ownership.js'
/**
 * dsh-gitbash-shell — host half (route B: the own bash tool + preset variants).
 *
 * Installed as a profile bundle, this plugin gives dsh a Git Bash command
 * channel WITHOUT touching the host's official PowerShell executor (route B,
 * v0.39.0 — the executor instance lives in ./shell.js and is constructed in a
 * private scope for the plugin's own bash tool). On startup it also registers
 * four Git Bash agent preset variants, mirroring how dsh-ptc-cordis-preset
 * ships its 'ptc-cordis' preset:
 *
 *   standard-gitbash — 标准模式 · Git Bash (tool-bash on, tool-pwsh off)
 *   minimal-gitbash  — 极简模式 · Git Bash (persistent Git Bash terminal)
 *   code-gitbash     — PTC 模式 · Git Bash (Code Mode presentation)
 *   cordis-gitbash   — 创造模式 · Git Bash (self-modifying toolset; skills
 *                       copied from the INSTALLED shipped 'cordis' preset so
 *                       the guidance tracks the deployment)
 *
 * Presets are registered declaratively through agentPresets.register(); the
 * composition data lives in src/compositions.js. Earlier releases materialized
 * preset directories with a .plugin-managed.json marker. That path is gone, but
 * cleanupLegacyTrees() still removes an UNMODIFIED tree left behind by an old
 * version — a user-modified or foreign tree is never touched.
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { PRESET_META, minimalPluginsFor, pluginsFor } from './compositions.js'
import { loadSchemastery } from './schemastery.js'
import { mountInlineTools } from './inline-tools.js'
import { debugLog, problemLog } from './log.js'
import { adoptTerminalBundlePatch, detectTerminalBundle, terminalBundleReport, terminalDialect } from './terminal-bundle.js'
import { adoptGlobalPtcPatch, globalPtcReport } from './global-ptc.js'
import { resolveHostModule } from './bash-tool.js'
import { mountFastctx } from './fastctx-bridge.js'
import {
  ERROR_CONTENT_TOOLS,
  GIT_MOUNTS,
  PATH_DIALECT_DESCRIPTION,
  PATH_DIALECT_KEY,
  PATH_DIALECT_VALUE,
  POSIX_DIRECTIVE_TEXT,
  POSIX_DIRECTIVE_TEXT_STRICT,
  buildTranslateEnv,
  driveToMsys,
  msysEcho,
  pathEcho,
  programPrelude,
  rewriteCodePaths,
  rewriteErrorContent,
  rewriteErrorMessage,
  rewriteFailureMessage,
  rewriteResultPaths,
  runCodeHintFor,
  programLanguageFor,
  scanCodeLiterals,
  translateDispatch,
  translateGlobArguments,
  translateMsysPath,
  translatePathArguments,
  windowsToMsys,
} from './path-dialect.js'

export * from './path-dialect.js'

/**
 * The schemastery module, resolved LAZILY: `@deepseek-ai/schemastery` is a
 * PEER — plain Node cannot resolve it from this package, only the host's own
 * resolution (the profile shared fallback) supplies it. A static peer import
 * failure makes the Loader skip the whole plugin row as non-fatal
 * (`vendor/loader/src/config/entry.ts` `_init()`: logger.error + return, no
 * fiber), so the import stays dynamic.
 *
 * WHICH copy is resolved is not left to our own resolution order: the resolver
 * picks a copy that can produce the Volatile refs the host executor reads
 * (src/schemastery.js). Both call sites share one cached answer, so the row
 * Config and the executor Config cannot disagree.
 */
let Schema = null
try {
  Schema = (await loadSchemastery()).z ?? null
} catch (error) {
  Schema = null
  problemLog(
    '[gitbash-shell] @deepseek-ai/schemastery is not resolvable here; the row Config surface is absent'
    + ' (the preset registration and the client half do not depend on it): '
    + (error && error.message || String(error)),
  )
}

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-gitbash-shell'

/** The preset roster is a hard dependency: without it there is nothing to do. */
export const inject = ['agentPresets']

const TAG = '[gitbash-shell]'
const MANAGED_BY = 'dsh-gitbash-shell'
const MARKER_FILE = '.plugin-managed.json'

/** Default preset ids this plugin materializes, in roster order (configurable). */
export const PRESET_IDS = ['standard-gitbash', 'minimal-gitbash', 'code-gitbash', 'cordis-gitbash']

/**
 * Variant preset id -> the OFFICIAL successor id, for the deployment-default
 * migration (v0.35.0). Every target is verified against the LIVE roster
 * before any write — the official ids renamed once already (code→ptc), so a
 * missing successor stands the migration down instead of writing an unknown
 * id. `code-gitbash` deliberately maps to `ptc`: that variant has described
 * the official PTC mode since dsh 0.1.2 renamed it.
 */
export const VARIANT_DEFAULT_SUCCESSORS = Object.freeze({
  'standard-gitbash': 'standard',
  'minimal-gitbash': 'minimal',
  'code-gitbash': 'ptc',
  'cordis-gitbash': 'cordis',
})

/**
 * The variant dsh-ptc-cordis-preset already covers while cooperating: its
 * `PTC 创造模式` is materialized against Git Bash too, so our own
 * `创造模式 · Git Bash` describes the same mode (their issue #7).
 */
export const PEER_COVERED_PRESET_ID = 'cordis-gitbash'

/**
 * Service dsh-ptc-cordis-preset publishes:
 * `{ id, gitBashActive, pythonRuntime, pythonBackend? }`. `pythonRuntime` is
 * the user's INTENT for the experimental CPython run_code backend (the field
 * the settings card writes); `pythonBackend` ('python' | 'node', v0.15.1+,
 * additive) is the backend that is ACTUALLY active after the peer's own
 * preflight — package resolvable, interpreter qualified, POSIX host.
 */
export const PEER_CAPABILITY = 'ptcCordisPreset'

/**
 * The peer's CPython intent field — on its capability AND on its row Config
 * (the field both settings cards read and write).
 */
export const PEER_PYTHON_FIELD = 'pythonRuntime'

/** The peer's EFFECTIVE backend field on the capability ('python' | 'node'). */
export const PEER_PYTHON_BACKEND_FIELD = 'pythonBackend'

/**
 * Read one boolean fact off the peer's capability object. A getter is honoured
 * so a live peer can report its current switch rather than a boot-time copy;
 * anything absent, of the wrong type, or throwing reads as false — the
 * conservative direction is always "the official Node backend is in use".
 * @param {object|undefined} capability - the peer's published capability.
 * @param {string} field - the field name to read.
 * @returns {boolean} the fact, false when it cannot be established.
 */
export function peerFact(capability, field) {
  if (capability === null || capability === undefined) return false
  try {
    const raw = capability[field]
    const value = typeof raw === 'function' ? raw.call(capability) : raw
    return value === true
  } catch {
    return false
  }
}

/**
 * The peer's EFFECTIVE run_code backend, as the closed two-value vocabulary it
 * publishes. `undefined` means "the peer does not report one" — an older peer,
 * a getter that threw, or a value outside the vocabulary — and every caller
 * must then fall back to the INTENT, which is the pre-v0.15.1 behavior.
 * @param {object|undefined} capability - the peer's published capability.
 * @returns {'python'|'node'|undefined} the reported backend.
 */
export function peerBackend(capability) {
  if (capability === null || capability === undefined) return undefined
  try {
    const raw = capability[PEER_PYTHON_BACKEND_FIELD]
    const value = typeof raw === 'function' ? raw.call(capability) : raw
    return value === 'python' || value === 'node' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Is the experimental CPython backend ACTUALLY the one run_code will use? The
 * composition's workflow mutex keys on this, never on the bare intent: when the
 * peer's preflight fails (package removed, interpreter too old, win32) the
 * composition still runs Node, so forcing the workflow rows off would cost the
 * user a capability for nothing.
 *
 * An older peer without the effective field reports no backend, and the intent
 * stands in for it — exactly the pre-v0.15.1 behavior, so the linkage never
 * changes shape because a field is missing.
 * @param {object|undefined} capability - the peer's published capability.
 * @returns {boolean} true only while the CPython backend is the active one.
 */
export function pythonBackendActive(capability) {
  const intent = peerFact(capability, PEER_PYTHON_FIELD)
  const reported = peerBackend(capability)
  if (reported === undefined) return intent
  return intent && reported === 'python'
}

/**
 * Is this agent a DELEGATED one — a subagent, a team member, or a nested child
 * of either? The canonical in-tree signal is the session header pair dsh's own
 * workspace-changes plugin uses
 * (`packages/deliverables/workspace-changes/src/index.ts:59-60`), stamped when
 * the subagent driver creates a child
 * (`packages/subagent/subagent/src/child-agent.ts:139-155`):
 * `origin === 'subagent'` or a non-zero `delegationDepth`.
 *
 * Unknown shapes read as NOT delegated: applying the dialect is the helpful
 * direction, and a diagnostic assembly without an agent must keep it.
 * @param {object|undefined} agent - the assembling/executing agent, when known.
 * @returns {boolean} true only when the agent is provably delegated.
 */
export function isDelegatedAgent(agent) {
  try {
    const header = agent && agent.session ? agent.session.header : undefined
    if (header === null || typeof header !== 'object') return false
    if (header.origin === 'subagent') return true
    return typeof header.delegationDepth === 'number' && header.delegationDepth > 0
  } catch {
    return false
  }
}

/**
 * Does the Git Bash dialect apply to THIS agent (v0.27.0)? The row switch
 * `subagentDialect` (default ON) decides whether delegated agents — subagents,
 * team members, nested children — participate in the dialect at all; the main
 * agent always does. A closed function so every consumer (prompt assembly,
 * dispatch translation, result echo, failure text, the shell-env fact) answers
 * the same way.
 *
 * Note the honest bound: dsh has exactly ONE shell provider per process, so
 * the executor binary stays Git Bash for every agent; this gate governs the
 * dialect/translation layers that this plugin owns.
 * @param {object} dialect - the live dialect switches.
 * @param {object|undefined} agent - the agent that owns this assembly/execution.
 * @returns {boolean} true when the dialect applies to this agent.
 */
export function dialectApplies(dialect, agent) {
  if (!dialect || dialect.subagentDialect !== false) return true
  return !isDelegatedAgent(agent)
}

/**
 * The roster this plugin serves: the configured list, minus the variant a peer
 * already covers. Two independent facts must BOTH hold before anything is
 * dropped — the user's `suppressPeerCordis` switch (row Config, default OFF)
 * and the peer actually reporting a Git Bash-materialized preset. A peer that
 * is absent, inactive, or mounted later than this row therefore never costs
 * the user a variant, and the default keeps the historical four-variant roster
 * byte for byte.
 * @param {string[]} configured - the row's `presets` list (empty/absent = default).
 * @param {object} [options] - live decision inputs.
 * @param {boolean} [options.suppress] - the live `suppressPeerCordis` switch.
 * @param {boolean} [options.peerGitBash] - the peer capability's `gitBashActive`.
 * @returns {string[]} the ids to register (or materialize), in configured order.
 */
export function effectivePresetIds(configured, { suppress, peerGitBash } = {}) {
  const list = Array.isArray(configured) && configured.length > 0 ? [...configured] : [...PRESET_IDS]
  if (suppress !== true || peerGitBash !== true) return list
  return list.filter((id) => id !== PEER_COVERED_PRESET_ID)
}

/**
 * The ONE bash resolver (v0.28.0, issue #11): the executor (src/shell.js) and
 * this translation layer read the same memoized result, so "dialect translated
 * to Q:/Git but the executor still spawns C:/Program Files/Git" cannot happen.
 */
import {
  DEFAULT_GIT_BASH, GIT_BASH_DOWNLOAD_URL, bashResolutionReport,
  effectiveConfiguredBashPath, executorConfiguredBashPath, resolveGitBashCached,
} from './bash-path.js'
import { adoptTerminalShell, terminalAdoptReport } from './terminal-shell.js'
import {
  adoptOpsBashRemoval,
  opsAdoptReport,
  opsRestoreReport,
  restoreOpsBash,
} from './ops-adopt.js'
import {
  cancelToolJob, clearToolJob, currentToolJob, defaultRunnerIo, fenceToolRequest,
  probeToolchain, readJsonBody, startToolJob,
} from './tool-runner.js'

/** The shipped preset whose skills/ dir seeds cordis-gitbash. */

// ── tree hashing ────────────────────────────────────────────────────────────

/** Every file under `root`, as sorted relative POSIX-style paths. */
function walkFiles(root, rel = '') {
  const out = []
  let entries
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walkFiles(root, r))
    else if (e.isFile()) out.push(r)
  }
  return out.sort()
}

/** Map of relative path → sha256 for every file under `root`. */
function hashTree(root) {
  const files = {}
  for (const rel of walkFiles(root)) {
    if (rel === MARKER_FILE) continue
    files[rel] = createHash('sha256').update(readFileSync(join(root, rel))).digest('hex')
  }
  return files
}

/** The parsed marker, or null when the tree is not ours. */
function readMarker(target) {
  try {
    const m = JSON.parse(readFileSync(join(target, MARKER_FILE), 'utf8'))
    if (m && m.managedBy === MANAGED_BY && m.files && typeof m.files === 'object') return m
  } catch {
    /* absent or unreadable → not ours */
  }
  return null
}

/** Classify a preset directory: absent | foreign | user-modified | unmodified. */
function classify(target) {
  if (!existsSync(target)) return 'absent'
  const marker = readMarker(target)
  if (!marker) return 'foreign'
  const current = hashTree(target)
  const recorded = marker.files
  const keys = Object.keys(recorded)
  if (keys.length !== Object.keys(current).length) return 'user-modified'
  for (const k of keys) if (current[k] !== recorded[k]) return 'user-modified'
  return 'unmodified'
}

// ── inspect-registry compatibility shim ─────────────────────────────────────
//
// The host-plane runner's inspect registry is a process-global singleton and
// its `register` THROWS on a duplicate provider id. `tool-cordis` registers
// the same provider ids from every preset that mounts it, so a process
// hosting both the built-in Creation mode and any cordis-derived preset
// (cordis-gitbash here, ptc-cordis from dsh-ptc-cordis-preset) fails the
// SECOND mount. Two registrants of the SAME package produce identical
// manifests, so replacing the stored entry instead of throwing is a no-op for
// consumers, and the identity-guarded disposer keeps teardown consistent.
// Installed once at boot by this always-mounted host row, so every later
// cordis toolset mount coexists.

const SHIM_FLAG = '__gitbashShellRegisterShim'

/** Wrap one inspect registry's `register` to tolerate duplicate registrations. */
export function installRegisterShim(reg) {
  const restore = () => {}
  if (!reg || typeof reg.register !== 'function' || !(reg.providers instanceof Map)) {
    return { installed: false, restore }
  }
  if (reg.register[SHIM_FLAG] === true) return { installed: false, restore }
  const original = reg.register
  try {
    const wrapped = function register(registration) {
      try {
        return original.call(this, registration)
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        if (!message.includes('is already registered')) throw error
        const manifest = registration && registration.manifest
        if (!manifest || typeof manifest.id !== 'string') throw error
        const stored = { ...registration, manifest }
        this.providers.set(manifest.id, stored)
        const self = this
        return () => {
          if (self.providers.get(manifest.id) === stored) self.providers.delete(manifest.id)
        }
      }
    }
    try { Object.defineProperty(wrapped, SHIM_FLAG, { value: true }) } catch { /* cosmetic */ }
    reg.register = wrapped
    return {
      installed: true,
      restore: () => {
        try { if (reg.register === wrapped) reg.register = original } catch { /* never block */ }
      },
    }
  } catch {
    return { installed: false, restore }
  }
}

// ── unified path dialect: settings namespace + gate (v0.9.0) ───────────────
//
// The dialect (directive + translation wrapper) is OFF by default and gated
// by the posixPaths boolean on this plugin's row Config (volatile, read live
// per dispatch), flipped from the plugin's settings card (src/client.js). The
// directive's text closure returns '' while off — empty context contributions
// are dropped at assembly, so a disabled dialect adds zero prompt noise; the
// wrapper reads the same value per dispatch and passes calls through.

/**
 * Row Config = this plugin's live settings surface (values persist under the
 * row id 'gitbash-shell'). Every editable field is volatile, so a change lands
 * on the next read without a remount. Absent (undefined) when schemastery is
 * unresolvable: cordis then passes the row config through unvalidated instead
 * of the whole row disappearing.
 */
export const Config = Schema === null ? undefined : Schema.object({
  // Row-level knob predating the Config surface (invariant 6): which preset
  // variants to serve. Ordinary config — an edit remounts the plugin, which
  // is the right weight for a list that changes the roster.
  presets: Schema.array(Schema.string()).default(PRESET_IDS),
  posixPaths: Schema.boolean().default(true).volatile(),
  virtualMounts: Schema.boolean().default(true).volatile(),
  globSplit: Schema.boolean().default(true).volatile(),
  errorDialect: Schema.boolean().default(true).volatile(),
  codePaths: Schema.boolean().default(true).volatile(),
  /**
   * Whether DELEGATED agents (subagents, team members, nested children) also
   * use the Git Bash dialect (v0.27.0). Default ON — the historical behavior;
   * OFF keeps the dialect to the main agent, so a delegated request carries the
   * official shell semantics (no prompt rewrite, no path-argument translation,
   * no echo rewrite, no DSH_PATH_DIALECT fact). The executor itself is one
   * per-process provider, so Git Bash stays the binary either way.
   */
  subagentDialect: Schema.boolean().default(true).volatile(),
  gitAutocrlf: Schema.boolean().default(true).volatile(),
  bashPath: Schema.string().default('').volatile(),
  /**
   * Bash init script (issue #37, v0.45.0): path of a file every `bash -c`
   * must source before running the command. Implemented as `BASH_ENV`, the
   * shell's OWN hook for non-interactive shells — `bash -c` sources it once,
   * with none of `-l`'s side effects (no `cd $HOME`, no PATH reordering, no
   * profile output in stdout). The reported case is fnm/nvm-style node
   * managers: `eval "$(fnm env)"` in that file makes node/npm visible to every
   * tool call. Empty (default) = BASH_ENV is never set, behavior unchanged.
   * `~` expands to the home directory; the path must exist (a missing file is
   * silently ignored by bash, so a typo looks like "not set").
   */
  initScript: Schema.string().default('').volatile(),
  adoptSidebar: Schema.boolean().default(true).volatile(),
  /**
   * Whether the OFFICIAL sidebar terminal ("new terminal") is switched to the
   * resolved Git Bash (v0.29.0, task-25). Default ON — the user asked for
   * exactly this ("自动检测 … 帮忙补上一个 gitbash 可以用"). On Windows without
   * this, dsh resolves the terminal shell from the environment, which on a
   * machine whose PATH `bash` is the WSL launcher means the new terminal starts
   * Ubuntu, not Git Bash. Only ever writes when the terminal has NO shell of
   * its own: an explicit choice is never overwritten.
   */
  autoTerminalShell: Schema.boolean().default(true).volatile(),
  /**
   * Dedupe switch against dsh-ptc-cordis-preset (their issue #7, v0.25.0):
   * ON while that plugin is installed AND materializing its `PTC 创造模式`
   * against Git Bash drops OUR `创造模式 · Git Bash` from the roster, because
   * the two describe the same mode. Default OFF — the historical four-variant
   * roster is unchanged until asked for. The same state is rendered on their
   * settings card too (their card binds this row through configForms), so
   * changing it on either side changes it here.
   */
  suppressPeerCordis: Schema.boolean().default(false).volatile(),
  /**
   * Serve the four `* · Git Bash` VARIANT presets (v0.34.x behaviour) instead
   * of relying on the inline tool patch (v0.35.0). Default OFF for every user
   * — new and existing — per the owner's explicit call: the official presets
   * carry Git Bash through the per-agent tool patch, the roster stays the
   * official four, and the variants remain one switch away for anyone who
   * wants the duplicated roster back. OFF also stops the reconcile from
   * registering variants; a session pinned to a variant id must re-select an
   * official preset (the roster flip is announced in the CHANGELOG).
   */
  variantPresets: Schema.boolean().default(false).volatile(),
  /**
   * Show the host `pwsh` tool to agents (v0.39.0 semantics; default OFF).
   * Route B keeps the official pwsh executor in place, so the tool is REAL
   * PowerShell (7 first per the official resolver) — showing it is a pure
   * product choice. OFF (default) hides it per agent: the host stays
   * bash-first. The retired v0.37 `pwsh7` side-channel is gone; this switch
   * now controls the real thing.
   */
  pwshTool: Schema.boolean().default(false).volatile(),
  // Maintainer PR #26 decision: one live opt-out for refusal and companions.
  experimentalNative: Schema.boolean().default(true).volatile(),
  /**
   * Issue #45: hide ONLY `gitbash_to_native_path`. The total switch above still
   * owns `gitbash_native` and the fail-closed refusal; turning this OFF keeps
   * both. Default ON preserves the v0.52.0 tool face for existing users.
   */
  pathTool: Schema.boolean().default(true).volatile(),
  /**
   * Publish the FastCtx file tools (`gb_*`) through the local MCP bridge.
   * Default OFF (dsh-ops 0.3.0 supersedes it); Windows-only payload, and it
   * stands down entirely when dsh-ops is present.
   */
  fastctxTools: Schema.boolean().default(false).volatile(),
  /**
   * Run supported agents through the GLOBAL PTC run_code SDK instead of a
   * native per-tool face (default OFF, and deliberately NOT volatile).
   *
   * The root executor is a profile-patch decision read at boot, so this is a
   * patch write and not a live toggle: an edit remounts the plugin, which is
   * the right weight for a change that lands on the next start. OFF never
   * adopts new rows; OFF/disable/uninstall lifts only receipted rows whose
   * data AND comments are still exactly what this switch wrote.
   *
   * What it writes (see src/global-ptc.js): `tool-executor-native` off and
   * `tool-executor-ptc` on. preset-minimal is deliberately NOT restated: its
   * complete persona erases the SDK, so minimal is outside this switch's
   * supported presets and needs a deployment-owned preset override instead.
   */
  globalPtcSdk: Schema.boolean().default(false),
})

/** Read one Config value: a Volatile ref, or a plain value from a test. */
export function valueOf(value) {
  return value && typeof value.get === 'function' ? value.get() : value
}

/**
 * This row's OWN live `bashPath` (issue #13): apply()'s `config` parameter IS
 * the `gitbash-shell` row's resolved Config, so reading it here replaces the
 * settings-service detour (`settingsBashPath`) that could read '' at apply
 * time on hosts where the service is describe()/update()-only or not injected
 * yet. Volatile refs mean a settings edit lands on the next read, no listener.
 * @param {object|undefined} config - apply()'s resolved Config (may be absent).
 * @returns {string} the row's `bashPath`, '' when unset or unreadable.
 */
export function rowBashPath(config) {
  try {
    const value = config && typeof config === 'object' ? valueOf(config.bashPath) : undefined
    return typeof value === 'string' ? value.trim() : ''
  } catch {
    return ''
  }
}

/**
 * Live settings reader for everything wired inside apply(): it reads this
 * plugin's own Config refs (no listener needed — every consumer here already
 * re-reads per dispatch/assembly).
 * @param {object} ctx - the plugin's mounting context (kept for the call shape).
 * @param {object|undefined} config - apply()'s resolved Config.
 * @returns {{ dialect: () => object, posix: () => boolean, adoptSidebar: () => boolean, suppressPeerCordis: () => boolean }}
 */
function makeLiveReader(ctx, config) {
  const hasConfig = !!(config && typeof config === 'object')
  const dialect = () => {
    if (!hasConfig) {
      // No row Config (schemastery unresolvable): everything off except the
      // opt-out booleans.
      return {
        posixPaths: false, virtualMounts: false, globSplit: false, errorDialect: false,
        codePaths: false, gitAutocrlf: false, bashPath: '', subagentDialect: true, autoTerminalShell: true,
      }
    }
    const bash = valueOf(config.bashPath)
    return {
      posixPaths: valueOf(config.posixPaths) === true,
      virtualMounts: valueOf(config.virtualMounts) === true,
      globSplit: valueOf(config.globSplit) === true,
      errorDialect: valueOf(config.errorDialect) === true,
      codePaths: valueOf(config.codePaths) === true,
      gitAutocrlf: valueOf(config.gitAutocrlf) === true,
      // Default ON: delegated agents keep the dialect unless the user opts out.
      subagentDialect: valueOf(config.subagentDialect) !== false,
      bashPath: typeof bash === 'string' ? bash : '',
      adoptSidebar: valueOf(config.adoptSidebar) !== false,
      // Default ON (v0.29.0): the official terminal is ours unless opted out.
      autoTerminalShell: valueOf(config.autoTerminalShell) !== false,
      // Default OFF (v0.35.0): the official presets carry Git Bash through the
      // inline tool patch; the variant roster is opt-in.
      variantPresets: valueOf(config.variantPresets) === true,
      // Default OFF (v0.39.0): route B keeps the real pwsh tool hidden unless
      // the user explicitly shows it.
      pwshTool: valueOf(config.pwshTool) === true,
      // Default OFF (v0.39.4, dsh-ops 0.3.0): FastCtx is dead upstream and dsh-ops ships stronger native ops_* file tools; an explicit true re-enables the bridge. It still stands down when dsh-ops is present.
      fastctxTools: valueOf(config.fastctxTools) === true,
      // Default OFF: the root executor keeps its official native shape until
      // the profile patch says otherwise (see src/global-ptc.js).
      globalPtcSdk: valueOf(config.globalPtcSdk) === true,
    }
  }
  return {
    dialect,
    posix: () => dialect().posixPaths === true,
    adoptSidebar: () => dialect().adoptSidebar !== false,
    autoTerminalShell: () => dialect().autoTerminalShell !== false,
    variantPresets: () => (hasConfig ? valueOf(config.variantPresets) === true : false),
    pwshTool: () => (hasConfig ? valueOf(config.pwshTool) === true : false),
    experimentalNative: () => (hasConfig ? valueOf(config.experimentalNative) !== false : true),
    // Issue #45: independent default-ON gate for gitbash_to_native_path only.
    pathTool: () => (hasConfig ? valueOf(config.pathTool) !== false : true),
    fastctxTools: () => (hasConfig ? valueOf(config.fastctxTools) === true : false),
    // Default OFF: only an explicit true asks for deduplication.
    suppressPeerCordis: () => (hasConfig ? valueOf(config.suppressPeerCordis) === true : false),
  }
}

// ── dsh-better-sidebar shell cooperation ───────────────────────────────────
//
// dsh-better-sidebar (v0.15.2+) resolves its terminal shell PER OPEN: a
// settings-page `terminalShell` value wins over the yaml/plugin default
// (their own words: "values here win for terminals opened afterwards").
// So this plugin adopts that official runtime seam — zero upstream change,
// no restart needed — and points the sidebar's UI terminal tabs AND the
// model-facing terminal_* tools at Git Bash on Windows. The plugin TAKES
// OVER the pref unconditionally while installed (a value set elsewhere is
// overwritten at every boot — that is the contract); the previous value is
// captured and restored on disposal (reload/update/uninstall), so removing
// this plugin returns the sidebar to what it was before.

// The settings namespace is the row id in dsh-better-sidebar's own bundle
// patch (`- id: better-sidebar`; verified against the published 0.25.0
// tarball) — NOT the npm package name. Using the package name made
// settings.describe() never match and every takeover silently no-op with one
// "unavailable" log line (issue #25, Bug 3).
const SIDEBAR_NS = 'better-sidebar'
const SIDEBAR_TRIES = 12
const SIDEBAR_RETRY_MS = 1500

/**
 * Reconcile the better-sidebar `terminalShell` takeover with the adoptSidebar
 * setting (v0.15.0, default ON). ON writes our bashPath (remembering what was
 * there before); OFF restores that previous value — but only while the current
 * value is still ours, so a user's manual choice is never clobbered. The
 * polling keeps the original ready-wait behavior: at boot the settings
 * service may not be provided yet when this row's apply runs. Never throws.
 *
 * `readAdopt` is apply()'s live gate getter (`() => liveSettings.
 * adoptSidebar()`), passed in because this module-level helper cannot see
 * that scope-local reader itself (v0.24.2 regression fix — referencing
 * `liveSettings` here threw `ReferenceError: liveSettings is not defined`
 * from `run()` and aborted the whole plugin mount).
 */
function adoptSidebarShell(ctx, bashPath, readAdopt) {
  let adopted = false
  let previous = ''
  let tried = 0
  let timer = null
  let closed = false
  let serial = Promise.resolve()
  /* better-sidebar 0.32 dropped `terminalShell` from its row Config; its
     terminal now takes the shell from the terminal service's browser-local
     preference. Writing the retired field makes the loader reject the update
     ("Config field terminalShell is not volatile") on every boot. Probe the
     live schema first: no field means there is nothing to adopt host-side, so
     the client half owns the new channel and this helper stays silent. */
  const legacySidebarShellSupported = () => {
    const settings = ctx.get('settings')
    if (!settings || typeof settings.describe !== 'function') return null
    try {
      const entry = settings.describe().find((row) => row && row.ns === SIDEBAR_NS)
      if (!entry) return false
      const fields = entry.schema && entry.schema.dict
      if (fields && typeof fields === 'object') return Object.prototype.hasOwnProperty.call(fields, 'terminalShell')
      return !!entry.value && typeof entry.value === 'object' && Object.prototype.hasOwnProperty.call(entry.value, 'terminalShell')
    } catch { return null }
  }
  const readShell = () => {
    const settings = ctx.get('settings')
    if (!settings || typeof settings.update !== 'function') return null
    try {
      if (typeof settings.describe !== 'function') return null
      const entry = settings.describe().find((row) => row && row.ns === SIDEBAR_NS)
      const value = entry?.value
      return value && typeof value.terminalShell === 'string' ? value.terminalShell : ''
    } catch { return null }
  }
  const restore = async () => {
    if (!adopted) return
    const now = readShell()
    if (now === null) return
    // The user may have selected another shell since our takeover.
    if (now === bashPath) {
      await ctx.get('settings').update(SIDEBAR_NS, { terminalShell: previous })
      debugLog(TAG + " better-sidebar shell restored ('" + previous + "')")
    }
    adopted = false
  }
  const reconcileSidebar = async (desired) => {
    const current = readShell()
    if (current === null) return false
    if (!desired) { await restore(); return true }
    if (adopted || current === bashPath) return true
    previous = current
    await ctx.get('settings').update(SIDEBAR_NS, { terminalShell: bashPath })
    adopted = true
    debugLog(TAG + ' dsh-better-sidebar terminal shell -> Git Bash (' + bashPath + ')')
    return true
  }
  const run = () => {
    if (closed) return serial
    if (legacySidebarShellSupported() === false) {
      if (readAdopt() === true) debugLog(TAG + ' better-sidebar has no terminalShell field (0.32+); the terminal service preference is used instead')
      return serial
    }
    if (timer) { clearTimeout(timer); timer = null }
    serial = serial.then(async () => {
      if (closed) return
      tried += 1
      const ok = await reconcileSidebar(readAdopt())
      if (ok || closed) return
      if (tried < SIDEBAR_TRIES) timer = setTimeout(run, SIDEBAR_RETRY_MS)
      else problemLog(TAG + ' better-sidebar shell adoption skipped: settings unavailable')
    }).catch((error) => {
      problemLog(TAG + ' better-sidebar shell adoption unavailable: ' + (error?.message ?? error))
    })
    return serial
  }
  try {
    ctx.on('loader/volatile-update', (paths) => {
      if (!Array.isArray(paths) || !paths.some((path) => Array.isArray(path) && path[0] === 'adoptSidebar')) return
      tried = 0
      void run()
    })
  } catch { /* a diagnostic context may have no event service */ }
  ctx.effect(() => async () => {
    closed = true
    if (timer) clearTimeout(timer)
    await serial
    await restore()
  }, 'dsh-gitbash-shell: sidebar shell revert')
  return run()
}

// ── plugin ──────────────────────────────────────────────────────────────────

// ── declarative registration ────────────────────────────────────────────────
//
// A preset is a definition registered through agentPresets.register(); dsh
// >=0.2.2-rc.1 has no directory-preset path. The composition data lives in
// src/compositions.js.

/** Resolve the Creation-skills dir beside @deepseek-ai/dsh-agent-preset. */
async function resolveSkillsDir() {
  try {
    const { createRequire } = await import('node:module')
    const here = createRequire(import.meta.url)
    const pkg = here.resolve('@deepseek-ai/dsh-agent-preset/package.json')
    return join(dirname(pkg), 'skills')
  } catch {
    return undefined
  }
}

/** The legacy preset root, best effort (used only to remove old leftovers). */
function legacyPresetRoot() {
  try {
    const env = process.env.DSH_HOME
    if (env && env.trim() !== '') return join(env, '.agent-presets')
    return join(homedir(), '.dsh', '.agent-presets')
  } catch {
    return undefined
  }
}

/**
 * Remove the stale materialized trees a previous (pre-0.1.7-host) version
 * left behind, when they are still byte-identical to what we wrote (the
 * marker judges). User-modified and foreign trees stay untouched — the same
 * ownership rules the materializer itself follows.
 */
function cleanupLegacyTrees(presetIds) {
  const root = legacyPresetRoot()
  if (!root) return
  for (const presetId of presetIds) {
    const target = join(root, presetId)
    const state = classify(target)
    if (state === 'unmodified') {
      try {
        rmSync(target, { recursive: true, force: true })
        debugLog(TAG + ' removed the stale materialized preset at ' + target + ' (directory presets are no longer read on this host; the declarative registration replaces it)')
      } catch (error) {
        problemLog(TAG + ' stale preset cleanup failed: ' + (error && error.message ? error.message : error))
      }
    } else if (state === 'user-modified') {
      problemLog(TAG + ' a user-modified preset tree remains at ' + target + ' — left untouched (this host ignores it; delete it manually if unwanted)')
    }
  }
}

/**
 * Probe the dsh host additions for the variant compositions.
 *
 * `timeContext` / `toolSchedule` / `pluginMarket` / `compaction` are
 * optional official rows (durable clock readings, reminder tools, the plugin
 * market row, the minimal tool-fs + compaction delta, and the rc.2 native
 * Office tool). `profileContext` is the live host service the manager/market
 * rows gate on — read from ctx, not from the package set. The rc.2-only office
 * probe also gates the rc.2 row dialect (tool-subagent-control.interrupt).
 *
 * A preset row whose package is absent rejects the WHOLE mount, so optional
 * rows ride this probe: each is added only when its package resolves from
 * the HOST's module base — `ctx.baseUrl`, the exact base
 * `prepareProfileEntries` mounts preset rows from, so the probe can never
 * disagree with the mounter. Probed once per boot; the profile's package set
 * does not change under a running host. A missing core row is not masked here:
 * the 0.2.2-rc.1 base rows (tool-executor-*, agent-preset, …) are emitted
 * unconditionally, so an inconsistent host fails the mount loudly.
 * @param {object} ctx - cordis context (any fiber of the running host).
 * @param {Function} [resolve] - predicate override for tests; receives a
 *   package specifier, resolves like `require.resolve`, returns boolean.
 * @returns {Promise<{timeContext: boolean, toolSchedule: boolean,
 *   pluginMarket: boolean, compaction: boolean, office: boolean,
 *   profileContext: boolean}>}
 */
export async function probeHostExtras(ctx, resolve) {
  let ok = resolve
  if (ok === undefined) {
    try {
      const { createRequire } = await import('node:module')
      const req = createRequire(ctx?.baseUrl ?? import.meta.url)
      ok = (specifier) => {
        try { req.resolve(specifier); return true } catch { return false }
      }
    } catch {
      ok = () => false
    }
  }
  const [timeContext, toolSchedule, pluginMarket, compaction, office] = await Promise.all([
    Promise.resolve(safeProbe(ok, '@deepseek-ai/dsh-time-context')).then(Boolean),
    Promise.resolve(safeProbe(ok, '@deepseek-ai/dsh-tool-schedule')).then(Boolean),
    Promise.resolve(safeProbe(ok, '@deepseek-ai/dsh-plugin-market/tools')).then(Boolean),
    Promise.resolve(safeProbe(ok, '@deepseek-ai/dsh-compaction-basic')).then(Boolean),
    Promise.resolve(safeProbe(ok, '@deepseek-ai/dsh-tool-office')).then(Boolean),
  ])
  let profileContext = false
  try {
    profileContext = ctx?.get?.('profileContext') !== undefined
  } catch {
    profileContext = false
  }
  return { timeContext, toolSchedule, pluginMarket, compaction, office, profileContext }
}

/** Run one probe predicate; ANY failure reads as "absent" (a throwing
 * resolver must degrade the row away, never reject the boot). */
function safeProbe(ok, specifier) {
  try {
    return ok(specifier)
  } catch {
    return false
  }
}

/**
 * The minimal variant's PTY row (`terminal-bash`) pins the shell binary it
 * spawns; before issue #15 that was the one hardcoded `DEFAULT_GIT_BASH`
 * copy left in the tree while every other consumer had moved to the
 * resolver, so a Git installed outside `C:/Program Files/Git` failed every
 * PTY spawn with node-pty's "File not found". The row now rides the ONE
 * resolution chain (explicit config tier first — readConfiguredBashPath,
 * the same chain the executor runs), read LAZILY per registration
 * (issue #13: never frozen at apply time). An unresolved chain returns
 * `undefined` and the composition then pins the historical default: per the
 * two hard rules a missing Git Bash stays a VISIBLE spawn failure — never a
 * substitute shell.
 * @param {() => object} [readResolution] - the lazy resolution reader shared
 *   with the executor and the capability service.
 * @returns {string|undefined} the resolved Git Bash path, or `undefined`
 *   when unresolved (the composition falls back to the visible default).
 */
export function minimalPtyBashPath(readResolution) {
  try {
    const resolution = readResolution()
    return resolution && resolution.ok && resolution.path ? resolution.path : undefined
  } catch {
    return undefined
  }
}

/**
 * Register one variant definition; returns the unregister function. Mount
 * failures stay visible through the roster's broken diagnostic instead of
 * failing the boot.
 */
async function migrateVariantDefault(ctx, readVariants) {
  if (readVariants() === true) return true
  const readDefault = () => { try { return ctx.agentPresets.defaultId } catch { return undefined } }
  const current = readDefault()
  if (typeof current !== 'string' || !PRESET_IDS.includes(current)) return true
  const target = VARIANT_DEFAULT_SUCCESSORS[current]
  try {
    const settings = ctx.get('settings')
    if (!settings || typeof settings.update !== 'function') return false
    const roster = await ctx.agentPresets.list()
    if (!Array.isArray(roster) || !roster.some((row) => row && row.id === target)) {
      problemLog(TAG + ' default-preset migration stood down: successor "' + target + '" is not registered. Set an OFFICIAL default or turn variantPresets on.')
      return false
    }
    // A roster read is asynchronous: never overwrite a newer user selection.
    if (readVariants() === true || readDefault() !== current) return true
    await settings.update('agent-preset-registry', { selectedDefault: target })
    const after = readDefault()
    if (after !== target) {
      problemLog(TAG + ' default-preset migration did not stick (read back "' + after + '"). Set an OFFICIAL default or turn variantPresets on.')
      return false
    }
    debugLog(TAG + ' deployment default migrated: "' + current + '" -> "' + target
      + '" (variantPresets is off). Pinned sessions are unchanged; agent-preset/locked still requires a NEW session.')
    return true
  } catch (error) {
    problemLog(TAG + ' default-preset migration failed: ' + (error?.message ?? error)
      + '. Set an OFFICIAL default or turn variantPresets on; variants were not retired.')
    return false
  }
}

async function registerVariant(ctx, presetId, { skillsDir, pythonActive, hostExtras = {}, readBashResolution }) {
  const meta = PRESET_META[presetId]
  if (!meta) return undefined
  const plugins = meta.kind === 'minimal'
    ? minimalPluginsFor({ bashPath: minimalPtyBashPath(readBashResolution), hostExtras })
    : pluginsFor({ kind: meta.kind, skillsDir, pythonActive, hostExtras })
  return ctx.agentPresets.register({
    id: presetId,
    name: meta.name,
    description: meta.description,
    order: meta.order,
    plugins,
  })
}

/**
 * Declarative-era wiring: keep exactly one registration per VARIANT THIS HOST
 * SHOULD SERVE for the plugin's lifetime, and re-reconcile whenever that set
 * changes. Three inputs drive it — the live `suppressPeerCordis` switch, the
 * peer capability appearing (or leaving) via `ctx.inject`, which fires
 * independent of row activation order, and the peer's EFFECTIVE CPython
 * backend (`pythonBackend`, falling back to the `pythonRuntime` intent on a
 * peer that does not report one), which changes the ROWS of every variant —
 * and the peer's own coverage only counts while it reports a Git Bash-
 * materialized preset.
 *
 * The roster picks entries up immediately; sessions already pinned to a
 * variant keep their revision until recomposed, so suppressing a variant never
 * rewrites a running session.
 * @param {object} ctx - the plugin's mounting context.
 * @param {string[]} presetIds - the row's configured variants.
 * @param {() => boolean} readSuppress - live dedupe switch reader.
 * @param {() => object} readBashResolution - lazy Git Bash resolution reader
 *   (the chain shared with the executor and the capability); the minimal
 *   variant's PTY row reads it once per registration (issue #15).
 * @returns {Promise<void>} resolves once the first reconcile finished.
 */
async function runDeclarativeEra(ctx, presetIds, readSuppress, readBashResolution, readVariants) {
  cleanupLegacyTrees(presetIds)
  const skillsDir = await resolveSkillsDir()
  // Optional official rows (time-context / tool-schedule / plugin-market /
  // minimal compaction) probe once per boot and ride every (re-)registration
  // below — the profile's package set cannot change under a running host.
  const hostExtras = await probeHostExtras(ctx)
  /** presetId -> unregister, i.e. exactly what is live right now. */
  const live = new Map()
  let peerGitBash = false
  let peerPython = false
  /** The CPython fact the LIVE registrations were built with. */
  let registeredPython = false
  let serial = Promise.resolve()
  let closed = false
  ctx.effect(() => async () => {
    closed = true
    await serial
    const failures = []
    for (const [presetId, off] of [...live]) {
      live.delete(presetId)
      try { await off() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Git Bash preset cleanup failed')
  }, 'dsh-gitbash-shell: declarative preset registrations')

  // v0.35.0: the variant roster is opt-in (`variantPresets`, default OFF).
  // OFF means an EMPTY desired set — the cleanup above still runs, so a
  // legacy materialized tree never survives just because the switch is off.
  const desired = () => (readVariants && readVariants() === true
    ? effectivePresetIds(presetIds, { suppress: readSuppress(), peerGitBash })
    : [])

  const reconcile = () => {
    if (closed) return serial
    serial = serial.then(async () => {
      if (closed) return
      const want = desired()
      const pythonActive = peerPython
      // Dynamic OFF repairs the deployment default BEFORE retiring its id.
      // Keep registrations if the official migration cannot be verified.
      if (live.size > 0 && readVariants() !== true
        && !await migrateVariantDefault(ctx, readVariants)) return
      if (closed) return
      // The peer's EFFECTIVE CPython backend rewrites the workflow rows of
      // EVERY variant (the official Python composition disables them, and
      // workflow-ptc refuses a non-TypeScript backend), so a flip re-registers
      // the live variants instead of leaving stale rows mounted. Same cadence
      // as the backend swap itself: the peer's patch is evaluated at boot. A
      // bare INTENT without the effective backend changes nothing here — the
      // composition still runs Node, so the workflow rows must stay live.
      if (live.size > 0 && registeredPython !== pythonActive) {
        for (const [presetId, off] of [...live]) {
          live.delete(presetId)
          try {
            await off()
            debugLog(TAG + " preset '" + presetId + "' retired (peer CPython backend changed; rows are rebuilt)")
          } catch (error) {
            live.set(presetId, off)
            problemLog(TAG + " preset '" + presetId + "' retirement failed: " + (error && error.message ? error.message : error))
            return // never register replacements after an unverified retirement
          }
        }
      }
      for (const [presetId, off] of [...live]) {
        if (want.includes(presetId)) continue
        live.delete(presetId)
        try {
          await off()
          debugLog(TAG + " preset '" + presetId + "' retired (dsh-ptc-cordis-preset covers Creation mode on Git Bash)")
        } catch (error) {
          live.set(presetId, off)
          problemLog(TAG + " preset '" + presetId + "' retirement failed: " + (error && error.message ? error.message : error))
          return
        }
      }
      for (const presetId of want) {
        if (closed) break
        if (live.has(presetId)) continue
        try {
          const unregister = await registerVariant(ctx, presetId, { skillsDir, pythonActive, hostExtras, readBashResolution })
          if (unregister) {
            if (closed) { await unregister(); break }
            live.set(presetId, unregister)
            debugLog(TAG + " preset '" + presetId + "' registered declaratively")
          }
        } catch (error) {
          problemLog(TAG + " preset '" + presetId + "' registration failed: " + (error && error.message ? error.message : error))
        }
      }
      registeredPython = pythonActive
    }).catch((error) => {
      problemLog(TAG + ' preset reconcile failed: ' + (error && error.message ? error.message : error))
    })
    return serial
  }

  await reconcile()
  if (closed) return
  debugLog(TAG + ' registered ' + live.size + ' preset(s) declaratively (' + [...live.keys()].join(', ') + ')'
    + (live.size === 0 ? ' — variantPresets is off: the official presets carry Git Bash through the inline tool patch (see the CHANGELOG)'
      : '')
    + (hostExtras.timeContext || hostExtras.toolSchedule || hostExtras.pluginMarket || hostExtras.compaction
    ? ' [host rows: ' + [
        hostExtras.timeContext ? 'time-context' : '',
        hostExtras.toolSchedule ? 'tool-schedule' : '',
        hostExtras.pluginMarket ? 'plugin-market' : '',
        hostExtras.compaction ? 'minimal compaction' : '',
      ].filter(Boolean).join(' + ') + ']'
    : ''))

  // The peer's capability: `ctx.inject` makes this independent of row order,
  // and the child scope's disposer runs when the peer unmounts (or its row is
  // disabled), which restores the variant.
  try {
    ctx.inject([PEER_CAPABILITY], (peerCtx) => {
      try {
        const coverage = peerCtx[PEER_CAPABILITY] ?? peerCtx.get(PEER_CAPABILITY)
        const nextGitBash = peerFact(coverage, 'gitBashActive')
        // INTENT (what the user asked for) vs EFFECTIVE (what run_code will
        // actually use). Only the effective fact may cost the user a variant's
        // workflow rows; the intent alone is reported, never acted on.
        const intentPython = peerFact(coverage, PEER_PYTHON_FIELD)
        const reportedBackend = peerBackend(coverage)
        const nextPython = pythonBackendActive(coverage)
        if (nextGitBash !== peerGitBash || nextPython !== peerPython) {
          peerGitBash = nextGitBash
          peerPython = nextPython
          if (nextPython) debugLog(TAG + ' peer reports the experimental CPython run_code backend: workflow rows go off in every variant')
          else if (intentPython) {
            problemLog(TAG + ' peer has the CPython switch on but the effective backend is '
              + (reportedBackend === undefined ? 'unreported (older peer: the intent stands in)' : reportedBackend)
              + ': workflow rows stay on (reason in the host log)')
          }
          void reconcile()
        }
      } catch (error) {
        problemLog(TAG + ' peer coverage read failed: ' + (error && error.message ? error.message : error))
      }
      peerCtx.effect(() => () => {
        if (!peerGitBash && !peerPython) return
        peerGitBash = false
        peerPython = false
        void reconcile()
      }, 'dsh-gitbash-shell: peer coverage release')
    })
  } catch (error) {
    problemLog(TAG + ' peer capability wiring failed: ' + (error && error.message ? error.message : error))
  }

  // The switches themselves: a volatile Config edit on this row lands as a
  // loader/volatile-update event on this fiber (v0.35.0 adds variantPresets).
  try {
    ctx.on('loader/volatile-update', (paths) => {
      try {
        if (!Array.isArray(paths) || !paths.some((path) => Array.isArray(path)
          && (path[0] === 'suppressPeerCordis' || path[0] === 'variantPresets'))) return
        void reconcile()
      } catch (error) {
        problemLog(TAG + ' dedupe switch handling failed: ' + (error && error.message ? error.message : error))
      }
    })
  } catch (error) {
    problemLog(TAG + ' dedupe switch wiring failed: ' + (error && error.message ? error.message : error))
  }

  // If settings appears after an OFF transition failed closed, retry it.
  ctx.inject(['settings'], () => { void reconcile() })
}

export async function apply(ctx, config = {}) {
  const presetIds = Array.isArray(config.presets) && config.presets.length > 0 ? config.presets : PRESET_IDS

  // The shim rides along every mount of this plugin and degrades silently if
  // the upstream shape differs from what we verified.
  //
  // INSTALL TIMING (aligned with dsh-ptc-cordis-preset 0.6.3): the host
  // runner row activates AFTER this plugin's row, so a one-shot
  // installRegisterShim(ctx.get('cordisInspect')) sampled a service that was
  // not provided yet and silently installed nothing — every later mount of a
  // second cordis-mode preset (e.g. 'cordis · Git Bash' beside the built-in
  // Creation mode) kept dying with 'Host Cordis inspect provider "Service"
  // is already registered' for the rest of the process. ctx.inject schedules
  // the install for the moment the service actually appears — independent of
  // row activation order, and still a no-op in a runner-less deployment.
  try {
    ctx.inject(['cordisInspect'], (inspectCtx) => {
      const shim = installRegisterShim(inspectCtx.get('cordisInspect'))
      if (!shim.installed) return
      inspectCtx.effect(() => () => shim.restore(), 'dsh-gitbash-shell: inspect-registry shim')
      debugLog(`${TAG} inspect-registry compatibility shim active (multiple cordis-mode sessions supported)`)
    })
  } catch (error) {
    problemLog(`${TAG} inspect-registry shim wiring failed: ${error?.message ?? error}`)
  }

  // Era-aware live settings: every consumer below re-reads the row Config
  // refs on every use (volatile), so a flipped knob lands on the next
  // dispatch with zero wiring. Declared BEFORE the cooperation capability so
  // its getters share the same reader (v0.40.3 pwshToolEnabled) — the
  // capability must answer with the exact value the masking layer sees.
  const liveSettings = makeLiveReader(ctx, config)

  // ── cooperation capability ────────────────────────────────────────────────
  // Publish whether the Git Bash shell stack is active on this host so peer
  // plugins (e.g. dsh-ptc-cordis-preset) can adopt it in the presets they
  // materialize: service present, 'active: true' on Windows, 'active: false'
  // where the bundle is installed but the platform stack stayed native.
  /* The explicit tier of the resolution chain, in its documented priority:
     the (pre-v0.39, legacy-profile) `gitbash-executor` row's config > the `gitbash-shell` row's
     `bashPath` field > empty (= run the automatic chain). Both this layer and
     the executor resolve from this same value, so an explicit answer is never
     substituted and never silently ignored.
     (issue #11: the row config is where the reporter's workaround landed.)
     LAZY, never frozen (issue #13): a single apply()-time snapshot can be
     taken before the profile's rows settle, and a stale '' then ran the
     automatic chain (which fails on shimmed Git layouts) while the executor's
     own per-call lazy resolution worked — the same boot gave OPPOSITE
     verdicts. Every consumer below re-reads per use; the own row's value comes
     from apply()'s `config` parameter (this row's live Config refs —
     volatile, so a settings edit is visible on the next read without any
     listener). */
  const readConfiguredBashPath = () => effectiveConfiguredBashPath(executorConfiguredBashPath(ctx), rowBashPath(config))
  const readBashResolution = () => resolveGitBashCached({ configured: readConfiguredBashPath() })
  const gitBashCapability = {
    // v0.35.0 semantics, unchanged shape: `active` answers "does command
    // execution run on Git Bash on this host" — TRUE regardless of the
    // variantPresets switch, because the inline tool patch carries the
    // official presets too. Peers (dsh-ptc-cordis-preset) key their roster
    // wording and dedupe on exactly this fact.
    active: process.platform === 'win32',
    // Additive (v0.35.1): the inline tool patch gives EVERY OFFICIAL preset
    // Git Bash, so a roster suffix like "· Git Bash" no longer distinguishes
    // anything — peers reading this flag drop the suffix (dsh-ptc-cordis-preset
    // v0.17.3+); older peers ignore it and keep the v0.34 wording.
    get inlinePatched() { return process.platform === 'win32' },
    // Additive (v0.40.3): whether the official pwsh row is VISIBLE for agents
    // on this host — the exact `pwshTool() === true` verdict the masking layer
    // reads (src/inline-tools.js hidePwsh), so peers composing the same row
    // key off one signal instead of re-deriving the switch. Default OFF
    // (bash-first); the switch is live, so a flip lands on the next read.
    // Older peers ignore the field and keep the v0.20.0 ops-only behavior.
    get pwshToolEnabled() { return liveSettings.pwshTool() === true },
    // Kept for existing consumers (peer plugins read `bashPath`): the resolved
    // interpreter. When resolution failed we report the explicit value (or the
    // historical default) so the ENOENT a consumer may hit names a real path —
    // never a substitute shell. Getters keep the capability live (issue #13):
    // a consumer reading it after the rows settle sees the settled verdict.
    get bashPath() {
      const resolution = readBashResolution()
      return resolution.ok ? resolution.path : (readConfiguredBashPath() || DEFAULT_GIT_BASH)
    },
    // Additive (v0.28.0): the full verdict, for the guided popup and peers.
    get ok() { return readBashResolution().ok },
    get source() { return readBashResolution().source },
    get configured() { return readBashResolution().configured },
    get tried() { return readBashResolution().tried },
    downloadUrl: GIT_BASH_DOWNLOAD_URL,
  }
  const disposeGitBash = ctx.provide('gitBash', gitBashCapability)
  ctx.effect(() => disposeGitBash, 'dsh-gitbash-shell: gitBash capability')

  // ── official shell-env fact: DSH_PATH_DIALECT (Windows only, gated; v0.11.0) ──
  // dsh-shell-env owns the model-visible $DSH_* facts (host-plane service;
  // the web composition injects it and publishes DSH_WEB_URL beside the
  // built-ins), and the bash tool's schema points the model straight at them
  // ("inspect them when needed"). While posixPaths is on, every shell call
  // therefore also carries a runtime-verifiable dialect declaration: the
  // prompt rewrite states the dialect once at the source, the environment
  // answers on demand. The resolver reads the live switch per execution, so
  // toggling the setting empties the variable without re-registration; the
  // disposer rides the plugin fiber. ctx.inject keeps the wiring independent
  // of row activation order and a silent no-op where the registry is absent.
  if (process.platform === 'win32') {
    try {
      ctx.inject(['shellEnv'], (envCtx) => {
        try {
          const shellEnv = envCtx && envCtx.shellEnv
          if (!shellEnv || typeof shellEnv.register !== 'function') return
          const unregister = shellEnv.register({
            name: 'gitbash-shell',
            // The registry accepts DSH_* FACTS ONLY (a non-DSH key makes the
            // whole contribution throw — learned in v0.21.0, see CHANGELOG):
            // git line endings and anything else non-DSH_* ride the executor's
            // own env layer (src/shell.js), not this registry.
            variables: { [PATH_DIALECT_KEY]: { description: PATH_DIALECT_DESCRIPTION } },
            resolve(execution) {
              try {
                const dialect = liveSettings.dialect()
                if (dialect.posixPaths !== true) return {}
                // The environment fact is per execution, so a delegated agent
                // the user excluded sees no DSH_PATH_DIALECT at all.
                if (!dialectApplies(dialect, execution && execution.agent)) return {}
                return { [PATH_DIALECT_KEY]: PATH_DIALECT_VALUE }
              } catch {
                return {}
              }
            },
          })
          envCtx.effect(() => unregister, 'dsh-gitbash-shell: shellEnv path-dialect fact')
          debugLog(`${TAG} shellEnv fact registered: ${PATH_DIALECT_KEY} (gated by the posixPaths setting)`)
        } catch (error) {
          problemLog(`${TAG} shellEnv fact registration failed: ${error?.message ?? error}`)
        }
      })
    } catch (error) {
      problemLog(`${TAG} shellEnv wiring failed: ${error?.message ?? error}`)
    }
  }

  // ── prompt-assembly path dialect (Windows only, gated; v0.10.0) ────────
  // While posixPaths is on, EVERY Windows absolute path the model would
  // see — section text, context text, and prompt variables — is rewritten
  // IN PLACE to the MSYS drive-root form. Nothing is added or removed: the
  // official prompt keeps its exact shape and only the path examples
  // change dialect, so the model meets a /c/ world at the source instead
  // of being asked to translate Windows forms it sees. Our own directive
  // context is skipped (self-reference), and tool schemas stay untouched
  // (they carry no drive-letter examples today, and blind string rewriting
  // could corrupt pattern/default fields).
  if (process.platform === 'win32') {
    try {
      ctx.on('system-prompt/assemble', (assembly, assembleContext, next) => {
        try {
          /* v0.27.0: the main agent always participates; a DELEGATED agent
             (subagent / team member / nested child) only while the
             `subagentDialect` switch is on. Turning it off leaves the official
             prompt text untouched for those agents — no source replacement and
             no run_code hint — so they meet the shell they were composed for. */
          const dialect = liveSettings.dialect()
          const applies = dialectApplies(dialect, assembleContext && assembleContext.agent)
          // This event carries prompt PRESENTATION only; tool declarations are
          // provider-owned. Read the step's admitted set back from the tools
          // service with the same toolSet the agent loop resolved, so
          // conditional tools are judged exactly as execution will judge them.
          const offeredTools = (() => {
            try {
              const registry = ctx.get('tools')
              // The provider's tool model is projected through the private
              // selectExecutor; without it (or if it throws) there is no public
              // way to tell whether this step offers run_code, so stay silent.
              if (typeof registry?.selectExecutor !== 'function') return []
              const scope = assembleContext?.scope ?? assembleContext?.agent
              return registry.selectExecutor(scope).describe(registry.definitions(scope, assembleContext?.toolSet)).schemas ?? []
            } catch {
              return []
            }
          })()
          // Routing is emitted by the owned Bash definition and prompt section;
          // this hook transforms only prompt text and the language-specific hint.
          if (applies && dialect.posixPaths === true && assembly && typeof assembly === 'object') {
            for (const section of Array.isArray(assembly.sections) ? assembly.sections : []) {
              if (section && typeof section.text === 'string') section.text = windowsToMsys(section.text)
            }
            for (const assembled of Array.isArray(assembly.contexts) ? assembly.contexts : []) {
              if (!assembled || assembled.name === 'gitbash-shell:posix-paths') continue
              if (typeof assembled.text === 'string') assembled.text = windowsToMsys(assembled.text)
            }
            const variables = assembly.variables
            if (variables && typeof variables === 'object') {
              for (const key of Object.keys(variables)) {
                if (typeof variables[key] === 'string') variables[key] = windowsToMsys(variables[key])
              }
            }
            // v0.20.1: the run_code sentence rides the SAME context entry, but
            // only when this assembly actually offers the tool (see
            // runCodeHintFor) — every other mode stays quiet.
            const hint = runCodeHintFor(offeredTools, dialect.codePaths === true, programLanguageFor(ctx, assembleContext?.agent))
            if (hint !== '') {
              for (const assembled of Array.isArray(assembly.contexts) ? assembly.contexts : []) {
                if (assembled && assembled.name === 'gitbash-shell:posix-paths' && typeof assembled.text === 'string') {
                  assembled.text += hint
                }
              }
            }
          }
        } catch { /* never block assembly */ }
        return next()
      })
      debugLog(TAG + ' prompt-assembly path dialect active (gated by the posixPaths setting)')
    } catch (error) {
      problemLog(TAG + ' system-prompt/assemble wiring failed: ' + (error?.message ?? error))
    }
  }

  // ── MSYS path translation on every tool dispatch (Windows only) ─────────
  // Covers every preset and mode: the wrapper sits on the global
  // tools/execute waterfall, through which model-direct calls, PTC run_code
  // sub-dispatches, and dynamic-tool calls all pass. It carries BOTH dialect
  // faces of one call — the path-bearing ARGUMENTS on the way in, and the
  // path-bearing RESULT metadata on the way out.
  //
  // The result face rides HERE, not tools/post-execute (v0.23.0, issue #2).
  // The registry rejects a post-execute decision that replaces `value` while
  // any listener on that waterfall replaced `content` —
  // "tools/post-execute accept decision cannot replace both value and content",
  // raised after the waterfall settles and outside every listener try/catch,
  // so the call ended as an isError and the model lost the result. An
  // around-dispatch wrapper may author the result instead: the registry re-runs
  // the owning output contract on what we return (normalizeDispatchResult ->
  // createSuccessResult -> render), so the content the model reads is rendered
  // FROM the dialect value handed back, and this plugin never projects a
  // `value` on a decision at all — the collision cannot happen. An unchanged
  // value returns the ORIGINAL result object, so the registry re-renders
  // nothing. Only a SUCCESSFUL result is touched; failures keep their value
  // (and their dialect rides the post-execute listener below).
  if (process.platform === 'win32') {
    try {
      ctx.on('tools/execute', (exec, next) => {
        let echo = false
        let echoEnv = null
        try {
          // Read the LIVE row Config (v0.25.1, issue #8). A snapshot taken at
          // apply() time can still carry defaults before volatile updates land,
          // so this wrapper translated NOTHING while the directive and the
          // shell env kept working: `/c/...` reached the file tools untranslated,
          // `~` was never expanded, `glob.path` and `bash.workdir` went through
          // raw, and an in-workspace `/c/...` write fell outside the sandbox.
          // One stale read site, five symptoms.
          const dialect = liveSettings.dialect()
          // v0.27.0: a delegated agent the user excluded keeps the official
          // semantics for BOTH faces of its calls — arguments go through
          // untouched and the result metadata is not echoed back in MSYS form.
          if (dialect.posixPaths && dialectApplies(dialect, exec && exec.agent)) {
            echo = true
            const env = dialect.virtualMounts ? buildTranslateEnv(readConfiguredBashPath()) : null
            echoEnv = env
            if (exec && exec.arguments && typeof exec.arguments === 'object') {
              const translated = translateDispatch(exec, dialect, env, programLanguageFor(ctx, exec?.agent))
              if (translated !== exec.arguments) exec.arguments = translated
            }
          }
        } catch { /* never block a call on translation */ }
        if (!echo) return next()
        return next().then((result) => {
          try {
            if (!result || typeof result !== 'object' || result.isError !== false) return result
            if (!result.value || typeof result.value !== 'object') return result
            const value = rewriteResultPaths(exec && exec.name, result.value, echoEnv)
            return value === result.value ? result : { ...result, value }
          } catch { return result }
        })
      })
      debugLog(TAG + ' MSYS path translation active on tool dispatch (arguments and result metadata)')
    } catch (error) {
      problemLog(TAG + ' tools/execute wiring failed: ' + (error?.message ?? error))
    }
  }

  // ── failure dialect on tools/post-execute (Windows only, gated; v0.17.1) ─
  // A FAILURE has two faces: `content` (the text the model reads on the failed
  // call, and what the UI card shows) and `error.message` (what the PTC bridge
  // hands a running program as its caught ToolCallError, while the durable
  // record keeps the structured identity). Rewriting only the content left a
  // program that printed a caught error holding the Windows form while every
  // other face said MSYS (v0.22.0).
  //
  // This listener projects CONTENT ONLY, and that is deliberate (v0.23.0,
  // issue #2): a decision carrying both `content` and `value` makes the
  // registry throw, and a replacement value is illegal on a failed result
  // anyway. The SUCCESS face therefore lives on the tools/execute wrapper
  // above, and this listener can never collide with any other plugin.
  //
  // error.message is rewritten IN PLACE on the result the waterfall was handed:
  // the registry keeps `result.error` by reference until the final
  // materialization, so this write reaches the PTC bridge and the record.
  // A post-execute `block` decision would rebuild the error as a bare message
  // and drop its structured identity — never do that.
  if (process.platform === 'win32') {
    try {
      ctx.on('tools/post-execute', (exec, result, next) => {
        let contentPatch
        try {
          const dialect = liveSettings.dialect()
          // Same agent gate as the dispatch wrapper: one call, one dialect.
          // RETURN the downstream promise: a waterfall listener that swallows
          // it would hand the caller `undefined` instead of the decision.
          if (!dialectApplies(dialect, exec && exec.agent)) return next()
          if (dialect.posixPaths && dialect.errorDialect && exec && result && typeof result === 'object'
            && result.isError === true && Array.isArray(result.content)) {
            const env = dialect.virtualMounts ? buildTranslateEnv(readConfiguredBashPath()) : null
            if (exec.name === 'run_code') {
              // paths only — the /dev/null hint is for file tools
              const content = rewriteErrorContent(result.content, { nulHint: false, env })
              if (content !== result.content) contentPatch = content
              rewriteFailureMessage(result, env)
            } else if (ERROR_CONTENT_TOOLS.has(exec.name)) {
              const content = rewriteErrorContent(result.content, { env })
              if (content !== result.content) contentPatch = content
              rewriteFailureMessage(result, env)
            }
          }
        } catch { /* never block a result */ }
        const chain = next()
        if (contentPatch === undefined) return chain
        return chain.then((decision) => {
          try {
            if (decision && decision.kind === 'accept') return { ...decision, content: contentPatch }
          } catch { /* keep the downstream decision */ }
          return decision
        })
      })
      debugLog(TAG + ' failure dialect active on tools/post-execute (content + error.message)')
    } catch (error) {
      problemLog(TAG + ' tools/post-execute wiring failed: ' + (error?.message ?? error))
    }
  }

  // ── Unified POSIX path directive (Windows Git Bash, EVERY session) ─────
  // ONE path style for every tool: MSYS drive roots (/c/Users/...). Bash
  // digests them natively; the file tools receive the drive-letter form
  // through the translation wrapper above, so the model never has to switch
  // dialects. The directive also pins the rewrite rules that neutralize the
  // Windows-form facts the harness injects elsewhere (backslash cwd strings,
  // tool results printing drive-letter paths). Same channel as dsh-agent-lang;
  // order 126 sits after the official CONTEXT_ORDERS 110/115/120 and beside
  // the 125 free slot. Non-Windows mounts inject nothing.
  if (process.platform === 'win32') {
    try {
      ctx.inject(['systemPrompt'], (pctx) => {
        try {
          pctx.effect(() => pctx.systemPrompt.context({
            name: 'gitbash-shell:posix-paths',
            order: 126,
            text: (assembleContext) => {
              try {
                const dialect = liveSettings.dialect()
                if (dialect.posixPaths !== true) return ''
                // A delegated agent whose dialect the user turned off meets the
                // official shell semantics: no directive, the same way no
                // translation happens for its calls.
                if (!dialectApplies(dialect, assembleContext && assembleContext.agent)) return ''
                return dialect.virtualMounts === false ? POSIX_DIRECTIVE_TEXT_STRICT : POSIX_DIRECTIVE_TEXT
              } catch {
                return ''
              }
            },
          }), 'dsh-gitbash-shell: posix-path context')
          debugLog(TAG + ' unified POSIX-path directive context active (win32, gated by the posixPaths setting)')
        } catch (error) {
          problemLog(TAG + ' context registration failed: ' + (error?.message ?? error))
        }
      })
    } catch (error) {
      problemLog(TAG + ' systemPrompt inject wiring failed: ' + (error?.message ?? error))
    }
  }

  // ── fail-loud bash report + the client-visible status route (v0.28.0) ──
  // issue #11: the old failure mode was "every command dies with
  // `spawn C:/Program Files/Git/bin/bash.exe ENOENT` and nothing explains it".
  // Now the boot log names the value, the whole probe chain and where to fix
  // it, and the client half reads the same verdict over HTTP to raise the
  // guided popup. Nothing here substitutes another shell — by design.
  //
  // issue #13: the boot verdict may legitimately be wrong for a few seconds —
  // at apply() time the loader store may not hold the executor row yet, so
  // the explicit tier reads '' while the executor's own per-call lazy
  // resolution succeeds. A FAILURE with an EMPTY configured value is therefore
  // not final: poll briefly for the explicit tier to appear as the rows
  // settle, print the settled verdict when it changes, and notify the
  // adoptions below (official terminal / better-sidebar) through
  // `onBashSettled`. A failure with a NON-empty configured value IS final (the
  // user's explicit answer was rejected), and so is any success.
  let settledBashResolution = null
  const bashSettleWaiters = []
  const onBashSettled = (listener) => {
    if (settledBashResolution !== null) listener(settledBashResolution)
    else bashSettleWaiters.push(listener)
  }
  const settleBashResolution = (resolution) => {
    settledBashResolution = resolution
    for (const listener of bashSettleWaiters.splice(0)) {
      try { listener(resolution) } catch { /* a waiter never blocks settling */ }
    }
  }
  const printBashResolution = (phase, resolution) => {
    debugLog(TAG + ' bash resolution' + (phase === '' ? '' : ' (' + phase + ')') + ': '
      + bashResolutionReport(resolution).split('\n').join('\n' + TAG + ' '))
  }
  const bootBashResolution = readBashResolution()
  printBashResolution('boot', bootBashResolution)
  // Non-win32 hosts settle immediately: resolution failure there is the
  // designed state (nothing consumes the capability), so no poll.
  if (bootBashResolution.ok || bootBashResolution.configured !== '' || process.platform !== 'win32') {
    settleBashResolution(bootBashResolution)
  } else {
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
      if (readConfiguredBashPath() === '' && ticks < 20) return // rows still mounting
      clearInterval(timer)
      const settled = readBashResolution()
      if (settled.ok || settled.configured !== '') printBashResolution('settled', settled)
      settleBashResolution(settled)
    }, 250)
    ctx.effect(() => () => clearInterval(timer), 'dsh-gitbash-shell: bash resolution settle poll')
  }
  if (process.platform === 'win32') {
    try {
      ctx.inject(['webServer'], (wctx) => {
        try {
          const route = '/dsh-gitbash-shell/api/status'
          const read = () => {
            // LIVE re-read (issue #13): the popup must see what the executor
            // actually resolves NOW, not a value frozen at apply() time.
            const resolution = resolveGitBashCached({ configured: readConfiguredBashPath(), fresh: true })
            return {
              ok: resolution.ok,
              platform: process.platform,
              resolved: resolution.path,
              root: resolution.root,
              source: resolution.source,
              configured: resolution.configured,
              tried: resolution.tried,
              downloadUrl: GIT_BASH_DOWNLOAD_URL,
              settingsHint: 'Settings -> Plugins -> dsh-gitbash-shell -> "Git Bash path"',
            }
          }
          const handler = (req, res) => {
            const text = JSON.stringify(read())
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
            res.end(text)
          }
          const dispose = wctx.webServer.register({ kind: 'prefix', path: route, handler })
          wctx.effect(() => dispose, 'dsh-gitbash-shell: bash status route')
          debugLog(TAG + ' bash status route active at ' + route + ' (read by the guided popup)')
        } catch (error) {
          problemLog(TAG + ' bash status route failed: ' + (error?.message ?? error))
        }
      })
    } catch (error) {
      problemLog(TAG + ' bash status route wiring failed: ' + (error?.message ?? error))
    }
  }

  // ── MSYS path facts for the browser half (v0.31.0) ───────────────────────
  // The native right Sidebar receives the path spelling the CONVERSATION
  // shows. While this plugin's POSIX dialect is on, that spelling is an MSYS
  // drive root (/c/Users/...), and the Host filesystem resolves it against the
  // current drive instead — '<drive>:\c\Users\...' — so every file link in the
  // transcript opens onto "file not found". The browser half rewrites the
  // resource address before opening it; this route is the fact bag that
  // rewrite needs. It reports the SAME env the tool-argument translation
  // already resolves against, plus the platform, so a non-Windows client never
  // rewrites anything. Read-only and loopback-fenced (a GET needs no Origin),
  // because the web server may be bound to 0.0.0.0.
  try {
    ctx.inject(['webServer'], (wctx) => {
      try {
        const route = '/dsh-gitbash-shell/api/pathmap'
        const mounts = {}
        for (const [mount, target] of GIT_MOUNTS) mounts[mount] = target
        const send = (res, code, payload) => {
          const text = JSON.stringify(payload)
          res.writeHead(code, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(text),
          })
          res.end(text)
        }
        const handler = (req, res) => {
          const fence = fenceToolRequest(req)
          if (!fence.ok) {
            problemLog(TAG + ' path map request refused (' + fence.reason + ')')
            send(res, 403, { error: 'forbidden', reason: fence.reason })
            return
          }
          const env = buildTranslateEnv(readConfiguredBashPath())
          // One line per read: the browser half fetches this once per page load,
          // so its presence in the log is how a user can tell the rescue is live.
          debugLog(TAG + ' path map read by ' + (req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '?'))
          send(res, 200, {
            platform: process.platform,
            home: env.home ?? null,
            tmpDir: env.tmpDir ?? null,
            gitRoot: env.gitRoot ?? null,
            mounts,
          })
        }
        const dispose = wctx.webServer.register({ kind: 'prefix', path: route, handler })
        wctx.effect(() => dispose, 'dsh-gitbash-shell: path map route')
        debugLog(TAG + ' MSYS path map route active at ' + route + ' (read by the browser half)')
      } catch (error) {
        problemLog(TAG + ' path map route failed: ' + (error?.message ?? error))
      }
    })
  } catch (error) {
    problemLog(TAG + ' path map route wiring failed: ' + (error?.message ?? error))
  }

  // ── winget toolchain route (v0.30.0) ─────────────────────────────────────
  // The settings card's "install / upgrade" buttons. Installing software is a
  // real side effect, so src/tool-runner.js fences the route: only a loopback
  // caller with a same-origin Origin/Referer gets through, and the ids in the
  // body are mapped onto the CLOSED catalog before any argv is built. The
  // request can therefore never name a package winget would install.
  //
  // GET  (no query)   → full status: every catalog row + the live job snapshot
  // GET  ?job=1       → the job snapshot ONLY (the cheap poll while installing)
  // POST ?action=run  → start a job; 409 while one is already running
  // POST ?action=clear→ forget a finished job
  if (process.platform === 'win32') {
    try {
      ctx.inject(['webServer'], (wctx) => {
        try {
          const route = '/dsh-gitbash-shell/api/tools'
          const io = defaultRunnerIo()
          const send = (res, code, payload) => {
            const text = JSON.stringify(payload)
            res.writeHead(code, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'content-length': Buffer.byteLength(text),
            })
            res.end(text)
          }
          const snapshot = () => {
            const job = currentToolJob()
            if (!job) return null
            return {
              id: job.id, action: job.action, total: job.total, done: job.done,
              current: job.current, finished: job.finished, results: job.results.slice(),
              // v0.43.0 (issue #35): elapsed time, the freshest winget line,
              // and the cancelled state, so the card can show them.
              startedAt: job.startedAt, currentSince: job.currentSince,
              lastOutput: job.lastOutput, cancelled: job.cancelled === true,
            }
          }
          const handler = async (req, res) => {
            const fence = fenceToolRequest(req)
            if (!fence.ok) {
              problemLog(TAG + ' toolchain request refused (' + fence.reason + ')')
              send(res, 403, { error: 'forbidden', reason: fence.reason })
              return
            }
            let query = new URLSearchParams()
            try { query = new URL(req.url || '/', 'http://localhost').searchParams } catch { /* keep empty */ }
            const method = String(req.method || 'GET').toUpperCase()
            try {
              if (method === 'POST') {
                const action = query.get('action') || ''
                if (action === 'cancel') {
                  // v0.43.0 (issue #35): kill the in-flight tree, mark the rest
                  // skipped. The cancelled job stays current until finished so
                  // the card can show what happened; `clear` then forgets it.
                  cancelToolJob('')
                  send(res, 200, { ok: true, job: snapshot() })
                  return
                }
                if (action === 'clear') {
                  clearToolJob('')
                  send(res, 200, { ok: true, job: null })
                  return
                }
                if (action !== 'run') { send(res, 400, { error: 'bad-action', action }); return }
                const body = await readJsonBody(req)
                if (!body) { send(res, 400, { error: 'bad-request' }); return }
                const started = startToolJob(io, body)
                if (!started.started) {
                  send(res, 409, { error: 'busy', job: snapshot() })
                  return
                }
                send(res, 202, { ok: true, job: snapshot() })
                return
              }
              // The cheap poll: while a job runs the card only needs its progress,
              // not another three winget invocations.
              if (query.get('job') === '1') { send(res, 200, { job: snapshot() }); return }
              const status = await probeToolchain(io)
              send(res, 200, { ...status, job: snapshot() })
            } catch (error) {
              send(res, 500, { error: 'internal', detail: String((error && error.message) || error) })
            }
          }
          const dispose = wctx.webServer.register({ kind: 'prefix', path: route, handler })
          wctx.effect(() => dispose, 'dsh-gitbash-shell: toolchain route')
          debugLog(TAG + ' winget toolchain route active at ' + route + ' (loopback + same-origin fenced)')
        } catch (error) {
          problemLog(TAG + ' toolchain route failed: ' + (error?.message ?? error))
        }
      })
    } catch (error) {
      problemLog(TAG + ' toolchain route wiring failed: ' + (error?.message ?? error))
    }
  }

  // ── OFFICIAL sidebar terminal adoption (v0.29.0, task-25) ──────────────
  // User report: dsh's own "new terminal" started WSL, because
  // `terminal-controller` falls back to the execution environment's default
  // shell and on that machine PATH's `bash` is the System32 WSL launcher.
  // The settings service CANNOT be used here (measured: `shell` is not a
  // volatile field, and there is no `terminal` configurable entry), so this
  // goes through `configEditor.edit()` — the API the official settings UI
  // persists through — and it only ever writes when the terminal has no shell
  // of its own. See src/terminal-shell.js for the full rationale.
  if (process.platform === 'win32') {
    try {
      ctx.inject(['configEditor'], (editorCtx) => {
        // The terminal row may activate after this plugin; retry a few times
        // (bounded) instead of silently giving up, and never spam the log.
        let attempts = 0
        const run = async () => {
          attempts += 1
          let result
          try {
            // LAZY re-read per attempt (issue #13): the first try may run
            // before the loader store holds the executor row, when the
            // resolution legitimately still reads ''.
            const resolution = readBashResolution()
            result = await adoptTerminalShell(editorCtx.configEditor, {
              platform: process.platform,
              enabled: liveSettings.autoTerminalShell(),
              resolved: resolution.ok ? resolution.path : '',
            })
          } catch (error) {
            // adoptTerminalShell reports expected conditions itself; reaching
            // here means something unexpected — say so instead of swallowing it.
            problemLog(`${TAG} official sidebar terminal adoption crashed: ${error?.message ?? error}`)
            return
          }
          if (result.status === 'skip-row-absent' && attempts < 6) {
            setTimeout(() => { run().catch((error) => problemLog(`${TAG} official sidebar terminal adoption retry failed: ${error?.message ?? error}`)) }, 3000)
            return
          }
          debugLog(`${TAG} ${terminalAdoptReport(result)}`)
        }
        run().catch((error) => problemLog(`${TAG} official sidebar terminal adoption failed: ${error?.message ?? error}`))
      })
    } catch (error) {
      problemLog(`${TAG} official sidebar terminal adoption wiring failed: ${error?.message ?? error}`)
    }
  }

  // ── dsh-ops bash removal from the agent face (dsh-ops 0.5.0) ──────────
  // ops_bash registers in each agent's OWN layer; the host restrict() only
  // filters INHERITED surfaces (core/tools view()), so "visible but denied"
  // can never become hidden — dsh-ops must simply not register the tool.
  // 0.5.0 replaced the 0.4.x mode rows with ONE `dsh-ops` row whose four
  // built-in sections (minimal/standard/ptc/cordis) each accept `bash:false`.
  // We hold those four flags false ONLY while this plugin is mounted, through
  // the official configEditor channel; the dispose hook below lifts them when
  // our fiber stops (disable / uninstall => dsh-ops gets its bash back).
  // See src/ops-adopt.js for the full rationale and safety rails.
  if (process.platform === 'win32') {
    try {
      ctx.inject(['configEditor'], (opsEditorCtx) => {
        let attempts = 0
        let closed = false
        let retry
        let pending = Promise.resolve()
        // Own retries and the in-flight edit before starting either. Disposal
        // waits for adoption, then restores only journalled fields.
        opsEditorCtx.effect(() => async () => {
          closed = true
          clearTimeout(retry)
          await pending
          try { debugLog(`${TAG} ${opsRestoreReport(await restoreOpsBash(opsEditorCtx.configEditor))}`) }
          catch (error) { problemLog(`${TAG} dsh-ops bash restore crashed: ${error?.message ?? error}`) }
        }, 'gitbash: dsh-ops bash removal restore')
        const run = () => {
          if (closed) return
          pending = (async () => {
            attempts++
            const result = await adoptOpsBashRemoval(opsEditorCtx.configEditor)
            if (!closed && result.status === 'skip-row-absent' && attempts < 6) {
              retry = setTimeout(run, 3000)
              retry.unref?.()
            }
            debugLog(`${TAG} ${opsAdoptReport(result)}`)
          })().catch(error => problemLog(`${TAG} dsh-ops bash removal failed: ${error?.message ?? error}`))
        }
        run()
      })
    } catch (error) {
      problemLog(`${TAG} dsh-ops bash removal wiring failed: ${error?.message ?? error}`)
    }
  }

  // ── OFFICIAL persistent-terminal bundle adoption (v0.41.0) ─────────────
  // The experimental terminal bundle mounts its shell backends behind a
  // bundle patch that on Windows enables the pwsh backend and disables the
  // bash one — exactly backwards for a Git Bash house. The fix is a
  // PROFILE-PATCH row edit (the host patch algorithm addresses group
  // children by id, and bundle patches are read before the profile patch
  // file) because configEditor can neither see bundle children nor write a
  // row-level `disabled`. See src/terminal-bundle.js for the full
  // rationale and safety rails. The terminal_* dialect sentence rides the
  // existing routing block once terminalDialect.gitBash turns true.
  if (process.platform === 'win32') {
    try {
      ctx.inject(['profileContext'], (patchCtx) => {
        const run = async () => {
          const patchPath = patchCtx.get('profileContext')?.patchPath
          if (typeof patchPath !== 'string' || patchPath.trim() === '') {
            problemLog(`${TAG} persistent terminal: no profile patch path — nothing to adopt`)
            return
          }
          let mounted = false
          try {
            mounted = await detectTerminalBundle(ctx)
          } catch (error) {
            problemLog(`${TAG} persistent terminal: bundle detection failed: ${error?.message ?? error}`)
            return
          }
          const resolution = readBashResolution()
          const atomic = await resolveHostModule(ctx, '@deepseek-ai/dsh-atomic-write')
          if (typeof atomic?.withFileLock !== 'function' || typeof atomic?.writeFileAtomic !== 'function') {
            throw new Error('current host atomic profile-edit capability unavailable')
          }
          const update = () => adoptTerminalBundlePatch(
            {
              readFile: (file) => readFileSync(file, 'utf8'),
              writeFileAtomic: (file, data) => atomic.writeFileAtomic(file, data, { mode: 0o600 }),
              yaml: () => resolveHostModule(ctx, 'yaml'),
            },
            {
              platform: process.platform,
              enabled: liveSettings.autoTerminalShell(),
              mounted,
              resolved: resolution.ok ? resolution.path : '',
              patchPath,
            },
          )
          const result = await atomic.withFileLock(join(dirname(patchPath), 'package.json'), update)
          if (result.status === 'adopted' || result.status === 'updated' || result.status === 'unchanged') {
            terminalDialect.gitBash = true
          }
          debugLog(`${TAG} ${terminalBundleReport(result)}`)
        }
        run().catch((error) => problemLog(`${TAG} persistent terminal adoption failed: ${error?.message ?? error}`))
      })
    } catch (error) {
      problemLog(`${TAG} persistent terminal adoption wiring failed: ${error?.message ?? error}`)
    }
  }

  // ── GLOBAL PTC SDK (row switch, default OFF) ───────────────────────────
  // `globalPtcSdk` asks for the root executor to be PTC for every agent that
  // does not explicitly mount a scoped native executor. Like the persistent
  // terminal adoption above, that is a PROFILE-PATCH decision (bundle patches
  // are read before the profile patch file) and a row-level `disabled` that
  // configEditor cannot write — so it rides the same guarded writer, with the
  // same atomic write, verify-by-reread and rollback. See src/global-ptc.js
  // for the full rationale and the stand-down matrix.
  //
  // OFF is not a no-op: it LIFTS only rows named by the ownership receipt AND
  // still carrying the recorded data+comment fingerprint. Disable/uninstall
  // runs the same lift after the in-flight adoption settles, so an enabled
  // switch cannot strand a PTC root after its settings UI has disappeared.
  try {
    ctx.inject(['profileContext'], (ptcPatchCtx) => {
      const enabled = valueOf(config.globalPtcSdk) === true
      let patchPath
      let atomic
      const write = (lift) => {
        const update = () => adoptGlobalPtcPatch(
          {
            readFile: (file) => readFileSync(file, 'utf8'),
            writeFileAtomic: (file, data) => atomic.writeFileAtomic(file, data, { mode: 0o600 }),
            yaml: () => resolveHostModule(ctx, 'yaml'),
          },
          { patchPath, enabled: !lift, lift },
        )
        // Same lock target as the terminal adoption: one serialisation point
        // for every profile-patch writer in this plugin, including disposal.
        return atomic.withFileLock(join(dirname(patchPath), 'package.json'), update)
      }
      const run = async () => {
        patchPath = ptcPatchCtx.get('profileContext')?.patchPath
        if (typeof patchPath !== 'string' || patchPath.trim() === '') {
          problemLog(`${TAG} global PTC SDK: no profile patch path — nothing to write`)
          return
        }
        atomic = await resolveHostModule(ctx, '@deepseek-ai/dsh-atomic-write')
        if (typeof atomic?.withFileLock !== 'function' || typeof atomic?.writeFileAtomic !== 'function') {
          throw new Error('current host atomic profile-edit capability unavailable')
        }
        const result = await write(!enabled)
        debugLog(`${TAG} ${globalPtcReport(result)}`)
      }
      const pending = run().catch((error) => problemLog(`${TAG} global PTC SDK wiring failed: ${error?.message ?? error}`))
      ptcPatchCtx.effect(() => async () => {
        await pending
        if (!enabled || !patchPath || !atomic) return
        try {
          const result = await write(true)
          debugLog(`${TAG} disable/uninstall: ${globalPtcReport(result)}`)
        } catch (error) {
          // Disposal must not fail the host shutdown. The log names the manual
          // follow-up because the patch is persistent by design.
          problemLog(`${TAG} global PTC SDK disable/uninstall lift failed: ${error?.message ?? error}; review the two executor rows in ${patchPath}`)
        }
      }, 'dsh-gitbash-shell: global PTC SDK restore')
    })
  } catch (error) {
    problemLog(`${TAG} global PTC SDK wiring failed: ${error?.message ?? error}`)
  }

  // ── dsh-better-sidebar terminal adoption (Windows only) ────────────────
  // The sidebar resolves its terminal shell through the settings seam per
  // open; adopt it through that seam (see adoptSidebarShell for rationale).
  // Rides the settle notification (issue #13): a boot-time failure with an
  // empty explicit tier may still settle into a success once the loader rows
  // mount, and the adoption then happens without a restart.
  if (process.platform === 'win32') {
    let sidebarAdopted = false
    onBashSettled((resolution) => {
      if (resolution.ok) {
        if (sidebarAdopted) return
        sidebarAdopted = true
        adoptSidebarShell(ctx, resolution.path, () => liveSettings.adoptSidebar())
        return
      }
      problemLog(TAG + ' sidebar terminal adoption skipped: no Git Bash resolved (nothing is substituted)')
    })
  }

  // ── inline tool patch (v0.35.0; route B since v0.39.0) ──────────────────
  // The official preset rows compose `tool-bash` as win32-disabled, and the
  // patch layer cannot reach rows nested in a preset declaration (buildMap
  // only descends into group rows), so the fix runs at the tool layer: per
  // agent, a face of "pwsh yes / bash no" gets the plugin's OWN bash tool
  // (src/bash-tool.js — a private Git Bash executor in a private scope, the
  // official tool surface mirrored call-for-call) plus a HIDE on the real pwsh
  // tool while the pwsh switch is off (route B: the official executor stays in
  // place, so pwsh is real PowerShell and hiding it is a product choice). The
  // Full Windows variants keep the same pwsh-only face as official presets,
  // so they receive this same private-executor patch. Minimal stays persistent.
  if (process.platform === 'win32') {
    // Eager native slot (issue #38): resolve the host builder and the native
    // capability BEFORE any agent can exist, so agent/created can register a
    // stable gitbash_native definition synchronously. This is deliberately a
    // mount-time preflight: if the public native packages are unavailable we
    // advertise no slot at all instead of leaving a ghost tool behind.
    await prepareToolOwnership(ctx)
    let nativeContract
    try {
      const [toolsModule, localBashModule, outputModule, nativeModule] = await Promise.all([
        resolveHostModule(ctx, '@deepseek-ai/dsh-tools'),
        resolveHostModule(ctx, '@deepseek-ai/dsh-bash-local'),
        resolveHostModule(ctx, '@deepseek-ai/dsh-subprocess-local/output'),
        import('./native-tool.js'),
      ])
      if (typeof toolsModule?.defineTool === 'function'
        && typeof localBashModule?.LocalBashExecutor === 'function'
        && typeof outputModule?.OutputCollector === 'function'
        && typeof nativeModule?.nativeToolDefinition === 'function') {
        nativeContract = ({ background, execute }) => nativeModule.nativeToolDefinition({ toolsModule, background, execute })
      }
    } catch (error) {
      problemLog(TAG + ' eager native slot unavailable; gitbash_native stays on the late registration path: ' + (error?.message ?? error))
    }
    try {
      mountInlineTools(ctx, {
        tools: (c) => { try { return c.get('tools') } catch { return undefined } },
        agents: (c) => { try { return c.get('agents') } catch { return undefined } },
        createScope: (agentCtx) => {
          let childCtx
          const fiber = agentCtx.plugin((c) => { childCtx = c })
          return {
            // cordis plugin() starts the fiber ASYNCHRONOUSLY — the apply
            // callback that captures childCtx has NOT run when plugin()
            // returns. The wrapped fiber is a thenable (`fiber.await()`):
            // awaiting it is the only way to observe childCtx being set
            // (v0.38.3, real machine: apply(undefined) crashed with
            // "Cannot read properties of undefined (reading 'shell')").
            fiber,
            get ctx() { return childCtx },
            dispose: async () => { try { await fiber?.dispose?.() } catch { /* already gone */ } },
          }
        },
        pwshEnabled: () => liveSettings.pwshTool() === true,
        experimentalEnabled: () => liveSettings.experimentalNative(),
        pathToolEnabled: () => liveSettings.pathTool(),
        nativeContract,
        routingOptions: (agent) => ({
          msys: liveSettings.posix() && dialectApplies(liveSettings.dialect(), agent),
          terminalGitBash: terminalDialect.gitBash === true,
        }),
        // Explicit conversion does not rewrite source or change auto-dialect
        // settings. The same lazy, verified mount facts are used each call.
        translatePath: (value) => translateMsysPath(value, buildTranslateEnv(readConfiguredBashPath())),
        // Trusted host-owned output storage, invoked only after the native
        // executor's actual policy/argument/capability gate. Never model cwd.
        // Completed bounded artifacts remain readable like Core spill files;
        // this does not claim a cross-task quota or automatic retention purge.
        createArtifactDirectory: (_request, _exec, signal) => {
          signal?.throwIfAborted()
          return mkdtempSync(join(tmpdir(), 'dsh-gitbash-native-'))
        },
        log: (m) => debugLog(TAG + ' ' + m),
        warn: (m) => problemLog(TAG + ' ' + m),
      })
      debugLog(TAG + ' inline tool patch armed (own bash tool over a private Git Bash executor; official pwsh executor untouched)')
    } catch (error) {
      problemLog(TAG + ' inline tool patch wiring failed: ' + (error?.message ?? error))
    }
  }

  // ── default-preset migration (v0.35.0, user request) ─────────────────────
  // A session records its preset by ID (`agent-preset/selected`), and the
  // registry resolves EVERY mount through `definitions.get(id)` — a variant
  // id that is not registered fails `agent-preset/not-found`, and the
  // official `select` refuses mid-session switches (`agent-preset/locked`),
  // so PINNED SESSIONS cannot be migrated by any official API. The DEPLOYMENT
  // DEFAULT, however, is one writable setting: `selectedDefault` on the
  // `agent-preset-registry` row (volatile; the official preset picker writes
  // it through `settings.update('agent-preset-registry', ...)`). While
  // variantPresets is OFF (the user did NOT keep the old modes) and that
  // default still names one of OUR variants, migrate it to the official
  // successor once — idempotent (a migrated or user-chosen official default
  // never matches PRESET_IDS again), roster-checked (the official id renamed
  // once already: code→ptc — a missing target stands down instead of
  // guessing), written through the OFFICIAL settings seam, and verified by
  // read-back (a write that did not stick is reported, never claimed).
  // With variantPresets ON nothing here runs: the variants stay registered,
  // so a variant default keeps working as-is.
  try {
    ctx.inject(['settings'], () => {
      // Boot migration is detached: registry.list() may await the Loader boot.
      void migrateVariantDefault(ctx, () => liveSettings.variantPresets())
    })
  } catch (error) {
    problemLog(TAG + ' default-preset migration wiring failed: ' + (error?.message ?? error))
  }

  // ── FastCtx bridge (v0.35.0): the gb_* file tools, default ON ────────────
  // Additions, never replacements: the official read/grep/glob/edit tools and
  // their file sandbox stay first choice in every description. The bridge
  // mounts nothing outside win32, nothing when the payload is absent, and
  // stands down entirely the moment dsh-ops (ops_* tools) is detected.
  if (process.platform === 'win32') {
    try {
      const { createRequire } = await import('node:module')
      mountFastctx(ctx, {
        platform: process.platform,
        enabled: () => liveSettings.fastctxTools(),
        createRequireFrom: (base) => createRequire(base ?? import.meta.url),
        tools: (c) => { try { return c.get('tools') } catch { return undefined } },
        msysToWin: (p, execution) => {
          const dialect = liveSettings.dialect()
          if (dialect.posixPaths !== true || !dialectApplies(dialect, execution?.agent)) return p
          if (!dialect.virtualMounts) {
            return typeof p === 'string' && (MSYS_DRIVE_ROOT.test(p) || MSYS_BARE_DRIVE.test(p))
              ? translateMsysPath(p, null) : p
          }
          return translateMsysPath(p, buildTranslateEnv(readConfiguredBashPath()))
        },
        echo: (text, execution) => {
          const dialect = liveSettings.dialect()
          if (dialect.posixPaths !== true || !dialectApplies(dialect, execution?.agent)) return text
          const env = dialect.virtualMounts ? buildTranslateEnv(readConfiguredBashPath()) : null
          return env ? msysEcho(text, env) : windowsToMsys(text)
        },
        log: (m) => debugLog(TAG + ' ' + m),
        warn: (m) => problemLog(TAG + ' ' + m),
      })
    } catch (error) {
      problemLog(TAG + ' FastCtx bridge wiring failed: ' + (error?.message ?? error))
    }
  }

  // ── declarative preset registration ───────────────────────────────────────
  try {
    await runDeclarativeEra(ctx, presetIds, () => liveSettings.suppressPeerCordis(), readBashResolution, () => liveSettings.variantPresets())
  } catch (error) {
    problemLog(TAG + ' declarative registration failed: ' + (error && error.message ? error.message : error))
  }
}
// Test surface: pure helpers, no Cordis context required.
export const _internal = { PRESET_IDS, VARIANT_DEFAULT_SUCCESSORS, PEER_COVERED_PRESET_ID, PEER_CAPABILITY, isDelegatedAgent, dialectApplies, PEER_PYTHON_FIELD, PEER_PYTHON_BACKEND_FIELD, peerFact, peerBackend, pythonBackendActive, effectivePresetIds, translateDispatch, translateMsysPath, translatePathArguments, rewriteCodePaths, scanCodeLiterals, programPrelude, translateGlobArguments, buildTranslateEnv, rewriteErrorContent, rewriteErrorMessage, rewriteFailureMessage, msysEcho, driveToMsys, pathEcho, ERROR_CONTENT_TOOLS, windowsToMsys, rewriteResultPaths, adoptSidebarShell, MARKER_FILE, classify, hashTree, installRegisterShim, probeHostExtras }
