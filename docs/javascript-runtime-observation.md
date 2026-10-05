# Passive Node and Electron runtime observation

REA can attach to an already-running Node.js or Electron V8 Inspector target
and retain script-load and execution-context metadata. The
`list_javascript_runtime_targets` and `observe_javascript_runtime` MCP tools
have equivalent `rea list-javascript-runtime-targets` and
`rea observe-javascript-runtime` commands. Successful calls return
deterministic Evidence.

This authority is disabled by default and is separate from browser CDP,
Electron file-page inspection, Process Capture, and controlled JavaScript
replay:

```bash
export REA_V8_INSPECTOR_OBSERVE_ENABLED=true

rea list-javascript-runtime-targets http://127.0.0.1:9229 \
  --json
rea observe-javascript-runtime http://127.0.0.1:9229 TARGET_ID \
  --runtime-kind node --json
```

The caller supplies the literal-loopback HTTP endpoint directly. Selecting an endpoint exposes all targets it serves and their local script locations or renderer origins. A target must match the exact requested target ID and expose a same-port WebSocket reported by that endpoint. Targets already marked attached are rejected rather than displacing another debugger. Local paths are canonicalized after symlink resolution.

`list_javascript_runtime_targets` returns every available target in one inline
array.

For the MCP follow-up call, pass the same literal-loopback endpoint and the selected target ID to `observe_javascript_runtime`. REA rediscovers targets and validates the ID against the live endpoint before observation.

### Discovery file locations

Node's `/json/list` reports a best-effort pathname prefixed with `file://`,
without URI encoding. On POSIX, REA interprets unambiguous paths literally,
including `#` and `%` in filenames. Node also replaces backslashes and double
quotes with underscores. That transformation cannot be reversed reliably:
an underscore may already be part of the original filename.

Windows paths, ambiguous underscore paths, and local discovery paths that
cannot be verified remain eligible by their endpoint and exact target ID.
Their target location preserves the reported value:

```json
{
  "kind": "unresolved",
  "reported_url": "file://C:_tools_entry.js",
  "reason": "unverifiable-file-location"
}
```

This location does not claim that a file exists or authorize reading its
contents. Listing remains HTTP-only. Observation resolves loaded script
locations independently from `Debugger.scriptParsed` file URLs, preserving
the existing checks for local files and encoded separators. Unsupported
schemes, remote file hosts, and a bare `file://` remain excluded. These Node
discovery rules do not apply to page targets or other runtime products.

Reconciliation retains an unresolved `target_location` object and reports
`runtime-location-unresolved` with unknown confidence for that target. It
does not derive a static match from the reported pathname; verified loaded
script locations remain available for independent matching.

## Passive protocol boundary

The provider sends exactly two protocol commands:

- `Runtime.enable`
- `Debugger.enable`

It never sends `Runtime.evaluate`, reads script source, installs breakpoints,
pauses or resumes execution, calls `Runtime.runIfWaitingForDebugger`, launches
the target, instruments JavaScript, or invokes Electron APIs. Closing a call
closes only REA's WebSocket.

The direct observations are:

- `Debugger.scriptParsed`, establishing that a bounded script location was
  parsed in the observed execution context;
- `Debugger.scriptFailedToParse`, retained only as a bounded invalid-script
  count;
- `Runtime.executionContextCreated`,
  `Runtime.executionContextDestroyed`, and
  `Runtime.executionContextsCleared`, establishing context lifecycle within
  the capture window.

The Inspector protocol does not directly expose require/import caller edges,
EventEmitter emissions or listener invocation, Electron IPC messages or
handlers, or script-unload events. Those facts remain explicit unknowns.
`scriptParsed` proves script presence, not the importing module, feature
execution, initialization order, or causality.

## Node and Electron roles

The caller declares one role: `node`, `electron-main`, `electron-preload`, or
`electron-renderer`. Node and Electron-main declarations require a protocol
target of type `node`; preload and renderer declarations require `page`.
Inspector does not authenticate the operating-system PID or distinguish an
Electron role, so Evidence records the role authority as
`caller-declared-unverified`.

Electron main, preload, and renderer behavior can therefore be observed only
as separate approved Inspector targets. The provider does not infer that two
targets belong to the same Electron application.

## Capture and determinism

Every observation records its time window and returns all valid script and
execution-context events received during it. Per-location protocol validation
remains in force. Scripts are authorized after capture, deduplicated by stable
metadata, and canonically sorted. Wall-clock timestamps and protocol script IDs
are excluded from the durable result, so identical inputs and captured metadata
produce the same Evidence ID.

Inspector attach is inherently incomplete. Enabling `Debugger` reports known
and uncollected scripts, but scripts collected before attachment may be
missing. Absence from the observation window never proves that a script or
behavior does not occur.

## Static correlation

Pass the resulting observation Evidence and an
`analyze_javascript_application` Evidence record to
`reconcile_javascript_runtime`. The reconciliation accepts this provider
alongside passive web and Electron page captures. Exact approved file or URL
mappings can correlate script presence with JavaScript Application Graph
assets. Because this provider never reads source bytes, matches normally use a
unique authorized location and remain weaker than captured-byte identity.
Builtin `node:` scripts remain runtime-only nodes unless a future explicit
static authority models them.
