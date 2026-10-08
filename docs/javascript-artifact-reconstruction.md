# JavaScript artifact reconstruction

REA can project an operator-supplied Electron/JavaScript application directory
or ASAR into [JavaScript Application Graph](javascript-application-graph.md)
without executing application code. The target-free
`analyze_javascript_application` MCP tool, dedicated
`rea analyze-javascript-application` CLI command, and generic
`rea analyze PATH` directory/ASAR route expose the same application
service and return an Evidence envelope containing the graph and an Electron
boundary summary.

The resulting Evidence can be combined with passive web or Electron capture
Evidence through
[`reconcile_javascript_runtime`](javascript-runtime-reconciliation.md). That
second operation does not rerun static analysis or contact CDP; it preserves
separate static, runtime, and cross-layer inference authorities.

## Public workflow

The tool reads the caller-selected local directory or ASAR path directly:

```bash
rea analyze /absolute/path/to/apps/app.asar --json
rea analyze-javascript-application /absolute/path/to/apps/app.asar \
  --json
```

Generic `rea analyze` selects this static provider for directories and `.asar`
paths when neither `--provider` nor `--snapshot` is supplied. The dedicated
command and the generic route return their complete results inline. Native
targets, single JavaScript files, `.app` bundles, and explicit deep-provider or
snapshot requests retain the native deep-analysis route.

Both CLI routes emit `rea_progress` JSON lines on stderr as inventory, source
parsing, graph construction, validation, and Evidence hashing begin. Stdout
remains the selected result document. Completion is reported after Evidence
creation; a failed analysis retains its typed diagnostic result.

Configure an MCP client with the ordinary REA setup command:

```bash
rea setup
```

The equivalent MCP input is:

```json
{
  "input_path": "/absolute/path/to/apps/app.asar",
  "format": "auto"
}
```

`input_path` must be absolute. `format` accepts `auto`, `asar`, or `directory`.
The result retains the canonical local path, root artifact digest, artifact
manifest and graph commitments, JavaScript Application Graph, static
Electron summary, reconstruction statistics, and explicit limitations. It does
not require a live Hopper, Ghidra, browser, or Electron process.

## ASAR integrity

ASAR inventory checks Electron integrity metadata for embedded archive entries
and supplied `.asar.unpacked` companion files. An integrity failure identifies
the logical path, declared and calculated SHA-256 values, and whether the entry
was unpacked. By default, a mismatch is returned as a failure with its artifact
context. Requests that support `integrity_policy` can explicitly select
`record-and-continue` to inspect verified siblings while retaining the mismatch.

An unpacked entry whose companion bytes were not supplied remains
`unavailable`. REA continues analyzing embedded JavaScript and records the
missing native/resource bytes as unknown. See [what is reconstructed](#what-is-reconstructed)
for the inventory fields and [MCP integrity handling](mcp-contracts.md#integrity-record-and-continue)
for the tool-result contract.

## Large results

Graph and Evidence identifiers hash canonical JSON incrementally, without
assembling a single string for the whole graph. The canonical bytes and existing
identifiers remain unchanged. The opt-in regression check is
`npm run verify:javascript:digests`;
it hashes a value larger than the running Node engine's single-string limit.

Both application CLI routes stream complete JSON and JSONL output in bounded
chunks, including field filters and `--full-output`. They wait for each stdout
write instead of constructing or reparsing a document-sized string. The opt-in
`npm run verify:javascript:output` checks the actual CLI formatting boundary with
a temporary output file larger than the running engine's string limit, verifies
its bytes and digest, and removes it. Use `-- jsonl` for the compact JSONL check.
Each check needs space for one output file plus a 1 GiB free-space reserve.

Other CLI formats, `--token-count`, and MCP transport serialization still
assemble whole strings. Field selection remains useful when the caller needs a
smaller view, for example `--format json --filter-output
evidence_id,normalized_result.statistics`. Streaming output does not bound the
memory needed to construct the analysis graph itself.
Client framing limits also apply: the pinned Node MCP SDK's stdio transport
defaults to a 10 MiB buffer. Its caller-selected `maxBufferSize` must accommodate
the complete response, including text and structured Evidence projections.

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
- local source-map declarations and original
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

Source-map contents are parsed as local input. The graph stores original source names and optional content digests, not raw `sourcesContent` text.

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

Endpoint observations preserve useful local diagnostics, including query values
and fragments, while removing only URL username/password credentials. Artifact
paths, digests, parse locations, and analysis metadata remain actionable
because REA is local-only.

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

The reconstruction keeps internal resource safeguards for artifact entries,
cumulative artifact bytes, bytes per entry, compression ratio, path depth and
length, selected text files, text bytes, AST nodes, and cooperative parse time.
These safeguards are not caller-selectable output budgets. Source-map parsing
reports truncation when its format or parser safety boundary is reached. The
application graph has no aggregate node, edge, root, or observation prefix cap.

Byte, entry, path, and graph-shape bounds are hard limits. The parse deadline is
checked before and between bounded parsing and traversal phases; the synchronous
Babel and JSON parser calls cannot be preempted mid-call, so their input byte
bounds remain the hard protection for an individual call.

Byte-identical assets share a content-digest node. Every distinct observation
and inventoried containment edge is retained. If parsing or artifact safety
boundaries omit input, coverage reports that omission; when an exact omission
count is not knowable, `omitted_count` is `null` rather than a guessed value.

## Verification boundary

The source-owned fixture covers an extracted directory, a direct ASAR with an
unpacked native add-on, a direct ASAR whose unpacked native companion is
missing, and an ASAR nested beneath a directory. Tests also cover deterministic
reruns, parse-not-execute behavior, source-map parsing, global source-map
limits, malformed structured data, invalid containers, traversal, symlink
escape, oversized text, cancellation, AST truncation, and repeated content
identities. A separate synthetic Electron fixture covers explicit safe and
unsafe preference values, preload and contextBridge surfaces, literal, dynamic,
paired, ambiguous, and unpaired IPC, validation candidates, utility processes,
and native binding requests. These fixtures establish parser and artifact-reader
claims; they do not replace the later operator-supplied real-application
benchmark.
