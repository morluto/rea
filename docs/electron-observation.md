# Electron file-page observation

REA can attach to a user-owned Electron/Chromium CDP endpoint and inspect existing `file://` renderer pages without evaluating JavaScript or invoking Electron APIs. Electron observation is separate from website observation because filesystem roots, not HTTP origins, define its authority.

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

The normalized result contains canonical local paths, bounded frame and DOM structure, resource metadata, stable script/resource identities, explicit completeness, and content-addressed approved source artifacts. It does not retain DOM values, execute renderer code, navigate, click, invoke Electron IPC, close a target, or terminate the application.
