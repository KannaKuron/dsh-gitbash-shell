/**
 * dsh-gitbash-shell — host half (preset materialization).
 *
 * Installed as a profile bundle, this plugin swaps Windows' PowerShell shell
 * for Git for Windows bash (the executor lives in ./shell.js). On startup it
 * also materializes four Git Bash agent presets into the FIRST user-trust
 * preset root, mirroring how dsh-ptc-cordis-preset ships its 'ptc-cordis'
 * preset:
 *
 *   standard-gitbash — 标准模式 · Git Bash (tool-bash on, tool-pwsh off)
 *   minimal-gitbash  — 极简模式 · Git Bash (persistent Git Bash terminal)
 *   code-gitbash     — PTC 模式 · Git Bash (Code Mode presentation)
 *   cordis-gitbash   — 创造模式 · Git Bash (self-modifying toolset; skills
 *                       copied from the INSTALLED shipped 'cordis' preset so
 *                       the guidance tracks the deployment)
 *
 * Each preset directory carries a .plugin-managed.json marker recording the
 * hash of every file this plugin wrote. Ownership rules (per preset):
 *   - absent           → materialize;
 *   - foreign          → written by someone else: never touch;
 *   - user-modified    → ours but edited: never touch again (delete the
 *                        directory to re-materialize);
 *   - unmodified       → refreshed only when the plugin version changed (or,
 *                        for cordis-gitbash, when the live skills source
 *                        drifted); otherwise idle.
 *
 * Uninstall hygiene mirrors dsh-ptc-cordis-preset: on disposal, a package
 * directory that still exists means reload/update/restart — keep the
 * presets; a vanished package.json means uninstall — remove each preset the
 * user never modified.
 *
 * ERA SPLIT (v0.6.0): dsh renamed the built-in `code` preset to `ptc` in
 * 0.1.2 with no compatibility alias (tool-presentation `mode` value, plus new
 * built-in rows), so each variant ships BOTH committed era texts where the
 * built-in changed (minimal did not — one text serves both). The era is
 * probed per boot from the roster (`ptc` → dsh >= 0.1.2, else `code`),
 * recorded in the marker (`base`), and a flipped detection re-materializes
 * on the next startup — either upgrade order converges, and preset IDS never
 * change (sessions are pinned to them; `code-gitbash` keeps its historical
 * id even though its dsh >= 0.1.2 text presents through the `ptc` built-in).
 */

import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PRESET_META, minimalPluginsFor, pluginsFor } from './compositions.js'
import { loadSchemastery } from './schemastery.js'

/**
 * The executor base class's own Config schema, when this deployment has it.
 *
 * Dynamic and optional on purpose: `@deepseek-ai/dsh-bash-sandbox` belongs to
 * another row of THIS plugin, and a deployment that cannot resolve it must
 * still mount every other face (the static-peer-import lesson, v0.24.3). What
 * we need it for is the host's OWN behavioural answer to "do you read your
 * shell limits through `.get()`?" — see src/schemastery.js.
 */
async function executorConfigSchema() {
  try {
    const mod = await import('@deepseek-ai/dsh-bash-sandbox')
    return (mod.SandboxBashExecutor ?? mod.default)?.Config
  } catch {
    return undefined
  }
}

/**
 * The schemastery module, resolved LAZILY (v0.24.3): `@deepseek-ai/schemastery`
 * is a PEER — plain Node cannot resolve it from this package, only the host's
 * own resolution (the profile shared fallback) supplies it. A deployment whose
 * fallback lacks it used to fail the *static* import at the top of this file,
 * and the Loader treats a failed plugin import as a non-fatal skip
 * (`vendor/loader/src/config/entry.ts` `_init()`: logger.error + return, no
 * fiber) — the row then silently never mounted, which for THIS plugin means no
 * preset variants, no executor wiring and no client half, while every host log
 * stays green. Same all-green failure class as dsh-better-workspace issue #9;
 * verified with a fixture plugin whose only difference was the static peer
 * import. Deferring the import hides the schema where the module is absent
 * instead of killing the row.
 *
 * WHICH copy is resolved is no longer left to our own resolution order
 * (v0.31.1, issue #12): src/schemastery.js asks the host what it expects and
 * picks a copy that agrees with it. Both call sites share the one cached
 * answer, so the settings namespace and the executor can never disagree.
 */
