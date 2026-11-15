# Inspect RPM package headers and dependency metadata

This specification records an implementation increment and its original problem
statement. For current behavior and limitations, see the
[current guide](../../../guides/native/rpm-package.md).

## Outcome

RPM packages were opaque to REA: `inspect_artifact` inventories the file and
`inspect_binary_layout` can describe surrounding ELF/PE, but neither decodes
the lead, signature header, or main header. An analyst needed an external
query tool such as `rpm -qp` to read this metadata. REA now provides built-in
inspection without requiring RPM to be installed.

`rea inspect-rpm-package <path>` reads one explicitly selected RPM as static
bytes and reports lead identity, signature-header digests and blob presence,
NEVRA and dependency metadata, scriptlet presence, and the header file
inventory, without installing the package, running scriptlets, verifying
signatures, or decompressing the payload. The same facts are available through
the `inspect_rpm_package` MCP tool.

## Requirements

- The reader accepts a file whose lead magic is `0xedabeedb`; anything else is
  refused before headers are walked.
- Lead type 0 is `binary` and type 1 is `source`. Other types are unsupported.
- Signature header tag numbers are interpreted independently of main-header tags
  because the 1000+ range collides.
- Missing optional tags stay `null`. Epoch `0` is distinct from absence.
- Dependency flags render as `>=`, `=`, `<`, and siblings. `rpmlib(...)` and
  scriptlet-only requires are marked.
- Scriptlet text is omitted unless `include_script_text` is true, bounded by
  `max_script_bytes`, and never executed.
- File listing comes from header tags. Payload offset, size, and declared
  compressor are reported without unpacking gzip/xz/zstd cpio.
- Observation is bounded by caller-selected budgets that report which bound was
  hit. Oversize counts fail rather than becoming zeros.
- Malformed or truncated headers keep safely read lead/signature facts in the
  typed refusal.

## Non-goals

- Installing or upgrading packages, or running `%pre`/`%post` scriptlets.
- Cryptographic signature verification or trust decisions.
- Decompressing or listing the cpio payload as a second inventory.
- Decoding RPM v3 lead-only packages that lack header signatures.

## Verification

- Binary, source, sparse, truncated, and out-of-bounds fixtures are encoded in
  `RpmPackage.fixture.ts` and parsed in module tests.
- CLI, MCP, absolute-path, and decimal-argument boundary contracts have their
  own tests.
- Payload listing is asserted as `header` and payload bytes are not inflated.
