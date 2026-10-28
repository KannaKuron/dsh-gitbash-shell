# dsh-gitbash-shell

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[简体中文](README.md) | English

> **Experimental implementation discussion / Unreleased:** the fail-closed behaviour and two explicit tools below have not been officially released and are not a release candidate. Public npm installation does not guarantee these changes. See the [design, interfaces and open decisions](<docs/experimental-native-execution.md>), [verification matrix and reproduction](<docs/experimental-native-verification.md>) and Unreleased CHANGELOG.

> Run **agent commands on Git Bash by default** on Windows with DeepSeek
> Harness (dsh) — the plugin does NOT replace the host executor (the official
> PowerShell executor stays untouched): it adds its own `bash` tool running
> on a PRIVATE Git Bash executor instance, gives the four OFFICIAL presets
> Git Bash through a per-agent inline tool patch (v0.35.0), keeps the
> official `pwsh` tool (REAL PowerShell) hidden behind a switch (`pwshTool`,
> off by default), keeps the `gb_*` FastCtx file tools behind a switch
> (`fastctxTools`, off by default since v0.39.4 — dsh-ops 0.3.0's native
> `ops_*` tools superseded FastCtx), and keeps the four `· Git Bash` variant
> presets behind a switch (`variantPresets`, off by default).

### Host requirement & preset alignment

Since v0.32.0 the host floor is **dsh >= 0.1.7-rc** (declared through the
`@deepseek-ai/dsh` peer, prereleases included; older hosts are no longer
supported). The four variants are committed JS row sets in
`src/compositions.js`, mirroring the official 0.1.7 standard/minimal/ptc/cordis
split plus the Git Bash delta; upgrade alignment is locked by the smoke test
`compositions: full variants mirror the official row split`. **Preset ids
never change** (`code-gitbash` kept its historical id when dsh 0.1.2 renamed
the built-in `code` to `ptc` — sessions are pinned to ids, and a rename would
orphan them).

## Install (public npm package)

```sh
dsh plugin --profile web add dsh-gitbash-shell
```

`dsh plugin add` installs the dependency via pnpm and, seeing the
`dsh.bundle` declaration, appends the package to `dsh.profile.bundles`.
**Restart the profile's host to activate.**

## What it does

The bundle patch (`cordis.patch.yml`) is ADDITIVE ONLY (v0.39.0): it inserts
this plugin's row (`gitbash-shell`) and nothing else — no official row is
disabled or replaced, and the host's own PowerShell executor keeps its place.
The old "replace the executor" three-step patch became runtime work:

1. **`pwsh-sandbox` is NOT withdrawn and no executor row is inserted**: the
   plugin no longer replaces the host executor, so the official `pwsh` tool
   is REAL PowerShell again;
2. **the own bash tool runs on a PRIVATE executor instance**
   (`src/bash-tool.js` + `src/shell.js`): `GitBashSandboxExecutor` — a
   subclass of the shipped `@deepseek-ai/dsh-bash-sandbox` whose inner argv
   is `<git-bash.exe> -c <command>` — is constructed in a private cordis
   scope and is NEVER registered as the `ctx.shell` service (sandbox policy,
   denial classification, background jobs, and settings behavior all
   inherited; **one Windows exception for confined modes — see the next
   section**);
3. **the `gitbash-shell` row**. **v0.35.0 dual form** — by default
   (`variantPresets: false`) it registers NO variants: the inline tool patch
   (`src/inline-tools.js`) registers the own bash tool per agent whenever the
   tool face says "pwsh yes / bash no"; the official `pwsh` tool (REAL
   PowerShell) stays hidden behind the `pwshTool` switch (off by default);
   the `gb_*`
   FastCtx tools (`src/fastctx-bridge.js`) publish alongside — **retired to
   an explicit opt-in from v0.39.4** (dsh-ops 0.3.0 replaced FastCtx with
   native `ops_*` file tools; when dsh-ops is present the bridge stands down
   regardless, and this plugin keeps the `/c/` dialect unified across both
   tool families by translating `ops_*` arguments and echoing their results
   and errors back in MSYS form). With the switch on, it registers the four
   preset variants **declaratively** (`ctx.agentPresets.register`,
   v0.32.0+) — the row sets are committed, diffable JS data
   (`src/compositions.js`) and **no directory is ever materialized**;
   materialized trees left by older versions are cleaned one-way at boot
   only when the marker proves the user never edited them (the cleanup
   ignores the switch).

