/**
 * dsh-gitbash-shell — winget toolchain catalog (v0.30.0).
 *
 * The settings card can install and upgrade a FIXED catalog of terminal tools
 * through winget. Four properties are load-bearing and smoke-enforced:
 *
 *   1. THE SOURCE IS PINNED. Every argv carries `--source winget`, so a package
 *      can only come from Microsoft's official community repository
 *      (https://cdn.winget.microsoft.com/cache; manifests live in
 *      github.com/microsoft/winget-pkgs and are read into this file's
 *      `publisher` / `source` columns by hand). The Microsoft Store source is
 *      never consulted and a user-added third-party source can never be
 *      substituted for a catalog id.
 *   2. THE ID IS EXACT. Every argv carries `--exact`, so a catalog id resolves
 *      to that one manifest or to nothing — never to a fuzzy lookalike.
 *   3. THE CATALOG IS CLOSED. There is no free-text package input anywhere in
 *      the card: the only ids that can reach winget are the constants below.
 *      winget additionally verifies the SHA256 recorded in each manifest
 *      (all 22 entries carry one).
 *   4. PROVENANCE IS SHOWN, NOT ASSERTED. Each entry carries the manifest's
 *      Publisher field and the installer URL's host, and the card renders them,
 *      so the user can see where a package comes from instead of trusting a
 *      claim.
 *
 * `admin: true` marks the two entries whose manifests say `Scope: machine`
 * (winget must elevate, so Windows shows a UAC prompt the user has to accept —
 * the install blocks until they do). The card pre-checks only non-admin
 * entries and labels these two explicitly.
 *
 * Everything here is pure, and every filesystem/process fact arrives through
 * `io`, so the whole module is unit-testable off-Windows.
 */

/** The ONLY source any argv may name. */
export const WINGET_SOURCE = 'winget'

/** Shown to the user next to the source column. */
export const WINGET_SOURCE_NOTE = 'winget 官方源 · 包定义在 microsoft/winget-pkgs(微软审核) · 安装时校验 SHA256'

/** Arguments every winget call this plugin makes carries, in a fixed order. */
export const WINGET_COMMON_ARGS = [
  '--exact',
  '--source', WINGET_SOURCE,
  '--accept-package-agreements',
  '--accept-source-agreements',
  '--disable-interactivity',
]

/** Card sections, in render order. */
export const TOOL_GROUPS = ['base', 'cli', 'managed', 'admin']

/**
 * The closed catalog. `cmd` is the command the tool installs (the portable
 * alias winget creates in %LOCALAPPDATA%\Microsoft\WinGet\Links, which is
 * already on PATH on a machine that has ever used winget), and is what the
 * PATH scan looks for. `publisher` and `source` are transcribed from each
 * package's manifest in microsoft/winget-pkgs.
 */
