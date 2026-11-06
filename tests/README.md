# Runtime validation

## CI / portable regression suite

```sh
npm ci --ignore-scripts --omit=optional
npm test
npm pack --dry-run --ignore-scripts
```

The `ci` workflow runs all portable suites on Windows/Linux with Node 24.9/24.
The lockfile supplies Cordis 4.1.0: executor/lifecycle cases exercise its real
`Context`, `Service`, `plugin`, `isolate`, inject, Config and disposal contracts.
Client, MCP and host-helper cases also use deterministic fixtures; those are not
production end-to-end tests. Actual ToolRuntime integration is checked separately
by the installed-host preview. Optional FastCtx payloads and all npm lifecycle
scripts are deliberately excluded from the test dependency install.

Additional portable regressions cover snapshot-dependent Hook ordering, retry
and cancellation of client polling, MCP spawn failure/error propagation, stable running-agent
pwsh visibility, pending tool/preset disposal, jobs withdrawal, required defineTool schemas,
standing session policy, deployment-default migration, regex data preservation,
sidebar switch updates and the shared dialect gates. No live winget installation
or FastCtx payload is needed.

## Installed-host preview (Windows, Node >= 24.9)

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
loads the real SystemPrompt, ToolRuntime, Native/Ptc tool executors, subprocess runtime, shell-env,
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

The preview dispatcher uses Core's current `calls` / `results` batch contract.
The synchronous resolution hook guards reentry into `require.resolve`. Ordinary
Node cannot load modules from an Electron ASAR: select a read-only extracted copy
of Desktop's `dsh` directory (including its unpacked files) in that case. Do not
point this variable at `app.asar.unpacked/dsh` alone; it is not the complete Core.

`tests/audit-preview.mjs` also loads the complete plugin entry and checks actual
native/PTC prompt assembly, complete-persona behavior, hidden ancestor ownership,
and Python source reaching a real interpreter unchanged. Set
`DSH_PREVIEW_PYTHON` to the Python executable to verify (otherwise `python` on PATH).
The PTC runtime adapter is a fixture calling that interpreter; this does not claim
a full deployment of the optional Python-runtime plugin.

Portable tests now include the persistent-terminal YAML writer, preservation of
user options/comments, TypeScript-only program rewriting, a separate-process
ownership-journal restore, failed edits, and concurrent config changes. YAML is a
locked development dependency rather than a probe of another user's home folder.