Environment: `bash.exe` is a direct child of the host's managed subprocess provider, not a login launcher. Parent environment values pass through credential scrubbing before the protected `DSH_*` overlay; this does not expose an unfiltered host environment.

### Upgrading from 0.34.x

The variants are OFF by default. **The deployment default preset migrates
automatically**: if you had set a variant (`*-gitbash`) as the default, the
first boot after upgrading switches it to the official successor through the
official settings seam (`standard-gitbash→standard`, `minimal-gitbash→minimal`,
`code-gitbash→ptc`, `cordis-gitbash→cordis`) — idempotent, roster-checked
before writing, and verified by read-back; with `variantPresets` ON nothing
migrates. **Pinned SESSIONS cannot be migrated** (the official
`agent-preset/locked` rule blocks a mid-session switch) — open a new session;
to bring old sessions back as-is, turn `variantPresets` on.

## Security semantics: confined modes on Windows

**POSIX hosts:** the executor's restricted path still inherits the official backend and denial classification. This section concerns Windows.

**Unreleased Windows bash/native tools fail closed while experimentalNative is ON (default):** read-only, workspace-write or unresolved policy is refused before execution. Only an actually resolved danger-full-access call may run. Restricted requests never admit/start an unconfined process, automatically switch permissions/interpreters, or bypass file-tool denials. This changes the old labelled-bypass behaviour.

- **Refusal is not restored confinement.** No verified confined Git Bash is provided. Historical failures were Win32 error 5 / 0xC0000142. The matched modern MSYS signal pipe uses an explicit SD without a restricting SID; cygheap uses VirtualAlloc, and Core already supplements TokenDefaultDacl. Neither a default-DACL-only fix nor permanent impossibility is established; IPC/OS solutions still require isolated-environment validation.
- **Per-call authority:** a full-access deployment default cannot widen a read-only session. Native preparation, async boundaries and the spawn seam recheck authority. Cancellation, owner disposal and direct kill mark output incomplete instead of claiming natural success.
- **Separate file policy:** official file tools retain their own checks; reads are not necessarily workspace-only. The path helper only converts strings: no existence check or permission grant. A refusal never authorizes another-tool workaround.
- **Scope:** this gate covers this plugin's own bash/native tools. Sidebar interactive terminals, minimal's persistent PTY and other plugins' executors do not acquire confinement from it. The official root PowerShell executor stays untouched.

Historical unconfined records/rendering remain readable; only the user’s explicit experimentalNative opt-out restores the legacy route. See CHANGELOG v0.13.2 for history and Unreleased for current behaviour/tests.

## Explicit tools (Unreleased)

**Runtime switch `experimentalNative` (default true):** Settings > Plugins > dsh-gitbash-shell > Experimental native execution / fail-closed. ON refuses restricted/unresolved Windows Bash and offers available companions. OFF immediately unregisters/disables both tools and restores legacy explicitly `unconfined` Bash, which does not enforce shell file-write restrictions. Changes affect subsequent calls in existing sessions without restart; already running jobs continue. Refusals also guide the user to select `danger-full-access` in the session access-mode control; agents must not relax permissions automatically. This switch is independent of path dialect/codePaths.

Both companions join the Windows own-bash agent scope without replacing official tools/root providers. Existing names are not overwritten. Missing public native executor/OutputCollector capability skips native without breaking bash/path; minimal's persistent terminal does not use this inline patch.

