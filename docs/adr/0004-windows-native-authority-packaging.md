# ADR-0004: Windows native authority packaging

- Status: Accepted
- Date: 2026-07-17
- Implementation status: the provider-neutral TypeScript base port and
  fail-closed host capability are implemented; the platform-package shape and
  protected runtime-projection type state are selected and implemented. The
  fail-closed package loader exists but is disabled by a null release artifact
  commitment; the platform package, native implementation, release integration,
  and real-Windows proof do not exist, so all Windows controls remain unavailable

## Context

REA's experimental Windows x64 Ghidra boundary cannot establish three security
properties with Node's public filesystem and child-process APIs alone:

- atomic process creation inside a dedicated kill-on-close Job Object;
- handle-based path admission that rejects disallowed reparse points and retains
  stable file identity; and
- creation and readback verification of protected private DACLs.

The existing fallback uses bounded `taskkill /T /F`, pathname-based Node file
operations, and POSIX mode requests. These are useful P0 mechanics, but they are
not evidence for the stronger Windows authority claims.

REA installation must remain compiler-free. Setup may not install Visual
Studio Build Tools, Python, node-gyp, PowerShell modules, or another runtime.
The packed CLI is also verified with lifecycle scripts disabled, so native
support cannot depend on an install hook.

## Decision drivers

1. Keep Win32 handles, structures, constants, and calling conventions outside
   domain, application, Ghidra, CLI, and MCP contracts.
2. Prevent target or launcher code from running before authority is established.
3. Work from an npm installation without a local compiler or install script.
4. Fail closed with typed capability diagnostics when the exact native artifact
   is absent, unsupported, unreadable, or incompatible.
5. Preserve the current limited P0 behavior without allowing it to satisfy a
   native-authority capability claim.
6. Verify the published artifact and the real Windows behavior independently.

## Options considered

### Source-built Node-API addon

Rejected. It requires a compiler toolchain during installation or setup and
would make availability depend on mutable operator build state.

### Source-owned helper executable

Rejected. A helper adds an authenticated protocol, helper-process ownership,
version negotiation, output capture, and crash cleanup without improving the
executable identity binding: it must still call `CreateProcessW` with a path.
The addon can perform blocking Win32 waits and pipe reads on source-owned native
threads and cross into JavaScript only through public Node-API operations.

### Prebuilt Windows Node-API addon in a platform package

Selected. Node-API provides an ABI-stable interface for the
handle and DACL operations when the addon uses only Node-API/node-addon-api
rather than V8, libuv, or Node internals. Release CI builds the Windows x64
artifacts. A platform-specific npm package declares
`os: ["win32"]` and `cpu: ["x64"]`; the main package references its exact
version as an optional dependency. Neither package has an install script or a
source-build fallback, and the platform package contains no helper executable.

This follows the platform-package selection pattern used by mature native npm
packages while deliberately omitting their node-gyp fallback. It also fits
REA's existing package verifier, which exercises installs with scripts disabled
and with optional dependencies omitted.

## Boundary

The TypeScript side exposes one provider-neutral external-adapter port with
three cohesive capabilities:

```text
ProviderProcess / PrivateRuntimeRoot / authorized file operations
                              |
                 WindowsNativeAuthority port
                  /            |             \
          owned process   admitted handle   sealed runtime
             lifetime       and identity      projection
                              |
          optional Windows x64 Node-API adapter package
```

The port returns typed observations and failures. It never returns raw Win32
handles, pointers, SIDs, access masks, or platform DTOs. Resource values own an
explicit idempotent `close` operation; the composition root also registers an
environment cleanup hook as crash/teardown defense, not as the normal lifetime
API.

The TypeScript port is an application-owned interface. Its operations are
limited to:

- `admitPath`, returning an opaque, closeable admitted-file identity plus
  normalized observations needed for policy decisions;
- `createPrivateRoot`, consuming admitted source trees/files and returning an
  opaque, closeable sealed projection with manifest, entry-point, launch, and
  verified owner/access-policy observations; and
- `spawnOwnedProcess`, consuming only that sealed projection plus stdio limits
  and an absolute startup deadline, and returning provider-neutral process I/O
  and lifetime operations. Source paths, executable identities, arguments, and
  environment values cannot be supplied or changed at this boundary.

