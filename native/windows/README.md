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
- `PROC_THREAD_ATTRIBUTE_JOB_LIST` assigns a suspended child atomically to an
  unnamed, non-inherited Job Object. Membership and kill-on-close policy are
  checked before resume. Breakaway is disabled, and cleanup waits for all
  job members and captured output, including detached descendants.
- Only the suspended child's default file owner is normalized. Caller token
  privileges and ownership remain unchanged. Caller CPU affinity and process
  priority are preserved in the child. Environment names are sorted and
  deduplicated using Windows ordinal comparison, preserving their native Unicode
  semantics and caller-selected values.
- Cleanup walks locked directory objects, removes files by handle, and unlinks
  reparse entries without traversing their targets. Normal close, cancellation,
  startup failure, and timeout release provider resources. Abrupt owner death
  kills the owned job; it can leave private runtime files for later operator
  cleanup and does not claim transactional deletion after a crash.

Windows failures retain their constraint, requested coordinate, Win32 code,
and system message. Unsupported filesystems and reparse paths are distinct
from OS access denial and missing packaged controls.

## Real verification

```powershell
npm run verify:windows-native
npm run verify:ghidra:windows
```

The native lane checks DACL readback independently, source write/replacement
rejection, unrelated sibling renames, reparse rejection, immutable snapshots,
asynchronous cancellation, cleanup containment,
descendant termination, unrelated-process preservation, normal exit, owner
close, and forced owner exit. An optional independently built
`tests/fixtures/windows/processBoundary.cc` executable adds breakaway and
caller/child token observations and an in-place ancestor reparse attempt:

```powershell
node scripts/verify-windows-native.mjs . C:\fixtures\process-boundary.exe
```

`nonAdminRunner.cc` is a test-only launcher for an elevated development shell.
It duplicates an existing non-elevated Explorer token belonging to the same
user, creates private temporary window-station objects, and launches the test
inside a kill-on-close fixture job. It does not create accounts, modify host
policy, or change the caller's token. A real-provider claim must additionally
verify the packaged CLI and MCP on that ordinary-user token.
