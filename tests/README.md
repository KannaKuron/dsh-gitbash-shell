# Runtime validation

## CI / portable regression suite

```sh
npm ci --ignore-scripts --omit=optional
npm test
npm pack --dry-run --ignore-scripts
```

The `ci` workflow runs all portable suites on Windows/Linux with Node 22/24.
The lockfile supplies Cordis 4.0.4: executor/lifecycle cases exercise its real
`Context`, `Service`, `plugin`, `isolate`, inject, Config and disposal contracts.
Client, MCP and host-helper cases also use deterministic fixtures; those are not
production end-to-end tests. Actual ToolRuntime integration is checked separately
by the installed-host preview. Optional FastCtx payloads and all npm lifecycle
scripts are deliberately excluded from the test dependency install.

Additional portable regressions cover snapshot-dependent Hook ordering, retry
and cancellation of client polling, MCP spawn failure/error propagation, dynamic
pwsh visibility, pending tool/preset disposal, jobs withdrawal, fallback schemas,
standing session policy, deployment-default migration, regex data preservation,
sidebar switch updates and the shared dialect gates. No live winget installation
or FastCtx payload is needed.

## Installed-host preview (Windows, Node >= 22.15)

Select the **actual host directory** that contains its `package.json` and
`node_modules`; do not substitute a global CLI installation for Desktop's Core.
In Git Bash:

```sh
DSH_PREVIEW_HOST_DIR='<actual installed host directory>' npm run test:preview
```

Or in PowerShell:

```powershell
$env:DSH_PREVIEW_HOST_DIR = '<actual installed host directory>'
npm run test:preview
```

This is a **headless runtime preview**, not a browser/UI deployment. The resolver
loads `@deepseek-ai/*` from the selected installed host without changing that
installation. The preview creates a fresh Cordis context and temporary cwd,
loads the real SystemPrompt, ToolRuntime, subprocess runtime, shell-env,
SandboxPwshExecutor and official pwsh tool, and activates the actual inline
Git Bash patch. Policy and session/working-directory wiring are test fixtures;
only danger-full-access commands are exercised.

Assertions cover:

- The old plain child-scope path fails with the actual
  `service "shell" has been registered at <SandboxPwshExecutor>` error.
- Fixed bash is present in the host's per-agent schema list, not globally.
- Real bash executes `command -v bash`, `uname -s`, and a sentinel successfully.
- With pwsh enabled, the original executor still executes `Get-Process`.
- With the default pwsh switch off, bash stays callable and pwsh is hidden.
- Disposing the inline patch removes bash, lifts its restrictions, and preserves
  the exact original shell provider.

The preview makes no model calls, starts no web server, installs no plugin into
a profile, does not edit production config, and does not restart Desktop. It is
not a full end-to-end GUI/preset-picker/PTY/background-job/confinement test.
