# Static Android APK analysis

REA wraps an existing headless JADX engine through `src/android/`. Its source is
kept as an unmodified, commit-pinned Git submodule; see
[upstream provenance](https://github.com/morluto/rea/blob/main/third_party/README.md). CLI and MCP use the same
application workflow and return artifact-bound Evidence inline.

This family is present on repository main and in npm 4.1.0. Check the
[released package boundary](installation.md#released-package-and-main) and the
connected server's tool list before selecting it.

## Supply tools

Use a **full JDK 17 or newer** (including its compiler module) and
**jadx-headless-mcp 0.7.1**. REA runs its packaged Java metadata bridge in
source-file mode against the unmodified engine JAR. REA does not install Java,
an Android SDK, JADX, a device service or an emulator. Set the path in the shell
or MCP server environment:

```sh
export REA_JADX_MCP_JAR=/absolute/path/jadx-headless-mcp-0.7.1-all.jar
# Optional: select an existing JDK rather than java on PATH.
export JAVA_HOME=/absolute/path/existing-jdk
```

Readiness checks the selected JAR's ZIP directory for the classes consumed by
REA's metadata bridge, as well as Java's compiler and version modules. It does
not load an APK or execute engine code. Invalid archives and missing bridge
classes report JAR-specific recovery; classpath inventory alone does not prove
that every class or engine operation will load successfully. Discovery limits
each ZIP metadata read to 8 MiB before allocation; a larger directory reports
the exhausted read budget and the selected JAR path.

The current metadata bridge is verified on macOS arm64 with OpenJDK 21 and the
public Appium ApiDemos fixture. The POSIX adapter also supports Linux; the new
bridge has not yet undergone real verification on Linux/JDK 25.
Windows is unsupported for this provider's owned stdio process boundary.

## Answer an analyst question

```sh
rea inspect-android-package /path/Example.apk
rea search-android-classes /path/Example.apk MainActivity
rea inspect-android-class /path/Example.apk example.MainActivity
rea inspect-android-method /path/Example.apk example.MainActivity onCreate
rea inspect-android-method /path/Example.apk example.MainActivity select --overload-index 1
rea trace-android-references /path/Example.apk example.MainActivity
rea trace-android-references /path/Example.apk example.MainActivity --method-name onCreate
```

Equivalent MCP methods are `inspect_android_package`, `search_android_classes`,
`inspect_android_class`, `inspect_android_method` and `trace_android_references`.
Every request includes `path`. Class/method operations use `class_name`,
`method_name` and optional `overload_index` as applicable. For example:

```json
{
  "name": "inspect_android_method",
  "arguments": {
    "path": "/path/Example.apk",
    "class_name": "example.MainActivity",
    "method_name": "select",
    "overload_index": 1
  }
}
```

Use `inspect_android_class` to choose an overload. REA rejects an ambiguous
method request rather than silently selecting the first match. The engine's
method reference operation cannot select overloads, so REA reports that boundary
as unsupported when multiple same-name methods exist.

The engine's smali fallback also joins same-name overloads; REA rejects that
fallback for an overloaded method instead of attributing all bodies to one
selected overload. Native/abstract methods with no decompiled body report
`body_status: "not_available"` without inferring which implementation flag caused it.

## Interpret the result

- Package inspection retains decoded manifest XML, summary declarations,
  permissions and class/resource counts. Summary fields are extracted by the
  upstream engine and should be checked against the retained XML when needed.
  Signature verification is explicitly `not_performed`.
- Class search consumes all pages and checks their counts. An empty `query`
  inventories all class names; class names are decompiler representations.
- Class inventories read parsed metadata without generating source and return
  full reported display types, fields and inner class names. Synthetic members
  that code generation hides can appear in the inventory; it stays consistent
  after method decompilation within the retained session.
  Exact DEX descriptors are unknown. Overload indices are tied to this artifact
  and engine, not stable identities across different builds.
- Method inspection reports Java or smali, fallback markers and complete/partial
  returned text. Decompiled source is a derived representation. A complete text
  result does not establish complete semantics or a byte-identical reconstruction.
- Reference results are incoming static relationships between provider nodes.
  Source lines and DEX instruction offsets remain unknown. They are not observed
  runtime calls.
- Original requests, APK SHA-256, actual engine JAR SHA-256 and raw producer
  responses remain in Evidence. Source revision is populated only for bytes
  matching the audited release JAR.

These operations do not execute the APK or provide split APK/AAB handling,
signature validation, full resource-table semantics, native-library analysis or
Android runtime capture. Existing artifact inventory/extraction tools can supply
archive evidence. Project that Evidence with the execution-free inventory tool:

```sh
rea project-android-application-graph '{"inventory_evidence":[<inventory_artifact Evidence>]}'
```

```json
{
  "name": "project_android_application_graph",
  "arguments": {
    "inventory_evidence": ["<inventory_artifact Evidence>"]
  }
}
```

The projection reports exact component paths and hashes, runtime-family hints,
and path-based bridge hypotheses. It does not decode DEX or claim observed
runtime calls. Bridge hypotheses form a DEX/JVM-class by native-library
Cartesian product. The projection computes the product and exact serialized
candidate-array size before creating candidate objects, then retains a
deterministic prefix within a 2 MiB UTF-8 JSON budget. If candidates are omitted,
`bridge_candidate_coverage` reports total, emitted, and omitted counts; overall
coverage is `partial` while component arrays still include every component
from the supplied inventory pages. A path pair does not establish that a
managed declaration names, loads, or calls the native library.

## Resource and lifecycle limits

REA retains one serialized session with private, immutable APK, engine JAR and
metadata-bridge copies. Matching requests reuse the loaded engine. APK/engine
digests and JVM configuration are checked before reuse; changed inputs retire
the previous session. Sessions are cleaned after 60 seconds of inactivity, on
target/configuration changes, failure, timeout, cancellation, MCP disconnect or
server shutdown. One-shot CLI commands always join cleanup before returning.
REA never writes to the original APK or launches target code.

If Java cannot start the bridge, REA reports the selected executable and retained
startup diagnostics. Select a full JDK through `JAVA_HOME` or `PATH`, and use
`java --list-modules` to confirm `jdk.compiler` is present. A runnable JRE alone
cannot compile the bridge. Missing or ambiguous class and method selections are
input failures; discover names with `search_android_classes` and
`inspect_android_class` before correcting the selected argument.

If process cleanup cannot be confirmed, REA retains the workspace and reports its
location. That provider instance blocks subsequent engine launches until the
caller resolves the reported resources and starts a fresh instance.

The provider uses one JADX analysis worker independently of JVM processor and
garbage-collector settings. REA supplies no default heap or visible-CPU override;
Java uses its normal ergonomics and inherits caller JVM settings. Optional
provider settings add explicit JVM arguments:

```sh
export REA_JADX_HEAP_MIB=8192
# Optional, independent of the single JADX worker:
export REA_JADX_ACTIVE_PROCESSOR_COUNT=4
# Or select settings through Java's standard environment options:
export JAVA_TOOL_OPTIONS=-Xmx8g
```

Both REA settings must be positive safe integers; processor counts must also fit
the JVM's signed 32-bit range. REA preserves
`JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS` and `_JAVA_OPTIONS` rather than replacing
them. Java's standard precedence applies: explicit command-line heap settings
override `JAVA_TOOL_OPTIONS`, while `_JAVA_OPTIONS` can override command-line
settings. Evidence reports the worker's observed `Runtime.maxMemory()` rounded
down to MiB and retains exact bytes, Java version and visible processors in its
raw runtime response. The observed allocatable heap can differ from configured
`-Xmx`, especially with Serial GC. Heap is not a total RSS cap: the JVM also
uses native memory. Independent REA instances have independent queues. Whole
operations have a **120-second** execution deadline after reaching the queue's
front; upstream decompilation is limited to **90 seconds**.

Decoded manifest and method text have a **1 MiB** upstream byte budget and report
truncation. Class-name pages use indexed slices of up to 4,096 names without changing the
complete, case-sensitive search contract. A protocol frame above **8 MiB**, or combined stdout/stderr above
**32 MiB per operation**, fails with a diagnostic instead of returning an incomplete inventory
as complete. These are memory-safety boundaries, not undocumented result caps.

## Real verification

Download the explicit public fixtures once; this installs no tools:

```sh
npm run fixtures:android
export REA_JADX_MCP_JAR="$PWD/_reference/apk-integration/jadx-headless-mcp-0.7.1-all.jar"
export REA_ANDROID_TEST_APK="$PWD/_reference/apk-integration/ApiDemos-debug.apk"
npm run verify:android
```

The lane also uses the selected full JDK's `jlink` to create a disposable JRE
without the compiler module. It checks real Java startup failures, missing
selectors, recovery after failures, and CLI cancellation with owned cleanup.
The original APK and host Java configuration remain unchanged.

The download script verifies fixed SHA-256 values, reuses matching files and
refuses to overwrite a different existing file. APK/JAR files live under ignored
`_reference/` and are excluded from package contents. The lane exercises actual
REA CLI and MCP results with the real engine, separately from synthetic protocol
regressions. It needs no Gradle build, emulator, Android SDK or Ghidra.