let Schema = null
try {
  Schema = (await loadSchemastery({ parentConfig: await executorConfigSchema() })).z ?? null
} catch (error) {
  Schema = null
  console.warn(
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
  clearToolJob, currentToolJob, defaultRunnerIo, fenceToolRequest,
  probeToolchain, readJsonBody, startToolJob,
} from './tool-runner.js'

/** The shipped preset whose skills/ dir seeds cordis-gitbash. */

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(here, '..')

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

/** 'skills/<rel>' → sha256 map of a skills source tree, or null when absent. */
function skillsHashes(source) {
  if (!source || !existsSync(source)) return null
  const out = {}
  for (const rel of walkFiles(source)) {
    out[`skills/${rel}`] = createHash('sha256').update(readFileSync(join(source, rel))).digest('hex')
  }
  return out
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
 * dsh >= 0.1.7 marks a Config field live-editable without remount; a
 * 0.1.6-era schemastery predates the method and the guard keeps this module
 * loadable there (values then behave as ordinary config, read through the
 * registered settings namespace instead).
 */
function live(schema) {
  return typeof schema.volatile === 'function' ? schema.volatile() : schema
}

/**
 * Row Config = the settings surface on dsh >= 0.1.7 (values persist under the
 * row id; the patch row id is 'gitbash-shell', the same string as the old
 * settings namespace, so the one-shot legacy settings.yaml import maps old
 * user values onto the new home). Inert metadata on older hosts, and absent
 * (undefined) when schemastery is unresolvable: cordis then passes the row
 * config through unvalidated instead of the whole row disappearing.
 */
export const Config = Schema === null ? undefined : Schema.object({
  // Row-level knob predating the Config surface (invariant 6): which preset
  // variants to serve. Ordinary config — an edit remounts the plugin, which
  // is the right weight for a list that changes the roster.
  presets: Schema.array(Schema.string()).default(PRESET_IDS),
  posixPaths: live(Schema.boolean().default(true)),
  virtualMounts: live(Schema.boolean().default(true)),
  globSplit: live(Schema.boolean().default(true)),
  errorDialect: live(Schema.boolean().default(true)),
  codePaths: live(Schema.boolean().default(true)),
  /**
   * Whether DELEGATED agents (subagents, team members, nested children) also
   * use the Git Bash dialect (v0.27.0). Default ON — the historical behavior;
   * OFF keeps the dialect to the main agent, so a delegated request carries the
   * official shell semantics (no prompt rewrite, no path-argument translation,
   * no echo rewrite, no DSH_PATH_DIALECT fact). The executor itself is one
   * per-process provider, so Git Bash stays the binary either way.
   */
  subagentDialect: live(Schema.boolean().default(true)),
  gitAutocrlf: live(Schema.boolean().default(true)),
  bashPath: live(Schema.string().default('')),
  adoptSidebar: live(Schema.boolean().default(true)),
  /**
   * Whether the OFFICIAL sidebar terminal ("new terminal") is switched to the
   * resolved Git Bash (v0.29.0, task-25). Default ON — the user asked for
   * exactly this ("自动检测 … 帮忙补上一个 gitbash 可以用"). On Windows without
   * this, dsh resolves the terminal shell from the environment, which on a
   * machine whose PATH `bash` is the WSL launcher means the new terminal starts
   * Ubuntu, not Git Bash. Only ever writes when the terminal has NO shell of
   * its own: an explicit choice is never overwritten.
   */
  autoTerminalShell: live(Schema.boolean().default(true)),
  /**
   * Dedupe switch against dsh-ptc-cordis-preset (their issue #7, v0.25.0):
   * ON while that plugin is installed AND materializing its `PTC 创造模式`
   * against Git Bash drops OUR `创造模式 · Git Bash` from the roster, because
   * the two describe the same mode. Default OFF — the historical four-variant
   * roster is unchanged until asked for. The same state is rendered on their
   * settings card too (their card binds this row through configForms), so
   * changing it on either side changes it here.
   */
  suppressPeerCordis: live(Schema.boolean().default(false)),
})

/** Read one Config value across eras: Volatile ref (>= 0.1.7) or plain value. */
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
 * Era-aware live settings reader for everything wired inside apply(): the
 * NEW era reads this plugin's own Config refs (no listener needed — every
 * consumer here already re-reads per dispatch/assembly), the OLD era keeps
 * reading the registered namespace through the settings service.
 * @param {object} ctx - the plugin's mounting context.
 * @param {object|undefined} config - apply()'s resolved Config.
 * @returns {{ dialect: () => object, posix: () => boolean, adoptSidebar: () => boolean, suppressPeerCordis: () => boolean }}
 */
function makeLiveReader(ctx, config) {
  const hasConfig = !!(config && typeof config === 'object')
  const dialect = () => {
    if (!hasConfig) {
      // No row Config (schemastery unresolvable): everything off except the
      // opt-out booleans, the exact shape the old fallback returned.
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
    }
  }
  return {
    dialect,
    posix: () => dialect().posixPaths === true,
    adoptSidebar: () => dialect().adoptSidebar !== false,
    autoTerminalShell: () => dialect().autoTerminalShell !== false,
    // Default OFF: only an explicit true asks for deduplication.
    suppressPeerCordis: () => (hasConfig ? valueOf(config.suppressPeerCordis) === true : false),
  }
}

/** The full directive text, injected only while posixPaths is on. */
const POSIX_DIRECTIVE_TEXT = 'The working shell is Git for Windows bash: paths use MSYS drive roots (/c/Users/...), and every tool accepts that form directly — including the bash-native habits (~ home shorthand, /tmp, /dev/null, /usr/bin/...), which resolve in every tool exactly as bash itself resolves them.'

/** Strict drive-root-only directive (v0.19.0): used while virtualMounts is off. */
const POSIX_DIRECTIVE_TEXT_STRICT = 'The working shell is Git for Windows bash: paths use MSYS drive roots (/c/Users/...), and every tool accepts that form directly.'

/**
 * The run_code sentence is added ONLY for assemblies whose tool list actually
 * carries run_code (v0.20.1): a preset without it — standard/cordis sessions,
 * or a code-mode session whose tool row is disabled — has no program text to
 * write paths into, so the sentence would be pure noise there. Cheap and
 * honest: the tool list of the very assembly being rendered decides.
 */
const RUN_CODE_DIRECTIVE_TEXT = ' Path literals written inside a run_code program are translated the same way before the program runs; shell expansion is not available there, so spell paths out instead of relying on $VARS.'
const RUN_CODE_DIRECTIVE_STRICT_TEXT = ' Path literals written inside a run_code program are translated before the program runs.'

/** The run_code sentence for this assembly, or '' when the tool is not offered. */
export function runCodeHintFor(tools) {
  if (!Array.isArray(tools)) return ''
  for (const tool of tools) {
    const name = tool && typeof tool.name === 'string' ? tool.name : ''
    if (name === 'run_code') return RUN_CODE_DIRECTIVE_TEXT
  }
  return ''
}

// Official runtime counterpart to the directive (v0.11.0): dsh-shell-env is
// the host-plane registry behind the model-visible $DSH_* facts, and the
// bash tool's schema tells the model to inspect them — so the dialect also
// lives there, verifiable at runtime instead of only stated in the prompt.
const PATH_DIALECT_KEY = 'DSH_PATH_DIALECT'
const PATH_DIALECT_VALUE = 'msys'
const PATH_DIALECT_DESCRIPTION = 'Path dialect for tool calls and tool results: MSYS drive roots (/c/Users/...) plus the bash-native mounts (~, /tmp, /dev/null, /usr); every tool accepts these forms directly.'

// v0.21.1 — line endings for the MODEL's git commands live in the EXECUTOR
// (src/shell.js, withParityEnv): Windows Git defaults to core.autocrlf=true, so
// an LF file the model writes comes back CRLF after a checkout (scripts break on
// the stray \r, byte assertions fail), while a Linux guest has autocrlf=false.
// They cannot ride the shell-env registry below: that registry accepts DSH_*
// facts only, and a non-DSH key throws the whole contribution away.

// Windows absolute path -> MSYS drive-root form, for rewriting PROSE in place
// (v0.10.0). Quoted spaced paths ("C:\Program Files\Git") are matched whole; a bare
// path stops at a closing punctuation and crosses a space ONLY into a token that
// itself carries a separator — so "C:\Program Files\Git\bin" comes back whole (v0.23.0)
// while "see C:\Users\kanna for details" keeps its prose. An unquoted path whose LAST
// segment holds the space (…\my dir\f.txt") stays ambiguous in prose; the model meets such
// a path as a whole-value FIELD, which never goes through here (driveToMsys).
// The lookbehind set rejects URL schemes (https:), file:// forms, and anything
// already mid-word, so only real drive-letter paths are translated. Separators
// normalize to single slashes. The separator group after the colon consumes
// EVERY consecutive separator (`[\\/]+`), not just one (v0.26.0, issue #10):
// JSON-escaped Windows paths ("D:\\dsh\\工作" as the host renders
// `${JSON.stringify(workspaceRoot)}` in sandbox:policy) carry a DOUBLED
// backslash, and a single-separator atom left the second one at the head of
// `rest`, where the separator normalization turned it into a leading slash —
// "/d/" + "/dsh/工作" = "/d//dsh/工作", a non-canonical workspace root the
// model then copied. Single-separator inputs are byte-for-byte unchanged.
const BARE_WIN_PATH = /(?<![A-Za-z0-9:\\/"'`])([A-Za-z]):[\\/]+([^\s"'`<>|),;:!?]+(?: [^\s"'`<>|),;:!?]*[\\/][^\s"'`<>|),;:!?]*)*)/g
const QUOTED_WIN_PATH = /(["'`])([A-Za-z]):[\\/]+([^`]*?)\1/g

/** Rewrite every Windows absolute path in a text to the MSYS form; pure. */
export function windowsToMsys(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  return text
    .replace(QUOTED_WIN_PATH, (_whole, quote, drive, rest) =>
      quote + '/' + drive.toLowerCase() + '/' + rest.replace(/[\\/]+/g, '/') + quote)
    .replace(BARE_WIN_PATH, (_whole, drive, rest) =>
      '/' + drive.toLowerCase() + '/' + rest.replace(/[\\/]+/g, '/'))
}

/**
 * The MSYS echo of one text the Windows layer produced (v0.22.0): the
 * drive-root translation plus the /tmp mount, so a path that came back out
 * of the host reads as the very path the model wrote. ONE helper for every
 * echo face — success metadata, failure content, failure message — because
 * those faces must never disagree about the dialect.
 */
function msysEcho(value, env) {
  const out = windowsToMsys(value)
  if (typeof out !== 'string' || out.length === 0) return out
  const tempRoot = env && env.tmpDir ? driveToMsys(env.tmpDir) : ''
  if (!tempRoot) return out
  return mountTempRoot(out, tempRoot)
}

/**
 * Swap every /tmp-mount path inside a text for the short bash spelling;
 * pure. Whole-value path fields hit the first branch; a diagnostic that
 * QUOTES a temp path ("ENOENT ... open /c/Users/u/AppData/.../x.txt") is
 * the reason this is an embedded scan rather than a prefix test — the
 * model must recognise its own /tmp path in an error the way it does in a
 * successful result. Case-insensitive like the Windows filesystem, and
 * anchored on a path boundary so a sibling name (…/Temperature) never
 * matches.
 */
function mountTempRoot(text, tempRoot) {
  const haystack = text.toLowerCase()
  const needle = tempRoot.toLowerCase()
  let out = ''
  let cursor = 0
  let hits = 0
  for (;;) {
    const at = haystack.indexOf(needle, cursor)
    if (at < 0) break
    const after = at + needle.length
    const boundary = after === text.length || text.charCodeAt(after) === 47
    if (boundary) {
      out += text.slice(cursor, at) + '/tmp'
      hits++
    } else {
      out += text.slice(cursor, after)
    }
    cursor = after
  }
  return hits === 0 ? text : out + text.slice(cursor)
}

/** Normalize backslash separators in a RELATIVE result path to slashes; pure. */
function posixSeparators(value) {
  return typeof value === 'string' && value.includes(String.fromCharCode(92))
    ? value.split(String.fromCharCode(92)).join('/')
    : value
}

/**
 * One WHOLE path value -> the MSYS dialect (v0.23.0). windowsToMsys is a PROSE
 * rewriter: its bare pattern stops at whitespace, so a path whose DIRECTORY
 * contains a space came back half-translated — "C:\my dir\f.txt" turned into
 * "/c/my dir\f.txt", and the model met that mixed form in a SUCCESSFUL
 * read/write/edit result (issue #3). A whole-value field IS exactly one path, so
 * the drive prefix is translated directly and every remaining separator
 * normalizes; no prose pattern is involved. Relative values (grep match paths)
 * only normalize. A UNC root becomes the MSYS spelling "//server/share";
 * anything without a drive prefix passes through unchanged. Pure.
 */
function driveToMsys(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  const drive = /^([A-Za-z]):(?=[\\/])/.exec(value)
  if (drive) return '/' + drive[1].toLowerCase() + '/' + posixSeparators(value.slice(2)).replace(/^\/+/, '')
  return posixSeparators(value)
}

/**
 * The MSYS echo of one whole path VALUE — never prose (v0.23.0): the drive root
 * and separators through driveToMsys, then the /tmp mount. Every whole-value
 * face (read/write/edit path, glob paths[], grep matches[].path, present
 * files[].path) goes through here, so none of them can disagree about the
 * dialect, and a spaced directory no longer leaks a backslash.
 */
function pathEcho(value, env) {
  const out = driveToMsys(value)
  if (typeof out !== 'string' || out.length === 0) return out
  const tempRoot = env && env.tmpDir ? driveToMsys(env.tmpDir) : ''
  return tempRoot ? mountTempRoot(out, tempRoot) : out
}

/**
 * Rewrite Windows absolute paths inside an ERROR result's text blocks to
 * the MSYS dialect (pure, v0.17.1). Error results cannot carry a
 * replacement `value` (the registry rejects that), but replacing `content`
 * is the official post-execute channel, so the message the model reads
 * stays in one dialect — it must not relearn Windows forms from failure
 * text. Non-drive-letter diagnostics (device paths, URLs) never match
 * windowsToMsys and are left verbatim.
 */
/**
 * The only tools whose ERROR content is dialect-translated (v0.17.1).
 * These messages are harness-generated path diagnostics (cannot read
 * "C:\..."), so rewriting them is safe. Every other tool — bash above all,
 * whose failed runs carry raw command stdout/stderr — keeps its error
 * content VERBATIM: output is data, never rewritten (the same red line as
 * file content in successful results).
 */
const ERROR_CONTENT_TOOLS = new Set(['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'present'])

export function rewriteErrorContent(content, options) {
  if (!Array.isArray(content)) return content
  const nulHint = !options || options.nulHint !== false
  const env = options && options.env ? options.env : null
  let changed = false
  const next = content.map((block) => {
    if (!block || typeof block !== 'object' || typeof block.text !== 'string') return block
    const out = msysEcho(block.text, env)
    if (out === block.text) return block
    changed = true
    return { ...block, text: out }
  })
  // /dev/null x file tools: the harness realpath step rejects device
  // paths, so the failure is EXPECTED — append one guidance line (v0.18.0)
  // instead of leaving the model to puzzle over EINVAL. The original
  // diagnostic stays verbatim; only a hint block is appended.
  const nulHit = content.some((block) => {
    const t = block && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''
    return t.includes('EINVAL') && t.includes('NUL')
  })
  if (nulHint && nulHit) {
    next.push({ type: 'text', text: 'hint: /dev/null is the NUL device — file tools cannot target device paths (their realpath step rejects them); discard output through bash instead (echo ... > /dev/null)' })
    changed = true
  }
  return changed ? next : content
}

/**
 * The SECOND face of a failure (v0.22.0). The content blocks are what the
 * model reads on a failed call and what the UI card shows; error.message is
 * what the PTC bridge hands a running program as its caught ToolCallError
 * message (the durable record keeps only the structured identity). Rewriting
 * only the content left a program that printed a caught error holding the
 * Windows form while every other face said the MSYS one. Pure; options
 * mirror rewriteErrorContent.
 */
export function rewriteErrorMessage(message, options) {
  if (typeof message !== 'string' || message.length === 0) return message
  return msysEcho(message, options && options.env ? options.env : null)
}

/**
 * Apply rewriteErrorMessage to a failure RESULT in place (v0.22.0). The
 * registry keeps result.error by reference through the whole post-execute
 * waterfall and only snapshots the projection afterwards
 * (normalizeDispatchResult -> materializeFinalResult), so this write reaches
 * the PTC bridge, which is where a program meets its caught error.
 * post-execute block decision: a block rebuilds the error as a bare message
 * and would drop the structured identity (FS_NOT_FOUND and friends) that the
 * record and the UI keep. Defensive — a frozen or absent error object leaves
 * the result untouched, and the content face still carries the dialect alone.
 */
export function rewriteFailureMessage(result, env) {
  try {
    const error = result && result.error
    if (!error || typeof error !== 'object' || typeof error.message !== 'string') return false
    const rewritten = msysEcho(error.message, env)
    if (rewritten === error.message) return false
    error.message = rewritten
    return error.message === rewritten
  } catch {
    return false
  }
}

export function rewriteResultPaths(name, value, env) {
  if (!value || typeof value !== 'object') return value
  // v0.17.0: paths under the user TEMP directory echo back in the bash
  // /tmp dialect (that IS what /tmp means in Git Bash), so the model sees
  // the same short root bash itself prints for $TMP.
  // v0.23.0: every value around here is ONE path, so it goes through
  // pathEcho — the prose rewriter stops at whitespace and left a spaced
  // directory half-translated (issue #3). posixSeparators now lives inside
  // pathEcho, so the three nested branches below need no second pass.
  const toMsys = (p) => pathEcho(p, env)
  if (name === 'read' || name === 'read_image' || name === 'write' || name === 'edit') {
    if (typeof value.path === 'string' && value.path !== '') {
      const out = toMsys(value.path)
      if (out !== value.path) return { ...value, path: out }
    }
    return value
  }
  if (name === 'present' && Array.isArray(value.files)) {
    let changed = false
    const files = value.files.map((file) => {
      if (!file || typeof file !== 'object' || typeof file.path !== 'string' || file.path === '') return file
      const out = toMsys(file.path)
      if (out === file.path) return file
      changed = true
      return { ...file, path: out }
    })
    return changed ? { ...value, files } : value
  }
  if (name === 'glob' && Array.isArray(value.paths)) {
    let changed = false
    const paths = value.paths.map((p) => {
      if (typeof p !== 'string') return p
      const out = toMsys(p)
      if (out === p) return p
      changed = true
      return out
    })
    return changed ? { ...value, paths } : value
  }
  if (name === 'grep' && Array.isArray(value.matches)) {
    let changed = false
    const matches = value.matches.map((m) => {
      if (!m || typeof m !== 'object' || typeof m.path !== 'string') return m
      const out = toMsys(m.path)
      if (out === m.path) return m
      changed = true
      return { ...m, path: out }
    })
    return changed ? { ...value, matches } : value
  }
  return value
}

// ── MSYS drive-root path translation (Windows, EVERY tool dispatch) ────────
//
// The directive below tells the model to use POSIX-style MSYS paths (/c/...)
// for EVERY tool. Bash digests those natively, but the Node-backed file tools
// resolve an MSYS root against the current drive (/c/Users -> C:/c/Users), so a
// global tools/execute wrapper rewrites the path-bearing ARGUMENT FIELDS (by
// field NAME, not by tool name — dynamic tools using the standard field names
// are covered too) into the drive-letter form the host accepts. The bash
// command field is deliberately untouched: MSYS roots are Git Bash native
// there. Defensive by design: the waterfall hands the same mutable exec object
// to the tool body, but if a future registry freezes it the write throws, is
// swallowed, and the call proceeds with the model original arguments (the
// directive still stands).

const MSYS_DRIVE_ROOT = /^\/([a-z])\/(.*)$/i
const MSYS_BARE_DRIVE = /^\/([a-z])$/i
const TRANSLATABLE_PATH_FIELDS = new Set(['file_path', 'path', 'workdir'])

// ── virtual mounts + env (v0.17.0) ─────────────────────────────────────
//
// Git Bash resolves a few POSIX roots through its OWN mount table before
// any drive root applies (`mount` inside Git Bash): /tmp is the user TEMP
// dir (usertemp), /dev/null is the Windows NUL device, and /usr /bin /etc
// /var /home /root /mnt live under the Git install root. The model carries
// those bash habits into EVERY tool, so the translation layer mirrors the
// same table or the file tools silently misplace them (/tmp becomes a
// fresh C:/tmp on the current drive; /dev/null becomes a real file under
// C:/dev). All matches are segment-bounded and case-sensitive, exactly
// like the msys mount table itself (/Tmp does NOT match).
//
// /home is deliberately the GIT mount (git-root/home, usually empty), NOT
// the user profile: bash itself resolves /home/x there, while the home
// SHORTHAND ~ expands to $HOME (= C:/Users/<u>) — mirroring both keeps
// file tools and bash in perfect agreement. A bare '/' is never
// translated: it would scope tools to the whole Git install tree.

/** The Windows null device — the exact target of Git Bash's /dev/null. */
const NUL_DEVICE = '\\\\.\\NUL'

/** Git-root mounts: MSYS path -> subdirectory under the Git install root. */
const GIT_MOUNTS = new Map([
  ['/usr', 'usr'],
  ['/bin', 'usr/bin'],
  ['/etc', 'etc'],
  ['/var', 'var'],
  ['/home', 'home'],
  ['/root', 'root'],
  ['/mnt', 'mnt'],
])

const translateEnvCache = new Map()

/**
 * The runtime facts the virtual mounts resolve against (all optional — a
 * missing fact simply leaves its paths untranslated). Probed once per
 * distinct bashPath setting (v0.19.0: a settings-configured bash.exe joins
 * the candidates FIRST, fixing /usr translation for custom installs);
 * tmpdir/homedir are cheap; the Git root walks the candidate bash.exe list
 * (the default install plus every PATH entry) and accepts a root only when
 * <root>/usr/bin exists, which excludes the WSL bash shim in WindowsApps.
 */
/**
 * One dispatch's path-bearing arguments in the host dialect (pure). The
 * tools/execute wrapper's decision surface, exported so a test can drive the
 * whole argument face without a Windows host — the shape issue #8 escaped
 * through: pure helpers were covered, the wiring that feeds them was not.
 * @param {{ name?: string, arguments?: object }} exec - the dispatch envelope.
 * @param {object} dialect - live dialect switches (posixPaths/globSplit/codePaths).
 * @param {object|null} env - mount table (buildTranslateEnv), null when mounts are off.
 * @returns {object|undefined} the translated arguments (same reference when untouched).
 */
export function translateDispatch(exec, dialect, env) {
  if (!exec || !exec.arguments || typeof exec.arguments !== 'object') return exec?.arguments
  let translated = translatePathArguments(exec.arguments, env)
  if (exec.name === 'glob' && dialect.globSplit) {
    const globTranslated = translateGlobArguments(translated, env)
    if (globTranslated !== translated) translated = globTranslated
  }
  // v0.20.0: a run_code program is DATA for a native Node process, so a
  // '/c/...' literal inside it never reached this layer and landed on the
  // current drive as '<drive>:\c\...'. The same mount table covers the program
  // path literals (see rewriteCodePaths; anything unclear leaves the code
  // untouched).
  if (exec.name === 'run_code' && dialect.codePaths && typeof translated.code === 'string') {
    const rewritten = rewriteCodePaths(translated.code, env)
    const nextCode = programPrelude(env) + rewritten
    if (nextCode !== translated.code) translated = { ...translated, code: nextCode }
  }
  return translated
}

export function buildTranslateEnv(configuredBashPath) {
  const cacheKey = typeof configuredBashPath === 'string' && configuredBashPath !== '' ? configuredBashPath : ''
  const cached = translateEnvCache.get(cacheKey)
  if (cached) return cached
  const env = { tmpDir: undefined, home: undefined, gitRoot: undefined }
  try {
    const t = tmpdir()
    if (t && existsSync(t)) env.tmpDir = t.replace(/\\/g, '/')
  } catch { /* keep undefined */ }
  // v0.18.2: in an EMPTY-env process (the PTC run_code child) os.tmpdir()
  // degrades to a garbage path and the guard above drops it — fall back to
  // the standard Windows per-user temp layout under the detected home, so
  // importing this module from inside run_code still translates /tmp.
  if (!env.tmpDir && process.platform === 'win32') {
    try {
      const fallback = join(homedir(), 'AppData', 'Local', 'Temp')
      if (existsSync(fallback)) env.tmpDir = fallback.replace(/\\/g, '/')
    } catch { /* keep undefined */ }
  }
  try {
    const h = homedir()
    if (h && existsSync(h)) env.home = h.replace(/\\/g, '/')
  } catch { /* keep undefined */ }
  try {
    // v0.28.0 (issue #11): ONE resolver for the executor and this layer. Its
    // chain is setting > default install paths > PATH > registry PATH and it
    // refuses WSL/MSYS2/Cygwin outright; `cacheKey` is the settings bashPath,
    // i.e. the same explicit tier the executor reads.
    const resolution = resolveGitBashCached({ configured: cacheKey })
    if (resolution.ok) env.gitRoot = resolution.root.replace(/\\/g, '/')
  } catch { /* keep undefined */ }
  translateEnvCache.set(cacheKey, env)
  return env
}

/**
 * '/c/Users/x' -> 'C:/Users/x'. With an env, the bash-native habits resolve
 * first (~ -> home) and the virtual mounts (/tmp, /dev/null, /usr & friends)
 * resolve after the drive roots; any other shape returns the input
 * unchanged. Pure: the env is a plain fact bag, nothing is probed here.
 */
/**
 * Expand a leading dollar-sign NAME / braced NAME path variable the way
 * Git Bash would (pure, string surgery, v0.18.0): HOME is the user home,
 * TMPDIR/TMP/TEMP all mean the /tmp mount. Unknown names and NAMEX-style
 * false positives return the input verbatim (written without any dollar
 * literal — a code-transport layer mangles that byte inside quotes).
 */
function expandLeadingVar(value, env) {
  if (!env || typeof value !== 'string' || value.length < 2) return value
  if (value.charCodeAt(0) !== 36) return value
  let name = ''
  let rest = ''
  if (value.charCodeAt(1) === 123) {
    const close = value.indexOf('}', 2)
    if (close < 0) return value
    name = value.slice(2, close)
    rest = value.slice(close + 1)
  } else {
    const head = value.slice(1)
    let i = 0
    while (i < head.length) {
      const c = head.charCodeAt(i)
      const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
      const digit = c >= 48 && c <= 57
      if (i === 0 ? !letter : !(letter || digit)) break
      i++
    }
    if (i === 0) return value
    name = head.slice(0, i)
    rest = head.slice(i)
  }
  if (rest !== '' && rest.charCodeAt(0) !== 47) return value
  let base
  if (name === 'HOME') base = env.home
  else if (name === 'TMPDIR' || name === 'TMP' || name === 'TEMP') base = env.tmpDir
  else return value
  return base ? (rest !== '' ? base + rest : base) : value
}
/**
 * Expand a leading tilde the way Git Bash does (v0.22.0): ~ and ~/... mean
 * the user home — the same fact the mount table already applies to every
 * other path argument. A named form (~other/...) is left alone: the plugin
 * has no such fact, and a wrong guess would search the wrong tree.
 */
function expandLeadingTilde(value, env) {
  if (!env || !env.home || typeof value !== 'string') return value
  if (value === '~') return env.home
  if (value.charCodeAt(0) !== 126 || value.charCodeAt(1) !== 47) return value
  return env.home + value.slice(1)
}

export function translateMsysPath(value, env) {
  if (typeof value !== 'string') return value
  if (env && env.home && (value === '~' || value.startsWith('~/'))) {
    return value === '~' ? env.home : env.home + '/' + value.slice(2)
  }
  if (env) {
    const expanded = expandLeadingVar(value, env)
    if (expanded !== value) return expanded
  }
  const match = MSYS_DRIVE_ROOT.exec(value)
  if (match) return match[1].toUpperCase() + ':/' + match[2]
  const bare = MSYS_BARE_DRIVE.exec(value)
  if (bare) return bare[1].toUpperCase() + ':/'
  if (value === '/dev/null') return NUL_DEVICE
  if (env && env.tmpDir && (value === '/tmp' || value.startsWith('/tmp/'))) {
    return value === '/tmp' ? env.tmpDir : env.tmpDir + value.slice(4)
  }
  if (env && env.gitRoot) {
    for (const [mount, target] of GIT_MOUNTS) {
      if (value === mount || value.startsWith(mount + '/')) {
        const rest = value === mount ? '' : value.slice(mount.length)
        return env.gitRoot + '/' + target + rest
      }
    }
  }
  return value
}

/**
 * Return an arguments object whose path fields carry drive-letter roots.
 * Pure: builds a NEW object when any field changes and returns the ORIGINAL
 * reference otherwise — the registry deep-freezes exec.arguments at exec
 * construction (0.10.2 lesson: in-place writes throw in strict mode and
 * were silently swallowed), so the caller REPLACES the exec.arguments
 * property (the exec object itself is not frozen until tools/result;
 * signal replacement is the registry's own precedent).
 *
 * v0.17.0: present's NESTED files[].path rides along (the field-name
 * whitelist only sees top-level keys, and present is the one tool whose
 * path arguments live one level down).
 * @returns {object} the translated arguments object, or the input when
 *   nothing changed (also the input itself when args is not an object).
 */
export function translatePathArguments(args, env) {
  if (!args || typeof args !== 'object') return args
  let changed = false
  const next = { ...args }
  for (const key of Object.keys(next)) {
    if (!TRANSLATABLE_PATH_FIELDS.has(key)) continue
    const value = next[key]
    if (typeof value !== 'string') continue
    const translated = translateMsysPath(value, env)
    if (translated === value) continue
    next[key] = translated
    changed = true
  }
  if (Array.isArray(next.files)) {
    const files = next.files.map((file) => {
      if (!file || typeof file !== 'object' || typeof file.path !== 'string') return file
      const translated = translateMsysPath(file.path, env)
      return translated === file.path ? file : { ...file, path: translated }
    })
    if (files.some((file, index) => file !== next.files[index])) {
      next.files = files
      changed = true
    }
  }
  return changed ? next : args
}

// ── MSYS paths written INSIDE a run_code program (v0.20.0) ───────────────
//
// run_code hands the model's program to a native Node process: a path literal
// in that source is plain program DATA, so '/c/Users/x' is resolved by Node
// against the current drive ('<drive>:\\c\\Users\\x') — that is where the stray
// C:\\c\\... directories came from, since the tool-argument translation never
// sees it (see AGENTS.md 4c). The same mount table is therefore applied to the
// program's string literals — but ONLY when the whole program scans cleanly and
// a literal's ENTIRE content is an absolute MSYS path. Anything unclear — an
// unterminated literal, a template with ${} interpolation, a regex we cannot
// place — turns the whole rewrite into a no-op: a half-rewritten program would
// be far worse than an untranslated one, and this layer never guesses.
//
// Deliberately NOT translated: shell-style '$VAR/x' (a JS literal is data, not
// a shell word) and anything carrying a scheme ('http://...').

/** Source text allowed inside a rewritten literal: no escapes, no dollar sign. */
const CODE_LITERAL_SAFE = /^[A-Za-z0-9._@+~\-/ ]+$/

/** Previous significant character that lets a '/' start a regex literal. */
function regexCanStart(previous) {
  if (previous === '') return true
  return '(,=:[!&|?{};+-*%<>~^'.indexOf(previous) >= 0
}

/** Index after the closing quote of the literal at `index`, or -1. */
function skipQuotedLiteral(code, index) {
  const quote = code[index]
  let i = index + 1
  while (i < code.length) {
    const c = code[i]
    if (c === '\\') { i += 2; continue }
    if (c === '\n') return -1
    if (c === quote) return i + 1
    i += 1
  }
  return -1
}

/** Index after a regex literal (body + flags), or -1 when it cannot be walked. */
function skipRegexLiteral(code, index) {
  let i = index + 1
  let inClass = false
  while (i < code.length) {
    const c = code[i]
    if (c === '\\') { i += 2; continue }
    if (c === '\n') return -1
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && inClass === false) {
      i += 1
      while (i < code.length && /[a-z]/i.test(code[i])) i += 1
      return i
    }
    i += 1
  }
  return -1
}

/** Index after the '}' matching an already-consumed interpolation, or -1. */
function skipBracedExpression(code, index) {
  let depth = 1
  let i = index
  let last = ''
  while (i < code.length) {
    const c = code[i]
    const next = code[i + 1]
    if (c === '/' && next === '/') {
      const nl = code.indexOf('\n', i)
      if (nl === -1) return -1
      i = nl
      continue
    }
    if (c === '/' && next === '*') {
      const close = code.indexOf('*/', i + 2)
      if (close === -1) return -1
      i = close + 2
      continue
    }
    if (c === '"' || c === "'") {
      const end = skipQuotedLiteral(code, i)
      if (end === -1) return -1
      i = end
      last = 'x'
      continue
    }
    if (c === '`') {
      const inner = skipTemplateLiteral(code, i)
      if (inner === null) return -1
      i = inner.end
      last = 'x'
      continue
    }
    if (c === '/' && regexCanStart(last)) {
      const end = skipRegexLiteral(code, i)
      if (end === -1) return -1
      i = end
      last = 'x'
      continue
    }
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
    if (c.trim() !== '') last = c
    i += 1
  }
  return -1
}

/**
 * Walk a template literal. Returns { end, plain } — plain means it holds no
 * interpolation, i.e. its text is one literal value — or null when the
 * template could not be walked to its end.
 */
function skipTemplateLiteral(code, index) {
  let i = index + 1
  let plain = true
  while (i < code.length) {
    const c = code[i]
    if (c === '\\') { i += 2; continue }
    if (c === '`') return { end: i + 1, plain: plain }
    if (c === '$' && code[i + 1] === '{') {
      plain = false
      const after = skipBracedExpression(code, i + 2)
      if (after === -1) return null
      i = after
      continue
    }
    i += 1
  }
  return null
}

/**
 * Every plain string-literal span of a program, or null when the source could
 * not be walked with certainty. Spans cover the CONTENT (quotes excluded).
 */
export function scanCodeLiterals(code) {
  const spans = []
  let i = 0
  let last = ''
  while (i < code.length) {
    const c = code[i]
    const next = code[i + 1]
    if (c === '/' && next === '/') {
      const nl = code.indexOf('\n', i)
      if (nl === -1) return null
      i = nl
      continue
    }
    if (c === '/' && next === '*') {
      const close = code.indexOf('*/', i + 2)
      if (close === -1) return null
      i = close + 2
      continue
    }
    if (c === '"' || c === "'") {
      const end = skipQuotedLiteral(code, i)
      if (end === -1) return null
      spans.push({ start: i + 1, end: end - 1 })
      i = end
      last = 'x'
      continue
    }
    if (c === '`') {
      const template = skipTemplateLiteral(code, i)
      if (template === null) return null
      if (template.plain) spans.push({ start: i + 1, end: template.end - 1 })
      i = template.end
      last = 'x'
      continue
    }
    if (c === '/' && regexCanStart(last)) {
      const end = skipRegexLiteral(code, i)
      if (end === -1) return null
      i = end
      last = 'x'
      continue
    }
    if (c.trim() !== '') last = c
    i += 1
  }
  return spans
}

/**
 * The one line prepended to a run_code program (v0.21.0). run_code's process
 * environment is EMPTY BY DESIGN — exactly the same on macOS — so this is NOT
 * "giving the program a shell env". It exists for one measured Windows-only
 * symptom: with an empty env, Node's os.tmpdir() on Windows returns the literal
 * 'undefined\\temp' (macOS falls back to a real per-user directory), so a program
 * asking for the temp dir silently writes into a bogus 'undefined' folder.
 * Seeding ONLY TEMP/TMP — Windows' own convention — makes it resolvable again.
 * HOME/PATH are deliberately NOT seeded: values macOS does not have would make
 * the two platforms behave DIFFERENTLY, which is the opposite of the goal.
 * @param {{tmpDir?: string}|null} env
 * @returns {string} prelude source, or '' when there is no temp fact to seed
 */
export function programPrelude(env) {
  const tmp = env && typeof env.tmpDir === 'string' && env.tmpDir !== '' ? env.tmpDir : ''
  if (tmp === '') return ''
  return 'try{const e=process.env;if(e&&!e.TEMP){e.TEMP=' + JSON.stringify(tmp) + ';e.TMP=e.TEMP}}catch{}\n'
}

/**
 * Translates MSYS path literals inside a run_code program. Returns the input
 * unchanged when nothing matched or when the scan was not certain.
 * @param {string} code the model's program
 * @param {{tmpDir?: string, home?: string, gitRoot?: string}|null} env mounts
 * @returns {string} the program to execute
 */
export function rewriteCodePaths(code, env) {
  if (typeof code !== 'string' || code === '') return code
  if (code.indexOf('/') === -1) return code
  const spans = scanCodeLiterals(code)
  if (spans === null) return code
  let out = ''
  let cursor = 0
  let changed = false
  for (const span of spans) {
    const raw = code.slice(span.start, span.end)
    if (raw.charCodeAt(0) !== 47 && raw.startsWith('~/') === false) continue
    if (raw.indexOf('$') >= 0 || raw.indexOf('\\') >= 0) continue
    if (CODE_LITERAL_SAFE.test(raw) === false) continue
    if (raw.indexOf('://') >= 0) continue
    const translated = translateMsysPath(raw, env)
    if (typeof translated !== 'string' || translated === raw) continue
    // What lands in the program is SOURCE text, not the value: a backslash in
    // the translated path (the NUL device) must be escaped for the literal it
    // is written into, and a quote inside it (a home directory with an
    // apostrophe) would end that literal early — refuse rather than corrupt.
    const quote = code[span.start - 1]
    if (translated.indexOf(quote) >= 0) continue
    if (quote === '`' && translated.indexOf('${') >= 0) continue
    const source = translated.replace(/\\/g, '\\\\')
    out += code.slice(cursor, span.start) + source
    cursor = span.end
    changed = true
  }
  if (changed === false) return code
  return out + code.slice(cursor)
}

// ── absolute glob patterns (v0.17.0) ────────────────────────────────────
//
// The glob tool takes its search root in the `path` argument and expects a
// RELATIVE pattern; an absolute pattern ('/c/Users/x/*.md', or the Windows
// form) is treated as relative text and silently matches nothing. A model
// raised on bash writes absolute patterns anyway, so for the glob tool the
// wrapper splits an absolute pattern at the last directory separator
// before the first wildcard and moves the translated directory into
// `path` ('/c/a/*/b/*.md' -> path 'C:/a', pattern '*/b/*.md'). An absolute
// path WITHOUT wildcards splits into directory + basename. Runs only for
// the glob tool and only for patterns that start absolute.

const GLOB_META = /[*?\[\]]/

/** Split an absolute glob pattern into { prefix, rest }; null when relative. */
function splitGlobPrefix(pattern) {
  if (typeof pattern !== 'string') return null
  let p = pattern
  // A Windows drive head ('C:' + separator) is normalized to the MSYS form
  // first so both absolute dialects split through the same code path.
  const winHead = /^([A-Za-z]):[\\/]+(.*)$/.exec(p)
  if (winHead) p = '/' + winHead[1].toLowerCase() + '/' + winHead[2].replace(/[\\/]+/g, '/')
  if (p[0] !== '/') return null
  const meta = GLOB_META.exec(p)
  const cut = meta ? p.lastIndexOf('/', meta.index) : p.lastIndexOf('/')
  if (cut <= 0) return null
  const rest = p.slice(cut + 1)
  if (rest === '') return null
  return { prefix: p.slice(0, cut), rest }
}


/** Translate the (always MSYS-form) directory prefix; null when it is not one. */
function normalizeAbsolutePrefix(prefix, env) {
  const translated = translateMsysPath(prefix, env)
  return translated !== prefix ? translated : null
}


/**
 * Rewrite a glob call's absolute pattern into the { path, pattern } pair
 * the tool actually supports; any existing `path` is superseded (an
 * absolute pattern already names its root). Pure; returns the input on any
 * miss.
 */
export function translateGlobArguments(args, env) {
  if (!args || typeof args !== 'object' || typeof args.pattern !== 'string') return args
  // Expand a leading variable shorthand first (v0.18.1): a pattern opening
  // with $HOME/... must become absolute before the split, or the splitter
  // rejects it and glob silently matches nothing.
  // Then the tilde shorthand (v0.22.0): ~/x names the same tree as $HOME/x
  // in every other tool, so glob must not silently match nothing for it.
  const expanded = env ? expandLeadingTilde(expandLeadingVar(args.pattern, env), env) : args.pattern
  const split = splitGlobPrefix(expanded)
  if (!split) return args
  const prefix = normalizeAbsolutePrefix(split.prefix, env)
  if (!prefix) return args
  return { ...args, pattern: split.rest, path: prefix }
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

const SIDEBAR_NS = 'dsh-better-sidebar'
const SIDEBAR_TRIES = 12
const SIDEBAR_RETRY_MS = 1500

// Reconciler installed by adoptSidebarShell; a no-op until then.
let reconcileSidebar = () => {}

/**
 * Reconcile the better-sidebar `terminalShell` takeover with the adoptSidebar
 * setting (v0.15.0, default ON). ON writes our bashPath (remembering what was
 * there before); OFF restores that previous value — but only while the current
 * value is still ours, so a user's manual choice is never clobbered. The
 * polling keeps the original ready-wait behavior: at boot the settings
 * service may not be provided yet when this row's apply runs. Never throws.
 *
 * `readAdopt` is apply()'s era-aware gate getter (`() => liveSettings.
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
  ctx.effect(() => () => { if (timer) clearTimeout(timer) }, 'dsh-gitbash-shell: sidebar adoption polling')

  const readShell = () => {
    const settings = ctx.get('settings')
    if (!settings || typeof settings.update !== 'function') return null
    try {
      // The sidebar's value lives in ITS row Config, projected into the
      // settings describe() list; the service exposes describe/update only
      // (the old `get(ns)` reader died with dsh 0.1.6).
      if (typeof settings.describe === 'function') {
        const entry = settings.describe().find((row) => row !== null && typeof row === 'object' && row.ns === SIDEBAR_NS)
        const value = entry === undefined ? undefined : entry.value
        return value && typeof value === 'object' && typeof value.terminalShell === 'string' ? value.terminalShell : ''
      }
      return null
    } catch {
      return null // namespace not registered yet / sidebar absent
    }
  }

  reconcileSidebar = (desired) => {
    const current = readShell()
    if (current === null) return false
    const settings = ctx.get('settings')
    if (desired && current !== bashPath) {
      const was = current
      settings.update(SIDEBAR_NS, { terminalShell: bashPath })
        .then(() => {
          previous = was
          adopted = true
          console.log(
            `${TAG} dsh-better-sidebar terminal shell -> Git Bash (${bashPath})` +
              (was ? ` (took over from '${was}')` : ''),
          )
        })
        .catch((error) => {
          console.log(`${TAG} better-sidebar shell adoption unavailable: ${error?.message ?? error}`)
        })
      return true
    }
    if (desired && current === bashPath) {
      adopted = true
      return true
    }
    if (!desired && adopted && current === bashPath) {
      settings.update(SIDEBAR_NS, { terminalShell: previous })
        .then(() => {
          adopted = false
          console.log(`${TAG} dsh-better-sidebar terminal shell restored ('${previous || 'sidebar default'}') — adoptSidebar off`)
        })
        .catch(() => {})
      return true
    }
    return true
  }

  const run = () => {
    tried += 1
    const ok = reconcileSidebar(readAdopt())
    if (ok) return
    if (tried < SIDEBAR_TRIES) {
      timer = setTimeout(run, SIDEBAR_RETRY_MS)
      return
    }
    console.log(`${TAG} better-sidebar shell adoption skipped: settings service unavailable after ${tried} tries`)
  }
  run.watched = false
  void run()

  // Dispose: while we still hold the value, restore what was there before.
  let reverted = false
  ctx.effect(
    () => () => {
      if (reverted || !adopted) return
      reverted = true
      const s = ctx.get('settings')
      if (!s || typeof s.update !== 'function') return
      // Era-aware read (v0.25.1): `settings.get(ns)` is gone on dsh >= 0.1.7, so
      // the old call threw straight into the catch and the takeover was NEVER
      // reverted when this plugin unloaded — same missed-era-read class as
      // issue #8 (readShell above carries both branches).
      const now = readShell()
      if (now === null) return
      if (String(now) === bashPath) {
        s.update(SIDEBAR_NS, { terminalShell: previous }).catch(() => {})
      }
    },
    'dsh-gitbash-shell: sidebar shell revert',
  )
}

// ── plugin ──────────────────────────────────────────────────────────────────

/** First user-trust root: the roster's authoring target. */

/** Directory of skills inside the installed shipped `cordis` preset, if any. */
async function findSkillsSource(agentPresets) {
  try {
    const list = await agentPresets.list()
    const cordis = Array.isArray(list) ? list.find((p) => p && p.id === SKILLS_SOURCE_PRESET && typeof p.path === 'string') : undefined
    if (!cordis) return undefined
    return join(dirname(cordis.path), 'skills')
  } catch {
    return undefined
  }
}

/**
 * Purge preset directories this plugin materialized in earlier versions but
 * that are no longer in the configured materialization set. Only an
 * UNMODIFIED tree is removed; a user-edited one stays (and is left alone).
 * @param userRoot - the user-trust preset root path.
 * @param keep - preset ids to keep.
 */
function purgeOrphans(userRoot, keep) {
  try {
    for (const entry of readdirSync(userRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const id = entry.name
      if (keep.includes(id)) continue
      const target = join(userRoot, id)
      const marker = readMarker(target)
      if (!marker || marker.managedBy !== MANAGED_BY) continue
      if (classify(target) === 'unmodified') {
        rmSync(target, { recursive: true, force: true })
        console.log(`${TAG} removed orphan preset '${id}' (no longer materialized)`)
      } else {
        console.log(`${TAG} orphan preset '${id}' was modified after materialization — leaving it alone`)
      }
    }
  } catch (error) {
    console.log(`${TAG} orphan cleanup skipped: ${error?.message ?? error}`)
  }
}

// ── declarative registration (dsh >= 0.1.7) ──────────────────────────────────
//
// dsh 0.1.7 removed directory presets: nothing reads ~/.dsh/.agent-presets
// any more, and a preset is a definition registered through
// agentPresets.register(). The era probe is the register method itself; the
// composition data lives in src/compositions.js (the new-era counterpart of
// the committed assets/<variant>/ texts).

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

/** The legacy preset root, best effort (roster roots are gone on 0.1.7). */
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
        console.log(TAG + ' removed the stale materialized preset at ' + target + ' (directory presets are no longer read on this host; the declarative registration replaces it)')
      } catch (error) {
        console.log(TAG + ' stale preset cleanup failed: ' + (error && error.message ? error.message : error))
      }
    } else if (state === 'user-modified') {
      console.log(TAG + ' a user-modified preset tree remains at ' + target + ' — left untouched (this host ignores it; delete it manually if unwanted)')
    }
  }
}

/**
 * Probe the dsh 0.2.1 host additions for the variant compositions: every
 * full-tool official preset gained a `time-context` row (durable clock
 * readings) and a `tool-schedule` row (the reminder tools). A preset row whose
 * package is absent rejects the WHOLE mount, so the rows ride this probe: each
 * is added only when its package resolves from the HOST's module base —
 * `ctx.baseUrl`, the exact base `prepareProfileEntries` mounts preset rows
 * from, so the probe can never disagree with the mounter. On dsh <= 0.2.0 both
 * stay false and the row set stays byte-identical to the 0.1.7 mirror. Probed
 * once per boot; the profile's package set does not change under a running
 * host. minimal never gains the rows (the official minimal preset has none).
 * @param {object} ctx - cordis context (any fiber of the running host).
 * @param {Function} [resolve] - predicate override for tests; receives a
 *   package specifier, resolves like `require.resolve`, returns boolean.
 * @returns {Promise<{timeContext: boolean, toolSchedule: boolean}>}
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
  const [timeContext, toolSchedule] = await Promise.all([
    Promise.resolve(safeProbe(ok, '@deepseek-ai/dsh-time-context')).then(Boolean),
    Promise.resolve(safeProbe(ok, '@deepseek-ai/dsh-tool-schedule')).then(Boolean),
  ])
  return { timeContext, toolSchedule }
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
async function registerVariant(ctx, presetId, { gitBashActive, skillsDir, pythonActive, hostExtras = {}, readBashResolution }) {
  const meta = PRESET_META[presetId]
  if (!meta) return undefined
  const plugins = meta.kind === 'minimal'
    ? minimalPluginsFor({ bashPath: minimalPtyBashPath(readBashResolution) })
    : pluginsFor({ kind: meta.kind, gitBash: gitBashActive, skillsDir, pythonActive, hostExtras })
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
async function runDeclarativeEra(ctx, presetIds, readSuppress, readBashResolution) {
  cleanupLegacyTrees(presetIds)
  const gitBashActive = process.platform === 'win32'
  const skillsDir = await resolveSkillsDir()
  // The dsh 0.2.1 additions (time-context / tool-schedule rows) probe once per
  // boot and ride every (re-)registration below — the profile's package set
  // cannot change under a running host.
  const hostExtras = await probeHostExtras(ctx)
  /** presetId -> unregister, i.e. exactly what is live right now. */
  const live = new Map()
  let peerGitBash = false
  let peerPython = false
  /** The CPython fact the LIVE registrations were built with. */
  let registeredPython = false
  let serial = Promise.resolve()

  const desired = () => effectivePresetIds(presetIds, { suppress: readSuppress(), peerGitBash })

  const reconcile = () => {
    serial = serial.then(async () => {
      const want = desired()
      // The peer's EFFECTIVE CPython backend rewrites the workflow rows of
      // EVERY variant (the official Python composition disables them, and
      // workflow-ptc refuses a non-TypeScript backend), so a flip re-registers
      // the live variants instead of leaving stale rows mounted. Same cadence
      // as the backend swap itself: the peer's patch is evaluated at boot. A
      // bare INTENT without the effective backend changes nothing here — the
      // composition still runs Node, so the workflow rows must stay live.
      if (live.size > 0 && registeredPython !== peerPython) {
        for (const [presetId, off] of [...live]) {
          live.delete(presetId)
          try {
            await off()
            console.log(TAG + " preset '" + presetId + "' retired (peer CPython backend changed; rows are rebuilt)")
          } catch (error) {
            console.log(TAG + " preset '" + presetId + "' retirement failed: " + (error && error.message ? error.message : error))
          }
        }
      }
      for (const [presetId, off] of [...live]) {
        if (want.includes(presetId)) continue
        live.delete(presetId)
        try {
          await off()
          console.log(TAG + " preset '" + presetId + "' retired (dsh-ptc-cordis-preset covers Creation mode on Git Bash)")
        } catch (error) {
          console.log(TAG + " preset '" + presetId + "' retirement failed: " + (error && error.message ? error.message : error))
        }
      }
      for (const presetId of want) {
        if (live.has(presetId)) continue
        try {
          const unregister = await registerVariant(ctx, presetId, { gitBashActive, skillsDir, pythonActive: peerPython, hostExtras, readBashResolution })
          if (unregister) {
            live.set(presetId, unregister)
            console.log(TAG + " preset '" + presetId + "' registered declaratively")
          }
        } catch (error) {
          console.log(TAG + " preset '" + presetId + "' registration failed: " + (error && error.message ? error.message : error))
        }
      }
      registeredPython = peerPython
    }).catch((error) => {
      console.log(TAG + ' preset reconcile failed: ' + (error && error.message ? error.message : error))
    })
    return serial
  }

  await reconcile()
  console.log(TAG + ' registered ' + live.size + ' preset(s) declaratively (' + [...live.keys()].join(', ') + ')' + (hostExtras.timeContext || hostExtras.toolSchedule
    ? ' [dsh 0.2.1 additions: ' + (hostExtras.timeContext ? 'time-context' : '') + (hostExtras.timeContext && hostExtras.toolSchedule ? ' + ' : '') + (hostExtras.toolSchedule ? 'tool-schedule (subagents denied)' : '') + ']'
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
          if (nextPython) console.log(TAG + ' peer reports the experimental CPython run_code backend: workflow rows go off in every variant')
          else if (intentPython) {
            console.log(TAG + ' peer has the CPython switch on but the effective backend is '
              + (reportedBackend === undefined ? 'unreported (older peer: the intent stands in)' : reportedBackend)
              + ': workflow rows stay on (reason in the host log)')
          }
          void reconcile()
        }
      } catch (error) {
        console.log(TAG + ' peer coverage read failed: ' + (error && error.message ? error.message : error))
      }
      peerCtx.effect(() => () => {
        if (!peerGitBash && !peerPython) return
        peerGitBash = false
        peerPython = false
        void reconcile()
      }, 'dsh-gitbash-shell: peer coverage release')
    })
  } catch (error) {
    console.log(TAG + ' peer capability wiring failed: ' + (error && error.message ? error.message : error))
  }

  // The switch itself: a volatile Config edit on this row lands as a
  // loader/volatile-update event on this fiber.
  try {
    ctx.on('loader/volatile-update', (paths) => {
      try {
        if (!Array.isArray(paths) || !paths.some((path) => Array.isArray(path) && path[0] === 'suppressPeerCordis')) return
        void reconcile()
      } catch (error) {
        console.log(TAG + ' dedupe switch handling failed: ' + (error && error.message ? error.message : error))
      }
    })
  } catch (error) {
    console.log(TAG + ' dedupe switch wiring failed: ' + (error && error.message ? error.message : error))
  }

  ctx.effect(() => () => { for (const off of live.values()) void off() }, 'dsh-gitbash-shell: declarative preset registrations')
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
      console.log(`${TAG} inspect-registry compatibility shim active (multiple cordis-mode sessions supported)`)
    })
  } catch (error) {
    console.log(`${TAG} inspect-registry shim wiring failed: ${error?.message ?? error}`)
  }

  // ── cooperation capability ────────────────────────────────────────────────
  // Publish whether the Git Bash shell stack is active on this host so peer
  // plugins (e.g. dsh-ptc-cordis-preset) can adopt it in the presets they
  // materialize: service present, 'active: true' on Windows, 'active: false'
  // where the bundle is installed but the platform stack stayed native.
  /* The explicit tier of the resolution chain, in its documented priority:
     the `gitbash-executor` row's own config > the `gitbash-shell` row's
     `bashPath` field > empty (= run the automatic chain). Both this layer and
     the executor resolve from this same value, so an explicit answer is never
     substituted and never silently ignored.
     (issue #11: the row config is where the reporter's workaround landed.)
     LAZY, never frozen (issue #13): at apply() time the loader store may not
     hold the executor row yet — `loader.resolve()` throws and reads '' — and
     the old settings-service detour could equally read '' before the service
     was injected. A frozen '' then ran the automatic chain (which fails on
     shimmed Git layouts) while the executor's own per-call lazy resolution
     worked, i.e. the same boot gave OPPOSITE verdicts. Every consumer below
     re-reads per use; the own row's value comes from apply()'s `config`
     parameter (this row's live Config refs — volatile, so a settings edit is
     visible on the next read without any listener). */
  const readConfiguredBashPath = () => effectiveConfiguredBashPath(executorConfiguredBashPath(ctx), rowBashPath(config))
  const readBashResolution = () => resolveGitBashCached({ configured: readConfiguredBashPath() })
  const gitBashCapability = {
    active: process.platform === 'win32',
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

  // Era-aware live settings: every consumer below re-reads the row Config
  // refs on every use (volatile), so a flipped knob lands on the next
  // dispatch with zero wiring.
  const liveSettings = makeLiveReader(ctx, config)

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
          console.log(`${TAG} shellEnv fact registered: ${PATH_DIALECT_KEY} (gated by the posixPaths setting)`)
        } catch (error) {
          console.log(`${TAG} shellEnv fact registration failed: ${error?.message ?? error}`)
        }
      })
    } catch (error) {
      console.log(`${TAG} shellEnv wiring failed: ${error?.message ?? error}`)
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
            const hint = runCodeHintFor(assembly.tools)
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
      console.log(TAG + ' prompt-assembly path dialect active (gated by the posixPaths setting)')
    } catch (error) {
      console.log(TAG + ' system-prompt/assemble wiring failed: ' + (error?.message ?? error))
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
          // The LIVE, era-aware reader (v0.25.1, issue #8). The legacy
          // `readDialectSettings(ctx)` reads `settings.get(ns)`, which does not
          // exist on dsh >= 0.1.7 — it returned the all-off fallback, so this
          // wrapper translated NOTHING while the directive and the shell env
          // (both already on the live reader) kept working: `/c/...` reached the
          // file tools untranslated, `~` was never expanded, `glob.path` and
          // `bash.workdir` went through raw, and an in-workspace `/c/...` write
          // fell outside the sandbox. One missed call site, five symptoms.
          const dialect = liveSettings.dialect()
          // v0.27.0: a delegated agent the user excluded keeps the official
          // semantics for BOTH faces of its calls — arguments go through
          // untouched and the result metadata is not echoed back in MSYS form.
          if (dialect.posixPaths && dialectApplies(dialect, exec && exec.agent)) {
            echo = true
            const env = dialect.virtualMounts ? buildTranslateEnv(readConfiguredBashPath()) : null
            echoEnv = env
            if (exec && exec.arguments && typeof exec.arguments === 'object') {
              const translated = translateDispatch(exec, dialect, env)
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
      console.log(TAG + ' MSYS path translation active on tool dispatch (arguments and result metadata)')
    } catch (error) {
      console.log(TAG + ' tools/execute wiring failed: ' + (error?.message ?? error))
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
      console.log(TAG + ' failure dialect active on tools/post-execute (content + error.message)')
    } catch (error) {
      console.log(TAG + ' tools/post-execute wiring failed: ' + (error?.message ?? error))
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
          console.log(TAG + ' unified POSIX-path directive context active (win32, gated by the posixPaths setting)')
        } catch (error) {
          console.log(TAG + ' context registration failed: ' + (error?.message ?? error))
        }
      })
    } catch (error) {
      console.log(TAG + ' systemPrompt inject wiring failed: ' + (error?.message ?? error))
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
    console.log(TAG + ' bash resolution' + (phase === '' ? '' : ' (' + phase + ')') + ': '
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
          console.log(TAG + ' bash status route active at ' + route + ' (read by the guided popup)')
        } catch (error) {
          console.log(TAG + ' bash status route failed: ' + (error?.message ?? error))
        }
      })
    } catch (error) {
      console.log(TAG + ' bash status route wiring failed: ' + (error?.message ?? error))
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
            console.log(TAG + ' path map request refused (' + fence.reason + ')')
            send(res, 403, { error: 'forbidden', reason: fence.reason })
            return
          }
          const env = buildTranslateEnv(readConfiguredBashPath())
          // One line per read: the browser half fetches this once per page load,
          // so its presence in the log is how a user can tell the rescue is live.
          console.log(TAG + ' path map read by ' + (req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '?'))
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
        console.log(TAG + ' MSYS path map route active at ' + route + ' (read by the browser half)')
      } catch (error) {
        console.log(TAG + ' path map route failed: ' + (error?.message ?? error))
      }
    })
  } catch (error) {
    console.log(TAG + ' path map route wiring failed: ' + (error?.message ?? error))
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
            }
          }
          const handler = async (req, res) => {
            const fence = fenceToolRequest(req)
            if (!fence.ok) {
              console.log(TAG + ' toolchain request refused (' + fence.reason + ')')
              send(res, 403, { error: 'forbidden', reason: fence.reason })
              return
            }
            let query = new URLSearchParams()
            try { query = new URL(req.url || '/', 'http://localhost').searchParams } catch { /* keep empty */ }
            const method = String(req.method || 'GET').toUpperCase()
            try {
              if (method === 'POST') {
                const action = query.get('action') || ''
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
          console.log(TAG + ' winget toolchain route active at ' + route + ' (loopback + same-origin fenced)')
        } catch (error) {
          console.log(TAG + ' toolchain route failed: ' + (error?.message ?? error))
        }
      })
    } catch (error) {
      console.log(TAG + ' toolchain route wiring failed: ' + (error?.message ?? error))
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
            console.log(`${TAG} official sidebar terminal adoption crashed: ${error?.message ?? error}`)
            return
          }
          if (result.status === 'skip-row-absent' && attempts < 6) {
            setTimeout(() => { run().catch((error) => console.log(`${TAG} official sidebar terminal adoption retry failed: ${error?.message ?? error}`)) }, 3000)
            return
          }
          console.log(`${TAG} ${terminalAdoptReport(result)}`)
        }
        run().catch((error) => console.log(`${TAG} official sidebar terminal adoption failed: ${error?.message ?? error}`))
      })
    } catch (error) {
      console.log(`${TAG} official sidebar terminal adoption wiring failed: ${error?.message ?? error}`)
    }
  }

  // ── dsh-better-sidebar terminal adoption (Windows only) ────────────────
  // The sidebar resolves its terminal shell through the settings seam per
  // open; adopt it through that seam (see adoptSidebarShell for rationale).
  // Disable with `betterSidebarShell: false` in the plugin row config.
  // Rides the settle notification (issue #13): a boot-time failure with an
  // empty explicit tier may still settle into a success once the loader rows
  // mount, and the adoption then happens without a restart.
  if (config.betterSidebarShell !== false && process.platform === 'win32') {
    let sidebarAdopted = false
    onBashSettled((resolution) => {
      if (resolution.ok) {
        if (sidebarAdopted) return
        sidebarAdopted = true
        adoptSidebarShell(ctx, resolution.path, () => liveSettings.adoptSidebar())
        return
      }
      console.log(TAG + ' sidebar terminal adoption skipped: no Git Bash resolved (nothing is substituted)')
    })
  }

  // ── era split: declarative registration on dsh >= 0.1.7 ──────────────────
  // The register method IS the era signal. On the new host the whole
  // materialization path below is dead code (nothing reads the directory any
  // more), so this branch serves the variants and returns.
  if (ctx.agentPresets && typeof ctx.agentPresets.register === 'function') {
    try {
      await runDeclarativeEra(ctx, presetIds, () => liveSettings.suppressPeerCordis(), readBashResolution)
    } catch (error) {
      console.log(TAG + ' declarative registration failed: ' + (error && error.message ? error.message : error))
    }
    return
  }

}
// Test surface: pure helpers, no Cordis context required.
export const _internal = { PRESET_IDS, PEER_COVERED_PRESET_ID, PEER_CAPABILITY, isDelegatedAgent, dialectApplies, PEER_PYTHON_FIELD, PEER_PYTHON_BACKEND_FIELD, peerFact, peerBackend, pythonBackendActive, effectivePresetIds, translateDispatch, translateMsysPath, translatePathArguments, rewriteCodePaths, scanCodeLiterals, programPrelude, translateGlobArguments, buildTranslateEnv, rewriteErrorContent, rewriteErrorMessage, rewriteFailureMessage, msysEcho, driveToMsys, pathEcho, ERROR_CONTENT_TOOLS, windowsToMsys, rewriteResultPaths, adoptSidebarShell, MARKER_FILE, classify, hashTree, installRegisterShim, probeHostExtras }