export const TOOLCHAIN = [
  // ── base: commands Git for Windows does not ship ──────────────────────────
  { id: 'make', cmd: 'make', ids: ['ezwinports.make'], group: 'base', admin: false,
    publisher: 'ezwinports', source: 'downloads.sourceforge.net/project/ezwinports',
    note: 'Eli Zaretskii 维护的 GNU Make 官方 Windows 构建(33 位,64 位系统上正常运行)' },
  { id: 'wget', cmd: 'wget', ids: ['JernejSimoncic.Wget'], group: 'base', admin: false,
    publisher: 'Jernej Simoncic', source: 'eternallybored.org',
    note: 'GNU wget 官方认可的 Windows 构建站(GNU 官网链接至此)' },
  { id: 'yq', cmd: 'yq', ids: ['MikeFarah.yq'], group: 'base', admin: false,
    publisher: 'Mike Farah', source: 'github.com/mikefarah/yq' },
  { id: 'xtree', cmd: 'xtree', ids: ['Excelano.xtree'], group: 'base', admin: false,
    publisher: 'Excelano LLC', source: 'github.com/excelano/xfiles',
    note: '现代 tree 替代(命令名是 xtree);经典 tree 需要管理员,见下' },

  // ── cli: modern command-line tools Git Bash does not ship ─────────────────
  { id: 'bat', cmd: 'bat', ids: ['sharkdp.bat'], group: 'cli', admin: false,
    publisher: 'David Peter', source: 'github.com/sharkdp/bat' },
  { id: 'fzf', cmd: 'fzf', ids: ['junegunn.fzf'], group: 'cli', admin: false,
    publisher: 'Junegunn Choi', source: 'github.com/junegunn/fzf' },
  { id: 'delta', cmd: 'delta', ids: ['dandavison.delta'], group: 'cli', admin: false,
    publisher: 'Dan Davison', source: 'github.com/dandavison/delta' },
  { id: 'zoxide', cmd: 'zoxide', ids: ['ajeetdsouza.zoxide'], group: 'cli', admin: false,
    publisher: "Ajeet D'Souza", source: 'github.com/ajeetdsouza/zoxide' },
  { id: 'dust', cmd: 'dust', ids: ['bootandy.dust'], group: 'cli', admin: false,
    publisher: 'andy.boot', source: 'github.com/bootandy/dust' },
  { id: 'procs', cmd: 'procs', ids: ['dalance.procs'], group: 'cli', admin: false,
    publisher: 'dalance', source: 'github.com/dalance/procs' },
  { id: 'xh', cmd: 'xh', ids: ['ducaale.xh'], group: 'cli', admin: false,
    publisher: 'ducaale', source: 'github.com/ducaale/xh' },
  { id: 'just', cmd: 'just', ids: ['Casey.Just'], group: 'cli', admin: false,
    publisher: 'Casey Rodarmor', source: 'github.com/casey/just' },
  { id: 'shellcheck', cmd: 'shellcheck', ids: ['koalaman.shellcheck'], group: 'cli', admin: false,
    publisher: 'Vidar Holen', source: 'github.com/koalaman/shellcheck' },
  { id: 'hexyl', cmd: 'hexyl', ids: ['sharkdp.hexyl'], group: 'cli', admin: false,
    publisher: 'David Peter', source: 'github.com/sharkdp/hexyl' },
  { id: 'tldr', cmd: 'tldr', ids: ['dbrgn.tealdeer'], group: 'cli', admin: false,
    publisher: 'Danilo Bargen', source: 'github.com/tealdeer-rs/tealdeer' },
  { id: 'jj', cmd: 'jj', ids: ['jj-vcs.jj'], group: 'cli', admin: false,
    publisher: 'jj-vcs', source: 'github.com/jj-vcs/jj' },
  { id: 'gdu', cmd: 'gdu', ids: ['dundee.gdu'], group: 'cli', admin: false,
    publisher: 'Daniel Milde', source: 'github.com/dundee/gdu' },

  // ── managed: already present on many machines; here for version control ──
  { id: 'jq', cmd: 'jq', ids: ['jqlang.jq'], group: 'managed', admin: false,
    publisher: 'jqlang', source: 'github.com/jqlang/jq' },
  // MEASURED: this machine has BurntSushi.ripgrep.GNU installed (the link
  // target under WinGet/Packages names it), while the MSVC build is a SEPARATE
  // package id. Both count as "ripgrep is already here", or the card would
  // offer to install a second copy beside the existing one. The first id is
  // the one a fresh install uses.
  { id: 'rg', cmd: 'rg', ids: ['BurntSushi.ripgrep.MSVC', 'BurntSushi.ripgrep.GNU'], group: 'managed', admin: false,
    publisher: 'BurntSushi', source: 'github.com/BurntSushi/ripgrep' },
  { id: 'fd', cmd: 'fd', ids: ['sharkdp.fd'], group: 'managed', admin: false,
    publisher: 'David Peter', source: 'github.com/sharkdp/fd' },

  // ── admin: Scope: machine in the manifest ⇒ winget elevates ⇒ UAC ────────
  { id: '7zip', cmd: '7z', ids: ['7zip.7zip'], group: 'admin', admin: true,
    publisher: 'Igor Pavlov', source: 'www.7-zip.org',
    note: 'Igor Pavlov 官方站;安装器要求管理员,会弹 UAC' },
  { id: 'tree', cmd: 'tree', ids: ['GnuWin32.Tree'], group: 'admin', admin: true,
    publisher: 'GnuWin32', source: 'sourceforge.net/projects/gnuwin32',
    note: '经典 tree 命令;GnuWin32 项目 1.5.2.2(2003 年版),安装器要求管理员' },
]

/** One catalog entry by id, or undefined. */
export function toolById(id) {
  return TOOLCHAIN.find((tool) => tool.id === id)
}

/** Every entry whose group is in `groups` (unknown groups ignored). */
export function toolsInGroups(groups) {
  const wanted = new Set(Array.isArray(groups) ? groups : [])
  return TOOLCHAIN.filter((tool) => wanted.has(tool.group))
}

