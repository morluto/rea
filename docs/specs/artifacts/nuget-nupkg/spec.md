# NuGet package inspection

## Problem and outcome

A `.nupkg` is a ZIP with a `.nuspec` manifest, but REA has no owner that reads
package identity, dependency groups or NuGet folder roles. Let
`inspect_nuget_nupkg` / `inspect-nuget-nupkg` report that metadata and a
contents inventory for one selected local file, without restoring the package,
executing anything in it or contacting a NuGet feed.

## Requirements

- Report the artifact path, SHA-256 and byte length.
- Select the `.nuspec` from a unique OPC `_rels/.rels` relationship whose Type
  ends in `/manifest` when that target exists, otherwise from a unique root
  `.nuspec`. Missing, ambiguous or malformed manifests succeed with the ZIP
  inventory, `identity: null` and an explicit limitation.
- Report `identity`, `license`, `repository` and `dependency_groups` as spelled
  in the `.nuspec`. Ungrouped dependencies form a group with
  `target_framework: null`. Version ranges stay text; restore results are
  unknown.
- List file ZIP members with sizes, an `encrypted` flag and a path-derived
  NuGet folder `role`. Omit directory markers.
- Bound the file size, ZIP entry count and `.nuspec` bytes with named
  allowances. Enforce the entry allowance while enumerating the ZIP. Refuse a
  file that is not a valid ZIP without a partial inventory.
- Reject a DOCTYPE in the `.nuspec` and report it as a limitation.

## Acceptance

Synthetic fixtures cover a complete package, ungrouped dependencies and
missing, ambiguous and malformed manifests. Tests cover non-ZIP refusal, the
entry, file and `.nuspec` allowances, service path admission, and the domain
schema. Limitation delivery is asserted through the parser-owned
`NUPKG_LIMITATIONS` wording. The [usage guide](../../../guides/managed/nuget-nupkg.md)
documents the result and limits.

## Out of scope

Restore-time asset selection, signature verification, feed lookups, extraction
of package members and any judgment of package safety.
