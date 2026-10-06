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

## Minimal launch example

Save this as `browser-scenario.json`, replacing the executable path with an
already-installed Chrome-family browser and the URL with your running fixture:

```json
{
  "browser": {
    "mode": "launch",
    "executable_path": "/absolute/path/to/chromium"
  },
  "start_url": { "url": "http://127.0.0.1:3000" },
  "actions": [
    { "step_id": "settle", "action": "wait_for_timeout", "duration_ms": 100 }
  ]
}
```

```bash
rea capture-browser-scenario ./browser-scenario.json --json > browser-capture.json
```

The default capture includes the final URL. Select DOM, screenshots, or events
only when they help answer the question. REA launches and cleans up the browser
profile for this request; it does not start your fixture server or install a
browser. A schema-valid scenario does not prove that the executable or target
is available on the host.

## Interaction example: capture the visible result

The default final URL answers "where did the page end up?", not "what did the
page show?". Many interactions, such as a search button that renders results in
place, change the page without changing the URL. A capture with only the
default `url` artifact then reports that the click succeeded and the URL is
unchanged, which cannot tell you whether results appeared.

Request the artifacts that answer your question and wait for the state you want
to inspect. This scenario clicks a Search button, waits for the current search
results, and captures the final DOM, accessibility tree, and URL. It assumes the
local page clears `#results`'s `data-state` while loading and sets it to `ready`
after rendering the current response. Adapt the selectors and readiness marker
to your page; an already-visible container or previous results are insufficient.

```json
{
  "browser": {
    "mode": "launch",
    "executable_path": "/absolute/path/to/chromium"
  },
  "start_url": { "url": "http://127.0.0.1:3000" },
  "actions": [
    {
      "step_id": "search",
      "action": "click",
      "locator": { "kind": "css", "selector": "#search" },
      "timeout_ms": 10000
    },
    {
      "step_id": "results-ready",
      "action": "wait_for",
      "locator": { "kind": "css", "selector": "#results[data-state='ready']" },
      "state": "visible",
      "timeout_ms": 10000
    }
  ],
  "capture": { "at_end": ["dom", "accessibility", "url"] }
}
```

Save it as `browser-search.json` and run it the same way as the minimal
example:

```bash
rea capture-browser-scenario ./browser-search.json --json > browser-search-capture.json
```

Through MCP, pass the same object as the `capture_browser_scenario` arguments.
The final step's DOM and accessibility artifacts retain the page state at that
capture time inline. REA still launches and cleans up the browser profile.

The click's `timeout_ms` covers the click action. A non-navigating `fetch` or
delayed render can finish later, so use `wait_for` to observe a page-specific
ready condition before final capture. A page that updates synchronously can
omit that wait. REA does not infer application readiness from capture selection.

Choose captures by the question being asked:

- `dom` and `accessibility`: text or structure the page rendered, such as
  search results, validation messages, or updated lists. The accessibility tree
  is usually the more compact way to read visible text.
- `screenshot`: visual layout or styling, or content not exposed as text, such
  as a canvas.
- `history` or `storage`: navigation history, or cookies and web storage the
  interaction wrote. Request them only when that state is the question; they
  are never captured implicitly.
- `after_each_step` instead of `at_end`: intermediate state between actions in
  a multi-step scenario.
- `events` (`console`, `page-errors`, `network`, and so on): how the page
  reached its result, such as the request a search issued or an error it
  logged. Select only the event families you need.

Capture states are reported per artifact. An artifact you did not request is
`not_requested`, which means REA did not look, not that the page had nothing
to show. A step's `completeness` of `complete` covers only the sections that
were requested. A URL-only capture can be `complete` and still be unable to
answer a question about rendered content, so add the relevant artifact and run
the scenario again rather than inferring from its absence. Capture completeness
also does not assert that the page's background work has finished.

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

