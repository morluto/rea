# REA UI Automator runner

Source-tree proposal: runner sources are not distributed in the npm package.
Public CLI/MCP tools expose observations and waits only; input is bound by the
unshipped `experiments/adb-ui/mcp.mjs` verifier pending maintainer scope approval.

This source-built, operator-owned instrumentation APK supplies the Android UI
backend described in [the UI guide](https://github.com/morluto/rea/blob/main/docs/adb-ui-automation.md). It pins
AndroidX UI Automator 2.4.0 and uses its public window, node and gesture APIs.
It needs JDK 17, Gradle 8.9, Android SDK 35 and build-tools 34.0.0.

```sh
gradle -p bridge/adb-ui assembleDebug
```

`-PreaBuildDir=/absolute/output` selects a separate build directory. The APK is
built locally and installed through the existing explicit ADB installation tool.
The instrumentation targets its own package and observes other apps' accessible
UI, including release apps; it does not inject code into those target processes.

Runner 0.2.0 uses protocol v2. Package-scoped, user-0 broadcasts protected by
`android.permission.DUMP` carry only control metadata. A prepared request's body
travels through owned stdin, `adb shell -T`, and `run-as`/`toybox nc -U` into an
instance-specific Unix socket in the helper's private files directory. The
socket checks its peer UID. UI request bodies are not placed in ADB or device argv.

Use the debug build and an Android image with Unix-socket support in toybox nc.
Rebuild the runner when upgrading from protocol v1. Preparation is cancellable
before body delivery; forgotten reservations reject late input. Status,
cancellation and acknowledgement remain reachable independently of the input
connection. One worker owns UI operations and the most recent snapshot.
Retained results, request bodies and sensitive-value state have explicit capacities.
Sensitive literals are retained in one runner-wide set and masked in every
inspected package. The existing 65,536 UTF-16-code-unit budget counts distinct
values once; admission failure never evicts earlier redactions.

The operator-owned runner owns `files/rea-ui-<instance>.sock`. Normal teardown
checks its inode before removing it. A force-stopped runner can leave that socket
node until package removal; payload data is carried in memory, not written there.

The operator owns start/stop and APK installation. Host REA sessions own their
individual requests, not the instrumentation process. No permission-dialog
watcher, arbitrary shell command or caller-authored code is exposed by the bridge.

UI Automator and AndroidX Test are Android Open Source Project components under
Apache-2.0. Their dependencies retain their own licenses, including Kotlin,
JUnit, Hamcrest and Guava. Gradle obtains these separately for the operator-built
APK; preserve the upstream notices when redistributing that artifact. See
[third-party notices](../../THIRD_PARTY_NOTICES.md) and the
[UI Automator release page](https://developer.android.com/jetpack/androidx/releases/test-uiautomator#2.4.0).
