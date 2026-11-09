# Android UI discovery and actions

REA exposes Android UI observation through the shared CLI/MCP ADB service: find
text and controls, inspect attributes and wait for conditions. The operator-owned
UI Automator runner operates outside the target app's process and observes its
accessibility-exposed UI.

**Input actions are an unshipped proposal pending a maintainer scope decision.**
The normal MCP catalog has no `perform_adb_ui_action` tool and the normal CLI has
no `perform-adb-ui-action` command. There is no environment or per-call opt-in.
The action contract is bound only by the source-tree experiment under
`experiments/adb-ui/`; its scripts and runner sources are not included in the
published package. Observation tools do not themselves authorize mutation.

## Prepare the runner

Supply adb, JDK 17, Gradle 8.9, Android SDK platform 35 and build-tools 34.0.0.
The source project pins Android Gradle Plugin 8.7.3 and UI Automator 2.4.0.
Gradle resolves the declared AndroidX dependencies from Google Maven/Maven Central.

Build the operator-owned runner from a source checkout:

```sh
gradle -p bridge/adb-ui assembleDebug
rea install-adb-package emulator-5554 \
  bridge/adb-ui/build/outputs/apk/debug/rea-uiautomator-runner-debug.apk
adb -s emulator-5554 shell am instrument --user 0 -w \
  dev.rea.uiautomator/dev.rea.uiautomator.ReaUiRunner
```

Keep that instrumentation command running in a terminal. `REA_UI_READY` identifies
the new runner instance. The operator owns its installation and lifetime. Runner
0.2.0 uses protocol v2; rebuild an older runner when updating the host CLI/MCP.
Short, package-scoped broadcasts for Android user 0 carry control metadata and
require the shell's `android.permission.DUMP` permission. Request bodies travel
over stdin and a private Unix socket through `run-as` and Android's `toybox nc -U`.
The helper must be debuggable, and toybox must support Unix sockets. The socket
checks the connecting app UID; the transport puts no UI request body in ADB or
device argument vectors.
The helper preserves other accessibility services with
`FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES` and registers no automatic dialog handlers.

`REA_ADB_PATH` selects adb as usual. `REA_ADB_UI_PACKAGE` can select a compatible,
operator-built runner package; the default is `dev.rea.uiautomator`. An unavailable
runner reports its setup requirement. Use the existing app-lifecycle tools to
launch the target application.

The UI observation tools and experimental action transport own their adb processes, so an unset `REA_ADB_PATH` is
resolved the same way the version probe resolves it: on Windows the owned
launcher receives the absolute executable found on the captured `PATH` and
`PATHEXT`, because the native launcher starts a drive path directly. A caller
path that is already absolute is used unchanged, and an unresolvable bare name
is reported by the failed launch instead of being guessed.

## Find text and buttons

CLI commands take the corresponding MCP input as inline JSON or a local JSON
file path. For example:

```sh
rea find-adb-ui-elements '{"serial":"emulator-5554","package":"com.example.app","selector":{"text":{"value":"Sign in","match":"exact"}}}' --json
rea find-adb-ui-elements '{"serial":"emulator-5554","package":"com.example.app","selector":{"clickable":true,"enabled":true,"visible":true}}' --json
rea inspect-adb-ui '{"serial":"emulator-5554","package":"com.example.app"}' --json
```

Selectors combine text, content description, resource ID, class name, ancestor
resource ID and observed states. Text matching is case-sensitive and supports
`exact` or `contains`. An empty selector inventories the captured scope. Omitted
states mean no filter; `enabled: false` specifically selects disabled controls.

For sensitive CLI text, supply the input as a local JSON file path. REA forwards
the file's request body through stdin to the runner.
JSON-file reads share the command's cancellation and failure-status boundary;
malformed or missing input fails before device dispatch. Cancellation during
final acknowledgement or provider close retains available observations.

Results preserve all observed matches, including duplicate labels. Each match
has a snapshot-scoped `id`, raw and UI Automator-visible bounds, package/class
and resource IDs, text and descriptions, state flags and parent identity.
`click_target_id` derives the nearest clickable ancestor (or the element itself);
`related_nodes` supplies that parent's facts when the label is a child node.
An enabled/clickable flag describes the observation, not a guaranteed outcome.

`snapshot.id` belongs to one runner instance. A new capture replaces its previous
snapshot; actions retire their input snapshot and attempt an after-capture.
Use `snapshot_id` with `next_offset` to page matches from that exact retained
observation. Such pages report `freshness: retained_snapshot`, not live freshness.
Repeat the package, display and optional window scope when using a retained ID.

## Proposed input actions (source-tree experiment only)

