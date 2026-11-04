/**
 * dsh-gitbash-shell — MSYS path dialect (host half).
 *
 * The model speaks Git Bash's path world (/c/Users/...), while the tools it
 * calls are native Windows processes. This module owns the whole translation
 * layer: the directive text, the run_code hint, path-argument translation,
 * result/error echoing, the glob split, and the literal rewrite inside a
 * run_code program. It is pure except for buildTranslateEnv(), which probes
 * temp/home/Git facts once per configured bash path.
 *
 * Extracted from src/index.js (v0.48.1) so the host entry point stays an
 * assembly file; the exports are re-exported by index.js for compatibility.
 */

import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveGitBashCached } from './bash-path.js'

/** The full directive text, injected only while posixPaths is on. */
export const POSIX_DIRECTIVE_TEXT = 'The working shell is Git for Windows bash: paths use MSYS drive roots (/c/Users/...), and every tool accepts that form directly — including the bash-native habits (~ home shorthand, /tmp, /dev/null, /usr/bin/...), which resolve in every tool exactly as bash itself resolves them.'

/** Strict drive-root-only directive (v0.19.0): used while virtualMounts is off. */
export const POSIX_DIRECTIVE_TEXT_STRICT = 'The working shell is Git for Windows bash: paths use MSYS drive roots (/c/Users/...), and every tool accepts that form directly.'

/**
 * The run_code sentence is added ONLY for assemblies whose tool list actually
 * carries run_code (v0.20.1): a preset without it — standard/cordis sessions,
 * or a code-mode session whose tool row is disabled — has no program text to
 * write paths into, so the sentence would be pure noise there. Cheap and
 * honest: the tool list of the very assembly being rendered decides.
 */
const RUN_CODE_DIRECTIVE_TEXT = ' In a run_code program, compatible plain MSYS path literals are translated on a best-effort basis; interpolated or tagged templates and uncertain syntax are not rewritten. For direct native Node fs/path APIs, prefer explicit Windows drive-letter or cwd-relative paths. Do not rely on literal rewriting for dynamic paths, shell command strings, routes or search data; tool path arguments are translated separately. Shell expansion is unavailable in program strings, so do not rely on $VARS.'
const RUN_CODE_DIRECTIVE_OFF_TEXT = ' In a run_code program, automatic path-literal rewriting is OFF. Direct native Node fs/path APIs require Windows drive-letter or cwd-relative paths, not MSYS /c/... strings. Tool path arguments are still translated separately; program strings do not perform shell expansion.'

/** The run_code sentence for this assembly, or '' when the tool is not offered. */
export function runCodeHintFor(tools, codePaths = true) {
  if (!Array.isArray(tools)) return ''
  for (const tool of tools) {
    const name = tool && typeof tool.name === 'string' ? tool.name : ''
    if (name === 'run_code') return codePaths === true ? RUN_CODE_DIRECTIVE_TEXT : RUN_CODE_DIRECTIVE_OFF_TEXT
  }
  return ''
}

