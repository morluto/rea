# Static Android APK analysis

REA wraps an existing headless JADX engine through `src/android/`. Its source is
kept as an unmodified, commit-pinned Git submodule; see
[upstream provenance](../third_party/README.md). CLI and MCP use the same
application workflow and return artifact-bound Evidence inline.

This family is present on repository main and in npm 4.1.0. Check the
[released package boundary](installation.md#released-package-and-main) and the
connected server's tool list before selecting it.

## Supply tools

Use **Java 17 or newer** and **jadx-headless-mcp 0.7.1**. REA does not install Java,
an Android SDK, JADX, a device service or an emulator. Set the path in the shell
or MCP server environment:

```sh
export REA_JADX_MCP_JAR=/absolute/path/jadx-headless-mcp-0.7.1-all.jar
# Optional: select an existing JDK rather than java on PATH.
export JAVA_HOME=/absolute/path/existing-jdk
```

Linux is verified with the public Appium ApiDemos fixture. The POSIX adapter can
run on macOS, but that host has not undergone real Android verification.
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
- Class inventories return display signatures, fields and inner class names.
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
archive evidence; `project_android_application_graph` remains a separate,
execution-free inventory projection.

## Resource and lifecycle limits

Each request creates private, immutable APK and JAR copies. Their workspace and
owned process group are cleaned on success, failure, timeout and cancellation.
REA never writes to the original APK or launches target code.

If process cleanup cannot be confirmed, REA retains the workspace and reports its
location. That provider instance blocks subsequent engine launches until the
caller resolves the reported resources and starts a fresh instance.

The provider serializes requests within each REA instance, uses one worker and
sets JVM maximum heap to **512 MiB**. Heap is not a total RSS cap: the JVM also
uses native memory. Independent REA instances have independent queues. Whole
operations have a **120-second** execution deadline after reaching the queue's
front; upstream decompilation is limited to **90 seconds**.

Decoded manifest and method text have a **1 MiB** upstream byte budget and report
truncation. A protocol frame above **8 MiB**, or cumulative stdout/stderr above
**32 MiB**, fails with a diagnostic instead of returning an incomplete inventory
as complete. These are memory-safety boundaries, not undocumented result caps.

## Real verification

Download the explicit public fixtures once; this installs no tools:

```sh
npm run fixtures:android
export REA_JADX_MCP_JAR="$PWD/_reference/apk-integration/jadx-headless-mcp-0.7.1-all.jar"
export REA_ANDROID_TEST_APK="$PWD/_reference/apk-integration/ApiDemos-debug.apk"
npm run verify:android
```

The download script verifies fixed SHA-256 values, reuses matching files and
refuses to overwrite a different existing file. APK/JAR files live under ignored
`_reference/` and are excluded from package contents. The lane exercises actual
REA CLI and MCP results with the real engine, separately from synthetic protocol
regressions. It needs no Gradle build, emulator, Android SDK or Ghidra.
