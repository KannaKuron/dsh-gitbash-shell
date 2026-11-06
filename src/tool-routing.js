/**
 * The routing addendum appended to the `bash` tool's description in the owned tool definition. TWO variants (v0.37.0, user decision):
 * the pwsh tool is hidden by default, and a routing sentence that names a tool
 * the agent cannot see only teaches the model to call a hidden name. The ON
 * variant names `pwsh` (the REAL PowerShell tool, real again since route B —
 * the official executor stays in place); the OFF variant states bash-only
 * routing. Both hold regardless of the path dialect a delegate sees.
 */
export const GITBASH_ROUTE_ADDENDUM = [
  'Prefer this bash tool for shell syntax, scripts, pipelines, redirection, globbing and POSIX utilities; use the pwsh tool ONLY when PowerShell cmdlets, registry, services or WMI are truly required.',
  'Fix failed bash syntax in bash; never embed `pwsh -Command` inside a bash command as a workaround (variable expansion and output encoding break there). Choose a separately offered native route for its documented purpose before execution, never as a policy-denial retry.',
].join('\n')

/** The bash-only routing variant, used while the pwsh switch is off (the default). */
export const GITBASH_ROUTE_ADDENDUM_NO_PWSH = [
  'Prefer this bash tool for shell syntax, scripts, pipelines, redirection, globbing and POSIX utilities — it is this host\'s shell.',
  'Fix failed bash syntax in bash; no PowerShell tool is offered here. Do not invent a hidden tool or embed another interpreter as a workaround.',
].join('\n')

/**
 * The dialect addendum (MSYS facts) — appended ONLY while this plugin's path
 * dialect is on for the assembling agent, because it describes the /c/ world
 * the dialect creates.
 */
export const GITBASH_MSYS_ADDENDUM = 'This bash is Git for Windows (MSYS): paths use drive roots (/c/Users/...), and ~, /tmp, /dev/null and /usr/... resolve exactly as Git Bash resolves them.'

const ROUTING_START = '\n[gitbash tool routing]\n'
const ROUTING_END = '\n[/gitbash tool routing]'
const ROUTING_SAFETY = 'Choose the execution route before running. A policy/access denial is a stop condition: never switch tools, shells or permissions to bypass it. A decoding/display failure does not mean the command failed to run; preserve its exit facts and never blindly repeat a side-effecting command. Do not guess unknown or mixed encodings.'
export const PTC_ROUTING = 'Inside run_code, call only bindings actually offered by the current SDK with await tools.<name>(...). Select by their descriptions: shell execution for shell syntax/pipelines; an offered typed native-executable binding for exact Windows argv or explicitly known per-stream encodings; an offered complete-path conversion binding before passing an MSYS value to Node fs/path. These are different operations, not substitutes for permissions. Never pass routes, search text or source code to a path converter. Program strings do not perform shell expansion. If a needed binding is absent, report the missing capability; do not invent its name. ' + ROUTING_SAFETY

/** Model guidance names only tools in this assembly, not a switch's intent. */
export function toolRoutingHintFor(tools, { pwshVisible = false, terminalGitBash = false } = {}) {
  const names = new Set((Array.isArray(tools) ? tools : []).map(tool => tool?.name))
  if (!names.has('bash')) return ''
  const lines = [pwshVisible && names.has('pwsh') ? GITBASH_ROUTE_ADDENDUM : GITBASH_ROUTE_ADDENDUM_NO_PWSH]
  // v0.41.0: the persistent-terminal dialect fact. Said ONLY when the host
  // actually carries the terminal tools AND our terminal-bundle adoption has
  // settled the rows to Git Bash (the caller passes the settled flag) - a
  // bundle left at its official defaults runs pwsh there, and a sentence
  // must never describe a shell the button will not start.
  if (terminalGitBash === true && names.has('terminal_open')) lines.push('The persistent terminal tools (terminal_open/read/send/...) run Git Bash (MSYS) on this host: the same drive-root paths (/c/...) and MINGW64 semantics as this bash tool; they are NOT PowerShell.')
  if (names.has('gitbash_native')) lines.push('Use gitbash_native before execution when a Windows .exe needs exact literal argv such as /all or /c without MSYS conversion, or independently declared stdout/stderr encodings. Supply an absolute executable, mark each argument literal or path, and select only a known encoding (raw for unknown/mixed bytes). It does not implement shell pipelines, expansion or .cmd/.bat wrappers; only resolved danger-full-access can execute it.')
  if (names.has('gitbash_to_native_path')) lines.push('Use gitbash_to_native_path only for a complete caller-declared MSYS filesystem path that a native Node fs/path API needs, especially a runtime-built value. Read native_path from the result. Never convert routes, search strings or shell/program source. Already-native or cwd-relative Node paths need no conversion; ordinary tool path fields already use their own translation. Conversion grants no access.')
  lines.push(ROUTING_SAFETY)
  return lines.join('\n')
}

/** Add a replaceable, idempotent block; a reused assembly follows visibility. */
export function applyToolRouting(tools, { pwshVisible = false, msys = false, terminalGitBash = false } = {}) {
  if (!Array.isArray(tools)) return
  for (const tool of tools) {
    if (!tool || typeof tool.description !== 'string' || !['bash', 'run_code'].includes(tool.name)) continue
    let description = tool.description
    const start = description.indexOf(ROUTING_START)
    const end = start < 0 ? -1 : description.indexOf(ROUTING_END, start)
    if (end >= 0) description = description.slice(0, start) + description.slice(end + ROUTING_END.length)
    const hint = tool.name === 'bash'
      ? toolRoutingHintFor(tools, { pwshVisible, terminalGitBash }) + (msys ? '\n' + GITBASH_MSYS_ADDENDUM : '')
      : PTC_ROUTING
    tool.description = description + ROUTING_START + hint + ROUTING_END
  }
}