// Official runtime counterpart to the directive (v0.11.0): dsh-shell-env is
// the host-plane registry behind the model-visible $DSH_* facts, and the
// bash tool's schema tells the model to inspect them — so the dialect also
// lives there, verifiable at runtime instead of only stated in the prompt.
export const PATH_DIALECT_KEY = 'DSH_PATH_DIALECT'
export const PATH_DIALECT_VALUE = 'msys'
export const PATH_DIALECT_DESCRIPTION = 'Path dialect for tool calls and tool results: MSYS drive roots (/c/Users/...) plus the bash-native mounts (~, /tmp, /dev/null, /usr); every tool accepts these forms directly.'

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
export function msysEcho(value, env) {
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
export function driveToMsys(value) {
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
export function pathEcho(value, env) {
  const out = driveToMsys(value)
  if (typeof out !== 'string' || out.length === 0) return out
  const tempRoot = env && env.tmpDir ? driveToMsys(env.tmpDir) : ''
  // A whole path has exactly one root; an embedded copy in a backup tree is data.
  if (tempRoot && out.slice(0, tempRoot.length).toLowerCase() === tempRoot.toLowerCase()
    && (out.length === tempRoot.length || out[tempRoot.length] === '/')) {
    return '/tmp' + out.slice(tempRoot.length)
  }
  return out
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
// ops_* six (v0.39.4, dsh-ops 0.3.0): their failures quote Windows paths too —
// the error content and error.message must answer in the same /c/ dialect.
export const ERROR_CONTENT_TOOLS = new Set(['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'present', 'ops_inspect_local_file', 'ops_glob', 'ops_grep', 'ops_replace', 'ops_batch', 'ops_result'])

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
  // v0.39.4 (dsh-ops 0.3.0): ops_* tools answer with the same paths the
  // model must keep speaking /c/ about. Their Rust worker names every path
  // field `path` (items[] / matches[]) and ops_batch/ops_result echo the
  // operation `root`; detailsRef ids are opaque, never rewritten.
  if (name === 'ops_grep' && Array.isArray(value.matches)) {
    let changed = false
    const matches = value.matches.map((match) => {
      if (!match || typeof match !== 'object' || typeof match.path !== 'string' || match.path === '') return match
      const out = toMsys(match.path)
      if (out === match.path) return match
      changed = true
      return { ...match, path: out }
    })
    return changed ? { ...value, matches } : value
  }
  if ((name === 'ops_inspect_local_file' || name === 'ops_glob' || name === 'ops_replace') && Array.isArray(value.items)) {
    let changed = false
    const items = value.items.map((item) => {
      if (!item || typeof item !== 'object' || typeof item.path !== 'string' || item.path === '') return item
      const out = toMsys(item.path)
      if (out === item.path) return item
      changed = true
      return { ...item, path: out }
    })
    return changed ? { ...value, items } : value
  }
  if ((name === 'ops_batch' || name === 'ops_result') && typeof value.root === 'string' && value.root !== '') {
    const out = toMsys(value.root)
    if (out !== value.root) return { ...value, root: out }
    return value
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
// 'root' (v0.39.4): dsh-ops ops_batch/ops_result name their path argument `root`;
// no official tool uses that key, so the extra alias is collision-free.
const TRANSLATABLE_PATH_FIELDS = new Set(['file_path', 'path', 'workdir', 'root'])

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
export const GIT_MOUNTS = new Map([
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
  // v0.39.4 (dsh-ops 0.3.0): ops_batch carries its paths one level down —
  // operations[] objects with path/to, and protect[] as a plain string
  // array. Same deal as present's files[].path: the field-name whitelist
  // only sees top-level keys. The model speaks /c/ everywhere; these
  // arrive at the Rust worker as native absolute paths.
  if (Array.isArray(next.operations)) {
    const operations = next.operations.map((operation) => {
      if (!operation || typeof operation !== 'object') return operation
      let out = operation
      for (const field of ['path', 'to']) {
        if (typeof out[field] !== 'string') continue
        const translated = translateMsysPath(out[field], env)
        if (translated !== out[field]) out = { ...out, [field]: translated }
      }
      return out
    })
    if (operations.some((operation, index) => operation !== next.operations[index])) {
      next.operations = operations
      changed = true
    }
  }
  if (Array.isArray(next.protect)) {
    const protect = next.protect.map((entry) => {
      if (typeof entry !== 'string') return entry
      return translateMsysPath(entry, env)
    })
    if (protect.some((entry, index) => entry !== next.protect[index])) {
      next.protect = protect
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
// unterminated literal or a regex we cannot place — turns the whole rewrite
// into a no-op. Interpolated/tagged templates are skipped as data. A partial guess would
// be far worse than an untranslated one, and this layer never guesses.
//
// Deliberately NOT translated: shell-style '$VAR/x' (a JS literal is data, not
// a shell word) and anything carrying a scheme ('http://...').

/** Source text allowed inside a rewritten literal: no escapes, no dollar sign. */
const CODE_LITERAL_SAFE = /^[\p{L}\p{M}\p{N}._@+~#\-/ ]+$/u

/** Previous significant character that lets a '/' start a regex literal. */
function regexCanStart(previous) {
  if (previous === '') return true
  if (['return', 'throw', 'yield', 'await', 'case', 'delete', 'void', 'typeof', 'in', 'instanceof', 'of', 'else', 'do', 'break', 'continue', 'debugger'].includes(previous)) return true
  return previous.length === 1 && '(,=:[!&|?{;+-*%<>~^'.includes(previous)
}

/** A newline may end a declaration before a statement regexp; do not guess ASI. */
function ambiguousSlash(code, index, previous, previousEnd) {
  return previous === ')' || previous === '}'
    || (!regexCanStart(previous) && /[\r\n\u2028\u2029]/.test(code.slice(previousEnd, index)))
}

/** Read an identifier as ONE token: keyword-led regexes are not division. */
function codeWordAt(code, index) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(code.slice(index))?.[0]
}

/** Index after the closing quote of the literal at `index`, or -1. */
function skipQuotedLiteral(code, index) {
  const quote = code[index]
  let i = index + 1
  while (i < code.length) {
    const c = code[i]
    if (c === '\\') { i += 2; continue }
    if (/[\r\n\u2028\u2029]/.test(c)) return -1
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
    if (/[\r\n\u2028\u2029]/.test(c)) return -1
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
  let previousEnd = 0
  while (i < code.length) {
    const c = code[i]
    const next = code[i + 1]
    if (c === '/' && next === '/') {
      const lineEnd = /[\r\n\u2028\u2029]/.exec(code.slice(i))
      const nl = lineEnd ? i + lineEnd.index : -1
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
      previousEnd = i
      continue
    }
    if (c === '`') {
      const inner = skipTemplateLiteral(code, i)
      if (inner === null) return -1
      i = inner.end
      last = 'x'
      previousEnd = i
      continue
    }
    // A slash after a closing group may start a statement regex OR division.
    // Without a parser that distinction is uncertain: abort the WHOLE scan.
    if (c === '/' && ambiguousSlash(code, i, last, previousEnd)) return -1
    const word = codeWordAt(code, i)
    if (word) {
      last = last === '.' ? 'x' : word
      i += word.length
      previousEnd = i
      continue
    }
    if (c === '/' && regexCanStart(last)) {
      const end = skipRegexLiteral(code, i)
      if (end === -1) return -1
      i = end
      last = 'x'
      previousEnd = i
      continue
    }
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
    if (c.trim() !== '') { last = c; previousEnd = i + 1 }
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
  let previousEnd = 0
  while (i < code.length) {
    const c = code[i]
    const next = code[i + 1]
    if (c === '/' && next === '/') {
      const lineEnd = /[\r\n\u2028\u2029]/.exec(code.slice(i))
      const nl = lineEnd ? i + lineEnd.index : -1
      // A line comment may legally terminate at EOF (outside interpolation).
      if (nl === -1) break
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
      previousEnd = i
      continue
    }
    if (c === '`') {
      const template = skipTemplateLiteral(code, i)
      if (template === null) return null
      // A preceding expression can be a tag (String.raw, fn(), obj[key], ...).
      // Tags own raw/cooked semantics: never rewrite their template data.
      // Contextual words can also be identifiers/tags; skip rather than guess.
      if (template.plain && regexCanStart(last) && !['of', 'await', 'yield'].includes(last)) {
        spans.push({ start: i + 1, end: template.end - 1 })
      }
      i = template.end
      last = 'x'
      previousEnd = i
      continue
    }
    // A slash after a closing group may start a statement regex OR division.
    // Without a parser that distinction is uncertain: abort the WHOLE scan.
    if (c === '/' && ambiguousSlash(code, i, last, previousEnd)) return null
    const word = codeWordAt(code, i)
    if (word) {
      last = last === '.' ? 'x' : word
      i += word.length
      previousEnd = i
      continue
    }
    if (c === '/' && regexCanStart(last)) {
      const end = skipRegexLiteral(code, i)
      if (end === -1) return null
      i = end
      last = 'x'
      previousEnd = i
      continue
    }
    if (c.trim() !== '') { last = c; previousEnd = i + 1 }
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
    if (translated.indexOf(quote) >= 0) return code
    if (quote === '`' && translated.indexOf('${') >= 0) return code
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

const GLOB_META = /[*?\[\]{}]/

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
