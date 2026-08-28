# dsh-gitbash-shell

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

> Run **every agent shell command through Git Bash** on Windows with DeepSeek
> Harness (dsh) — replaces the PowerShell executor and materializes Git Bash
> variants of all four agent presets.

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

## Cooperation with dsh-better-sidebar

When [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) (v0.15.2+) is installed, on Windows this plugin adopts its official runtime settings seam (`terminalShell` — by the sidebar's own contract, "settings-page overrides win for terminals opened afterwards"), so both the sidebar's UI terminal tabs and the model-facing `terminal_*` tools open Git Bash — no upstream change, new terminals pick it up immediately. In addition, this bundle's patch also sets `config.shell` on the sidebar's row (boot-time resolution, so the **tab label reads `bash` too**; the row edit is harmless-skipped when the sidebar is not installed). Rules:

- **The plugin owns the pref while installed**: on every Windows boot it unconditionally sets `terminalShell` to Git Bash — a value you set elsewhere is overwritten again on the next boot;
- Removing this plugin restores the previous value (the sidebar returns to what it had before, e.g. its default pwsh / powershell resolution);
- Disable the adoption with `betterSidebarShell: false` in this plugin's row config.

## License

MIT © KannaKuron. Inspired by
[dsh-ptc-cordis-preset](https://github.com/KannaKuron/dsh-ptc-cordis-preset).