- **gitbash_to_native_path**: `{ msys_path: completeValue } → { native_path }`, using fresh shared mount facts. Native Windows/cwd-relative values may pass through; unknown MSYS roots/missing facts, URLs, empty/NUL values reject. Independent of automatic dialect/codePaths switches, with no filesystem access or permission grant.
- **gitbash_native**: description, absolute `executable: {kind:'path',value}`, `argv: [{kind:'literal'|'path',value}]`, optional absolute typed cwd. Literals avoid MSYS conversion; only declared paths translate/normalize. No bare command, model env, implicit scripts, .cmd/.bat or escalation. Known interpreters require explicit `entrypoint:'interpreter'`; this is not executable attestation or a guarantee about arbitrary cmd/non-CRT parsers.
- Independent stdoutEncoding/stderrEncoding: utf8 (default), gbk, utf16le or raw; errors defaults to replace, strict is opt-in. Unknown mixed bytes require raw rather than guessing. Decoding/storage failures retain actual exit facts; never blindly rerun side effects because display failed.
- Existing Jobs supports background/promotion when its controller is attached. Missing capability rejects rather than ignoring fields. Without Jobs, foreground uses a kill deadline; preparation also has bounded cancellation. Owner disposal/direct kill marks interrupted output.
- Host-owned temporary artifacts, not model cwd: default 8MiB combined raw+decoded disk cap and 16MiB adapter-owned payload budget, not OS/RSS or cross-task hard quotas. Completed files remain readable; no automatic purge is promised. sourceComplete, pipeline complete, tail lossy and artifact.complete are distinct facts.

**Agent routing:** descriptions distinguish shell syntax/pipelines/redirection/POSIX scripts (bash), exact native .exe argv/known per-stream encoding (offered gitbash_native), complete MSYS runtime values before Node I/O (offered gitbash_to_native_path), and genuine cmdlets/services/WMI (offered, enabled pwsh). Guidance follows actual visibility and replaces its own block on reassembly. Permission denial means stop, not another-tool/mode retry; display failure never authorizes blindly repeating side effects.

PTC directly calls only run_code; invoke the offered `tools.gitbash_to_native_path`/`tools.gitbash_native` inside it. The run_code description explains SDK selection without inventing absent names, while binding descriptions explain their purpose. Actual Core native/PTC prompt delivery is tested; autonomous LLM selection has not been tested or guaranteed. Given an already obtained complete inputPath:

```typescript
const resolved = await tools.gitbash_to_native_path({ msys_path: inputPath });
const fs = await import('node:fs/promises');
return await fs.readFile(resolved.native_path, 'utf8');
```

For route/search strings that resemble paths, choose codePaths:false to avoid legacy guessing; typed tool argument translation still works.

## Native Windows and run_code compatibility boundaries

The tool description always warns about these argument, encoding and security
boundaries, independently of the path-dialect switch. The plugin does not
silently rewrite command source, globally disable argument conversion or guess
output encodings.

- **Slash options**: MSYS can treat native Windows `/all` and `/c` as paths.
  Tested alternatives are `ipconfig //all`, `cmd //c`, or a per-command
  `MSYS2_ARG_CONV_EXCL='/all' ipconfig /all`. Exclusions match prefixes: excluding
  `/c` also excludes `/c/...` file paths, so explicitly use native drive-letter
  paths for those arguments. Do not set `MSYS2_ARG_CONV_EXCL='*'` globally.
  A converted `cmd /c` may exit0 without performing the intended action; verify
  the expected effect, not only the exit code.
- **Output encodings**: the host decodes UTF-8. Native programs may emit CP936/GBK
  or another code page. Prefer a program's UTF-8 option, or explicitly convert
  known-encoding bytes before capture while preserving the original exit state.
  Locale variables do not guarantee native UTF-8. Do not decode all Bash output
  as GBK or infer encoding from replacement-character counts: one call can mix
  UTF-8 and GBK, and an already-corrupted string cannot recover the original bytes.
- **run_code**: `codePaths` defaults ON and follows the total/delegate dialect
  gates. Complete compatible plain path literals are rewritten best-effort with
  the shared mount table, including Unicode letters/marks, spaces and `#` names.
  Legal EOF line comments no longer prevent rewriting; tagged templates (such
  as String.raw) retain their data and raw semantics. Interpolation, escapes,
  uncertain regex/division syntax may remain unchanged; uncertainty abandons the
  entire rewrite. Prefer native drive-letter or cwd-relative paths for direct
  Node fs/path APIs; typed tool path arguments remain translated separately.
  Lexical scanning cannot distinguish routes/search data/shell command strings
  from paths. Do not rely on rewriting those values; disable `codePaths` when
  needed (the model hint now accurately states OFF).
- **Security**: Unreleased refuses restricted calls before execution while experimentalNative is ON; this is not restored confinement. A file-tool policy denial never authorizes a shell/native retry.

## Config