/**
 * `winget install` argv for one catalog entry (argv array — never a shell
 * string, and the id comes from the closed catalog, never from the request).
 * A fresh install always uses the entry's FIRST id; the extra ids exist only to
 * RECOGNIZE an existing install of a sibling build (see `rg`).
 * @param {{ids: string[]}} tool - catalog entry.
 * @returns {string[]}
 */
export function installArgv(tool) {
  return ['install', '--id', tool.ids[0], ...WINGET_COMMON_ARGS, '--silent']
}

/**
 * `winget upgrade` argv for one catalog entry. `installedId` is the id the
 * machine ACTUALLY has (from `winget export`), so upgrading a GNU-build ripgrep
 * upgrades that package rather than installing the MSVC one beside it.
 * Upgrading a current package is a no-op winget reports with its own exit code.
 * @param {{ids: string[]}} tool - catalog entry.
 * @param {string} [installedId] - the id winget reported as installed.
 * @returns {string[]}
 */
export function upgradeArgv(tool, installedId) {
  const id = typeof installedId === 'string' && installedId !== '' ? installedId : tool.ids[0]
  return ['upgrade', '--id', id, ...WINGET_COMMON_ARGS, '--silent']
}

/** `winget list --upgrade-available` argv (one call covers the whole catalog). */
export function listUpgradableArgv() {
  return ['list', '--upgrade-available', '--source', WINGET_SOURCE, '--accept-source-agreements', '--disable-interactivity']
}

/**
 * `winget export` argv. THE authoritative inventory: it is JSON (immune to the
 * localized, column-truncating tables `list` prints), it carries the exact
 * package id the machine has, and `--include-versions` adds the installed
 * version. `outputPath` must be a WINDOWS path — winget is a native binary and
 * cannot open an MSYS `/tmp/...` spelling (measured).
 * @param {string} outputPath - absolute Windows path for the JSON file.
 * @returns {string[]}
 */
export function exportArgv(outputPath) {
  return ['export', '-o', outputPath, '--include-versions', '--source', WINGET_SOURCE, '--accept-source-agreements', '--disable-interactivity']
}

/** `winget --version` argv — the availability probe. */
export function wingetVersionArgv() {
  return ['--version']
}

/**
 * Read winget's own inventory JSON. Only the `winget` source is considered, so
 * a package the user installed from the Microsoft Store can never make this
 * plugin believe the community-repo package is present.
 * @param {string} text - the file `winget export` wrote.
 * @param {Array} [tools] - catalog entries (defaults to all).
 * @returns {Map<string, { pkgId: string, version: string }>} catalog id → what winget has.
 */
export function parseExportJson(text, tools) {
  const list = Array.isArray(tools) ? tools : TOOLCHAIN
  const found = new Map()
  let json
  try { json = JSON.parse(typeof text === 'string' ? text : '') } catch { return found }
  const sources = json && Array.isArray(json.Sources) ? json.Sources : []
  const byId = new Map()
  for (const source of sources) {
    const name = source && source.SourceDetails && source.SourceDetails.Name
    if (name !== WINGET_SOURCE) continue
    for (const pkg of Array.isArray(source.Packages) ? source.Packages : []) {
      const id = pkg && typeof pkg.PackageIdentifier === 'string' ? pkg.PackageIdentifier : ''
      if (id === '') continue
      byId.set(id.toLowerCase(), { pkgId: id, version: typeof pkg.Version === 'string' ? pkg.Version : '' })
    }
  }
  for (const tool of list) {
    for (const id of tool.ids) {
      const hit = byId.get(id.toLowerCase())
      if (hit) { found.set(tool.id, hit); break }
    }
  }
  return found
}

/**
 * Which catalog commands the machine already has, and WHERE they came from.
 * One `readdir` per PATH directory (not one `exists` per tool × directory ×
 * extension), and every unreadable directory is skipped rather than fatal.
 * First PATH hit wins, which is the same precedence the shell itself applies.
 * @param {{pathDirs: () => string[], readdir: (dir: string) => string[]}} io
 * @param {Array} tools - catalog entries to look for.
 * @returns {Map<string, string>} cmd → the first resolving full path.
 */
