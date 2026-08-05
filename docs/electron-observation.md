# Electron file-page observation

REA can attach to a user-owned Electron/Chromium CDP endpoint and inspect existing `file://` renderer pages without evaluating JavaScript or invoking Electron APIs. Electron observation is separate from website observation because filesystem roots, not HTTP origins, define its authority.

This passive runtime surface is distinct from the target-free static
[`analyze_javascript_application`](javascript-artifact-reconstruction.md)
workflow. Static analysis reads an approved ASAR or extracted directory under
`REA_INVESTIGATION_INPUT_ROOTS_JSON`; it does not attach to CDP. Runtime
observations and static inferences are never silently treated as the same fact.
Use the separate
[`reconcile_javascript_runtime`](javascript-runtime-reconciliation.md) workflow
when both Evidence sets already exist.

## Configure authority

The capability is disabled by default:

```bash
export REA_ELECTRON_OBSERVE_ENABLED=true
export REA_ELECTRON_CDP_ENDPOINTS_JSON='["http://127.0.0.1:9223"]'
export REA_ELECTRON_FILE_ROOTS_JSON='["/Applications/Example.app/Contents/Resources"]'
```

Endpoints accept only explicit-port loopback HTTP URLs. Roots are canonicalized by the shared permission authority. Each target, frame, script, and resource is independently converted from a hostless `file://` URL to a real path and checked after symlink resolution. UNC hosts, percent-encoded path separators, nonexistent paths, and root escapes are rejected.

## Workflow

```bash
rea list-electron-targets http://127.0.0.1:9223 --approved --json
rea inspect-electron-page http://127.0.0.1:9223 TARGET_ID \
  --approved --observation-ms 100 --json
```

Script content is excluded by default. Capturing it requires both flags and remains subject to per-script and aggregate byte budgets:

```bash
rea inspect-electron-page http://127.0.0.1:9223 TARGET_ID \
  --approved \
  --include-script-sources \
  --source-capture-approved \
  --json
```

The normalized result contains canonical local paths, bounded frame and DOM
structure, resource metadata, stable script/resource identities, explicit
completeness, and content-addressed approved source artifacts. Script metadata
retains its execution-context frame ID when CDP supplies one. The capture also
inventories authorized worker, service-worker, and shared-worker targets with
bounded opener-target and parent-frame IDs. Worker discovery uses passive
target metadata; REA does not attach to or execute code in those targets.

The default worker limit is 500 and the caller-visible maximum is 5,000. Like
every target, frame, script, and resource, a worker URL must resolve beneath an
approved canonical root before it is retained. Relationship IDs improve
attribution but do not prove which static module started a worker or that its
work completed.

Inspection does not retain DOM values, execute renderer code, navigate, click,
invoke Electron IPC, close a target, or terminate the application.

## Active Electron scenarios

Active Electron authority is separate and disabled by default. When enabled,
REA launches an operator-approved Electron executable through the official
Playwright Electron API, owns its lifetime, accepts bounded click/wait actions,
and records process/window metrics plus IPC channel and value-shape metadata.
Payload values are not retained.

Configure exact roots and run the real fixture verifier with an operator-owned
Electron runtime:

```bash
export REA_ELECTRON_AUTOMATE_ENABLED=true
export REA_ELECTRON_AUTOMATE_AUTO_GRANT=false
export REA_ELECTRON_AUTOMATE_EXECUTABLE_ROOTS_JSON='["/absolute/path/to/runtime"]'
export REA_ELECTRON_AUTOMATE_APPLICATION_ROOTS_JSON='["/absolute/path/to/app"]'
REA_ELECTRON_EXECUTABLE=/absolute/path/to/electron npm run verify:electron
```

This capability actively launches and interacts with the target. It is not a
passive CDP observation and must be granted separately as `electron_automate`.
The default is fail-closed (`AUTO_GRANT=false`); an operator can instead issue
a project/session/one-shot grant through the normal permission workflow. The
owned process keeps normal host filesystem and network privileges, so this is
an authority boundary and lifecycle boundary, not a sandbox.

The CLI and MCP surfaces accept the same schema. For a JSON request file:

```bash
rea capture-electron-scenario scenario.json --json
```

The result records bounded action status, correlated app/window/WebContents,
preload, session, navigation, shell, permission, popup, download, protocol,
native-addon, process, and IPC timeline events. IPC channels are capped at
1,024 characters and argument-shape metadata at 32 entries; values are never
retained. The active hook blocks and records external shell/navigation,
permission, download, popup, updater, and OS-integration effects. The timeline
is explicitly partial when attachment starts after application activity or when
the event budget is exhausted.
