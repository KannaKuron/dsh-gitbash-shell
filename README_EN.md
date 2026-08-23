# dsh-gitbash-shell

> Run **every agent shell command through Git Bash** on Windows with DeepSeek
> Harness (dsh) — replaces the PowerShell executor and materializes Git Bash
> variants of all four agent presets.

## Install (public GitHub plugin)

```sh
dsh plugin --profile web add github:KannaKuron/dsh-gitbash-shell
# optional TUI surfaces
dsh plugin --profile tui add github:KannaKuron/dsh-gitbash-shell
dsh plugin --profile cc-tui add github:KannaKuron/dsh-gitbash-shell
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

## License

MIT © KannaKuron. Inspired by
[dsh-ptc-cordis-preset](https://github.com/KannaKuron/dsh-ptc-cordis-preset).
