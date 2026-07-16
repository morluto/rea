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
