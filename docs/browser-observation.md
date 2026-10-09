# Website observation with CDP

Captured Debugger sources can be exported for REA's existing static JavaScript
analysis with `export_web_scripts`. See [captured website scripts](website-script-export.md)
for the capture options, source mappings, and browser/local resolution limits.
Use [captured module relationships](website-module-trace.md) to resolve one
exported script's native imports under an explicit URL/import-map context.

REA can attach to a user-owned Chrome-family browser through the Chrome DevTools Protocol (CDP) and produce bounded Evidence about an existing page. This is a passive reverse-engineering capability, not a general browser automation or remote-control surface.

## Shipped surfaces

- `list_browser_targets` / `rea list-browser-targets` discovers all eligible page targets at the endpoint by default, with an optional exact-origin filter.
- `inspect_web_page` / `rea inspect-web-page` captures DOM structure, accessibility nodes, scripts, resources, safe response/DOM metadata, attach-window network and console metadata, WebSocket frame sizes, workers, quota, and optionally selected storage key names, redacted storage-content fingerprints, or script sources.
- `analyze_web_bundle` / `rea analyze-web-bundle` parses selected script artifacts without execution and derives chunk edges, route and endpoint candidates, vendor fingerprints, static WebMCP declarations, and optionally source-map/original-source evidence.
- `observe_web_session` / `rea observe-web-session` arms an observation window of the requested duration for an external user action and records ordered reload, SPA navigation, redirect, failure, lifecycle, and target-termination metadata.
- `discover_webmcp_tools` / `rea discover-webmcp-tools` uses the experimental CDP WebMCP domain to return every in-scope registration and its complete observed `input_schema` declaration and canonical `input_schema_sha256` digest inline. Declarations are untrusted JSON data, including declared types, required fields, enums, examples and reference URLs. REA does not resolve schema references. These fields replace `input_schema_shape`. Registrations with the same name and URL in distinct observed frames retain separate identities. `tool_key` includes the observed frame ID; it is not a stable identity across navigation or browser sessions. Same-frame registration updates replace that owner only, and removal leaves other owners intact. REA never exposes `WebMCP.invokeTool`; malformed protocol payloads fail explicitly instead of returning incomplete tool metadata.
- `compare_web_captures` / `rea compare-web-captures` compares passive captures or exact-step-aligned browser scenarios. Scenario results commit reproducible literal normalization and expose alignment failures plus artifact-level action, screenshot, DOM, accessibility, URL, history, storage, and event differences. Missing or truncated evidence is never treated as equivalence.
- `capture_web_screenshot` / `rea capture-web-screenshot` returns a content-addressed visible-viewport PNG.
- `compare_web_screenshots` / `rea compare-web-screenshots` performs bounded local PNG pixel comparison without OCR or external services.
- Every surface has equivalent CLI and MCP contracts and returns Evidence provenance.
- MCP tools return complete results inline and include the Evidence ID. Session evidence can be exported with `export_evidence_bundle`.

Target discovery returns the complete in-scope target array in one result.

Electron `file://` pages use a separate provider and target boundary; see [electron-observation.md](electron-observation.md).

## Provider authorities

CDP page capture, V8 Inspector observation, and Playwright scenarios stay
separate providers because their authorities differ: CDP and V8 attach to an
already-running target and never launch, drive, evaluate, or mutate it, while
Playwright providers own and drive the runtime (launch browsers, run actions,
capture step snapshots). Merging them would mix attach-only and owned-process
lifecycles in one contract. What they share instead is one exclusion
vocabulary (`BrowserExclusionReason`): every denial reason in every stack maps
onto it, even where a wire schema keeps a narrower historical bucket.
Existing static application Evidence and passive web/Electron captures can be
combined later through
[JavaScript static/runtime reconciliation](javascript-runtime-reconciliation.md).

## Start a browser

Start a separate browser profile with an explicit debugging port. The exact executable name varies by platform and installation:

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/rea-browser-profile \
  http://127.0.0.1:3000
```

REA does not launch, own, or terminate this browser. Use a dedicated profile and stop it yourself when the investigation is complete. Do not expose the debugging port on a non-loopback interface.

## Request boundary

Discovery supplies a literal loopback CDP endpoint and returns all eligible
page targets unless an exact HTTP(S) origin filter narrows the result. Follow-up
inspection requests select one target; their default scope is its current origin. `localhost`, private-LAN
addresses, HTTPS CDP endpoints, credentials, paths, queries, fragments, and
implicit ports are not valid CDP endpoints. Origin filters contain only scheme,
host, and port; paths, credentials, queries, fragments, and wildcards are not
valid origins.

## CLI workflow

Pass the endpoint and selected target for each call. An origin filter is
optional and narrows the target set.

```bash
rea list-browser-targets http://127.0.0.1:9222 --json
rea inspect-web-page http://127.0.0.1:9222 TARGET_ID \
  --observation-ms 1000 \
  --json