The `gitbash-shell` row (its id has matched the settings namespace since v0.24.0; it was
`gitbash-presets` through v0.23.0) takes the materialized `presets` list and the cooperation
switch:

```yaml
- id: gitbash-shell
  config:
    presets: [standard-gitbash, minimal-gitbash]   # all four by default
    suppressPeerCordis: false                       # dedupe against dsh-ptc-cordis-preset, off by default
```

`suppressPeerCordis` (boolean, **off by default**) drops `创造模式 · Git Bash` (`cordis-gitbash`)
from the roster only while two facts hold **at the same time**: the switch is `true` **and**
dsh-ptc-cordis-preset reports that its `PTC 创造模式` is the Git Bash variant. Off by default means
the four-variant roster of 0.24.x is unchanged; see
[Cooperation with dsh-ptc-cordis-preset](#cooperation-with-dsh-ptc-cordis-preset) for the decision
rule, the timing, and how both sides share one state.

Own-bash-tool config: `bashPath` lives on the settings card (= the `bashPath`
field of the `gitbash-shell` row config); a pre-v0.39 legacy profile's
`gitbash-executor` row config is still read first (compatibility):

```yaml
- id: gitbash-shell
  config:
    bashPath: "D:/Tools/Git/bin/bash.exe"   # default '' (empty) = automatic chain
```

The automatic chain (empty `bashPath`) probes, in order: explicit settings → default
install locations → PATH → `git.exe` reverse lookup → `git --exec-path` (covers
Scoop/choco shim layouts and the `ucrt64` runtime, v0.33.0) + the GitForWindows
registry `InstallPath` → the registry `Path`. Resolution is re-read live per
consumer (never frozen at boot, v0.33.0), and only Git for Windows' own bash
counts — WSL / MSYS2 / Cygwin are refused with guidance, never substituted.

### Bash init script: `initScript` (empty = off, v0.45.0, issue #37)

```yaml
- id: gitbash-shell
  config:
    initScript: "~/.dsh/bash-env.sh"   # default ""; point it at a script
```

When set, every bash command this plugin runs gets it as `BASH_ENV` — bash's own hook
for **non-interactive** shells, so `bash -c` sources it first with none of `-l`'s side
effects (no `cd $HOME`, no PATH reordering, no profile output in stdout). The reported
use case is fnm / nvm-style node managers: put `eval "$(fnm env)"` in that file and
`node` / `npm` become visible to every tool call.

Two boundaries: whatever the script prints lands in the command's output (do not `echo`
in it), and the file must exist — bash silently ignores a missing `BASH_ENV`, so a typo
behaves exactly like "not set". `~` expands to the home directory.

## Cooperation with dsh-ops: one bash per face (v0.42.0; rows follow 0.4.3)

The host cannot turn "visible but denied" into "hidden": `tools.restrict` filters
only the inherited surface, while dsh-ops registers `ops_bash` in each agent's
OWN layer. So this plugin drives dsh-ops's own `publishBashTool` switch instead —
`false`, through the official `configEditor` channel — and `ops_bash` stops
being registered at all. dsh-ops keeps its pwsh7 overlay, file tools and
background jobs (`publishBashTool` gates `mountSessionBash` only).

**dsh-ops 0.4.3 replaced the component roster with preset-mode rows.** The
switch used to live on the single `dsh-ops-shell` row; today four rows carry it —
`dsh-ops-mode-minimal`, `-standard`, `-ptc`, `-cordis` — and every one of them
plans a Windows shell (`MODE_PLANS[*].shell`), so every one can publish
`ops_bash`. v0.46.0 walks the whole set: the legacy row when an older dsh-ops is
mounted, the four mode rows on 0.4.3+, and a mixed profile handles whichever
rows are actually mounted. Disabling or uninstalling this plugin lifts the
override again (dispose hook) and leaves every unrelated setting in the same row
untouched.

Two edges: (1) an override left behind by uninstalling while dsh was shut down
is one click away from gone — dsh-ops's own settings card offers "restore
defaults" for each row; (2) dsh-ops 0.4.3+ also gates its tools on the agent's
preset id and knows only the four official ones — this plugin's `ptc-cordis`
preset and the `· Git Bash` variant ids match no mode, so dsh-ops publishes
nothing there (and hides nothing either): our bash is the only command tool.

## Cooperation with dsh-ptc-cordis-preset