export function scanCommands(io, tools) {
  const list = Array.isArray(tools) ? tools : TOOLCHAIN
  // "make.exe" / "make.cmd" / "make" all resolve the command `make`.
  const wanted = new Map(list.map((tool) => [String(tool.cmd).toLowerCase(), tool.cmd]))
  const found = new Map()
  let dirs
  try { dirs = io.pathDirs() } catch { return found }
  for (const dir of Array.isArray(dirs) ? dirs : []) {
    if (typeof dir !== 'string' || dir === '') continue
    let entries
    try { entries = io.readdir(dir) } catch { continue }
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (typeof entry !== 'string') continue
      const base = entry.replace(/\.[^./\\]+$/, '').toLowerCase()
      const cmd = wanted.get(base)
      if (cmd !== undefined && !found.has(cmd)) {
        found.set(cmd, dir.replace(/[\\/]+$/, '') + '\\' + entry)
      }
    }
  }
  return found
}

/**
 * Which detected command paths winget itself owns. winget's portable installs
 * are shimmed into `%LOCALAPPDATA%\Microsoft\WinGet\Links` (the link directory
 * winget reports in `--info`), so a path under it is proof winget put the
 * command there; anything else (LLVM, WinLibs, Visual Studio, a system copy)
 * is somebody else's toolchain.
 * @param {string} commandPath - full path of a resolving command.
 * @returns {boolean}
 */
export function isWingetOwnedPath(commandPath) {
  const path = String(commandPath || '').replace(/\\/g, '/').toLowerCase()
  if (path === '') return false
  return path.includes('/microsoft/winget/links/') || path.includes('/winget/packages/')
}

/**
 * A short label for who provides a command, for the card's "provided by"
 * column. Purely cosmetic — it never changes a decision.
 * @param {string} commandPath - full path of a resolving command.
 * @returns {string} provider label ('' when the path says nothing).
 */
export function describeProvider(commandPath) {
  const path = String(commandPath || '').replace(/\\/g, '/')
  if (path === '') return ''
  const lower = path.toLowerCase()
  if (lower.includes('/microsoft/winget/links/')) return 'winget'
  if (lower.includes('/winlibs/')) return 'WinLibs'
  if (/(^|\/)llvm(\/|$)/.test(lower)) return 'LLVM'
  if (lower.includes('/visual studio/')) return 'Visual Studio'
  if (lower.includes('/git/')) return 'Git for Windows'
  if (lower.includes('/windowsapps/')) return 'Windows'
  if (/^[a-z]:\/(windows|program files)/.test(lower)) return 'system'
  // Last resort: the parent directory name, which is what the user recognizes.
  const parts = path.split('/').filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 2] : ''
}

/**
 * The four states a catalog row can be in. THE RULE THAT MATTERS: a command
 * provided by somebody else's toolchain is `external`, which means this plugin
 * neither installs nor upgrades it — a machine whose `make` came from WinLibs
 * or whose LLVM ships its own copy must not end up with a second make, and an
 * upgrade must never touch a toolchain winget does not own.
 * @param {{ hasCommand: boolean, wingetOwned: boolean, upgradable: boolean }} facts
 * @returns {'missing'|'external'|'managed'|'current'}
 */
export function classifyToolState(facts) {
  const hasCommand = !!(facts && facts.hasCommand)
  const wingetOwned = !!(facts && facts.wingetOwned)
  const upgradable = !!(facts && facts.upgradable)
  // winget's own inventory is checked FIRST: MEASURED, this machine has 7-Zip
  // installed by winget while `7z` is not on PATH at all (the MSI does not add
  // its directory). Deciding by command presence would call that "missing" and
  // offer to install a package that is already there.
  if (wingetOwned) return upgradable ? 'managed' : 'current'
  if (hasCommand) return 'external'
  return 'missing'
}

/** The rows a "check all" click selects: only what is genuinely absent. */
export function isActionable(state) {
  return state === 'missing' || state === 'managed'
}

/**
 * Which catalog packages winget reports as having an upgrade available. The
 * output is a LOCALIZED table whose ID column can be narrow, so this only runs
 * for ids winget's export already proved it owns (see `parseExportJson`), where
 * a miss is harmless. Every id variant of an entry is checked.
 * @param {string} output - raw stdout+stderr of `winget list --upgrade-available`.
 * @param {Array} [tools] - catalog entries (defaults to all).
 * @returns {Set<string>} catalog ids with an available upgrade.
 */
export function parseUpgradable(output, tools) {
  const list = Array.isArray(tools) ? tools : TOOLCHAIN
  const text = typeof output === 'string' ? output : ''
  const found = new Set()
  for (const tool of list) {
    if (tool.ids.some((id) => text.includes(id))) found.add(tool.id)
  }
  return found
}

