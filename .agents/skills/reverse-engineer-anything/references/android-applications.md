# Android application artifacts

Use the connected server's advertised Android tools. Repository main and npm
4.1.0 include this family. A skill installation alone cannot add it to an
older server.

Start with `inspect_android_package` on the caller's APK path for package
identity, manifest declarations, coverage, and inline Evidence. Use
`search_android_classes` to find candidates, `inspect_android_class` for one
class's members, `inspect_android_method` for decompilation, and
`trace_android_references` for incoming static references. Each call takes its
own APK path and explicit selectors; do not open a native session first.
Choose an `overload_index` from the class inventory when methods are ambiguous
instead of guessing.

For JNI implementations, discover `inspect_android_jni_bindings`. Select raw
DEX class/method identities and optional descriptors, ABI or logical library
paths. Prefer `detail: "summary"`; complete Evidence remains retained and
`android-jni` views page declarations, libraries, candidates or binding rows
with exact fields. Global native-pair ambiguity survives class selection.
Preserve slot/relocation provenance and source coverage: matched means observed
candidate presence; partial scans do not establish uniqueness or absence.
This reads DEX/ELF bytes without loading the APK into the decompiler or executing
target code. Runtime registration and loading remain unknown. See the
[JNI guide](https://github.com/morluto/rea/blob/main/docs/android-analysis.md#link-native-declarations-to-jni-candidates).

For an R8/ProGuard release build with its `mapping.txt`, pass the absolute
`mapping_path` to `inspect_android_class` or `inspect_android_method`. Prefer
`detail: "summary"` to receive normalized symbols or the selected body without
duplicate raw class metadata. Complete Evidence stays retained under the linked
parent ID and can be exported; CLI summary delivery requires `--evidence_output`.
Omitted or complete detail preserves the full inline response. Keep
selecting by observed names; the separate `mapping` block reports each symbol
as `mapped`, `ambiguous` or `unmapped` after checking DEX types and prototypes.
REA does not verify that the mapping belongs to the APK build.

The provider requires a separately supplied headless JADX MCP JAR 0.7.1 and
Java 17 or newer. `REA_JADX_MCP_JAR` selects the absolute JAR path; `JAVA_HOME`
can select Java. Use `rea doctor --provider jadx --json` to check the JADX
configuration and obtain remediation for missing prerequisites. Java and the
headless JADX MCP JAR remain caller-supplied; REA setup does not install or
configure them. Configuration readiness does not establish successful analysis
of a particular APK.

Linux and macOS use the POSIX owned-process boundary. Windows x64 requires the
matching bundled native controls and uses an owned Job Object with bidirectional
stdio. A full JDK, including `jdk.compiler`, is required on every host; Windows
`JAVA_HOME` selects `bin\java.exe`. Consult the Android guide for actual host
verification coverage. Calls use one worker and provider deadlines; optional
`REA_JADX_HEAP_MIB` selects the JVM heap and `REA_JADX_OPERATION_TIMEOUT_MS`
the per-operation deadline (integer milliseconds from 1 to 2147483647, default
120000). To change that deadline on a running MCP server, set
`jadx.operation_timeout_ms` through `update_analysis_settings`, then retry after
work and cleanup settle. Newly accepted operations use the override; accepted
work keeps its budget. Changing the launch environment requires a new process.
The MCP client's tool timeout must also allow the selected deadline. The APK is never launched,
and no emulator is required.

Manifest entries and decompiled text are static observations, not execution or
policy enforcement. Incoming references are recovered static relationships;
reflection, dynamic loading, and unresolved calls remain unknown. Preserve
artifact digests, locations, diagnostics, and incomplete coverage. For archive
members rather than code analysis, use `open_binary` and `inspect_artifact`.

## Large APKs

Keep defaults when the APK fits. When retained diagnostics establish JVM heap
exhaustion, check the observed maximum heap and available host/container memory.
Budget for JVM native memory and other processes as well; a heap cap is not a
total memory cap. One 105,453-class APK exhausted an observed 2 GiB heap; loading
completed with `REA_JADX_HEAP_MIB=6144`. This is an example, not a minimum or a
guarantee for other APKs. Only use it when the memory budget permits:

```sh
REA_JADX_HEAP_MIB=6144 rea inspect-android-package /absolute/path/app.apk --format json
```

For MCP, set the variable in the environment of the REA server handling the
request before it starts; changing an unrelated shell does not affect a running
server. Retain the failed diagnostics and retry the same bounded operation.
Heap exhaustion differs from a missing JADX JAR, `jdk.compiler`, or client tool
registration; use the prerequisite or connection remedy for those failures.

If deliberately using the headless JADX MCP server directly, inspect its
`tools/list` first. Its 0.7.1 `load_apk` schema supports `include_packages`, a
comma-separated string of package or fully qualified class prefixes to keep.
An unscoped direct load can trigger broad preprocessing; `threads: 1` alone
does not narrow that work. For a focused investigation, call `load_apk` with
arguments such as:

```json
{
  "path": "/absolute/path/app.apk",
  "include_packages": "com.example.feature,com.example.MainActivity",
  "threads": 1
}
```

Replace the example prefixes with discovered candidates. These are direct JADX
arguments, not REA Android tool arguments; REA manages its own loading behavior.
Record the selected prefixes as a coverage limit: omitted classes and their
references remain unexamined. Unload the APK and terminate the owned direct
server when finished.