```

Static bundle analysis and a user-driven observation window are separate operations:

```bash
rea analyze-web-bundle http://127.0.0.1:9222 TARGET_ID \
  --json
rea observe-web-session http://127.0.0.1:9222 TARGET_ID \
  --observation-ms 10000 --json
rea discover-webmcp-tools http://127.0.0.1:9222 TARGET_ID \
  --json
```

Accessibility names/descriptions, console primitive text, JSON body shapes, WebSocket shapes, script content, and storage key names are selected independently:

```bash
rea inspect-web-page http://127.0.0.1:9222 TARGET_ID \
  --include-accessibility-text \
  --include-console-text \
  --include-json-body-shapes \
  --include-websocket-shapes \
  --include-script-sources \
  --include-storage-keys --include-storage-fingerprints \
  --json
```

Accessibility text, script content, query values, and explicitly requested primitive console text may contain application secrets and become part of the returned Evidence. URL username/password credentials are removed; ordinary query values, fragments, and parameter order remain intact. JSON and WebSocket captures retain complete paths, types, and counts, never values or examples. Storage values remain redacted even when key-name capture is requested. `--include-storage-fingerprints` requests SHA-256 identity/value fingerprints, which support comparison only when cookies, DOM storage, IndexedDB, and Cache Storage were all captured completely.

Screenshot capture returns the complete visible viewport as an inline image artifact:

```bash
rea capture-web-screenshot http://127.0.0.1:9222 TARGET_ID \
  --json
