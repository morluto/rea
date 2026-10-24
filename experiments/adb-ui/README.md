# Android UI Automator verification

Discovery and waits use the public [UI observation contracts](../../docs/adb-ui-automation.md).
Input remains an **unshipped proposal** pending a maintainer scope decision.
The normal CLI/MCP surface does not register it and has no opt-in switch.

These verifiers explicitly start `mcp.mjs`, which adds the proposed action
contract to a source-tree-only server using the existing runtime lifecycle.
The operator starts the source-built runner from `bridge/adb-ui/`. Actual
CLI/MCP observation and experimental input are checked against isolated emulator
apps. The experimental entrypoint and runner sources are excluded from the npm
package; these checks do not authorize public integration.

## Native Android Views

With JDK 17, compatible caller-supplied Android tools and an already-running runner:

```sh
npm run build:cached
node experiments/adb-ui/build-fixture.mjs --aapt2 /tools/aapt2 \
  --framework /sdk/android.jar --d8 /sdk/d8.jar --output /lab/ui-fixture
node experiments/adb-ui/verify.mjs --aapt2 /tools/aapt2 --serial emulator-5554 \
  --apk /lab/ui-fixture/ui-probe.apk --output /lab/ui-result
```

The permission-free source fixture supplies editable text, duplicate buttons,
a disabled control, a child label inside a clickable parent, a drag/drop target,
and a scrollable list. The verifier checks text/button discovery, stable paging,
explicit selection, tap/double-tap/long-press, Unicode replacement and clearing,
sensitive-text handling, scroll/swipe/drag/key primitives, stale/disabled refusals,
wait outcomes, cancellation, screenshots and CLI/MCP snapshot parity. A completed
provider call and an observed application outcome are asserted separately.

`verify-node-validation.mjs` takes the same arguments and uses the native fixture's
shell-permission-protected mutation receiver to change existing Views without
retiring the runner snapshot. It verifies stale disabled/moved/detached/password
targets and changed checked/selected/focused/checkable states are refused before
dispatch, using the fixture's click counter and state readback. A fresh checked
selection still toggles successfully. Null text changing to the literal `"null"`
is also stale. Freshly selected password text is redacted, ordinary text
is preserved and the fixture is removed. The builder dexes the complete compiled
class inventory, including the fixture's accessibility delegate and receiver.

The same verifier checks double taps on a checkbox, a relabelled/selected control
and an initially unfocused text field, with independent click/touch counters.
Stale initial selections must still be refused. A control that disables, moves,
detaches or leaves its window after the first click must stop the second click
and preserve its original selection and partial action outcome. App departure
must retain an after-state capture with no selected active/focused window and
`foreground_package: null`; another app's identity is outside that scope.

### Preparation-boundary cancellation

Create a separate verification-only runner source copy, then build and explicitly
install/start it using the normal runner instructions:

```sh
node experiments/adb-ui/build-dispatch-probe.mjs --output /lab/dispatch-probe
gradle -p /lab/dispatch-probe/project assembleDebug
node experiments/adb-ui/verify-dispatch-guard.mjs --serial emulator-5554 \
  --aapt2 /tools/aapt2 --apk /lab/ui-fixture/ui-probe.apk --output /lab/dispatch-result
```

The copied helper is labelled `dispatch-guard-probe`; the verifier requires that
identity. It sets cancellation or expiry just after the real window/destination
reads, using the modes recorded in `probe.json`, and exercises the experimental
MCP action binding. The native fixture's key, drag-start and drop counters must remain
zero for interrupted requests; unchanged controls must deliver input. A separate
key-only mode masks the admission-time `UiWindow.isFocused()` read to false,
leaving the real selected window and its active state unchanged. The fixture
must show an initially active, focused captured window, then report a
`focus_changed` refusal and zero delivered keys under the masked read. This is
a controlled producer-boundary regression, not a reproduction of native
touch-exploration routing between two apps. The source
copy and hashes make this controlled state injection reproducible. Ordinary
runner sources are untouched by the builder. Use a freshly built primary fixture
containing the counters and restore the ordinary helper after verification.
The builder identifies the final key/drag dispatch checkpoints independently of
preparation-helper signatures and requires exactly one of each, plus one scoped
key-admission focus read. A boundary test
runs the builder against the current runner source to catch producer drift.

### Password description redaction

Build the primary and mirror fixtures, then run the focused verifier against the
runner that is installed:

```sh
node experiments/adb-ui/build-fixture.mjs --aapt2 /tools/aapt2 \
  --framework /sdk/android.jar --d8 /sdk/d8.jar --output /lab/ui-fixture
node experiments/adb-ui/build-fixture.mjs --mirror --aapt2 /tools/aapt2 \
  --framework /sdk/android.jar --d8 /sdk/d8.jar --output /lab/ui-fixture-mirror
node experiments/adb-ui/verify-password-description.mjs --serial emulator-5554 \
  --aapt2 /tools/aapt2 --apk /lab/ui-fixture/ui-probe.apk \
  --mirror-apk /lab/ui-fixture-mirror/ui-probe.apk --output /lab/password-result
```

The mirror application keeps the entered value in its content description. The
verifier turns that field into a password field, so the description holds a
value REA never typed, and requires that both textual fields stay redacted,
that the value never reaches the observation, and that a search over the
redacted description reports partial coverage. An unredacted runner fails the
verifier with the value in the node facts.

## Compose

Build the separate Compose fixture with Gradle 8.9, JDK 17 and SDK 35:

