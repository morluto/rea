# Windows native controls

REA ships one Windows x64 Node-API 8 addon. Users do not compile it or install
another runtime. Ghidra and a full JDK remain bring-your-own prerequisites.
The addon uses Windows 10+ APIs and admits fixed local NTFS volumes only.

The package owns the artifact path. The loader checks the package version,
ABI, Node-API compatibility, PE architecture, and SHA-256 before loading it.
There is no environment override for loading an arbitrary native module.

## Build

The artifact lane requires Linux, MinGW-w64 `x86_64-w64-mingw32-g++`,
`x86_64-w64-mingw32-dlltool`, and `tar`. It never installs these commands.
Node-API headers are reused from the build cache or downloaded from the
pinned official Node release with its published SHA-256 checked.

```sh
npm run build:windows-native
npm run verify:windows-native:artifact
npm pack
```

`build/` is ignored by Git. The npm file inventory includes only the addon and
its manifest. Release CI builds both, and `prepublishOnly` rejects a missing,
stale, mismatched, or wrong-architecture artifact. A development tarball built
without this lane reports Windows native controls as unavailable.

## Boundaries

- Opaque Node objects carry a native type tag, resource kind, and closed state.
  A pathname, serialized object, or forged handle cannot grant authority.
- Input admission opens every component with `OPEN_REPARSE_POINT`, verifies
  the actual NTFS object, and retains handles that deny replacement and source
  writing. An admitted child keeps each ancestor nonempty; ancestor handles
  permit unrelated writes while NTFS rejects in-place reparse conversion. Volume serial, 128-bit file ID, final handle path,
  requested path, size, and digest observations are preserved separately.
- New runtime roots and private child objects are created relative to admitted
  parent handles with `NtCreateFile`. A protected DACL and current-user owner
  are installed at creation. Readback permits exactly the current user and SYSTEM. Child
  files inherit this boundary; private files are also checked by handle.
- Snapshots stream through a 64 KiB buffer on a Node async worker. Cancellation
  is checked between reads, cleanup waits for settlement, and the digest
  commits to the bytes written. Descriptor and snapshot handles remain held
  until runtime cleanup.
  Snapshot ownership is single-flight per runtime: an overlapping request fails
  with `ERROR_BUSY` before acquiring cancellation ownership. The TypeScript owner
  records only the accepted promise and abort listener; aborting a rejected copy
  must not cancel the active copy.
- `PROC_THREAD_ATTRIBUTE_JOB_LIST` assigns a suspended child atomically to an
  unnamed, non-inherited Job Object. Membership and kill-on-close policy are
  checked before resume. Breakaway is disabled, and cleanup waits for all
  job members and captured output, including detached descendants.
- A launch may request a Job Object commit limit (`JOB_OBJECT_LIMIT_JOB_MEMORY`)
  as a positive, page-aligned safe-integer byte count; invalid values fail
  with `ERROR_INVALID_PARAMETER` before any process is created. Readback must
  match the requested flags and limit exactly. A private I/O completion port is
  associated with that job before the child is created; each poll drains it
  without waiting and records a sticky `memoryLimitReached` when
  `JOB_OBJECT_MSG_JOB_MEMORY_LIMIT` arrives, alongside the job's
  `peakJobMemoryBytes`. Notifications are drained before checking for exit
  and again after exit is observed, so a memory failure between those steps
  is included in the first exit report. Runtimes report a reached limit
  differently (Bun 1.4.2 exits 1
  after a JavaScript out-of-memory exception or 3 after a panic), so callers
  classify by the notification. `inspect` reports `jobMemoryLimit` only after
  creating such a job and port. An artifact without that capability refuses a
  requested limit rather than launching an unlimited process. REA requests
  limits only for its JavaScript helpers when running on Bun, which ignores
  their V8 heap flags; Node.js launches are unchanged.
- Only the suspended child's default file owner is normalized. Caller token
  privileges and ownership remain unchanged. Caller process priority is
  preserved in the child, and caller CPU affinity whenever both occupy the same
  processor group. Windows chooses a new process's group itself and rejects a
  mask belonging to another group, so a child placed elsewhere keeps that
  group's default when the caller asked for no bound of its own. A caller
  deliberately pinned to fewer processors than its group holds is a constraint
  such a child cannot express, and is refused rather than widened to that
  group's default. A mask covering its group's whole active set does not
  distinguish a caller Windows placed in that group from one that selected the
  group deliberately, so such a child can still be placed elsewhere: its
  processor count stays bounded, its group placement is not preserved, and
  neither that case nor the refusal above has a verification lane, because both
  need a host whose processors span more than one group.
  Environment names are sorted and deduplicated using Windows
  ordinal comparison, preserving their native Unicode semantics and
  caller-selected values.
