# Browser scenario contract

`capture_browser_scenario` accepts the provider-neutral
`browserScenarioSchema` through both MCP and the
`capture-browser-scenario INPUT_JSON` CLI command. The request is declarative:
it admits a fixed action vocabulary, explicit HTTP(S) targets, deterministic
browser settings, explicit storage seeds, and provider-owned
liveness deadlines. `INPUT_JSON` may be inline JSON or a JSON file path.

The minimal request contains only browser launch/connect selection, `start_url`,
and at least one `actions` entry. Launch `headless` defaults to `true` and can
be set to `false` where the host supports a visible browser. Navigations follow
the destinations named by the scenario and the page's ordinary browser requests;
there is no separate origin allowlist or request-interception layer. Environment
settings (including service workers blocked by default), empty storage, and a
final sanitized URL capture are supplied by default. Set
`environment.service_workers` to `allow` when the application requires them.
Add secret declarations, storage seeds, and additional artifact or event
capture only when needed. Action, secret, and storage counts are not capped.
Duration, action, and navigation
timeouts remain fixed provider-owned liveness limits; the request does not
accept a caller-controlled `limits` object.

The browser boundary is part of the contract. Launch mode requires a
caller-selected executable and always uses a provider-owned temporary profile
that is closed and deleted during cleanup. Connect mode accepts only an
explicit-port loopback CDP endpoint. The Playwright driver preserves this
distinction: it closes and deletes provider-owned profiles, but only disconnects
from an external CDP browser. Real-browser verification checks both outcomes and
confirms that an attached external browser remains alive.

HTTP(S) URLs may include ordinary query values and fragments directly. Use
ordered structured query entries when a value needs to reference a declared
environment-backed secret. Form, storage, and cookie values are either literal
strings or declared secret references. Raw URL userinfo credentials are rejected.
Captured credential-header
values are not retained, and declared secret values are redacted automatically.
A secret may be declared solely to
redact matching observed content; every secret reference in an action, URL,
storage value still needs a declaration. Ordinary query values
and fragments remain intact. Durable results replace resolved secret values
with their secret references.

The exact `start_url`, navigation destinations, and storage-seed origins define
the inputs to a scenario; ordinary page requests are handled by the browser.
Storage cookies are scoped to the page URL at each capture. Unsupported action
tags, unknown fields, duplicate step IDs, and undeclared secret references fail
validation.

The result is Evidence with an initial state followed by one record per
declared action. Each step reports action status, elapsed time, sanitized URLs,
event bounds, and independently typed capture states for screenshot, DOM,
accessibility, URL, history, and storage. Console, page-error, network,
WebSocket, frame, worker, popup, and cancelled-download events are attributed to
steps and all observed events and requested artifacts are returned inline.
There are no event, frame, worker, popup, WebSocket, DOM-node,
accessibility-node, storage-entry, screenshot-count, or cumulative
metadata-byte caps. Requested artifacts and observed events are returned
inline without application-defined size ceilings. Other missing sections
remain explicit and make the capture ineligible for equality claims.
Attach-mode captures also declare the unavoidable pre-attach event gap.

Each request names the exact launch executable or loopback CDP endpoint, target,
actions, and capture behavior. Origin filters and environment-variable names
are included when the scenario needs them.
Launch owns a temporary profile; connect mode disconnects from the selected
external browser without closing it. The request itself defines the operation;
there is no additional REA grant step. The browser and host still enforce their
own access and process rules.

## Scenario comparison

`compare_web_captures` and `compare-web-captures` also accept two complete
browser scenario captures. Steps align only by exact, unique `step_id`.
Duplicate IDs, missing counterparts, changed action kinds, and incompatible
browser/origin capture context are returned as alignment failures. They prevent
an unchanged claim; observed differences may still prove a changed result.

The comparison records its full normalization commitment and SHA-256 digest.
Built-in rules exclude step elapsed time and event sequence/index fields,
compare screenshots by content digest, and compare DOM/accessibility captures
by normalized text. Optional caller rules are bounded exact-literal
replacements over named artifact kinds. Rules and artifact-kind lists are
sorted canonically before application, making the same policy reproducible
regardless of input order. Rules operate only on already-redacted durable
capture fields and are preserved in the result.

Each aligned step reports changed, unchanged, or unknown. Changed and unknown
action, screenshot, DOM, accessibility, URL, history, storage, and event
artifacts carry their normalized before/after digests and capture states.
Every changed or unknown artifact record is returned inline for each aligned
step. Missing, truncated, or mismatched capture coverage remains unknown
instead of being treated as equality.
