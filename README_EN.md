# dsh-gitbash-shell

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

## License

MIT © KannaKuron. Inspired by
[dsh-ptc-cordis-preset](https://github.com/KannaKuron/dsh-ptc-cordis-preset).