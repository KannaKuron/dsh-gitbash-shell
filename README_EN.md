# dsh-gitbash-shell

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[简体中文](README.md) | English

> Run **every agent shell command through Git Bash** on Windows with DeepSeek
> Harness (dsh) — replaces the PowerShell executor and materializes Git Bash
> variants of all four agent presets.

### dsh 0.1.6: the workflow-engine row was renamed

dsh 0.1.6-alpha.1 renamed the built-in presets' workflow-engine row from
`workflow-worker-thread` to `workflow-ptc` and **deleted** the old package. One row
that fails to import rejects the **whole preset mount**, so a composition pinning the
old name simply stops working on the new host. This plugin pins neither spelling: at
materialization it copies that row — id, package and `disabled` state — straight out
of the host's own built-in preset (`rowFormsOf` / `alignEngineRow`), and aligns
`tool-ralph` with the new `disabled: true` default. The rewrite is plain string
surgery (no YAML round-trip, so `!!js` stays safe) and idempotent; a failed probe (old
host, no roster) leaves the assets byte-for-byte untouched — **one set of assets serves
both eras, in either upgrade order**.

The same release made `LocalBashExecutor`'s protected hooks asynchronous: the
`runArgv` result unwrapping, the `start` return shape and the `confine` cancellation
signal are all probed at load time, so both host generations behave identically.

## Install (public npm package)

```sh
dsh plugin --profile web add dsh-gitbash-shell
```

`dsh plugin add` installs the dependency via pnpm and, seeing the
`dsh.bundle` declaration, appends the package to `dsh.profile.bundles`.
**Restart the profile's host to activate.**

## Works with both dsh 0.1.1 and 0.1.2+

dsh 0.1.2 renamed the built-in `code` preset to `ptc` (`mode: code` → `mode: ptc`,
no compatibility aliases) and added new built-in rows (`command-goal`, …). For
the affected variants (standard/code/cordis) this plugin **ships both committed
era texts**, probes the built-in roster at every boot, records the choice in
`.plugin-managed.json` (`base`), and re-materializes automatically when the
detection flips. `minimal-gitbash`'s built-in base did not change across the
rename, so one text serves both eras. **Preset ids never change**
(`code-gitbash` keeps its historical id — sessions are pinned to ids, and a
rename would orphan them). Either upgrade order converges automatically; directories
you modified are still never touched.

## What it does

The bundle patch (`cordis.patch.yml`):

1. disables `pwsh-sandbox` (one `ctx.shell` provider per process);
2. mounts `dsh-gitbash-shell/shell` — a subclass of the shipped
   `@deepseek-ai/dsh-bash-sandbox` whose inner argv is
   `<git-bash.exe> -c <command>` (sandbox policy, denial classification,
   background jobs, and settings behavior all inherited);
3. mounts `dsh-gitbash-shell/presets`, which materializes
   `standard-gitbash`, `minimal-gitbash`, `code-gitbash`,
   `cordis-gitbash` into the first user-trust preset root, guarded by
   per-file `.plugin-managed.json` hashes (user edits are never overwritten;
   unmodified trees are cleaned on uninstall).

Environment: `bash.exe` is spawned as a direct child of the host, so it
inherits the full system environment plus the `DSH_*` snapshot, exactly like
the pwsh executor did.

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

Executor config:

```yaml
config:
  bashPath: "D:/Tools/Git/bin/bash.exe"   # default C:/Program Files/Git/bin/bash.exe
```

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

While replacing the host shell with Git Bash on Windows, this plugin makes every path the
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
