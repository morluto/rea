# JavaScript artifact reconstruction

Inspect a local Electron/JavaScript directory or ASAR without executing its code.
`analyze_javascript_application` and the CLI routes below return an Evidence
record with the [application graph](javascript-application-graph.md), static
Electron observations, statistics, limitations, and coverage.

Start with the [public workflow](#public-workflow), select sources when useful,
then [read the analysis](#read-the-analysis). Use [application workflows](javascript-application-workflows.md)
for tracing and comparisons, or [partial recovery](#recover-partial-analysis)
when an operation is interrupted.

## Public workflow

The tool reads the caller-selected local directory or ASAR path directly:

```bash
rea analyze /absolute/path/to/apps/app.asar --json
rea analyze-javascript-application /absolute/path/to/apps/app.asar \
  --integrity-policy record-and-continue --json
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
  "format": "auto",
  "integrity_policy": "fail"
}
```

`input_path` must be absolute. `format` accepts `auto`, `asar`, or `directory`.
`integrity_policy` accepts `fail` or `record-and-continue`; both CLI routes and
the MCP tool default to `fail`.
The result retains the canonical local path, root artifact digest, artifact
manifest and graph commitments, JavaScript Application Graph, static
Electron summary, reconstruction statistics, and explicit limitations. It does
not require a live Hopper, Ghidra, browser, or Electron process.

The application graph selects the shallowest `package.json` outside
`node_modules` as its package root, breaking equal-depth ties by Unicode
code-point order. Dependency manifests remain package observations but do not
declare Electron main or renderer entries. If only dependency manifests are
present, the inventory artifact remains the graph root.

## Select sources before analysis

For a question about known entry sources, supply exact artifact-relative file
paths in `source_paths`, or repeat `--source-path` on either CLI route:

```bash
rea analyze /absolute/path/to/app.asar \
  --source-path package.json --source-path main.js --json
```

```json
{
  "input_path": "/absolute/path/to/app.asar",
  "source_paths": ["package.json", "main.js"],
  "detail": "summary"
}
```

REA inventories and verifies the complete artifact, including unselected bytes,
but allocates source text and performs static analysis only for selected files.
Include supporting manifests, HTML or source maps explicitly when needed;
imports do not expand the selection. Paths must match relevant inventoried
files exactly, including nested ASAR prefixes. Unknown paths, aliases and globs
return an `invalid_request` correction. Selected files are analyzed in request
order before unselected scopes are projected. Repeated paths preserve the
caller's request and first-occurrence priority, analyzing the file once.
Omit the selection for the existing complete
application workflow.

The result and summary retain `source_selection.requested_paths` and
`source_selection.unselected_files`. Every relevant file keeps its original
inventory identity; unselected files report `text_status:
"outside-analysis-scope"`. Their relationships remain unknown, and application
coverage is partial while any file remains outside scope. Selection does not
claim whole-application completeness or change integrity policy. Summary detail
only reduces delivery; source selection reduces text acquisition and analysis.
Explicit native provider or snapshot routing rejects `--source-path` rather
than ignoring it.

## Read the analysis

`analyze_javascript_application` returns the complete analysis Evidence by
default. Select `"detail": "summary"` to retain that complete Evidence in the
current session and receive only its `inspect_analysis_view` summary: artifact
identity, statistics, Electron surface counts, application and semantic
coverage, limitations, and `normalized_result.parent_evidence_id`. Pass that ID
to `inspect_analysis_view` for module pages or items, or to the application
workflows as a retained reference. The summary does not repeat or truncate the
analysis; a server without session retention refuses summary detail with
`capability_unavailable`. CLI output is unchanged and always complete.

With a connected MCP `client` and the caller-selected absolute `inputPath`, this
recipe analyzes once and pages module identities using the returned ID:

```js
const analysis = await client.callTool({
  name: "analyze_javascript_application",
  arguments: { input_path: inputPath, detail: "summary" },
});
if (analysis.isError) throw new Error(JSON.stringify(analysis.content));
const parentId =
  analysis.structuredContent.normalized_result.parent_evidence_id;
const modules = await client.callTool({
  name: "inspect_analysis_view",
  arguments: {
    source: { kind: "retained-evidence", evidence_id: parentId },
    view: { kind: "page", collection: "modules", offset: 0, limit: 16 },
  },
});
if (modules.isError) throw new Error(JSON.stringify(modules.content));
```

Select a returned module's exact `node_id` for an item view. A path can identify
several graph roles; module items preserve their recorded properties and source
locations. Follow `coverage.next_offset` when another page matters. For feature
tracing, version comparison, and retained-input examples, use the
[application workflows](javascript-application-workflows.md).

For supplied passive browser or Electron observations, use
[runtime reconciliation](javascript-runtime-reconciliation.md). It compares
existing Evidence without rerunning static analysis or contacting CDP.

## ASAR integrity

ASAR inventory checks Electron integrity metadata for embedded archive entries
and supplied `.asar.unpacked` companion files. An integrity failure identifies
the logical path, declared and calculated SHA-256 values, and whether the entry
was unpacked. By default, a mismatch is returned as a failure with its artifact
context. Application analysis can explicitly select `record-and-continue` to
analyze observed bytes while retaining each contradiction's declared and
observed hashes and `observed-untrusted` trust. Such results mark application
graph coverage partial and include every contradicted path in the limitations.
Mismatched nested ASARs stay opaque rather than being expanded.

An unpacked entry whose companion bytes were not supplied remains
`unavailable`. REA continues analyzing embedded JavaScript and records the
missing native/resource bytes as unknown. The occurrence keeps
`hash_status: unavailable`; no content-addressed child artifact is created for
those missing bytes. See [MCP integrity handling](mcp-contracts.md#integrity-record-and-continue)
for the tool-result contract.

## Large results

Use MCP `detail: "summary"` for a large application, then read selected views of
the retained analysis. Summary changes delivery only. To reduce source parsing,
select exact [source paths](#select-sources-before-analysis).

If a complete response exceeds the transport budget, use its retained Evidence
ID for a summary, module page, or item, or export the bundle. See
[MCP tool results](mcp-contracts.md#tool-results) for delivery limits, export, and
matching server/client buffer settings. Follow-up results also need to fit that
budget. [Analyzer limits](#analyzer-and-result-admission) control analysis memory,
source deadlines, and semantic capacity separately.

## Recover partial analysis

A source timeout stops the remaining analysis and returns completed facts as
partial Evidence. Cancellation after source analysis begins can also retain
completed facts, including when interrupted during cleanup, graph construction,
or Evidence sealing. Unexamined relationships remain unknown.

MCP returns a `partial_observation` retained reference after recording succeeds;
open it with `inspect_analysis_view` on the same connection. If the SDK stopped
waiting before receiving the reply, follow [MCP cancellation recovery](mcp-contracts.md#progress-and-cancellation)
to find the record. CLI failure output contains the complete partial Evidence.
Owned analyzer cleanup is verified before private files are released; uncertain
cleanup retains ownership for retry and is reported separately.

## What is reconstructed

The projector reuses the content-addressed artifact inventory and safe artifact
readers. It retains canonical artifact-relative paths, exact byte counts,
SHA-256 digests, inventory IDs, ASAR container identity, and `.asar.unpacked`
status. Direct ASAR inputs and filesystem-backed ASAR files nested beneath a
directory are supported.

JavaScript sources (`.js`, `.jsx`, `.mjs`, and `.cjs`) and TypeScript sources
(`.ts`, `.tsx`, `.mts`, and `.cts`) are parsed as inert text; analysis does not
execute them.

JavaScript and HTML source ranges retain an initial UTF-8 BOM as one UTF-16
code unit, matching the original bytes identified by the artifact digest.

Plain `.ts` artifact sources use TypeScript syntax without JSX, including
angle-bracket type assertions. `.tsx` and `.jsx` retain JSX parsing.

Relative TypeScript imports can name their emitted `.js`, `.mjs`, or `.cjs`
counterparts while resolving to inventoried source files. This substitution
requires import or require semantics. Literal Electron preload, renderer, and
utility-process runtime paths retain the runtime filename selected by the caller.

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

Overloaded `.open` calls use lexical receiver facts: ambient browser window and
document receivers are treated as browsing-context or document operations,
while locally shadowed receivers can still contribute network endpoint
candidates. A template recovered with a parser error and no cooked value stays
dynamic; its raw spelling is not treated as a valid JavaScript string.

RPC client syntax also contributes network endpoint candidates, in both
`analyze_javascript_application` and `analyze_web_bundle`, distinguished by
`mechanism`:

- `trpc:procedure:<method>` records the static member path between the root
  expression and the method, such as `invoice.list` in
  `root.invoice.list.useQuery(...)`. tRPC proxies keep these property names
  through identifier minification. React hooks and TanStack option factories
  (`useQuery`, `useMutation`, `useInfiniteQuery`, `useSubscription`, suspense
  and prefetch variants, `queryOptions`, `infiniteQueryOptions`,
  `mutationOptions`, `subscriptionOptions`) are recognized directly. The
  vanilla `query` and `mutate` methods are recognized on a root bound to
  `createTRPCClient` or `createTRPCProxyClient` in the same lexical binding, or on a
  path of at least two segments in a source containing `TRPCClientError`,
  `trpc-accept`, or `/trpc`. Factory bindings must have one unconditional
  initializer and no binding assignments; shadowed locals do not inherit client
  identity. `subscribe` additionally requires a tRPC observer
  argument (`onData`, `onError`, `onStarted`, `onStopped`, `onComplete`, or
  `onConnectionStateChange`). `this` roots, browser globals, and any path
  containing an RTK Query `endpoints` segment are never procedures; cache-key
  helpers such as `queryKey` issue no request and are excluded.
- `trpc:link:<link>` records the literal `url` option of `httpLink`,
  `httpBatchLink`, `httpBatchStreamLink`, and `httpSubscriptionLink` when the
  link's callee name survives bundling, including `(0, module.httpBatchLink)`
  import-call wrappers.
- `graphql:query`, `graphql:mutation`, and `graphql:subscription` record a
  named operation found at the start of a string or cooked template literal —
  the name must be followed by variable definitions (`($`), a directive, or a
  selection set starting with a field name — or in a precompiled
  `OperationDefinition` document object. A graphql-tag `loc.source.body` copy is
  not reported twice. Anonymous operations are not reported.

A procedure path is the server-side procedure name, not a resolved URL; the
transport URL depends on the link configuration and batching. When the proxy is
reached through a member expression, such as a webpack module binding
(`l.S.invoice.list`) or a property holding the proxy (`o.api.post.byId`), the
recorded path keeps those leading carrier segments; the procedure path is its
suffix. Utility calls such as `useUtils().invoice.list.fetch()`, `useQueries`,
and links whose callee was renamed by a minifier are not recognized.

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
Unresolved option objects, bridge keys, API objects, and IPC channel expressions
remain unknown and make coverage partial.

Recognized literal module-table bootstraps also support bounded lexical
substitution through module exports, import helper bodies, local wrapper calls,
returned closures, object spreads, and callback parameters. Recovered Electron
paths retain source ranges, module identities, literal channels and branch
conditions as static candidates. Unknown spreads, reassigned bindings, accessors,
dynamic channels and unsupported syntax do not become exact implementations.
This pass neither executes the bundle nor proves that runtime guards pass.
An ambiguous or unresolved handler retains its channel registration but does
not acquire a path to one arbitrarily selected callback. Unknown factory
conditions retain both return branches, including fallthrough. Short-circuit
selection distinguishes truthiness from nullishness; uncertain `??` paths
retain a nullish guard rather than a falsy guard.

These paths appear as contextual `javascript-expression` nodes. An exact `api`
seed such as `desktop.copy` can trace an exposed member through a unique IPC
pairing to an external API call. `addListener` is normalized to `on`. Semantic
projection retains these boundary paths before bulk function definitions, within
the existing per-file node budget; omitted general semantics remain explicitly
partial. Wrapper expansion is bounded by one million visits/substitutions and
128 nested substitutions, with exhaustion reported as unknown coverage.

Electron API identity follows proven lexical module aliases. Namespace interop
also preserves identity when the complete Rolldown helper operations, lexical
roles, live getters, and captured intrinsic origins match, or when a stable
helper simply returns its module parameter. Harmless single-statement control
blocks preserve recognition; added operations still require proof. Literal
member and destructuring projections are retained from proven results.
Omitted or literal node-mode arguments preserve named exports; a module-valued
default projection requires a truthy literal node mode. Computed or extra
arguments remain unresolved.
Recognition uses structure rather than emitted names; other helper bodies and ambiguous
runtime fallbacks remain unresolved. Captured function identities survive later global-property
replacement, including copies through initialized aliases. Reads before an
alias initializer remain unresolved. Visible intrinsic writes before capture or
conversion are checked in their owning callable scope, including identifier leaves in nested/default/rest
destructuring and loop targets. Property keys and shadowed local bindings do not
overwrite the global intrinsic identity. Cross-call side effects, including
writes inside directly invoked local functions, are not evaluated. Other
reassignments, dynamic selections, and visibly overwritten namespace members
are unresolved.
Known Object/Reflect mutators remain recognizable through literal destructuring
of intrinsic objects and stable bound-function aliases. Calls retain bound
argument prefixes and the original bound receiver through `call`, `apply`, and
`Reflect.apply`, including generic `Function.prototype` invocation and binding
creation. Arguments follow each actual callable invocation rather than property
chain depth; rebinding retains the original bound receiver.
Visibly replaced invocation intrinsics produce unknown effects instead
of using their former call semantics; captured function aliases retain their
earlier identity. Unexamined targets remain unresolved. `Reflect.set` examines
its explicit receiver as well as its target, retaining unknown receiver effects.
Creating an unused binding does not itself mutate an intrinsic. Variable
redeclarations retain a single unconditional initializer
when they introduce no assignment or second initializer.
Stable identifier chains to fresh object, array, function,
undecorated class or RegExp syntax keep those targets separate from intrinsic
objects when initialized before use; opaque, decorated, reassigned or
not-yet-initialized targets remain unresolved. Writes during class initialization
are still retained. Function declarations are available before their textual
position; variable and class initializers must precede use.
Direct and destructuring assignment, loop, update, and delete targets are checked
through namespace aliases; unrelated member writes do not discard observed API
identity. This static check does
not evaluate arbitrary call side effects or runtime registration. Missing findings
do not establish that an application has no Electron boundary usage.

IPC pairing is an inference, not an observation. A renderer `invoke` pairs only
with one unique `ipcMain.handle`/`handleOnce` candidate on the same exact literal
channel; a renderer send pairs only with one unique `ipcMain.on`/`once`/`addListener`
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

Semantic evaluation retains at most 256 distinct primitive candidates per
expression and at most 1 MiB of worst-case JSON string bytes across a normalized
primitive value's string candidates. The byte budget estimates six JSON bytes
per UTF-16 code unit, the expansion bound for escaped strings, and bounds both
retained candidate strings and temporary canonical-key serialization. This is
an in-memory semantic allocation bound independent of CLI or MCP transport
budgets. Source literal bytes remain in the parsed source and artifact evidence;
when a normalized semantic value exceeds the bound, its value is unknown and
coverage is partial. Expression
evaluation and provenance walks stop after 256 nested levels. Union products
and string lengths are checked before allocating combinations or concatenated
strings. When a boundary is reached, the value stays unknown, semantic coverage
becomes partial, and graph evidence retains the expression location and typed
limiting reason. The number of unresolved alternatives is unknown; it is not
reported as an exact omission count.

Byte, entry, path, and graph-shape bounds are hard limits. The parse deadline is
checked before and between bounded parsing and traversal phases; the synchronous
Babel and JSON parser calls cannot be preempted mid-call, so their input byte
bounds remain the hard protection for an individual call.

Byte-identical assets share a content-digest node. Every distinct observation
and inventoried containment edge is retained. If parsing or artifact safety
boundaries omit input, coverage reports that omission; when an exact omission
count is not knowable, `omitted_count` is `null` rather than a guessed value.

### Analyzer and result admission

Application analysis projects semantic relationships one source file at a time.
After projection, it retains only the lexical module facts and exported return
shapes needed to build application relationships. Full source IR does not stay
resident for every file together. Callable ownership and contained-reference
queries use per-file range indexes, while call sites use exact-range lookups.
Existing node budgets and coverage reporting remain in effect.

Progress identifies the source file being parsed and projected. Cancellation is
checked between files and throughout result transfer. The owned analyzer can
be stopped while its synchronous parser or semantic extractor is active;
the CLI/MCP process remains available for control requests.

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

Other CLI formats and `--token-count` still assemble whole strings.
Field selection remains useful when the caller needs a
smaller view, for example `--format json --filter-output
evidence_id,normalized_result.statistics`. Streaming output does not bound the
memory needed to construct the analysis graph itself.

JavaScript source parsing, static analysis and semantic projection run in one
owned analysis process, reused sequentially across files. Target code is never
executed. The analyzer defaults to 1024 MiB of V8 old-space and a 300000 ms
deadline per source, including startup and fact transfer. Select
`max_heap_mb` and `analysis_timeout_ms` through MCP, or `--max-heap-mb` and
`--analysis-timeout-ms` on the dedicated CLI command. These choices control the
analyzer; the caller's `NODE_OPTIONS` still controls the CLI/MCP process heap.
V8 old-space limits do not impose a process RSS limit. When REA runs on Bun,
the analyzer ignores the V8 heap flags; resource failures then report
`worker_heap_limit_bytes` as null instead of a requested or V8-reported limit.
On Windows, the analyzer's owned Job Object instead limits its committed
memory to `max_heap_mb` plus a 512 MiB reserve for Bun itself (1536 MiB by
default). Reaching it fails the current source with the same memory resource
failure and reports `worker_process_memory_limit_bytes`, also a coverage limit;
the next source starts a new analyzer. Bun elsewhere enforces no analyzer limit.

The default semantic capacities are 100000 nodes across the application and
20000 per source. Large bundles may explicitly select `max_semantic_nodes` and
`max_semantic_nodes_per_file` (CLI: `--max-semantic-nodes` and
`--max-semantic-nodes-per-file`), each from 1 to 1000000. The per-file offer is
also bounded by the remaining application capacity. Raising these controls does
not bypass worker heap, execution deadline or parent result admission. Truncated
coverage reports both effective node ceilings; omitted relationships remain
unknown.

While sources remain, the sequential worker reserves one next compact static
checkpoint at its 8 MiB bound with the same 6x retention expansion used at
admission. Earlier checkpoints are already charged to retained bytes; the
remaining inventory does not multiply the reserve. Streamed file transfers keep the default 512 MiB
allowance, and can grow with the parent's offered retention budget (8x byte
expansion), up to 2 GiB. Individual records remain bounded to 8 MiB. The parent
still independently checks actual bytes, record overhead, digests and source
identities before adopting results.

A source that exhausts the analyzer heap does not terminate the CLI/MCP
process. Completed static facts are retained, other files can still be analyzed,
and unexamined semantic relationships remain explicit unknowns. The parent
also checks transfer expansion and accumulated results against its remaining
heap before accepting semantic facts. A resource-limited result has partial
coverage, the observed limits and an `analyze-javascript-source` unknown scope
with the specific failure, including captured diagnostics when available.
Resource failures do not increment syntax parse failures. There is no fixed
source-length cutoff.

Static observations also need memory when expanded into nodes, relationships
and Evidence. If that expansion does not fit, the file node retains
`static_analysis` and any admitted `semantic_module_analysis` observations,
including their exact values and source locations. Use the public modules item
view to read them. The graph marks those unexpanded relationships as unknown.
If cumulative result capacity is exhausted, analysis stops; inventoried but
unexamined files remain present with explicit unknown scopes.

### Large local JSON inputs

CLI workflows parse larger JSON input files incrementally from one verified
regular-file handle, without constructing a document-sized string. Smaller
files retain native JSON parsing. Both paths require strict JSON and valid
UTF-8, and return one complete value; the assembled object still needs memory.
An individual JSON string exceeding the native length limit or the available
heap headroom for assembly returns
`resource_constraint` with `input_reason: "too-large"`. Supply a smaller valid
value; for Evidence workflows, re-analyze a smaller selection of the original
target and use its complete Evidence. Splitting JSON text or trimming Evidence
fields does not produce a valid workflow input.

Evidence bundle and analysis snapshot file readers still decode whole
documents. Their runtime string-limit failures report a resource constraint
with the selected path, observed bytes and UTF-16 limit, rather than malformed
JSON.

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

URI schemes are classified independently of local file names: a reference such
as `web3:app.js` remains external even when an artifact has that literal name.
Scheme characters may include digits after the initial letter; a relative path
such as `./web3:app.js` still names a local artifact.

Package `exports` fallback arrays are supported both at the top level and under
the root `"."` entry. The resolver selects targets in declared order using the
same conditional and invalid-entry handling as nested exports arrays.
Nonempty arrays containing only inactive conditions remain unmatched, allowing
the enclosing condition object to continue to a later active condition.
Empty arrays and explicit null targets keep their blocking outcome.
Refusal evidence distinguishes those source values and retains condition names
from unmatched nested targets rather than reporting array indices.
For imports and requires, the active Node conditions include `module-sync`;
earlier active conditions retain precedence over later ones.

Package self-references use the importer's enclosing package scope before
installed dependencies. ESM requires the parsed package name to equal the
metadata name; a scope-only name such as `@scope` cannot capture `@scope/pkg`.
CommonJS retains Node's raw-request name/prefix matching. Both paths preserve
the original specifier and select exports under their own loader conditions.

Exact package-private `#alias` specifiers resolve against the importer's
enclosing `package.json` `imports` map — the nearest same-container package
scope, stopping at a `node_modules` directory so a nested package cannot inherit
an ancestor's aliases. Selected targets are package-local `./` files with no
extension or index fallback, using the same condition, array, and null selection
as exports subpaths. A missing key, explicit null, or out-of-scope alias keeps
an unresolved edge with that reason. Wildcard keys (`#internal/*`), recursive
`#` targets, and external-package import targets remain unresolved.

Exact keys such as `#/x` are literal lookup identities. `#` and names ending
in `/` are invalid. Imports arrays skip invalid parent-relative, absolute, and
URL targets before selecting a later package-local file; an unsupported bare
package or recursive alias keeps its unresolved outcome rather than selecting
a later fallback.

ESM relative module paths, legacy package subpaths without exports, and selected
package exports targets use URL suffix handling and one percent-decoding pass.
Bare specifiers retain their complete query/fragment text for exports key matching.
For dependency lookup, ESM constructs a package metadata URL instead of treating
the parsed package name as a literal directory. A root request such as `legacy?x`
does not load either `node_modules/legacy?x` or `node_modules/legacy`; an exact
self-reference with that metadata name can still select its exports first.
Without an exports map, ESM subpaths select exact files; directory imports and
extension fallback are refused. CommonJS relative paths and legacy package main
fields retain literal filename punctuation. Exports targets must start with
`./` and exclude `.`, `..`, and `node_modules` path segments, including their
encoded forms, before URL normalization. Arrays skip invalid exports targets
in declared order, including URLs that escape the package root after normalization.
Selected package targets use the normalized URL path for lookup; tabs and
newlines in the URL text are removed by the URL parser. CommonJS package targets
reject encoded separators anywhere in the selected URL; ESM checks its pathname.
URL decoding and file lookup failures for a selected target do not select a
later entry. Rejected references retain the package metadata
path, original target, failed constraint, and importing source location.

HTML script references resolve to exact inventoried files after applying the
document base and query/fragment rules. As in a browser, the script URL and base
href are read without surrounding whitespace or embedded tabs and newlines, and
their percent-encoded path bytes are decoded; encoded dot and separator bytes
are still rejected. CommonJS module lookups retain extension and directory
resolution.
Unresolved HTML references retain their declaration, source range, and resolution
reason in the renderer observations.
HTML script source ranges follow the HTML parser across LF, CRLF, and bare CR
line endings, preserving UTF-16 columns.
