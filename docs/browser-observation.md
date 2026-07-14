# Website observation with CDP

REA can attach to a user-owned Chrome-family browser through the Chrome DevTools Protocol (CDP) and produce bounded Evidence v2 about an existing page. This is a passive reverse-engineering capability, not a general browser automation or remote-control surface.

## Shipped surfaces

- `list_browser_targets` / `rea list-browser-targets` discovers page targets whose current URL matches an approved exact origin.
- `inspect_web_page` / `rea inspect-web-page` captures bounded DOM structure, accessibility nodes, scripts, resources, safe response/DOM metadata, attach-window network and console metadata, WebSocket frame sizes, workers, quota, and optionally storage key names or script sources.
- `analyze_web_bundle` / `rea analyze-web-bundle` parses approved script artifacts without execution and derives chunk edges, route and endpoint candidates, vendor fingerprints, static WebMCP declarations, and optionally approved source-map/original-source evidence.
- `observe_web_session` / `rea observe-web-session` arms a bounded window for an external user action and records ordered reload, SPA navigation, redirect, failure, lifecycle, and target-termination metadata.
- `discover_webmcp_tools` / `rea discover-webmcp-tools` uses the experimental CDP WebMCP domain to inventory page registrations. REA never exposes `WebMCP.invokeTool`.
- `compare_web_captures` / `rea compare-web-captures` compares stable DOM, script, resource, network, metadata, and optional WebMCP identities without treating incomplete absence as equivalence.
- `capture_web_screenshot` / `rea capture-web-screenshot` returns an explicitly approved, bounded, content-addressed visible-viewport PNG.
- `compare_web_screenshots` / `rea compare-web-screenshots` performs bounded local PNG pixel comparison without OCR or external services.
- Every surface has equivalent CLI and MCP contracts and returns Evidence v2 provenance.
- MCP session results are retained as `rea://evidence/{evidenceId}` resources. One-shot CLI output is not retained by a long-lived REA session.

Electron `file://` pages use a separate provider, permission capability, and root model; see [electron-observation.md](electron-observation.md).

## Start a browser

Start a separate browser profile with an explicit debugging port. The exact executable name varies by platform and installation:

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/rea-browser-profile \
  http://127.0.0.1:3000
```

REA does not launch, own, or terminate this browser. Use a dedicated profile and stop it yourself when the investigation is complete. Do not expose the debugging port on a non-loopback interface.

## Configure authority

Browser observation is fail-closed by default. Configure the administrator ceiling before starting REA:

```bash
export REA_BROWSER_OBSERVE_ENABLED=true
export REA_BROWSER_CDP_ENDPOINTS_JSON='["http://127.0.0.1:9222"]'
export REA_BROWSER_ALLOWED_ORIGINS_JSON='["http://127.0.0.1:3000"]'
```

`REA_BROWSER_CDP_ENDPOINTS_JSON` accepts at most 16 literal `http://127.0.0.1:PORT` or `http://[::1]:PORT` endpoints. `localhost`, private-LAN addresses, HTTPS endpoints, credentials, paths, queries, fragments, and implicit ports are rejected.

`REA_BROWSER_ALLOWED_ORIGINS_JSON` accepts at most 32 exact HTTP(S) origins. Paths, credentials, queries, fragments, and wildcards are rejected. An input must stay within both this administrator ceiling and any active project/session/once grant.

Configuration is reloadable through the existing `SIGHUP` permission-policy path. A request still requires `approved: true`; configuration alone does not make a tool call implicit.

Inspect the exact effective scope without contacting the browser:

```bash
rea policy explain browser_observe \
  --origins http://127.0.0.1:9222 \
  --origins http://127.0.0.1:3000 \
  --network loopback \
  --json
```

## CLI workflow

Configured origins are used by default. `--allowed-origins` can request a narrower set that still fits the configured ceiling.

```bash
rea list-browser-targets http://127.0.0.1:9222 --approved --json
rea inspect-web-page http://127.0.0.1:9222 TARGET_ID \
  --approved \
  --observation-ms 1000 \
  --json
```

Static bundle analysis and a user-driven observation window are separate operations:

```bash
rea analyze-web-bundle http://127.0.0.1:9222 TARGET_ID \
  --approved --source-capture-approved --json
rea observe-web-session http://127.0.0.1:9222 TARGET_ID \
  --approved --observation-ms 10000 --json
rea discover-webmcp-tools http://127.0.0.1:9222 TARGET_ID \
  --approved --json
```

Accessibility names/descriptions, console primitive text, JSON body shapes, WebSocket shapes, script content, and storage key names require separate opt-ins. Console/body/WebSocket capture additionally requires its matching approval flag:

```bash
rea inspect-web-page http://127.0.0.1:9222 TARGET_ID \
  --approved \
  --include-accessibility-text \
  --include-console-text --console-text-approved \
  --include-json-body-shapes --json-body-schema-approved \
  --include-websocket-shapes --websocket-shape-approved \
  --include-script-sources \
  --include-storage-keys \
  --json
```

Accessibility text and script content may contain application secrets and become part of the returned Evidence. Accessibility and console text have independent per-field and aggregate UTF-8 byte limits; credential-shaped console substrings are redacted. JSON and WebSocket captures retain paths, types, counts, and truncation only, never values or examples. Storage values remain redacted even when key-name capture is approved.

