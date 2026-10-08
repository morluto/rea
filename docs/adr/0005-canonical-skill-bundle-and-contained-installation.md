# ADR-0005: Canonical skill bundle manifest and contained installation

- Status: Accepted
- Date: 2026-10-08
- Implementation status: Implemented for generation, packaged-byte verification,
  setup preflight, per-file atomic replacement, doctor byte comparison, and
  conformance hashing. Descriptor-bound containment, bundle-wide transactions,
  managed residue classification, and richer doctor diagnostics remain follow-up.

## Context

The authored skill tree under
`skill-src/reverse-engineer-anything/` is projected into the published package.
Generation discovered files recursively, while setup maintained a separate
hardcoded list. The two authorities could drift when a reference was added,
removed, or renamed. Installation also trusted path components beneath the
selected home directory without rejecting symbolic-link redirects.

## Decision

1. `skill-src/reverse-engineer-anything/` is the sole human-authored authority.
2. Generation emits `bundle-manifest.json` beside the generated skill. It
   contains a schema version, skill identity, skill version, sorted relative-file
   inventory, and SHA-256 for every authored file.
3. Setup reads and validates that manifest, verifies every packaged file digest,
   and installs exactly that inventory plus the manifest. Runtime code does not
   maintain a parallel file list.
4. Manifest paths must be canonical forward-slash relative paths without empty,
   `.` or `..` segments. Duplicate paths, unsupported schema versions, identity
   mismatches, and digest mismatches fail closed.
5. Setup rejects symbolic links and non-directory/non-file components observed
   during preflight, including pre-existing backup siblings. All required backup
   siblings are validated before any backup is written. Each changed file is
   replaced atomically, read back, and backed up when an original exists; rollback
   is best effort. Path-based Node.js operations do not provide descriptor-bound
   no-follow guarantees, so concurrent path replacement and crash-consistent
   bundle transactions remain unresolved.
6. The completion ledger hashes the complete generated directory, including the
   bundle manifest, so package setup evidence commits to the same bytes.
7. The canonical skill root is REA-owned for uninstall purposes. Uninstall
   removes that complete root, including operator-added files within it, while
   unrelated sibling skill roots remain outside REA authority.

## Options considered

### Keep the runtime file list in TypeScript

Rejected. It is easy to review but duplicates generator authority and turns new
references into late package failures.

### Discover package files recursively at setup time

Rejected. It would install unexpected package residue and would not establish a
reviewable, content-addressed release contract.

### Generate and verify one bundle manifest

Accepted. It gives generation, setup, doctor, package verification, and
conformance one inventory authority. Uninstall currently owns the complete skill
root rather than consulting the manifest inventory.

## Consequences

- Adding or removing an authored reference automatically changes the generated
  inventory and conformance digest.
- A malformed or tampered package fails before any skill file is installed.
- Existing installations receive the manifest as managed operational metadata.
- Skill version policy still needs an explicit compatibility/bump gate for
  behavior-bearing authored changes.

## Follow-up

- Record the previously installed managed inventory so upgrades can identify
  and safely remove obsolete REA-managed files.
- Have doctor distinguish absent, unreadable, changed, and unexpected managed
  paths and name the exact affected files.
- Validate authored frontmatter, trigger quality, local references, and catalog
  tool names before generation.
- Require a skill-version bump for behavior-bearing authored changes.
- Replace path-based setup writes with descriptor-relative/no-follow operations,
  deterministic swap-race coverage, and a crash-consistent bundle transaction.
