# Runtime validation

## CI / portable regression suite

```sh
npm ci --ignore-scripts --omit=optional
npm test
npm pack --dry-run --ignore-scripts
```

The `ci` workflow runs the smoke suite and real Cordis lifecycle regressions on
Windows/Linux with Node 22/24. The lockfile supplies Cordis 4.0.4; the new tests
use its real `Context`, `Service`, `plugin`, `isolate`, inject, Config and disposal
contracts, not a mocked service registry. Optional FastCtx payloads and all npm
lifecycle scripts are deliberately excluded from the test dependency install.

## Installed-host preview (Windows, Node >= 22.15)

Select the **actual host directory** that contains its `package.json` and
`node_modules`; do not substitute a global CLI installation for Desktop's Core.
In PowerShell:

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
