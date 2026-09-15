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
  directly;
- **Argument translation**: on `tools/execute` the file tools' path arguments (`file_path` /
  `path` / `workdir`) are translated from /c/... back to C:/... for the Node-backed file tools;
  a bash command's `command` field is left alone — that is Git Bash's native form;
- **Result round-trip**: path metadata in successful results (`path` of read/write/edit,
  `paths[]` of glob, `matches[].path` of grep) flows back in the MSYS form; file contents and
  error results are untouched;
- **Runtime fact**: `DSH_PATH_DIALECT=msys` is contributed to the official `dsh-shell-env`
  registry, so the model can verify the dialect at execution time (it follows the live switch).

With the switch off, dsh-native behavior returns: the directive text is empty (dropped at
assembly, so zero prompt noise), path arguments and result metadata are no longer rewritten, and
the file tools receive Windows paths. **Bash stays Git Bash either way** — the switch only
governs the cross-tool path dialect.

## Cooperation with dsh-better-sidebar

When [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) (v0.15.2+) is installed, on Windows this plugin adopts its official runtime settings seam (`terminalShell` — by the sidebar's own contract, "settings-page overrides win for terminals opened afterwards"), so both the sidebar's UI terminal tabs and the model-facing `terminal_*` tools open Git Bash — no upstream change, new terminals pick it up immediately. In addition, this bundle's patch also sets `config.shell` on the sidebar's row (boot-time resolution, so the **tab label reads `bash` too**; the row edit is harmless-skipped when the sidebar is not installed). Rules:

- **The plugin owns the pref while installed**: on every Windows boot it unconditionally sets `terminalShell` to Git Bash — a value you set elsewhere is overwritten again on the next boot;
- Removing this plugin restores the previous value (the sidebar returns to what it had before, e.g. its default pwsh / powershell resolution);
- Disable the adoption with `betterSidebarShell: false` in this plugin's row config.

## License

MIT © KannaKuron. Inspired by
[dsh-ptc-cordis-preset](https://github.com/KannaKuron/dsh-ptc-cordis-preset).
