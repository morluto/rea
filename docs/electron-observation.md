# Electron file-page observation

REA can attach to an Electron/Chromium CDP endpoint and inspect existing `file://` renderer pages without evaluating JavaScript or invoking Electron APIs. The request supplies the endpoint directly; REA accepts only literal-port loopback HTTP endpoints. Selecting an endpoint exposes every Electron target it serves, including local file paths and page metadata.

This passive runtime surface is distinct from the target-free static
[`analyze_javascript_application`](javascript-artifact-reconstruction.md)
workflow. Static analysis reads a local ASAR or extracted directory without
executing application code. Passive observation inspects an existing Electron
page. The results keep static inferences and runtime observations distinct.
Use the separate
[`reconcile_javascript_runtime`](javascript-runtime-reconciliation.md) workflow
when both Evidence sets already exist.

## Target boundary

The request supplies a literal-port loopback endpoint and, for inspection, a
target ID. REA accepts local hostless `file://` URLs that resolve to regular
files; remote hosts, encoded path separators, and nonexistent paths are
rejected. The endpoint exposes every eligible target and its local path
metadata.

## Workflow

`list_electron_targets` returns every eligible target served by the supplied endpoint in one inline array.

For the MCP follow-up call, pass the same literal-loopback endpoint and the selected target ID to `inspect_electron_page`. REA rediscovers targets and validates the ID against the live endpoint before inspection.

```bash
rea list-electron-targets http://127.0.0.1:9223 --json
rea inspect-electron-page http://127.0.0.1:9223 TARGET_ID \
  --observation-ms 100 --json
```

Script content is excluded by default. Setting `include_script_sources` in the
request returns the selected target's script sources:

```bash
rea inspect-electron-page http://127.0.0.1:9223 TARGET_ID \
  --include-script-sources \
  --json
```

The normalized result contains canonical local paths, frame and DOM
structure, resource metadata, stable script/resource identities, explicit
completeness, and content-addressed script artifacts. Script metadata
retains its execution-context frame ID when CDP supplies one. The capture also
inventories worker, service-worker, and shared-worker targets with
validated opener-target and parent-frame IDs. Worker discovery uses passive
target metadata; REA does not attach to or execute code in those targets.
Collection counts and aggregate script-source bytes are not capped. Like every
target, frame, script, and resource, a worker URL must resolve to a local
file before it is retained. Relationship IDs improve
attribution but do not prove which static module started a worker or that its
work completed.

Inspection does not retain DOM values, execute renderer code, navigate, click,
invoke Electron IPC, close a target, or terminate the application.

## Active Electron scenarios

The scenario request supplies the Electron executable and application entry
point, plus any arguments and actions. The application root defaults to the
entry point's parent directory and can be supplied when the app uses a different
root. REA launches that executable through
the official Playwright Electron API and owns its lifetime. It accepts click/wait actions,
window-targeted renderer reload/crash actions, and synthetic `open-url` or
`second-instance` deep-link delivery. It records capture-scoped window and
WebContents identities, process metrics, and IPC channel and value-shape metadata.
Payload values are not retained.

Run the real fixture verifier with an operator-provided Electron runtime:

```bash
REA_ELECTRON_EXECUTABLE=/absolute/path/to/electron npm run verify:electron
```

This operation actively launches and interacts with the selected target. It is
not a passive CDP observation. The owned process keeps normal host filesystem
and network privileges, so lifecycle ownership does not make it a sandbox.

The CLI and MCP surfaces accept the same schema. For a JSON request file:

```bash
rea capture-electron-scenario scenario.json --json
```

The result records action status and targets, correlated app/window/WebContents,
preload, session, navigation, shell, permission, popup, download, protocol,
native-addon, process, and IPC timeline events. Event retention has a 16 MiB
accounting budget for full channel strings, argument-shape arrays, and an
estimated object-graph cost. Admission computes an exact JSON byte length
incrementally, then charges twice that size plus 256 bytes per event and 8 bytes
per argument shape. The doubled JSON charge covers the timeline and IPC views;
the additional charge estimates their in-process object and array storage. This
is a resource estimate, not an exact V8 heap measurement. An event that does not
fit is dropped whole. The result reports the estimate, serialized-byte upper
bound, dropped event families, and
observed/dropped totals for IPC and runtime events. Retained sequence numbers
keep their original capture identities. Payload values are never retained.
Renderer crash/restart and deep-link actions are synthetic
scenario controls; their attempted and observed outcomes remain in the
timeline. The active hook blocks and records external shell/navigation,
permission, download, popup, updater, and OS-integration effects. The timeline
is explicitly partial when attachment starts after application activity. The
owned experiment has an internal 60-second deadline and a 5-second per-action
timeout so hung work reaches process cleanup; these are lifecycle timeouts, not
caller-selected capture limits.

Active Electron Evidence can also be supplied to
[`reconcile_javascript_runtime`](javascript-runtime-reconciliation.md). That
projection is intentionally target-only and partial: it binds the selected
application path and capture outcome to the static graph, while frames, scripts,
workers, and execution claims remain unavailable until a separate passive runtime
capture provides them.
