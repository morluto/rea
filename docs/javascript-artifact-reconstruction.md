# JavaScript artifact reconstruction

REA can project an operator-supplied Electron/JavaScript application directory
or ASAR into [JavaScript Application Graph v1](javascript-application-graph.md)
without executing application code. The target-free
`analyze_javascript_application` MCP tool and
`rea analyze-javascript-application` CLI command expose the same application
service and return an Evidence v2 envelope containing the graph and an Electron
boundary summary.

The resulting Evidence can be combined with passive web or Electron capture
Evidence through
[`reconcile_javascript_runtime`](javascript-runtime-reconciliation.md). That
second operation does not rerun static analysis or contact CDP; it preserves
separate static, runtime, and cross-layer inference authorities.

## Public workflow

The administrator first grants a canonical input root. Every request still
requires explicit per-call approval, and the requested ASAR or directory must
remain beneath that root after canonicalization:

```bash
export REA_INVESTIGATION_INPUT_ROOTS_JSON='["/absolute/path/to/apps"]'
rea analyze-javascript-application /absolute/path/to/apps/app.asar \
  --approved \
  --json
```

When configuring an MCP client, set the variable before approved setup so REA
copies the explicit non-secret root policy into the managed registration:

```bash
export REA_INVESTIGATION_INPUT_ROOTS_JSON='["/absolute/path/to/apps"]'
rea setup
```

Restart the configured MCP client after changing this administrator ceiling.
An already-running server cannot acquire a new process environment through
MCP elicitation or `SIGHUP`.

The equivalent MCP input is:

```json
{
  "input_path": "/absolute/path/to/apps/app.asar",
  "format": "auto",
  "approved": true,
  "source_map_read_approved": false
}
```

`input_path` must be absolute. `format` accepts `auto`, `asar`, or `directory`.
The result retains the canonical local path, root artifact digest, artifact
manifest and graph commitments, JavaScript Application Graph v1, static
Electron summary, reconstruction statistics, and explicit limitations. It does
not require a live Hopper, Ghidra, browser, or Electron process.

## What is reconstructed

The projector reuses the content-addressed artifact inventory and safe artifact
readers. It retains canonical artifact-relative paths, exact byte counts,
SHA-256 digests, inventory IDs, ASAR container identity, and `.asar.unpacked`
status. Direct ASAR inputs and filesystem-backed ASAR files nested beneath a
directory are supported.

If an ASAR declares an unpacked companion entry but the corresponding
`<archive>.unpacked` file is absent from the operator-supplied artifact set, REA
keeps the ASAR occurrence with `hash_status: unavailable`, records an explicit
limitation, and does not create a content-addressed child artifact for those
missing bytes. This allows static JavaScript/Electron reconstruction to proceed
for the embedded files while preserving the missing native/resource bytes as an
unknown instead of silently treating them as absent or verified.

Selected bounded text is then parsed as inert data to recover:

- `package.json` metadata and declared main or renderer entrypoints;
- Electron preload paths and renderer files visible in static syntax;
- local HTML script entrypoints;
- Webpack and Rspack chunk registrations and module factories represented as
  AST literals;
- static imports, dynamic imports, CommonJS `require` calls, workers, and
  service workers;
- route, network endpoint, storage, and vendor-marker observations;
- local source-map declarations and, when separately approved, bounded original
  source names and content digests;
- explicit BrowserWindow options and `webPreferences`, including statically
  resolvable preload entrypoints;
- `contextBridge.exposeInMainWorld` and `exposeInIsolatedWorld` API keys and
  bounded literal member paths;
- renderer and main-process IPC operations, literal or dynamic channels, exact
  handler locations, and conservative pairing status;
- sender, frame, URL, and origin validation candidates without claiming that a
  visible check enforces a complete policy;
- utility-process entrypoints and native `.node` binding requests without
  parsing or executing the add-on.

Each recovered bundle module retains the exact factory-source digest. A complete
bounded AST also receives a `babel-ast-v1` structural fingerprint that ignores
ordinary identifier names while retaining syntax, literals, operators, object
keys, and member properties. If fingerprint construction reaches its structural
bound, the fingerprint is unavailable and its status is `truncated`; a bounded
prefix is never presented as a complete stable fingerprint.