This section documents the unregistered proposal, not a production CLI/MCP
operation. The [verification workflow](https://github.com/morluto/rea/blob/main/experiments/adb-ui/README.md) starts
`node experiments/adb-ui/mcp.mjs` to bind the proposed contract explicitly. Its
real-device checks use isolated, operator-owned fixture apps. A maintainer scope
decision is still required before public registration or distribution.

Example input for that experimental binding, using observed snapshot/element IDs:

```json
{
  "serial": "emulator-5554",
  "package": "com.rea.ui.probe",
  "snapshot_id": "00000000-0000-4000-8000-000000000001",
  "element_id": "7",
  "action": { "kind": "tap" }
}
```

Replace the example IDs with the actual discovery result. The primitives are:

| `action.kind` | Additional fields                 | Meaning                                                                                                         |
| ------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `tap`         | —                                 | Click the selected visible element                                                                              |
| `double_tap`  | —                                 | Two clicks on the selected element                                                                              |
| `long_press`  | —                                 | UI Automator long click                                                                                         |
| `set_text`    | `text`, optional `sensitive`      | Accessibility text replacement; empty text clears it                                                            |
| `scroll`      | `direction`, `percent`            | Scroll an observed scrollable control                                                                           |
| `swipe`       | `direction`, `percent`            | Swipe inside the selected element                                                                               |
| `drag`        | `destination_id`                  | Drag to another observed element in the same window                                                             |
| `key_event`   | `key_code`, optional `meta_state` | Send a key only while a captured window in the selected package has input focus on display 0; omit `element_id` |

Directions are `up`, `down`, `left` or `right`; percent is greater than zero and
at most one. Before dispatch, refresh checks compare all captured node facts, rejecting changed
checked/selected/focused/checkable/password state, disabled/invisible targets
and inactive windows. Snapshot-derived clickable-parent links are separate from
the refreshed node facts.
UI Automator 2.4.0 refreshes retained nodes through `getAccessibilityNodeInfo()`;
text entry consumes that validated node so its password classification matches
the selection used to redact Evidence parameters. No first matching element is silently chosen.
Snapshots and input dispatch are sequential, so UI changes between observations
remain possible.

Each input primitive checks cancellation and its operation deadline again at
dispatch, after preparation reads. Drag consumes the destination geometry from
that validated read. An interruption detected there prevents dispatch; input
already dispatched may have changed application state.

Between the two clicks of `double_tap`, checked/selected/focused state, text and
description may change. The continuation still checks the same target's identity,
geometry, capabilities, visibility and active window. `selected_element` retains
the original selection. If the second click is refused, `dispatch_attempted` stays
true, `action_completed` is false and `action_error` describes the interruption;
the first click may already have changed application state.

`dispatch_attempted` and `action_completed` describe the provider call. A click
returning does not prove that navigation, saving or another app outcome occurred.
Use the after-snapshot or an explicit wait to verify that outcome. Text replacement
also reports its immediate readback, and scrolling retains UI Automator's own
`can_scroll_more` result. Overlays or the input keyboard can intercept gestures;
that return value alone does not prove the end of a list. Handle a known visible
keyboard explicitly (for example, a BACK key event) and verify the after-state.
Input can change app data, permissions and network state;
application state is left as-is.

## Coverage, privacy and lifecycle

- Scope is accessibility-visible windows for the selected package/display, with
  an optional window filter. Custom canvas content and unmaterialized off-screen
  items can be absent from this interface. Coverage is of examined accessibility
  data, not every visually drawn pixel or every screen in the application.
- Capture reports examined/retained node counts, partial coverage and reasons.
  The caller's node budget defaults to 500. Pending native node handles and
  retained facts also share a budget derived from reply capacity. The Binder reply
  budget can be reached sooner; its 256 KiB JSON ceiling accounts for base64 and
  Binder's UTF-16 string expansion. Requests have a 16 KiB JSON budget before
  base64 encoding to bound retained requests and private input frames.
- Password-marked text is excluded. `set_text` with `sensitive: true` redacts that
  action's recorded parameter; the runner also omits UI text and description
  fields containing that literal value across all inspected packages for its
  lifetime, including a receiving app, keyboard or share sheet. Its runner-wide
  store counts each distinct value once and refuses
  additional values when full rather than evicting earlier redactions. Search
  predicates involving redacted text report partial query coverage. A wait cannot
  claim absence from incomplete or hidden matching facts.
- Runtime observations use `controlled-replay` Evidence authority and preserve
  the caller-selected device, scope and runner-reported identity. No association
  with a local APK's bytes is established by an equal package name.
- A password-marked node keeps both of its textual fields out of the
  observation: the runner redacts the text and the content description together,
  reports both as redacted, and reports a search over a redacted field as
  partial coverage. An application that stores the entered value in the
  description of a password field cannot leak it through an inspection.
- Work is prepared by request ID before its body is sent over the private stdin
  channel. A cancelled/forgotten preparation rejects late input. Submission is
  acknowledged immediately, then polled by request ID; long UI waits and blocked
  input sockets leave the control channel reachable. Replies remain retained
  until acknowledged; at most 16 prepared/unacknowledged requests are admitted.
  A completion too large for the transport budget is replaced by a capacity-only
  envelope, and its request can still be released. For an admitted action, that
  envelope does not establish whether input occurred: the outcome remains unknown
  and replay stays blocked until a matching fresh inspection. This also applies
  when cleanup recovers the envelope or its forget acknowledgement is lost.
  A definitive sensitive-value storage refusal has its own `sensitive_capacity`
  kind and leaves other permitted actions available. An operator restarts the
  runner after outstanding work settles to admit additional sensitive values.
  Missing results keep the existing `capacity` kind so older hosts retain replay
  protection. Older runners' ambiguous terminal `capacity` replies also retain
  the unknown-outcome gate.
- Host stdin handoff alone does not prove action admission. A matching runner's
  immediate refusal (such as `busy` or `capacity`) stays definitive even if
  host-command or prepared-slot cleanup needs a retry. Admission is recorded from
  the complete matching reply before host cleanup, including cancellation during
  that cleanup. It does not report a possible mutation or
  require a fresh inspection before the next action. A missing, malformed or
  mismatched reply still leaves submission uncertain and retains replay safeguards.
- A key code outside the connected Android version's supported range is a
  producer-reported capability refusal. The error retains the requested code
  and directs the caller to choose a supported code, rather than refreshing an
  element selection. The runner reports its runtime key-code range.
- Cancellation settles host commands, cancels only the owned remote request,
  waits for its work to settle and acknowledges its retained result. A separate
  five-second cleanup budget applies. Completed facts survive acknowledgement
  failures as partial observations: a recovered observation is composed into the
  same Evidence a successful call returns, with the same redaction, limitations
  and `controlled-replay` authority, so an exported session records it. Failed
  cleanup retains exact request/runner
  identities for later retry; another runner instance cannot prove old cleanup.
  Host launch preparation creates no remote owner. Once a request is prepared
  on the runner, a later stdin transport failure reconciles that reservation
  before subsequent ADB operations, including non-UI reads and app/package
  mutations. Those calls join earlier UI work and remain blocked while its
  cleanup is unresolved. A missing request after interrupted preparation is unresolved delivery, not
  proof of cancellation; cleanup retains it until delivery can be reconciled.
- Each provider instance admits ADB execution requests in arrival order, before
  client discovery, and holds the turn through execution and cleanup. Later
  requests, including non-UI reads and mutations, cannot overtake UI setup or
  final acknowledgement. A queued caller may cancel independently without
  releasing its successor ahead of earlier work. Closing seals new admission
  and joins all accepted turns before retrying retained cleanup. This ordering
  is local to that provider instance; it does not lock other REA processes or
  external ADB clients.
- One-shot CLI close failures preserve the original operation error and any
  completed/partial observation. The experimental action binding retains the
  same provider-owned outcome and cleanup diagnostics.
- The runner's private socket is removed when the runner stops. A setup failure,
  including a rejected receiver registration, closes the socket before the
  instrumentation reports the failure, so the next launch does not refuse a
  leftover socket path.
- A request owns its recovery until the runner forgets it. If a cleanup retry,
  including provider `close`, reaches the runner after the outcome was
  already returned, the recovered terminal reply is attached to that same error:
  completed facts become its Evidence, and a recovered refusal replaces an
  undecided cancellation or is retained as a secondary failure. The request is
  released only after that recovery.

End the operator-owned runner explicitly when finished:

```sh
rea stop-adb-app emulator-5554 dev.rea.uiautomator
rea uninstall-adb-package emulator-5554 dev.rea.uiautomator
```

The instance socket lives in the helper's private files directory. Normal teardown
removes the identity-checked socket node. Force-stop may leave the node until
uninstall; request payloads are not stored in that filesystem entry.

## Verification

`experiments/adb-ui/verify.mjs` exercises public observation tools and the
unshipped action binding against a source-built probe: text/button discovery,
duplicate-label paging, clickable ancestors, eight primitives, Unicode, sensitive
text, stale/disabled refusals, waits, cancellation, observation CLI/MCP snapshot
parity and fixture cleanup. The Compose
fixture and `verify-compose.mjs` exercise virtual/merged accessibility nodes.
Provider-boundary tests separately exercise malformed replies, request identity,
unavailable runners, cancellation and acknowledgement/cleanup failure.

The runner's source minimum is API 24; secondary-display inspection requires
API 30, and key events require display 0. A definitive runner `unsupported`
refusal reports `capability_unavailable`, preserves the selected display and
is not retryable without changing the device or operation scope. REA does not
retry inspection or silently choose another display for that refusal.
Real verification and platform-specific limitations are recorded in the
experiment README. The protocol targets the user-0 runner; other Android-user
configurations and host/platform combinations need their own verification.

Foreground and action focus checks use the selected display/window scope.
`foreground_package` is null when no selected window was observed active or
focused; a package active on another display is not substituted. Element actions
revalidate the selected node's window, display and active/focused state before
dispatch, including between double-tap clicks. Key events remain display-0 only.
Their admission requires input focus on a captured window in that scope;
accessibility activity alone does not establish keyboard routing. An active but
unfocused selected window is refused before dispatch. This remains a sequential
focus check, not an atomic guarantee against a subsequent external focus change.