Each operation returns the existing `Result` shape with a dedicated tagged
failure union covering unavailable capability, invalid input, policy rejection,
identity drift, access denial, resource exhaustion, timeout, native contract
mismatch, and unexpected native failure. No native adapter may export platform
DTOs directly to its callers.

The application-owned contract lives in
`src/application/WindowsNativeAuthority.ts`. It fixes the public names
`WindowsNativeAuthority`, `WindowsAdmittedFile`,
`WindowsAdmittedDirectory`, `WindowsPrivateRoot`, and
`WindowsOwnedProcess`. Module-owned wrappers register backend tokens in a
shared weak registry and reject resources created by another authority
instance, aliased by another backend result, or already closing/closed. File
and directory admission are distinct types, so a
directory cannot be supplied as an executable and a file cannot be supplied as
the parent of a private root. The backend must continuously drain process
output and retain no more than the committed byte limits; callers receive
detached snapshots with retained bytes, total byte counts, and truncation
flags. Process completion and close are typed results, and every native
resource owns an explicit idempotent close operation. The built-in unavailable
implementation fails all three operations closed and reports no loaded
identity; the Windows capability report continues to advertise no native
authority.

Successful path admission is deliberately narrower than an opaque native
identity string. The adapter must return the exact requested path, the
handle-derived final diagnostic path, the admitted `ntfs` filesystem tag, a
lowercase 16-hex-digit volume identity, a lowercase 32-hex-digit file identity,
and the regular-file digest where applicable. The volume identity is the
zero-padded hexadecimal representation of the unsigned `FILE_ID_INFO`
`VolumeSerialNumber` numeric value. The file identity is the lowercase
hexadecimal encoding of `FileId.Identifier[0]` through
`FileId.Identifier[15]` in array order. The composite identity is scoped to the
retained handle and admitted volume; it is not a durable global identifier and
must not authorize a later reopened object.

The application boundary parses the runtime-shaped report, rejects unknown or
malformed fields, derives one canonical string encoding, and closes the
returned backend resource before reporting a native-contract mismatch. This
proves only the shape and canonical encoding of what the adapter reports. The
trusted native implementation and real-Windows verifier must separately prove
that the filesystem tag and identity bytes came from handle-based filesystem
inspection and `GetFileInformationByHandleEx(FileIdInfo)`. TypeScript schema
validation cannot prove Win32 provenance or prevent a malicious native module
from inventing well-shaped values. This is contract hardening only: it does not
implement `CreateFileW` traversal or make the host capability available.

The sealed-root observation applies the same boundary discipline to #290. A
native result is not published as a `WindowsPrivateRoot` until the application
parses a strict readback report for five object classes: the root directory,
read-only directories, read-only files, writable directories, and writable
files. Each class commits its object kind, explicit-versus-inherited ACE
disposition, propagation flags, verified object count, descriptor digest, and
path-to-policy manifest digest. One enclosing security manifest binds all five
classes to both the sealed projection manifest and launch commitment. Its
versioned canonical input contains `version`, `projectionManifestSha256`,
`launchSha256`, and the five ordered class records, each limited to
`verifiedObjectCount` and `policyManifestSha256`.

Root and existing immutable objects require explicit protected DACLs. Directory
policies distinguish inheritable container/object ACEs from non-propagating
leaf-file policies. Writable directories require an explicit protected policy;
files created beneath them report inherited ACEs from that protected parent.
Every class must state current-user ownership, no additional trustee or broad
allow entry, SYSTEM full control, and an explicit OWNER RIGHTS denial of
`WRITE_DAC` and `WRITE_OWNER`. Root and immutable objects admit only
current-user read/execute; writable objects admit current-user modify. Null
DACLs, unexpected fields, different rights, missing OWNER RIGHTS policy,
class/propagation contradictions, count or manifest mismatches, or malformed
digests poison and close the returned native token.

These normalized values deliberately omit raw SIDs, ACEs, masks, and security
descriptor buffers. Schema acceptance proves only that the adapter reported the
selected policy vocabulary. The native implementation must create the
descriptors, read them back from retained handles, canonicalize trustee and
rights semantics, and prove the report against real non-administrator Windows
access tests. Until that implementation and verifier exist, private-DACL
capability remains unavailable.

The native package remains unimplemented. The owner boundary, packaging shape,
and launch binding are accepted; capability availability still depends on the
projection and complete native teardown state machine below passing the
real-Windows adversarial verifier.