## Authority and unknowns

Artifact bytes and AST syntax are observations. Entrypoint resolution, imports,
loads, calls, and persistence relationships are static inferences and explicitly
say that syntax does not prove runtime execution. A malformed or unavailable
JavaScript file, package record, or source map produces an `unknown` graph scope
with `state: unavailable`; it is not treated as evidence that modules or source
are absent.

Source-map content has a separate `source_map_read_approved` input. Without that
approval, REA inventories the map, links a static declaration when present, and
records partial non-truncated coverage plus an unavailable parse scope. With
approval, the graph stores original source names and optional content digests,
not the raw `sourcesContent` text.

Only explicitly present BrowserWindow values are observations. REA does not
substitute version-dependent Electron defaults for omitted `webPreferences`.
Dynamic option objects, bridge keys, API objects, and IPC channel expressions
remain unknown and make coverage partial.

IPC pairing is an inference, not an observation. A renderer `invoke` pairs only
with one unique `ipcMain.handle`/`handleOnce` candidate on the same exact literal
channel; a renderer send pairs only with one unique `ipcMain.on`/`once`
candidate. Dynamic channels are never paired, and multiple compatible handlers
are reported as ambiguous without adding a caller-to-handler edge. A matching
channel still does not prove registration order, reachability, or runtime use.

For `.node` bindings, member names mean “requested by JavaScript syntax.” A
resolved add-on path does not convert them into verified native exports. Native
symbol verification remains a separate deep-analysis claim.

Endpoint observations preserve useful local diagnostics while removing URL
credentials, fragments, and query values. Artifact paths, digests, parse
locations, and analysis metadata remain actionable because REA is local-only.

## Safety boundary

The reconstruction path never uses `eval`, `Function`, `vm.runInContext`, a DOM,
bundle `push` handlers, or application bootstrap code. The Webpack/Rspack fixture
used by the test suite mutates a global and throws if executed; reconstruction
recovers its four module factories without triggering either side effect.

Directory readers do not follow symlinks. Artifact paths pass through the shared
normalizer and collision registry, ASAR entry bytes are rechecked against the
inventory digest before parsing, and malformed ASAR operations return typed
format diagnostics that retain the local container path. Native add-ons are
represented by metadata only.

## Bounds and coverage

The input schema bounds artifact entries, cumulative artifact bytes, bytes per
entry, compression ratio, path depth and length, selected text files, text bytes,
AST nodes, static findings, bundle modules, source-map originals, and cooperative
parse time. Source-map original limits are shared across all maps in one
reconstruction. Combined input limits are rejected if their conservative graph
projection could exceed the v1 contract's 100,000 nodes or 200,000 edges.

Byte, entry, path, and graph-shape bounds are hard limits. The parse deadline is
checked before and between bounded parsing and traversal phases; the synchronous
Babel and JSON parser calls cannot be preempted mid-call, so their input byte
bounds remain the hard protection for an individual call.

Byte-identical assets share a content-digest node. At most 64 distinct
observations are retained on that node, as required by the graph contract; every
inventoried containment edge remains present, and any omitted observations make
top-level coverage partial and truncated. When an exact omission count is not
knowable, `omitted_count` is `null` rather than a guessed value.

## Verification boundary

The source-owned fixture covers an extracted directory, a direct ASAR with an
unpacked native add-on, a direct ASAR whose unpacked native companion is
missing, and an ASAR nested beneath a directory. Tests also cover deterministic
reruns, parse-not-execute behavior, source-map approval, global source-map
limits, malformed structured data, invalid containers, traversal, symlink
escape, oversized text, cancellation, AST truncation, and repeated content
identities. A separate synthetic Electron fixture covers explicit safe and
unsafe preference values, preload and contextBridge surfaces, literal, dynamic,
paired, ambiguous, and unpaired IPC, validation candidates, utility processes,
and native binding requests. These fixtures establish parser and artifact-reader
claims; they do not replace the later operator-supplied real-application
benchmark.
