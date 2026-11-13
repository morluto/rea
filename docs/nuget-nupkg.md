# NuGet packages

`inspect_nuget_nupkg` / `inspect-nuget-nupkg` reads one selected local `.nupkg`
as a ZIP and reports package identity, dependency groups, and a contents
inventory from the `.nuspec` and related package files. It does not restore the
package, execute anything in it, or contact a NuGet feed.

```bash
rea inspect-nuget-nupkg /absolute/path/to/Demo.Package.1.2.3.nupkg --json
```

With `--detail summary --evidence_output /absolute/path/nupkg.json`, the CLI
saves the complete Evidence as a new bundle and prints a summary view with the
package identity, license, repository, selected `.nuspec`, coverage, and counts
of dependency groups, dependencies, contents and limitations.

The CLI resolves relative paths against the caller's working directory. MCP
requires an absolute filesystem path and preserves that exact selection:

```json
{
  "name": "inspect_nuget_nupkg",
  "arguments": { "path": "/artifacts/Demo.Package.1.2.3.nupkg" }
}
```

## Observations

The inline Evidence result contains the artifact path, SHA-256, and byte length.

`identity` reports `id`, `version`, `authors`, and `description` as present in
the `.nuspec` metadata. Missing fields are `null`. When no `.nuspec` can be
selected, `identity` is `null`.

`license` reports the `.nuspec` license element: `type` is `expression` or
`file` when that attribute is present, otherwise `null`, and `value` is the
element text. `repository` reports `type`, `url`, `commit`, and `branch`
attributes when a repository element is present. Absent elements stay `null`.

`dependency_groups` lists each `.nuspec` dependency group with its
`target_framework` and dependencies (`id`, `version` range as spelled,
`include`, `exclude`, `development_dependency`). Ungrouped dependencies appear
as a group with `target_framework: null`. Version ranges are recorded as text;
restore results are unknown.

`contents` lists file ZIP members with the stored ZIP `name`, a logical `path`
(backslashes as `/`, leading `./` removed), uncompressed and compressed sizes,
an `encrypted` flag, and a `path`-derived `role` (`lib`, `ref`, `runtimes`,
`native`, `analyzers`, `build`, `buildTransitive`, `buildMultiTargeting`,
`content`, `contentFiles`, `tools`, `nuspec`, `opc`, or `unknown`). Directory
markers are omitted. Encrypted members are listed and not extracted.

`nuspec` names the selected manifest path, decoded byte length, and whether it
came from an OPC `_rels/.rels` manifest relationship or a unique root `.nuspec`.
When selection is missing or ambiguous, `nuspec` is `null` and the inventory
still succeeds with a limitation.

The `.nuspec` is chosen from a unique OPC relationship whose Type ends in
`/manifest` when that target exists in the ZIP. Otherwise a unique `.nuspec` at
the package root is used. Multiple conflicting manifests are not decoded.

## Limits and failures

The selected file is limited to 64 MiB by default (512 MiB maximum). At most
4096 ZIP entries are inventoried by default (65536 maximum), and the selected
`.nuspec` is limited to 1 MiB by default (16 MiB maximum). Invalid ZIP input
fails without a partial inventory.

Missing, ambiguous, or malformed `.nuspec` members succeed with the ZIP
inventory and explicit limitations. This workflow does not restore packages,
verify signatures, or select assets the way `dotnet restore` would. Member
roles are folder conventions in ZIP names. Package identity, license,
repository, and dependency metadata are publisher-provided and do not establish
package safety.
