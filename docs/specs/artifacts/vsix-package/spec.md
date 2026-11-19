# VS Code extension package inspection

## Problem and outcome

A `.vsix` is an OPC ZIP with `extension.vsixmanifest` and often
`extension/package.json`, but REA has no owner that reads that identity,
activation, contributes summary, or native/wasm members. Let
`inspect_vsix_package` / `inspect-vsix-package` report that metadata and a
contents inventory for one selected local file, without installing the
extension, executing anything in it, or contacting a marketplace.

## Requirements

- Report the artifact path, SHA-256 and byte length.
- Decode `extension.vsixmanifest` Identity (Id, Version, Publisher,
  TargetPlatform), DisplayName, Description, engine/dependency/pack/kind
  properties, and Assets. Decode `extension/package.json` name, publisher,
  version, `engines.vscode`, `main`/`browser` (and whether each resolves to a
  ZIP member), activation events (`*` and `onStartupFinished` flagged eager),
  a contributes summary (key names and counts; commands listed up to 32),
  extensionDependencies, extensionPack, extensionKind, untrusted/virtual
  workspace capabilities, and enabledApiProposals.
- Report disagreements between the two manifests for identity, engine range,
  dependencies, and pack members. Observed vs inferred member kinds stay
  distinguishable.
- List file ZIP members with sizes, an `encrypted` flag, a path-derived kind,
  and a `traverses` flag. Hash native `.node` addons, `.wasm` modules,
  executables/shell scripts, and nested archives (SHA-256) when they fit the
  member budget. Report `extension.signature.p7s` and `.signature.manifest`
  presence only; do not verify signatures.
- Bound the file size, ZIP entry count, manifest bytes and interesting-member
  bytes with named allowances. Enforce the entry allowance while enumerating
  the ZIP. Refuse a file that is not a valid ZIP without a partial inventory.
  Oversize manifests refuse; oversize interesting members list without a
  digest. Path-traversal names, duplicate logical paths, missing or malformed
  XML/JSON succeed with inventory and explicit limitations.
- Reject a DOCTYPE in the vsixmanifest and report it as a limitation.

## Acceptance

Synthetic fixtures cover a complete package, hashed interesting members,
identity disagreement, missing and malformed manifests, path traversal,
duplicate names, command capping, and oversize members. Tests cover non-ZIP
refusal, the entry, file, manifest and member allowances, service path
admission, CLI, MCP, and the domain schema. Limitation delivery is asserted
through the parser-owned `VSIX_LIMITATIONS` wording. The
[usage guide](../../../guides/managed/vsix-package.md) documents the result
and limits.

## Out of scope

Installing or activating the extension, signature verification, marketplace
lookups, extraction of package members, executing bundled code, and any
judgment of extension safety.