Selected event families are observed on the root page and discovered descendant
popups, including nested popups. Popup lifecycle records are emitted only when
`popups` is selected. Launch-mode network observation starts at the owned
context before navigation, so popup document requests, redirects, and responses
are included once. Connected contexts can contain unrelated tabs: only network
events with a frame belonging to the root or a discovered popup are retained.
Initial popup requests without a frame cannot be attributed in shared contexts
and are omitted; attach coverage remains incomplete.

Playwright reports new popup Pages after their first navigation has committed.
It buffers early console messages and page errors, but the pinned API cannot
recover every earlier frame, worker, WebSocket, or download event. If one of
those families is selected and a popup is discovered, REA reports the family gap
in `limitations`, marks `events` missing, and disables equality eligibility.
Later events remain available; no initial navigation is synthesized from the
popup's current URL.

Each request names the exact launch executable or loopback CDP endpoint, target,
actions, and capture behavior. Origin filters and environment-variable names
are included when the scenario needs them.
Launch owns a temporary profile; connect mode disconnects from the selected
external browser without closing it. The request itself defines the operation;
there is no additional REA grant step. The browser and host still enforce their
own access and process rules.

## Network evidence

`capture.events: ["network"]` retains request, response, completion, failure,
and unfinished-request metadata. Select content independently:

```json
{
  "browser": {
    "mode": "launch",
    "executable_path": "/absolute/path/to/chromium"
  },
  "start_url": { "url": "http://127.0.0.1:3000" },
  "actions": [
    {
      "step_id": "run",
      "action": "click",
      "locator": { "kind": "css", "selector": "#start" },
      "timeout_ms": 10000
    },
    {
      "step_id": "ready",
      "action": "wait_for",
      "locator": { "kind": "css", "selector": "#done" },
      "state": "visible",
      "timeout_ms": 10000
    }
  ],
  "capture": {
    "network": {
      "request_body": true,
      "response_body": true,
      "header_values": true
    }
  }
}
```

All three options default to `false`. Any selected network content also enables
network metadata observation; listing `network` in `events` is then optional.
Each observed request object receives a capture-scoped `transaction_id`.
Requests sharing a URL remain distinct. Redirects link to the preceding
transaction only when it was observed; a null predecessor does not establish
that no earlier hop existed. Older captures without IDs remain readable and
their transaction association is unknown.

`scenario.network_content` records the resolved content selection. Comparing
captures with different selection, or legacy captures without that coverage
information, reports network evidence as unknown with a recovery instruction.
Capturing more data alone does not establish a website change.

`network-content` events reference the exact request or response event through
`source_event_sequence`. They include independently typed headers and body
states. Captured bodies retain base64 bytes, byte count, media type, and SHA-256
of the retained bytes. Request bytes are those exposed by Playwright; a
`not_exposed` request body does not prove absence or complete multipart file
coverage. Response bytes are decoded by the browser, not the compressed wire
representation. No later fetch is substituted for the original response.
Headers preserve producer order and duplicates. Authorization,
Proxy-Authorization, Cookie, and Set-Cookie values are null with
`redacted: true`; ordinary values remain intact. Declared UTF-8 secret values
and their standard URI/form or JSON-escaped representations are replaced without
decoding unrelated binary bytes. Other encodings are not interpreted. Digests describe the
retained representation after redaction.

Only completed responses are read. At the end of the final step, observation
stops; requests still in flight emit `request-unfinished`, and their observed
responses have explicitly unavailable bodies. This cutoff does not wait for
long-lived streaming connections. Already-started content reads settle before
browser cleanup, with a provider-owned five-second timeout per read and
cancellation support. Failed or unexposed reads retain per-content states and make selected
event coverage incomplete. Body events can arrive during later steps or final
drain; event bounds describe receipt during the step, while the source event
reference establishes the transaction phase. Comparison attributes content to
its source event's step and excludes the sequence reference from normalization.
Playwright scenario capture does not supply initiator stacks; passive CDP
observation retains its own initiator evidence.

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