The initial admission contract accepts only `reparsePolicy: "reject_all"` and
can report only `reparseDisposition: "absent"`. A later admitted reparse kind
must be added as an explicit normalized policy variant together with its real
Windows proof; the generic port does not provide an open-ended allow mode.

The three implementation slices remain separate:

1. **Job Object ownership (#288):** create a dedicated Job Object, apply
   kill-on-close without silent breakaway, and create the launcher already
   assigned through the process-creation attribute list.
2. **Handle-based filesystem authority (#289):** open authority-relevant path
   components without following reparse points, admit an explicit filesystem
   and reparse-tag set, retain or revalidate stable identity, and perform
   sensitive I/O through that authority.
3. **Private runtime DACLs (#290):** create the root with a protected DACL,
   verify owner/trustees/rights/inheritance by handle, and make all runtime
   children inherit or receive the verified policy.

#289 owns the shared handle and filesystem-identity primitives used by #290 and
the eventual launch binding consumed by #288. Job Object implementation follows
#289 and #290; it cannot satisfy or advertise the Windows native authority
boundary until the executable, runtime root, and session token are all
protected.

The delivery order is #289, then #290, then #288. This lets process creation
consume an already verified executable identity and private runtime root. The
P0 limitations remain in force until all three real-Windows gates pass.

`CreateProcessW` cannot consume the admitted file handle directly. A retained
path-component chain opened without write/delete sharing was evaluated and
rejected as a complete binding. It prevents later conflicting opens, rename,
and ordinary replacement, but it cannot revoke a writable mapped view created
before admission. Such a view can mutate the admitted bytes after hashing while
the writer's file handle is already closed.

Protecting only the primary executable is also insufficient for the Windows
Ghidra launch. The current launcher includes the command interpreter, a batch
script, Java, Ghidra JARs, native libraries, configuration, and DLL search
inputs. A share lock on `lpApplicationName` does not bind that runtime closure.

The selected design projects the complete non-system runtime into the private
root before process creation. Immutable-install admission is rejected: a BYO
Ghidra or JDK tree normally belongs to the same analyst identity that runs REA,
so that identity can replace content or rewrite its ACL. Treating such an
installation as immutable would silently narrow the threat boundary.

The projection contains:

- the complete Ghidra installation root, including root
  `application.properties`, the `Ghidra/` module tree, JARs, native libraries,
  launch properties, and configuration discovered by `GhidraClassLoader`;
- the complete admitted JDK 21 root;
- the packaged REA Ghidra bridge and session descriptor; and
- the digest-bound target snapshot plus private project, home, temporary,
  cache, configuration, and data directories.

The native adapter enumerates each admitted tree relative to retained directory
handles, rejects every reparse point and unsupported filesystem, admits only
regular files and directories, and applies explicit entry, depth, and byte
limits. It copies each file through handles into a newly created destination,
hashes the bytes while copying, closes and reopens the destination by handle,
and verifies the readback digest. A canonical sorted manifest of relative path,
file size, and SHA-256 is hashed into one runtime-projection identity. The
readback projection, not the mutable source installation, is intended to become
the launch authority. Concurrent source mutation may make projection fail or
produce a different committed snapshot.

Read-only projected files and directories use a protected DACL that grants the
analyst read/execute and SYSTEM full control while withholding create, write,
append, delete, `WRITE_DAC`, and `WRITE_OWNER`. Because a file owner otherwise
has implicit DACL-rewrite authority, the descriptor includes an explicit
`OWNER RIGHTS` SID entry that withholds those mutation rights. Writable runtime
subdirectories use a separate verified policy and never contain executable,
classpath, or native-library inputs. Creation and readback of both policies
belong to #290.

Applying that restrictive descriptor only after population is rejected. An
access check occurs when a handle is opened; later DACL changes do not revoke a
same-user process's previously granted write, delete, mapping, or `WRITE_DAC`
rights. The native implementation must therefore apply the final descriptor at
object creation or establish another proven construction principal/capability,
retain only non-inheritable construction handles, close every mutation-capable
handle before commit, and retain only non-mutating authority/cleanup handles.
Whether the selected non-administrator Win32 creation APIs can populate the
tree under its final descriptor remains an explicit native design/proof gap.
Until a real-Windows race proves that pre-open write, delete, `WRITE_DAC`,
directory-create, and writable-section handles cannot survive commit, REA does
not claim same-user immutability for the projection. #290 can establish privacy
against unrelated local principals without silently satisfying that stronger
same-user launch-authority requirement.

Windows launches the projected JDK directly, without `cmd.exe`,
`analyzeHeadless.bat`, `launch.bat`, `LaunchSupport`, or another pre-authority
process. REA derives and validates the exact Ghidra 12.1.2 foreground headless
arguments from the supported launch contract:

```text
<root>\jdk\bin\java.exe <validated-vm-arguments>
  -cp <root>\ghidra\Ghidra\Framework\Utility\lib\Utility.jar
  ghidra.Ghidra ghidra.app.util.headless.AnalyzeHeadless <bounded-arguments>
```

`lpApplicationName`, the classpath, script path, target, project, user, cache,
and temporary paths all resolve beneath the sealed projection. The current
directory is the sealed Ghidra root. The environment removes ambient Java and
Ghidra option variables and admits only the projected JDK `bin` plus the
canonical System32 directory into `PATH`. Java native-library paths are
enumerated from the projection manifest. The process-creation mitigation policy
rejects remote and low-integrity image loads and prefers System32 for system
images. The verifier must prove the exact supported Windows build honors these
mitigations; there is no weaker DLL-search fallback.

Trusted inputs outside the projection are limited to the Windows kernel,
KnownDLLs, and binaries or DLLs resolved from the canonical Windows/System32
roots under the supported non-administrator Windows installation. REA records
those roots and the applied mitigation policy in the native launch observation.

The implemented TypeScript port represents the projection lifecycle as type
state:

1. a mutable private-root builder accepts admitted source trees/files and
   bounded destination-relative names;
2. sealing returns an immutable `WindowsRuntimeProjection` observation with the
   readback tree digest and an opaque projected entry point; and
3. `spawnOwnedProcess` accepts only that sealed projection, rejecting a source
   admission, mutable input, foreign authority, aliased backend token, or
   closing/closed resource before crossing the native boundary.

The projection API also commits entry, depth, and byte limits; the exact
read-only and writable subtrees; the Ghidra/JDK/bridge/target roles; and the
canonical environment and VM-argument inputs. These are provider-neutral
resource roles and observations, not Win32 DTOs. #289 owns handle-relative
projection and readback, #290 owns sealing and verified DACL state, and #288
consumes only the sealed result. The port snapshots every mutable projection
and launch container before its first asynchronous boundary, leases all
source/projection capabilities across native calls, and poisons/cleans
malformed aliased root or process results before returning a contract mismatch.
Native package work must implement this sealed-projection contract and may not
reintroduce the older admitted-file spawn signature.

The verifier must include a writable mapping established before admission,
hard-link alias writes, ordinary and POSIX-semantics delete/rename, reparse
substitution, DLL search substitution, post-admission changes to scripts, JARs,
native libraries, and configuration, owner attempts to rewrite the sealed DACL,
and attempts to inherit or duplicate REA's retained authority handles. It must
also prove that Ghidra starts after the original JDK and Ghidra trees are renamed
or modified, demonstrating that no original runtime byte is used after
projection. Network and other filesystems whose semantics cannot satisfy the
selected proof fail closed. No implementation may fall back to the original
unbound pathname or batch launcher.

## Process I/O and lifetime mechanism

The proposed process implementation is addon-only. Before the application
publishes a `WindowsOwnedProcess`, it strictly parses a normalized ownership
report requiring a dedicated unnamed Job Object, atomic
`PROC_THREAD_ATTRIBUTE_JOB_LIST` assignment, execution assigned at creation,
kill-on-close enabled, breakaway disabled, no admitted nested job, a retained
non-inheritable owner handle, exactly one REA-owned Job handle, stdio-only
inherited handles, and verified membership. The application derives the policy
digest from a versioned ordered projection of every normalized field; it does
not accept an opaque backend digest. A missing, malformed, broader, or unknown report
poisons the native token and closes the Job rather than degrading to
create-then-assign or `taskkill`. This validates only the adapter's report; the
native implementation and real-Windows verifier must prove the actual attribute
list, queried limits, membership, and descendant behavior.

The single-owner-handle claim means the addon creates no internal duplicate and
retains only its one non-inheritable Job handle. An unnamed Job prevents a new
open by name, but it does not stop another process that can obtain
`PROCESS_DUP_HANDLE` access to REA from duplicating that handle. Consequently
last-handle kill-on-close is claimed only against processes outside that handle-
theft boundary. Same-user handle theft remains unproven unless the native design
can protect the REA process handle and the verifier demonstrates failed
duplication attempts; it is not implied by the normalized report.

One native resource owns the Job Object, process/thread handles, anonymous-pipe
endpoints, wait state, bounded output accumulators, and its reader/wait threads.
The launch sequence creates
non-inheritable parent pipe ends and supplies only the three intended child
stdio handles through `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`. Both the handle-list
and job-list attributes are installed in one correctly sized attribute list;
`bInheritHandles` is true as required by the handle-list contract, while every
unlisted native handle remains non-inheritable.

The parent closes its duplicates of the child pipe ends immediately after
`CreateProcessW` returns. Reader threads exclusively own the remaining parent
read handles.

Dedicated native reader threads continuously drain stdout and stderr regardless
of JavaScript consumption. Each accumulator records an overflow-checked total
byte count while retaining at most its committed byte limit. `snapshot()` copies
the retained prefix into new Node buffers; no external buffer aliases native
storage. A native wait thread observes process completion. Promise completion
crosses to the main thread through a size-one Node-API `ThreadSafeFunction`
using nonblocking calls; an already queued exit notification is coalesced rather
than blocking a native thread. Native threads acquire and release the TSFN and
never call V8, libuv, or JavaScript directly. `waitForExit` cancellation removes
only that waiter and cannot release the Job Object.

Normal `close` is idempotent: transition once to closing and close the Job Object
to trigger kill-on-close. Process termination closes every inherited pipe write
end, allowing readers to drain retained tail bytes and receive EOF. If a reader
has not exited by the cleanup deadline, call `CancelSynchronousIo` with that
reader's thread handle; never close a read handle from underneath a synchronous
`ReadFile`. Join each reader before closing its read handle or freeing its
accumulator. A timeout keeps native state owned until all threads have exited;
it cannot detach or free live reader state.

Environment teardown first aborts the TSFN. Every reader/wait thread stops
calling it on `napi_closing`, releases its acquisition, and exits. An
`napi_add_async_cleanup_hook` joins native threads without blocking the
JavaScript thread; native state is freed only after both async cleanup and the
TSFN finalizer have completed. Pending promises may be abandoned only after
JavaScript execution is unavailable. Object finalization requests the same
state transition but does not independently free state or silently detach a
live job.

## Packaging and loading contract

- Support is initially exact to Windows 10 / Windows Server 2016 or newer on
  x64, and the Node ranges declared by the main package. Runtime loading probes
  the required process-attribute APIs and fails closed; there is no suspended or
  post-creation Job assignment fallback.
- Release CI builds from source and publishes the platform package before the
  matching main package version.
- The main package pins the optional dependency to the exact same version.
- npm package integrity is the installation authenticity boundary. Release CI
  writes the platform artifact SHA-256 into the version-matched main package's
  generated metadata before publication. REA must compare that pinned value
  with the addon bytes immediately before loading, require the exact package,
  version, contract, Node-API level, and export set, and record the loaded
  identity for diagnostics. Before first load, the process-global loader rejects
  an existing `require.cache` entry for the exact canonical resolved addon path.
  After acceptance it pins the returned module object, canonical path, and
  identity for the process lifetime: a repeat request for that same tuple is
  idempotent, while a different observable path or identity is rejected. Alias
  loads and native images that are not observable through that exact JavaScript
  loader entry belong to the excluded pre-existing same-user boundary; the
  loader does not claim process-wide native-image enumeration.
- The addon bootstrap has a deliberately narrower threat boundary than the
  runtime projection it creates. REA loads and validates the addon before it
  starts Hopper, Ghidra, a target, or another provider-controlled process. npm
  integrity plus the release-generated digest detects package drift, but a
  hash-path-`require` handshake cannot prevent an already-running process under
  the same Windows user from replacing bytes between verification and native
  image mapping, restoring them afterward, injecting into REA, or preloading a
  cache entry. REA does not claim resistance to that pre-existing same-user
  bootstrap attacker. This is consistent with the separately documented
  unproven same-user Job-handle theft boundary; it is not evidence for runtime
  projection immutability.
- After the bootstrap-accepted addon is loaded, #289/#290 must project every
  non-system byte that a provider or target can cause REA to execute or read as
  authority, including Ghidra, the JDK, bridge/session inputs, target snapshot,
  and runtime configuration. At the composition root, a bootstrap failure must
  occur before a Hopper/Ghidra/provider client is constructed, a target is
  opened or admitted, or provider/target code is run. After bootstrap succeeds,
  no provider or target process may start before the complete projection is
  sealed. Ordinary side-effect-free JavaScript module evaluation is not part of
  that execution claim. The addon itself remains bound to the installed npm
  release and is not recursively required to project itself before loading.
- A future claim that includes hostile pre-existing same-user processes needs a
  different bootstrap, such as a signed separately protected launcher or a
  native main executable. That stronger boundary is outside #287–#290 and must
  not be inferred from package hashing or DACL readback.
- Runtime selection admits only the expected package, platform, architecture,
  Node-API version, native contract version, and exported operation set.
- Missing optional dependencies, `--omit=optional`, unsupported filesystems,
  nested-job conflicts, or native load failures produce typed unavailable
  outcomes. They never trigger node-gyp, a download, PowerShell, `icacls`, or a
  helper fallback.
- The current `taskkill` and pathname implementations remain explicitly limited
  fallbacks and cannot set the native authority capability flags.

## Verification

Package verification must prove:

- ordinary packed installation selects the exact Windows x64 package;
- installation with scripts disabled performs no build or download;
- omission or removal of optional dependencies fails closed with actionable
  doctor output;
- registry/package-lock integrity authenticates the installed package set,
  while the main-package metadata digest independently detects runtime artifact
  drift and release-pair mismatch without acting as another signature;
- the exact main/platform version pair and platform-tarball/addon digest match
  before native evaluation;
- digest, package, version, contract, Node-API, or manifest-declared export-set
  mismatch prevents addon evaluation and leaves provider construction, target
  admission, and provider/target launch counts at zero; an actual runtime export
  or identity mismatch is detected immediately after evaluation and prevents
  backend use, provider construction, target admission, and provider/target
  launch;
- an exact resolved path already present in `require.cache` is rejected before
  use, a second load of the pinned tuple is idempotent, and another observable
  path or identity is rejected;
- unsupported or omitted packages never probe provider or target paths and
  return the typed unavailable outcome;
- a successful bootstrap is followed by a sealed complete projection before
  direct projected-Java launch; and
- the published main and platform packages resolve as one release set.

Neither package verification nor the real proof may claim survival when a
same-user attacker can replace both the main metadata and platform package,
inject into REA, or preload an alias outside the exact observable cache entry.
Real proof output must retain this bootstrap limitation after #289/#290 pass.

The self-hosted real-Windows verifier must separately prove the acceptance
criteria in #288, #289, and #290 while running as a non-administrator. Mocked
Node tests may verify TypeScript routing and failure translation but cannot
satisfy Job Object, reparse-point, file-identity, or DACL claims.

## Consequences

- Releases gain a coordinated Windows platform package and Windows build job.
- Installing without optional dependencies keeps the CLI usable but leaves the
  stronger Windows authority unavailable.
- The native surface remains deliberately small and security-specific.
- Native reader threads add a small, explicit concurrency surface, but keep
  output progress independent of JavaScript scheduling and preserve the public
  Node-API ABI boundary.

## Research basis

- Node-API documentation states that ABI stability requires exclusive use of
  Node-API/node-addon-api and excludes direct V8, libuv, and Node internals.
- `node-pty` demonstrates a public Node-API `ThreadSafeFunction` carrying a
  Windows process-exit observation from a native wait thread. REA adopts the
  thread-delivery pattern, not its process-tree enumeration or install-time
  native build/copy workflow.
- `sharp` demonstrates platform-specific optional npm packages selected with
  `os`/`cpu` metadata. REA adopts that distribution shape but not its
  source-compilation fallback.
- `better-sqlite3` demonstrates broad prebuilt coverage, but its
  prebuild-install-to-node-gyp fallback conflicts with REA's compiler-free
  installation rule.

These external repository summaries are discovery evidence. The implementation
must still be verified against current Node-API, npm, Win32, repository source,
package artifacts, and the real Windows runner.
