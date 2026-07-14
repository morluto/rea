# Website observation with CDP

REA can attach to a user-owned Chrome-family browser through the Chrome DevTools Protocol (CDP) and produce bounded Evidence v2 about an existing page. This is a passive reverse-engineering capability, not a general browser automation or remote-control surface.

## Shipped surfaces

- `list_browser_targets` / `rea list-browser-targets` discovers page targets whose current URL matches an approved exact origin.
- `inspect_web_page` / `rea inspect-web-page` captures bounded DOM structure, accessibility nodes, scripts, resources, attach-window network and console metadata, WebSocket frame sizes, workers, quota, and optionally storage key names or script sources.
- Both surfaces return the same provider-neutral normalized results and Evidence v2 provenance.
- MCP session results are retained as `rea://evidence/{evidenceId}` resources. One-shot CLI output is not retained by a long-lived REA session.

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

Script content and storage key names require separate opt-ins:

```bash
rea inspect-web-page http://127.0.0.1:9222 TARGET_ID \
  --approved \
  --include-script-sources \
  --include-storage-keys \
  --json
```

Script content may contain application secrets and becomes part of the returned Evidence. Storage values remain redacted even when key-name capture is approved.

## MCP input

```json
{
  "cdp_endpoint": "http://127.0.0.1:9222",
  "allowed_origins": ["http://127.0.0.1:3000"],
  "target_id": "TARGET_ID_FROM_LIST_BROWSER_TARGETS",
  "approved": true,
  "observation_ms": 500,
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
- Network observations retain method, status, MIME type, size, type, and redacted URLs, but not request/response headers, bodies, post data, cookies, or response content.
- Console observations with an approved stack source retain call type, argument types, timestamp, and redacted source location, but not argument values or descriptions. Events without a source URL are excluded because their origin cannot be established.
- WebSocket observations retain direction, opcode, and payload byte length, but not payload content.
- Storage observations always redact values. Key names, IndexedDB names, and cache names are omitted unless explicitly requested.
- Script metadata is included only when CDP supplies a URL on an allowed origin. URL-less scripts are excluded because their origin cannot be established. Source content is omitted unless explicitly requested and remains subject to per-script and aggregate byte limits.

Cross-origin frames, resources, scripts, events, and workers are excluded unless their exact origins are also approved. Excluded target details are counted without being exposed.

## Completeness and limits

The default observation window is 500 ms and the maximum is 10 seconds. Frames (200), DOM nodes (2,000), accessibility nodes (2,000), scripts (200), resources (2,000), workers (500), and each storage key/name inventory (1,000) have conservative defaults and caller-visible hard bounds. Script source bytes, network events, console events, and WebSocket events are bounded separately. The CLI exposes the same limits as kebab-case options such as `--max-frames` and `--max-storage-keys`.

A bounded result reports `completeness.status: "truncated"`, named truncated sections, and dropped event counts rather than implying exhaustive capture. Disallowed-origin entries are filtered before collection-limit accounting, so they cannot consume an approved origin's output budget.

CDP discovery, WebSocket connection, and each command have a 5-second timeout. Version discovery is capped at 64 KiB, target discovery at 2 MiB and 1,000 targets, each WebSocket message at 16 MiB, and correlated pending commands at 128. Malformed unsolicited protocol events poison the connection so later commands fail closed.

Network and console coverage starts only after REA attaches and enables the relevant CDP domains. `prior_activity_available` is always `false`; absence from these arrays is not evidence that an event never occurred. Source maps are reported only as redacted declarative URLs and are never fetched.

## Non-goals and threat model

The first browser provider deliberately does not expose generic CDP commands, `Runtime.evaluate`, navigation, input, downloads, screenshots, page closure, or browser closure. REA disables the domains it enabled, detaches the target session, and closes only its own WebSocket.

This feature is not a browser sandbox or network containment mechanism. The attached page and browser continue running with their existing privileges and may make external requests independently of REA. CDP gives deep access to the selected browser profile, so use a dedicated profile, approve only origins you intend to inspect, and treat other same-user processes as outside this boundary.