This plugin publishes a `gitBash` host capability (`{ active, bashPath }`,
active only on Windows). [dsh-ptc-cordis-preset](https://github.com/KannaKuron/dsh-ptc-cordis-preset)
v0.5.0+ detects it while materializing `PTC 创造模式`: with both installed,
the PTC preset is materialized as Git Bash automatically (tool-bash on,
tool-pwsh off) — no extra mode, no manual edits. Without this plugin the PTC
preset stays as its own plugin manages it.

### Dedupe switch: `suppressPeerCordis` (off by default, v0.25.0)

Once the cooperation is active, `创造模式 · Git Bash` (this plugin's `cordis-gitbash`) and the
peer's Git Bash-materialized `PTC 创造模式` describe the same mode, and with both plugins installed
they are listed side by side by default. Turning on `suppressPeerCordis` in this plugin's row
Config is what retires this plugin's variant (request and tradeoffs:
[issue #7](https://github.com/KannaKuron/dsh-gitbash-shell/issues/7)).

**Two facts must BOTH hold — neither alone is enough:**

- the switch is `true`;
- and the peer reports `gitBashActive: true` through the `ptcCordisPreset` host capability (that
  is, its `PTC 创造模式` really is the Git Bash variant).

A peer that is **absent / not mounted yet / not active / older than 0.14.0** ⇒ nothing is dropped:
we would rather show one extra roster entry than cost the user a mode because the peer could not be
seen. The switch is off by default, so nothing changes unless you ask for it.

**When it takes effect:**

- **New hosts (dsh ≥ 0.1.7) — live**: the switch rides the row Config's volatile channel and the
  peer capability is watched through `ctx.inject(['ptcCordisPreset'])` (**independent of plugin row
  activation order**); either change reconciles on the spot — retiring logs `preset 'cordis-gitbash'
  retired (dsh-ptc-cordis-preset covers Creation mode on Git Bash)`, restoring logs `preset
  'cordis-gitbash' registered declaratively`. Sessions already mounted keep their own composition
  snapshot and are never rewritten; the roster change shows up for new sessions.
- **Old hosts (dsh ≤ 0.1.6) — decided once at startup**: there is no registration registry to watch
  and the capability probe is bounded (1s by default; "not seen" counts as "not covered"), so
  turning the switch on cleans up the `cordis-gitbash` directory an earlier boot materialized,
  while turning it back off re-materializes that variant on the **next startup** only.

**Both settings cards show one and the same state**: the single authoritative value lives in this
plugin's own row Config; the peer's card binds that same row through
`ctx.configForms.get('gitbash-shell')` and writes the same field (DSH officially supports editing a
namespace another plugin owns), so a change on either side shows up on the other immediately —
there is no second copy and no sync logic. On old hosts `configForms` does not exist, the mirrored
card never appears, and the switch is only editable on this plugin's own surface (the
`gitbash-shell` namespace).

**Versions**: the switch itself ships in **this plugin ≥ 0.25.0**; the peer's cooperation
capability ships in **dsh-ptc-cordis-preset ≥ 0.14.0**.

## POSIX path dialect (introduced in v0.7.0, gated by the `posixPaths` switch)

While commands default to this plugin's own Git Bash tool on Windows, the
plugin makes every path the
model sees use the MSYS drive-root POSIX form (/c/Users/..., /c/Program Files/...). The switch
is the `posixPaths` boolean in the `gitbash-shell` settings namespace; it is **on by default**
(since v0.10.0) and can be toggled any time on this plugin's "Git Bash path dialect" card in
**Settings → Plugins**. No preset or composition file is touched, and every mode —
standard/minimal/PTC/creation and user-authored presets — is covered.

While it is on (Windows only), `posixPaths` gates all of the following:

- **Source-level rewrite**: during assembly (`system-prompt/assemble`) every Windows absolute
  path in the official prompt's sections, contexts, and variables is rewritten in place to the
  /c/... form — nothing is added or removed, and tool schemas stay untouched;
- **One-sentence directive**: a global directive via `systemPrompt.context` (order 126) — the
  shell is Git for Windows bash, paths use MSYS drive roots, and every tool accepts that form
  directly — including the bash-native habits (`~`, `/tmp`, `/dev/null`, `/usr`), which resolve
  exactly as bash itself resolves them (v0.17.0, mirroring the Git Bash mount table);
  directly;
- **Argument translation**: on `tools/execute` the tools' path arguments (`file_path` / `path` /
  `workdir`, plus present's nested `files[].path`) are translated from /c/... back to C:/... for
  the Node-backed file tools; a bash command's `command` field is left alone — that is Git Bash's
  native form; **bash virtual paths resolve through the Git Bash mount table (v0.17.0)**: /tmp is
  the user TEMP dir, /dev/null the Windows NUL device, ~ the home directory, and /usr /bin /etc
  live under the Git install root — the same physical locations bash itself reads and writes; an
  absolute glob pattern (/c/.../*.md) is split into `path` + a relative `pattern` (it used to
  silently match nothing);
  `path` / `workdir`) are translated from /c/... back to C:/... for the Node-backed file tools;
  a bash command's `command` field is left alone — that is Git Bash's native form;
- **Result round-trip**: path metadata in successful results (`path` of read/read_image/write/edit,
  `paths[]` of glob, `matches[].path` of grep) flows back in the MSYS form; file contents and
  error results are untouched;
- **Runtime fact**: `DSH_PATH_DIALECT=msys` is contributed to the official `dsh-shell-env`
  registry, so the model can verify the dialect at execution time (it follows the live switch).

With the switch off, dsh-native behavior returns: the directive text is empty (dropped at
assembly, so zero prompt noise), path arguments and result metadata are no longer rewritten, and
the file tools receive Windows paths. **Bash stays Git Bash either way** — the switch only
governs the cross-tool path dialect.

## Sidebar terminal (v0.29.0+): the official "new terminal" runs Git Bash

dsh's own terminal is resolved by the official `terminal-controller` row, not by this plugin's executor. On a machine
whose PATH `bash` is the WSL launcher, that terminal used to start Ubuntu. This plugin now writes the verified Git Bash
into that row (only when the row has no shell of its own — an explicit choice is never overwritten; the display name is
`Git Bash` so it cannot be confused with the WSL candidate, which is left in the menu). `shellCandidates` is untouched.

**Three-step check (Windows)**

1. Install Git for Windows, restart dsh, open this plugin's settings card: the "adopt the sidebar terminal" switch is on
   and the host log shows `official sidebar terminal switched to Git Bash: …`.
2. Open a new terminal and confirm it really is Git Bash (either check works; **`uname -s` is the hardest**):
   - `uname -s` ⇒ `MINGW64_NT-10.0-<build>` (Git Bash's system name; WSL prints `Linux`);
   - `echo $MSYSTEM` ⇒ `MINGW64` (simplest).
   ⚠️ **Do not judge by `uname -r`**: under Git Bash / MSYS2 it is the **MSYS runtime version** (e.g.
   `3.6.9-b4195d69.x86_64`), whereas WSL prints `6.x.y.z-microsoft-standard-WSL2` — neither can decide this alone.
3. **Revert**: turning the switch off only stops FUTURE writes; it does not remove the `shell` field already written to
   the profile config. To restore the original exactly, delete that field from the `terminal-controller` row in the
   profile patch and restart dsh.

## Cooperation with dsh-better-sidebar

When [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) (v0.15.2+) is installed, on Windows this plugin adopts its official runtime settings seam (`terminalShell` — by the sidebar's own contract, "settings-page overrides win for terminals opened afterwards"), so both the sidebar's UI terminal tabs and the model-facing `terminal_*` tools open Git Bash — no upstream change, new terminals pick it up immediately. In addition, this bundle's patch also sets `config.shell` on the sidebar's row (boot-time resolution, so the **tab label reads `bash` too**; the row edit is harmless-skipped when the sidebar is not installed). Rules:

- **The plugin owns the pref while installed**: on every Windows boot it unconditionally sets `terminalShell` to Git Bash — a value you set elsewhere is overwritten again on the next boot;
- Removing this plugin restores the previous value (the sidebar returns to what it had before, e.g. its default pwsh / powershell resolution);
- Disable the adoption with `betterSidebarShell: false` in this plugin's row config.

## License

MIT © KannaKuron. Inspired by
[dsh-ptc-cordis-preset](https://github.com/KannaKuron/dsh-ptc-cordis-preset).