```sh
gradle -p experiments/adb-ui/compose-fixture assembleDebug
node experiments/adb-ui/verify-compose.mjs --aapt2 /tools/aapt2 --serial emulator-5554 \
  --apk experiments/adb-ui/compose-fixture/build/outputs/apk/debug/rea-compose-fixture-debug.apk \
  --output /lab/compose-result
```

This checks virtual/merged Compose semantics: text/button discovery, duplicate
labels, resource IDs exposed by test tags, text replacement, disabled state and
lazy-list scrolling. It observes the configured keyboard before explicitly
dismissing it, and verifies its disappearance before scrolling. Use a new
output directory for each run. Observations are
saved individually, including those preceding a later failure.

## Cross-app sensitive text

Build the same permission-free fixture as a second, explicitly named app:

```sh
node experiments/adb-ui/build-fixture.mjs --mirror --aapt2 /tools/aapt2 \
  --framework /sdk/android.jar --d8 /sdk/d8.jar --output /lab/ui-mirror
node experiments/adb-ui/verify-sensitive-scope.mjs --serial emulator-5554 \
  --aapt2 /tools/aapt2 --apk /lab/ui-fixture/ui-probe.apk \
  --mirror-apk /lab/ui-mirror/ui-probe.apk --output /lab/cross-app
```

The primary fixture explicitly launches `com.rea.ui.mirror` with its entered
text. The verifier checks text/description masking in the receiving app for
caller-marked and password input, independent CLI and MCP sessions, partial
coverage for masked text queries and preservation of ordinary text. Each app
has its own digest-bound admission, package lease and cleanup receipt.

With a fresh operator-started runner, add `--capacity` to fill the existing
65,536-code-unit sensitive-value budget, verify cross-package deduplication,
refuse overflow and confirm earlier values remain masked. Restart the runner
explicitly before other workflows that need to register new sensitive values.

## Fixture ownership

The verifier requires an emulator and refuses an already-installed
`com.rea.ui.probe` (or the explicitly selected `com.rea.ui.mirror` peer).
AAPT2 inspects a digest-bound private APK snapshot, and the
same bytes are installed. CLI/MCP entrypoints are module-relative; caller APK
and output paths remain relative to the launch directory.

A persistent OS-account serial/package lease is acquired before the complete
package-absence check. Installation ownership is recorded before dispatch.
Retained host commands must settle before package reconciliation. Unknown
cleanup retains the package identity, lease and original failure. Complete
absence and session closure precede lease release and a success receipt.

Leases live under the OS account's home in `.cache/rea/adb-ui-leases/`, shared
across worktrees/output directories and independent of `HOME` overrides. Equal
serials on different ADB servers are conservatively serialized too. They are
not reclaimed from PID, age or malformed contents. Reconcile the recorded
processes and package before manually removing a stranded lease. Independent
ADB clients, other accounts and other hosts do not participate; use a dedicated
emulator. The UI runner itself remains owned by the operator.

## Evidence and limits

The native View workflow passed on Linux, adb 34.0.5, Android 16/API 36 x86-64,
UI Automator 2.4.0 and Node 24.18.0. Its 43 public UI observations covered all
eight primitives, Unicode, redaction, stale/disabled rejection, cancellation and
fixture cleanup, including incomplete-coverage and redacted-text absence checks.
The Compose workflow also passed on that emulator: 22 public observations
covered text/button discovery, duplicate labels, Unicode, disabled state,
observed keyboard dismissal, lazy-list scrolling and fixture cleanup.
Boundary tests separately exercise malformed replies, incorrect request
identity, unavailable runners and retained cleanup/acknowledgement errors.

With protocol v2 on the merged main baseline, the warm native View workflow took
68.99 s elapsed and 37.51 s host CPU, with 944,799,744 bytes peak host cgroup memory
and verified host payload cleanup, including the observer. The input channel adds
one preparation exchange so cancellation can settle before body delivery. The
earlier v1 run measured 44.62 s / 25.08 s / 923,791,360 bytes on a different code
baseline with concurrent documentation checks; these are not a controlled
transport-only comparison. External emulator/ADB-server resources, cold runs,
Compose resource costs and agent-token costs are unmeasured.

A separate argv-audited native/Compose/node-validation run recorded 621 ADB
commands: 399 metadata-only control broadcasts and 80 private stdin submissions.
No UI request body or tested input value appeared in their arguments. Direct
shell-UID access to the private socket was refused; valid calls used `run-as`.
That audit wrapper's overhead is excluded from the measurement above.

The runner's accessibility connection flags are consistent across its modern
and classic APIs. Long operations run outside broadcast delivery; immediate
acknowledgement plus status/cancel/release requests keep cancellation reachable.
The node-transition verifier reproduced the password-state omission on API 36
before the fix, while disabled/moved/detached nodes were already refused by the
pinned UI Automator getter's refresh behavior (also checked in its AAR bytecode).
After the fix, all transitions and both password/plain-text Evidence checks pass.
That targeted task took 28.51 s elapsed and 17.73 s host CPU, with 884,248,576 bytes
peak host cgroup memory including the observer. The emulator was already booted;
focused host tests ran concurrently. Cold and external-device costs and agent
tokens remain unmeasured; this is not a comparison with the larger workflow above.
The extended control-state regression reproduced dispatch for all four changed
states on API 36, including clearing a newly checked checkbox while reporting its
saved unchecked state. It also reproduced the null/string comparison ambiguity.
Comparing the producer's complete, typed node facts refuses all five transitions;
fresh checkbox input and the earlier node/password controls pass.
Input dispatch is not atomic with UI observation, and inaccessible/custom-drawn
content is not recovered. Other API levels, secondary displays, other Android
users and native macOS/Windows hosts remain unverified.