Screenshot pixels require both `--approved` and `--screenshot-approved`:

```bash
rea capture-web-screenshot http://127.0.0.1:9222 TARGET_ID \
  --approved --screenshot-approved --json
```

## MCP input

```json
{
  "cdp_endpoint": "http://127.0.0.1:9222",
  "allowed_origins": ["http://127.0.0.1:3000"],
  "target_id": "TARGET_ID_FROM_LIST_BROWSER_TARGETS",
  "approved": true,
  "observation_ms": 500,
  "include_accessibility_text": false,
  "include_console_text": false,
  "console_text_approved": false,
  "include_json_body_shapes": false,
  "json_body_schema_approved": false,
  "include_websocket_shapes": false,
  "websocket_shape_approved": false,
  "include_script_sources": false,
  "include_storage_keys": false
}
```

Call `list_browser_targets` first because target IDs are browser-instance-specific. REA rechecks the selected target's current type and origin immediately before attaching.

REA establishes an authorized main-frame boundary before enabling Runtime, Debugger, or Network observation, rechecks it before document capture, and validates it again afterward. If the main frame navigates during final capture, REA discards the mixed result and returns `target_changed`.

## Data minimization

REA removes sensitive values before normalized event data is retained:

- URLs retain a bounded path and at most 256 bounded query parameter names, replace every retained query value with `[REDACTED]`, and remove credentials and fragments.
- DOM snapshots retain node types, node names, value lengths, and attribute names, but not text or attribute values.
- Accessibility structure and roles are retained by default, but names and descriptions require `include_accessibility_text: true` and remain byte-bounded.
- Network observations retain method, status, MIME type, size, type, initiator stack location, and redacted URLs. Headers are discarded after an allowlisted projection of length/encoding, structured CSP/Link/policy fields, and untrusted agent hints. Cookies and authorization headers are never retained.
- Request/response bodies are not requested or parsed by default. With independent approval, only allowed-origin JSON media types are read within per-body and aggregate budgets, converted immediately to value-free property paths/types, and discarded. `Network.getResponseBody` is never sent without that approval.
- Console observations with an approved stack source retain call type, argument types, timestamp, and redacted source location. With independent approval, only already-delivered primitive values are retained after credential redaction and byte bounds; objects, getters, and remote properties are never expanded.
- WebSocket observations retain direction, opcode, and payload byte length. With independent approval, bounded text frames are classified as text or value-free JSON shape; binary bytes, hashes, prefixes, and raw frames are never retained.
- Storage observations always redact values. Key names, IndexedDB names, and cache names are omitted unless explicitly requested.
- Script metadata is included only when CDP supplies a URL on an allowed origin. Stable keys exclude transient CDP script IDs, and exact transient raw URLs are used only during script/resource reconciliation. URL-less scripts are excluded because their origin cannot be established. Source content is omitted unless explicitly requested and becomes a self-verifying `rea://web-content/sha256/...` artifact subject to per-script and aggregate byte limits.

Cross-origin frames, resources, scripts, events, and workers are excluded unless their exact origins are also approved. Excluded target details are counted without being exposed.

## Completeness and limits

The default observation window is 500 ms and the maximum is 10 seconds. Frames (200), DOM nodes (2,000), accessibility nodes (2,000), scripts (200), resources (2,000), workers (500), and each storage key/name inventory (1,000) have conservative defaults and caller-visible hard bounds. Script source bytes, network events, console events, and WebSocket events are bounded separately. The CLI exposes the same limits as kebab-case options such as `--max-frames` and `--max-storage-keys`.

Every result distinguishes `complete_within_window`, `policy_filtered`, `attach_limited`, and `truncated` coverage. It names affected sections and reports sparse excluded-item and per-event-type dropped counts rather than implying exhaustive capture. Disallowed-origin entries are filtered before collection-limit accounting, so they cannot consume an approved origin's output budget.

CDP discovery, WebSocket connection, and each command have a 5-second timeout. Version discovery is capped at 64 KiB, target discovery at 2 MiB and 1,000 targets, each WebSocket message at 16 MiB, and correlated pending commands at 128. Malformed unsolicited protocol events poison the connection so later commands fail closed.

Network and console coverage starts only after REA attaches and enables the relevant CDP domains. `prior_activity_available` is always `false`; absence from these arrays is not evidence that an event never occurred. Source maps are not fetched by inspection. Bundle analysis can fetch them only after separate approval, with exact-origin redirect checks, no credentials/cookies/referrer, per-map and aggregate byte limits, a total map-count limit, v3 validation, and bounded generated/original mappings. Source-map results report requested, processed, and dropped counts rather than hiding budget truncation.

## Non-goals and threat model

The browser provider deliberately does not expose generic CDP commands, `Runtime.evaluate`, WebMCP invocation, navigation, input, downloads, page closure, or browser closure. Screenshot capture is the sole pixel surface and requires separate literal approval. REA disables the domains it enabled, detaches the target session, and closes only its own WebSocket.

This feature is not a browser sandbox or network containment mechanism. The attached page and browser continue running with their existing privileges and may make external requests independently of REA. CDP gives deep access to the selected browser profile, so use a dedicated profile, approve only origins you intend to inspect, and treat other same-user processes as outside this boundary.