```

## MCP input

```json
{
  "cdp_endpoint": "http://127.0.0.1:9222",
  "target_id": "TARGET_ID_FROM_LIST_BROWSER_TARGETS"
}
```

The omitted observation window and capture options use conservative defaults.
Set an option only when the investigation needs that additional content.
Collection counts are not capped. Per-value validation, the selected observation
window, and CDP protocol limits still apply; any incomplete or truncated values
are reported in the result.

Call `list_browser_targets` first because target IDs are browser-instance-specific. REA rechecks the selected target's current type and origin immediately before attaching. Without an origin filter, discovery lists all eligible pages; an individual capture defaults to the selected page's current origin.

REA establishes a main-frame origin boundary before enabling Runtime, Debugger, or Network observation, rechecks it before document capture, and validates it again afterward. If the main frame navigates during final capture, REA discards the mixed result and returns `target_changed`.

## Data minimization

REA retains local observation data and removes only URL userinfo credentials, explicitly declared scenario secrets, and values from structured credential/storage fields:

- URL observations preserve the complete local URL, including query values, fragments, duplicate parameters, and their order. Only username/password userinfo is removed; malformed original URL strings remain available with `origin: null`.
- DOM snapshots retain node types, node names, value lengths, and attribute names, but not text or attribute values.
- Accessibility structure and roles are retained by default, while names and descriptions require `include_accessibility_text: true`.
- Network observations retain method, status, MIME type, size, type, initiator stack location, and complete URLs with userinfo credentials removed. Redirects reported by CDP are attached as ordered `redirects` on the one request ID, with the prior request URL, CDP response URL, method/type, response status/MIME/encoded length, request timestamp, and the next `requestWillBeSent` event timestamp. CDP delivers `redirectResponse` with that next request event, so the latter is an event boundary rather than an exact response timestamp. Redirect response headers and bodies are discarded; hops outside the selected origins are discarded with the request chain. Headers are discarded after an allowlisted projection of length/encoding, structured CSP/Link/policy fields, and untrusted agent hints. Cookies and authorization headers are never retained.
- Request/response bodies are not requested or parsed by default. When selected, only allowed-origin JSON media types are read, converted immediately to complete value-free typed paths, types and observation counts, and discarded. Each path segment is either `{ "kind": "property", "name": "raw property name" }` or `{ "kind": "array-element" }`; array-element types include primitives and nested arrays. Literal `*` properties remain distinct from array elements. `Network.getResponseBody` is never sent unless JSON body shape capture is selected. Comparison uses body shapes only when both captures selected them, and compares request/response shapes only where both observations provide those facts. Unavailable or truncated selected coverage makes equivalence unknown; observed differences still report changed.
- Console observations with a stack source retain call type, argument types, timestamp, and source location. When console text capture is selected, already-delivered primitive values are retained verbatim; objects, getters, and remote properties are never expanded.
- WebSocket observations retain direction, opcode, and payload byte length. When shape capture is selected, text frames are classified as text or complete value-free JSON shape; binary bytes, hashes, prefixes, and raw frames are never retained.
- Storage observations always redact values. Key names, IndexedDB names, and cache names require `include_storage_keys`; stable content fingerprints require the additional `include_storage_fingerprints` selection. Cookie fingerprints cover cookies applicable to the current main-frame URL, including its path, rather than every cookie path on that origin. Other storage remains scoped to the origin. Cache bodies above 64 KiB and partial IndexedDB remote objects make fingerprint coverage incomplete, so identical observations remain `unknown`.
- Script metadata is included only when CDP supplies a URL on an allowed origin. Stable keys exclude transient CDP script IDs, and exact transient raw URLs are used only during script/resource reconciliation. URL-less scripts are excluded because their origin cannot be established. When CDP supplies an execution-context association, the accepted script retains its authorized frame ID for later attribution. Script metadata admission bounds retained identity and source-map strings to 8 MiB and 50,000 records. When a source-map URL cannot fit, the script identity remains and source-map coverage reports `resource_budget_exhausted`; rejected script observations are counted without retaining their IDs. Source content is omitted unless explicitly requested and is returned inline as a self-verifying artifact with its SHA-256 digest.

Frames, resources, scripts, events, and workers outside the selected origin scope are excluded. An explicit `allowed_origins` list can include additional origins; excluded target details are counted without being exposed.
Retained workers include validated opener-target and parent-frame IDs when CDP
provides them; these relationships do not expand the exact-origin boundary or
prove static module ownership.

## Completeness and limits

The default inspection window is 500 ms; callers choose its duration. The
capture returns in-scope frames, DOM and accessibility nodes, admitted scripts,
resources, workers, storage names, and observed network, console, and WebSocket
events. Full selected text, script sources, and JSON shapes are returned inline.
The result distinguishes
`complete_within_window`, `policy_filtered`, `attach_limited`, and `truncated`
coverage. It reports excluded items and any values omitted or truncated by
validation and resource bounds. Omitted script metadata makes its affected
section explicitly truncated.
Disallowed-origin entries are filtered before retention.

CDP discovery, WebSocket connection, and commands continue until the peer responds or the caller cancels the operation; REA has no internal byte, message-count, or pending-command quota for these exchanges. Without caller cancellation, a stalled peer can leave an operation waiting. On cancellation, REA closes only its own WebSocket, waiting up to one second before terminating it. Malformed unsolicited events and malformed replies to pending commands poison the connection so later commands fail closed. When a correlated reply reports a session ID, it must match the command's selected session. An optional method is reported unavailable only when the browser rejects it as unknown; other command rejections retain their reported failure.

Network and console coverage starts only after REA attaches and enables the relevant CDP domains. `prior_activity_available` is always `false`; absence from these arrays is not evidence that an event never occurred. If CDP reuses a request ID without supplying redirect metadata, REA retains the predecessor observation and marks network coverage incomplete.

Source maps are not fetched by inspection. Bundle analysis fetches them only when `fetch_source_maps` is selected, with exact-origin redirect checks and no credentials, cookies, or referrer. Each fetch operation has a 30-second deadline and a 64 MiB aggregate streamed-response budget across redirects. A deadline or byte-limit failure remains explicitly unavailable and makes bundle completeness partial. Source-map decoding also bounds raw resolved identities to 64 MiB and aggregate inline evidence to 32 MiB. Failed maps preserve their failure context when it fits; if another context cannot fit, collection stops with the full requested count, the returned processed count, and an explicit unknown-results limitation. Retained mappings and original sources are returned inline. See [source-location limits](web-source-location.md) for the structural decoder bounds. Original source artifacts with `.ts`, `.tsx`, `.mts`, or `.cts` suffixes carry `text/typescript`; other source names retain `text/javascript`.

## Non-goals and threat model

The browser provider deliberately does not expose generic CDP commands, `Runtime.evaluate`, WebMCP invocation, navigation, input, downloads, page closure, or browser closure. Screenshot capture is the sole pixel surface and returns an image only when requested. REA disables the domains it enabled, detaches the target session, and closes only its own WebSocket.

This feature is not a browser sandbox or network containment mechanism. The attached page and browser continue running with their existing privileges and may make external requests independently of REA. CDP gives deep access to the selected browser profile, so use a dedicated profile, include only origins you intend to inspect, and treat other same-user processes as outside this boundary.

Response metadata normalizes a `Referrer-Policy` fallback list to its last recognized nonempty policy, including mixed-case tokens. Unknown policy names are skipped; malformed token syntax and lists without a recognized policy remain `null`. This reports the response's declared policy, not the effective policy of a document or an inferred browser default.
