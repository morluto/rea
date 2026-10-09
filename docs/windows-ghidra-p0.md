# Windows Ghidra P0

This guide describes repository main. npm 4.1.0 includes the Windows
native bundle; check the [release boundary](installation.md#released-package-and-main)
before applying these instructions to an older published package.
Native x86 (32-bit) PE support is available on repository main; npm releases
through 5.0.0 admit x86-64 PE targets on Windows. Native PE DLLs are admitted
on repository main; npm releases through 6.1.0 admit PE applications only.

Status: experimental Windows x64 support for the read-only P0 boundary. Windows
package builds bundle native process, filesystem, and DACL controls. REA
uses them automatically when the analyst selects a Ghidra operation; no
additional permission flag or degraded mode is required.

## Supported boundary

- Windows 10+ x64 with fixed local NTFS target and temporary volumes;
- Node.js 22.x (>=22.19), 24.x (>=24.11), or 26+;
- an operator-installed Ghidra 12.1.x distribution (verified with 12.1.4);
- a 64-bit full JDK inside that installation's declared Java range (JDK 21 or newer, with no maximum, for current 12.1 releases);
- an explicit native, non-managed x86 or x86-64 PE application or DLL; and
- the 25 read-only Ghidra inventory, memory, and function-analysis operations.

DLLs are imported statically, like applications: REA never loads or executes
them, calls their entry routine, or resolves their imports at runtime. Exported
functions appear in procedure inventory under their export names. A DLL keeps
its observed `shared-library` role; it is not reported as an application.

Loaded memory reads and file offsets preserve Ghidra's observed source mappings.
PE load-image inspection returns measurements with an explicit unsupported
attestation status; independent format-specific verification currently supports
DOS MZ only.

This boundary does not establish general Windows feature parity. Ghidra GUI
state, annotations, other target architectures and formats, and Hopper-only
operations remain unavailable through this provider. Managed PE/CLI inspection
uses its separate execution-free provider.

REA does not install or upgrade Ghidra, Java, Python, npm, Node.js, Hopper, or a
compiler. The adapter uses the packaged Java `HeadlessScript`; Python and
PyGhidra are not prerequisites. Users do not build the native addon.

REA selects its packaged bridge scripts by explicit path. Same-named files or
directories in the caller's working directory do not select a different
script or require users to clean that directory before analysis.

## Configuration

```powershell
npm install --global rea-agents
$env:GHIDRA_INSTALL_DIR = "C:\tools\ghidra_12.1.4_PUBLIC"
$env:JAVA_HOME = "C:\tools\jdk-21"
$env:REA_ANALYSIS_PROVIDER = "ghidra"

rea doctor --json
rea providers --json
rea inspect "C:\fixtures\sample.exe" --provider ghidra --format json
```

`rea doctor` distinguishes installation prerequisites from native artifact or
OS failures. It checks the Ghidra release, headless launcher, full JDK, x64
host, and native controls. A missing or mismatched addon requires the matching
Windows x64 package; changing MCP registration cannot supply that artifact.
A filesystem or access failure identifies the failed native constraint.
Other doctor checks, including unconfigured agent integrations, can remain
unready while Ghidra itself is available.

`rea setup` can register supported agent integrations and the bundled skill.
Its existing preview and approval apply to configuration writes. Setup
preserves valid Ghidra and Java settings even when a separate runtime
prerequisite is unavailable.

For MCP, register the resolved Node entry point and the same provider settings:

```json
{
  "mcpServers": {
    "rea": {
      "command": "C:\\tools\\node\\node.exe",
      "args": ["C:\\tools\\rea\\scripts\\rea.mjs", "mcp"],
      "env": {
        "REA_ANALYSIS_PROVIDER": "ghidra",
        "GHIDRA_INSTALL_DIR": "C:\\tools\\ghidra_12.1.4_PUBLIC",
        "JAVA_HOME": "C:\\tools\\jdk-21"
      }
    }
  }
}
```

These paths are examples. Use the actual package location and restart the MCP
client after registration changes. Cold Ghidra import can exceed a client's
short default request timeout; the real verification lane allows the existing
330-second provider startup deadline to complete.

## Native authority and target identity

The verified boundary excludes SUBST aliases and changing drive-letter/DOS-device
namespaces. REA does not claim a separate SUBST detector. Mounted-folder entries
that expose reparse tags fail component admission; broader namespace variants
have not been established by this lane. Requested paths, final handle paths,
volume serials, and file IDs remain separate observations.

The loader validates package version, ABI, Node-API compatibility, PE machine,
and artifact SHA-256 before loading the package-owned addon. Native failure
reasons remain distinct from a valid installation and an unsupported target.

PE header classification and SHA-256 come from the same open file. The Windows
provider admits native x86 and x86-64 PE applications and DLLs and rejects
non-executable images, unsupported architectures, managed images, and malformed
headers. The original selected source coordinate is preserved for native
admission.

Admission opens and checks every path component without following a reparse
point. It retains handles, verifies local NTFS semantics, and observes volume
serial, 128-bit file ID, final handle path, requested path, and size. Reparse
paths, alternate streams, ambiguous coordinates, UNC paths, and other
filesystems are rejected with the actual constraint.

The snapshot streams from the admitted source handle on a background worker.
Its digest must match the parsed target digest. Ghidra imports that private,
immutable snapshot, and the bridge requires the imported program SHA-256 to
match before serving operations. Source and snapshot identities remain
separate diagnostic observations. Snapshot cancellation is checked between
64 KiB reads and cleanup waits for worker settlement.

## Private runtime, transport, and lifecycle

Runtime creation installs a protected DACL permitting exactly the current user
and SYSTEM. Readback checks the actual owner and ACEs by handle. Descriptors
and snapshots remain locked until owner cleanup. Child files inherit the
private boundary. Analysis runs with the caller's authority; these controls
are not a sandbox for the Ghidra engine or other processes using the same user.

Windows uses an authenticated listener bound to `127.0.0.1` on an ephemeral
port. The endpoint record contains only the literal loopback host and port.
The bridge writes a new record and closes its writer before the native reader
can admit it. The reader refuses concurrent writers and verifies its opened
object's private DACL. The random 256-bit bearer token stays in the private,
immutable session descriptor and is redacted from diagnostic output.

The batch launcher uses an absolute `cmd.exe`, fixed switches, delayed
expansion disabled, and quoted tokens. Command-interpreter metacharacters in
launch paths are unsupported. JVM home and temporary properties use quoted
`JDK_JAVA_OPTIONS`, preserving spaces. `APPDATA` and `LOCALAPPDATA` point into
the private runtime, isolating Ghidra preferences, logs, and caches.

Process creation assigns a suspended child atomically to an owned Job Object.
Membership and kill-on-owner-close policy are verified before resume.
Breakaway is disabled. Only the child's default file owner is normalized;
the caller token stays unchanged. Caller CPU affinity and priority are
preserved. Close, cancellation, timeout, startup failure, and provider failure
terminate the job and verify all members have settled before runtime cleanup.
Cleanup removes admitted objects by handle and unlinks reparse entries without
following their targets. Abrupt owner death kills the job but can leave
private runtime files; crash-time transactional deletion is not claimed.

## Verification

See [native controls](https://github.com/morluto/rea/blob/main/native/windows/README.md) for the separate artifact
build lane and native boundary checks. Development tarballs without the built
artifact report native controls unavailable; publishing requires the verified
artifact and manifest.

```powershell
npm run verify:windows-native
npm run verify:ghidra:windows
npm run verify:ghidra:windows -- --x86
npm run verify:ghidra:windows:package -- --x86
npm run verify:ghidra:windows -- --dll
npm run verify:ghidra:windows -- --x86 --dll
npm run verify:ghidra:windows:package -- --dll
npm run verify:ghidra:windows:package -- --x86 --dll
npm run verify:ghidra:windows:package -- C:\fixtures\installed-rea C:\fixtures\sample.exe
```

The package lane must run with an ordinary, non-elevated user token. It exercises
CLI inspection and every admitted MCP operation, validates named canonical
input/output contracts, checks the source digest stays unchanged, and verifies
runtime cleanup. Use a source-owned fixture, one analysis process at a time,
and a bounded heap for real-provider verification.

The controlled GitHub workflow runs only default-branch code on its protected
self-hosted Windows environment. A separate Linux job builds the matching
native artifact. Hosted Windows CI verifies native controls and packaged
startup separately from real Ghidra acceptance. Broader hostile-target,
concurrently mutable-path, extraction, and IPC-security claims require their
own acceptance and are not implied by this P0 result.