- Cleanup walks locked directory objects, removes files by handle, and unlinks
  reparse entries without traversing their targets. Failed removal retains the
  root and ancestor leases for retry; a partially removed runtime accepts only
  cleanup, and its registry entry remains until removal succeeds. Normal close, cancellation,
  startup failure, and timeout release provider resources. Abrupt owner death
  kills the owned job. The Android provider additionally uses a detached helper
  that owns its private runtime directory and cleans it when the owner pipe
  closes. Other providers can leave private runtime files after owner death;
  helper death and host power loss are not transactional deletion.

Windows failures retain their constraint, requested coordinate, Win32 code,
and system message. Unsupported filesystems and reparse paths are distinct
from OS access denial and missing packaged controls.

A failed runtime-parent admission additionally reports
`runtimeAllocation: "not-started"`: no runtime directory was created. The
Windows adapter uses that fact with numeric sharing/lock codes 32/33 to retain
a retryable private-runtime failure, including after successful native
authority caching. Missing allocation evidence, other codes, and opaque error
text do not establish a safe retry. Analysis errors propagate the producer's
retry disposition through JavaScript, source-map and WABT workflows; transient
failures report `category: unavailable` and retain the original reason.
Incomplete cleanup blocks an operation retry until its owned resources settle.
REA adds no automatic retry loop or new analysis cache for this behavior.

Ordinary drive-absolute paths accept backslashes, forward slashes, or mixed
separators. File identity retains the original requested spelling. Separator
translation does not resolve dot components, repeated separators, or extend
the supported device/UNC namespaces; existing admission checks still apply.

The bearer-token descriptor remains under its immutable private lease until
`runtime_close` on Windows; POSIX removes the descriptor after the bridge reads
it. Job ownership guarantees process termination on owner death. Android's
detached workspace helper provides a separate cleanup owner for that provider,
but simultaneous helper death or power loss can still leave private files.
SUBST drive aliases and changing DOS-device
namespaces are outside the verified P0 scope and are not detected as a separate
alias policy. Mounted-folder paths that report a reparse tag are rejected by
component admission; broader namespace variants remain unverified. Preserve
requested and final handle coordinates rather than treating them as one identity.

## Real verification

```powershell
npm run verify:windows-native
npm run verify:ghidra:windows
```

The native inspection probe retains its directory owner if deletion fails. A
later availability query retries that cleanup before creating another probe;
successful admission and static artifact failures remain cached. Environment
teardown makes one final cleanup attempt and reports a persistent failure to
stderr rather than claiming the directory was removed.

CI separately builds and verifies a test-only artifact:

```sh
node scripts/build-windows-native.mjs --inspection-fixture
```

On Windows, after compiling the runtime:

```powershell
node scripts/verify-windows-native-inspection.mjs
```

This artifact injects one access-denied disposition result while using a real
NTFS directory. The verifier checks retained ownership, recovery on a later
query, cached successful admission, and cleanup on environment teardown. It
does not reproduce or identify the host-dependent cause reported in #1701.
The fixture is stored under `.cache/` and is excluded from the shipped addon.

The native lane checks DACL readback independently, source write/replacement
rejection, unrelated sibling renames, reparse rejection, immutable snapshots,
asynchronous cancellation, cleanup containment,
descendant termination, unrelated-process preservation, normal exit, owner
close, forced owner exit, and Job Object commit limits: invalid limit
rejection, a 128 MiB-limited child allocating external Buffer memory that the
V8 heap flags cannot bound (limit notification, peak commit at the limit, all
members settled, with the notification present in the first native exit report
and the wrapper's exit event), and a control under the same limit that
completes normally.
A separately built `tests/fixtures/windows/processBoundary.cc` executable adds
breakaway, caller/child token and environment semantics observations and an
in-place ancestor reparse attempt. The lane skips all of them when the
executable is absent, so both Windows workflows cross-build it in the same
MinGW job that builds their artifact and pass it: the capability and package
lane in `.github/workflows/ci.yml`, and the real Ghidra proof run in
`.github/workflows/real-ghidra-windows.yml`. Build it locally with any Windows
C++ compiler, or the same way they do, and pass its path:

```powershell
node scripts/verify-windows-native.mjs . C:\fixtures\process-boundary.exe
```

`nonAdminRunner.cc` is a test-only launcher for an elevated development shell.
It duplicates an existing non-elevated Explorer token belonging to the same
user, creates private temporary window-station objects, and launches the test
inside a kill-on-close fixture job. It does not create accounts, modify host
policy, or change the caller's token. A real-provider claim must additionally
verify the packaged CLI and MCP on that ordinary-user token.
