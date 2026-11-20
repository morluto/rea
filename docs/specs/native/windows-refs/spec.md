# Windows ReFS filesystem authority

## Problem and outcome

The Windows native authority currently admits only fixed local NTFS volumes.
Its `openFile` admission combines the filesystem-name check and the persistent
ACL check in one failure, so a ReFS target is rejected with `Backing volume must
be NTFS with persistent ACLs` even when ReFS reports `FILE_PERSISTENT_ACLS` and
the target's DACL is readable. The rejection occurs while creating the protected
target snapshot, before Ghidra starts.

Extend the existing shared Windows filesystem authority to fixed local ReFS
volumes without weakening its handle, identity, DACL, snapshot or cleanup
boundaries. NTFS behavior must remain unchanged, and every other filesystem must
continue to fail closed. This increment belongs to the additional-filesystem
acceptance direction in
[#289](https://github.com/morluto/rea/issues/289).

## Requirements

- Admit a fixed local volume only when its filesystem is `NTFS` or `ReFS` and it
  reports `FILE_PERSISTENT_ACLS`. Keep the existing fixed-drive, path-component,
  reparse-point and sharing admission rules unchanged.
- Report unsupported filesystems and missing persistent ACL support as distinct
  constraints. Do not imply that ReFS lacks ACL support.
- Record the observed filesystem in the native `File` or `Runtime` owner at
  admission. Handle-relative private children inherit the runtime's filesystem;
  snapshot sources and destinations report their respective observed values.
  Remove the hardcoded `NTFS` identity projection.
- Accept exactly `NTFS` and `ReFS` in `windowsFileIdentitySchema`; unknown values
  remain invalid. Preserve the existing native observation structure and ABI
  version. An older consumer that only understands NTFS must continue to fail
  closed when it encounters ReFS.
- Reuse the existing handle-relative implementation rather than adding a second
  filesystem backend. Do not add an environment override or a fallback that
  bypasses source admission, private DACLs, stable file identity, reparse
  rejection, immutable snapshots or owned cleanup.
- Extend the independent Windows verifier fixture to report volume semantics,
  and make the real native verifier check source, runtime and snapshot
  filesystem identities against that independent observation.
- Run the complete native conformance lane on NTFS and ReFS at the same revision,
  including DACL readback, source replacement denial, unrelated sibling rename,
  ancestor reparse denial, snapshot digest/cancellation and cleanup containment.
  Run the complete real Windows Ghidra lane on ReFS and repeat it on NTFS.
- Update the Windows native build guide, Windows Ghidra P0 limitations, recovery
  guidance and verifier reports to say fixed local NTFS/ReFS only. Preserve all
  unrelated NTFS documentation and claims.

## Acceptance

Focused TypeScript tests accept NTFS and ReFS identities and reject unsupported
filesystem values. The native build produces the Windows x64 artifact through
the existing Linux/MinGW lane with Node 24.22.1, and generated artifacts remain
uncommitted.

The same revision passes the complete native verifier on both filesystems and
the real Windows Ghidra verifier on both filesystems. Source and snapshot
filesystem identities are observed independently rather than asserted only from
REA's own output. Relevant source, boundary, documentation, artifact and package
checks pass; any unrun or failed check is reported explicitly and prevents a
complete-support claim.

## Evidence already obtained

A disposable independent Win32 probe, built with the WSL MinGW toolchain and run
without elevation, completed 24 checks on each filesystem. Both NTFS and ReFS
reported persistent ACLs; created and read back protected private DACLs;
provided stable 128-bit file IDs and final handle paths; denied source writes,
source replacement and ancestor replacement through sharing violations; allowed
an unrelated sibling rename; rejected conversion of a pinned nonempty ancestor
into a reparse point with `ERROR_DIR_NOT_EMPTY`; and removed junctions by handle
without modifying an external sentinel. The probe source, executable and owned
test directories were removed. These observations support feasibility but do
not replace the complete REA verification required above.

## Out of scope

- SMB, UNC, exFAT, FAT32 and other filesystems or namespace variants.
- Admitting reparse components, SUBST aliases, mounted-folder aliases or a
  mutable-path/provider authority expansion.
- A separate ReFS backend, changed process-execution authority, Ghidra database
  mutation, or a native ABI version/structure change.
- Weakening a failing assertion or omitting a required verification lane to make
  ReFS appear supported.
- Marking the upstream pull request ready on behalf of the human owner or
  merging it.