/**
 * `winget list --id <missing> -e` exit code, MEASURED on this machine
 * (winget 1.29.380): Node reports the full HRESULT 0x8A150014 = 2316632084,
 * while a POSIX shell shows only its low byte (20). `isNoMatchExit` accepts
 * both spellings so the verdict does not depend on which layer reports it.
 */
export const WINGET_NO_MATCH_EXIT = 0x8A150014

/** True when an exit code means "no installed package matches this id". */
export function isNoMatchExit(code) {
  const value = Number(code)
  if (!Number.isFinite(value)) return false
  return value === WINGET_NO_MATCH_EXIT || (value & 0xFF) === (WINGET_NO_MATCH_EXIT & 0xFF)
}

/**
 * `winget upgrade --id <current> -e` exit code, MEASURED in the same session
 * (winget 1.29.380): winget reports "there is nothing newer" as a NON-ZERO exit
 * and prints 找不到可用的升级 / "No applicable upgrade found". On a machine that
 * is already current that is the NORMAL outcome of an upgrade round, so it must
 * never surface as a failure — otherwise every healthy box cries wolf. Low byte
 * is 0x2B, distinct from the no-match 0x14, so the two cannot collide.
 */
export const WINGET_NO_UPGRADE_EXIT = 0x8A15002B

/** True when an exit code means "this package is already current". */
export function isNoUpgradeExit(code) {
  const value = Number(code)
  if (!Number.isFinite(value)) return false
  return value === WINGET_NO_UPGRADE_EXIT || (value & 0xFF) === (WINGET_NO_UPGRADE_EXIT & 0xFF)
}

/**
 * Turn one winget run into a verdict the card can render. Kept deliberately
 * small: a wrong "succeeded" is the only outcome that must never happen, so an
 * unrecognized non-zero exit stays `failed` with winget's own text attached.
 * @param {number} code - process exit code.
 * @param {string} output - raw stdout+stderr.
 * @returns {{ ok: boolean, kind: string, detail: string }}
 */
export function classifyWingetResult(code, output) {
  const text = typeof output === 'string' ? output : ''
  const lower = text.toLowerCase()
  const detail = text.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' · ').slice(0, 600)
  if (code === 0) return { ok: true, kind: 'ok', detail }
  // The two MEASURED no-ops come FIRST and structurally, never by localized
  // wording: both exits are non-zero yet mean "nothing to do" — which is
  // exactly what a healthy, fully current machine reports.
  if (isNoUpgradeExit(code)) return { ok: false, kind: 'up-to-date', detail }
  if (isNoMatchExit(code)) return { ok: false, kind: 'not-found', detail }
  // Elevation declined / impossible: the machine's UAC prompt was dismissed, or
  // the call ran where no interactive user could accept it.
  if (/0x80070005|access is denied|拒绝访问|elevat|管理员|uac|0x80073d02/i.test(text)) {
    return { ok: false, kind: 'needs-admin', detail }
  }
  // The same verdicts again for wording without the codes (another winget build).
  if (/no applicable upgrade|没有可用的升级|找不到可用的升级|already installed|已安装/i.test(text)) {
    return { ok: false, kind: 'up-to-date', detail }
  }
  if (/no package found|找不到与输入条件匹配|未找到与输入/i.test(text)) {
    return { ok: false, kind: 'not-found', detail }
  }
  if (/0x80072|0x80072ee2|timed out|超时|网络|network|failed to download|下载失败|0x8a15005e/i.test(lower)) {
    return { ok: false, kind: 'network', detail }
  }
  return { ok: false, kind: 'failed', detail }
}

/**
 * Whether winget itself is usable on this machine: the executable has to
 * resolve AND answer `--version` (an App Execution Alias that exists but whose
 * package was removed answers with an error, and that must not be reported as
 * "winget available").
 * @param {{ run: (file: string, args: string[]) => { code: number, output: string } }} io
 * @returns {{ ok: boolean, version: string }}
 */
export function probeWinget(io) {
  try {
    const result = io.run('winget', wingetVersionArgv())
    const text = String(result && result.output ? result.output : '')
    const match = text.match(/v?(\d+\.\d+\.\d+)/)
    if (result && result.code === 0 && match) return { ok: true, version: match[1] }
    return { ok: false, version: '' }
  } catch {
    return { ok: false, version: '' }
  }
}
