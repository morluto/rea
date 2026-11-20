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
the `.nuspec` metadata. Authors and description follow NuGet's first eligible
leaf rule with case-insensitive local names. Empty leaves and ordinary
whitespace-only leaves are skipped. Whitespace preserved by CDATA or
`xml:space` can occupy the first slot and yield `null` even when a later leaf
has text. The package ID and version use their case-sensitive names in the
metadata namespace. Missing fields are `null`. In the `.nuspec` and OPC
relationships, XML end-of-line handling maps CRLF and lone CR to LF. When no `.nuspec` can be
selected, `identity` is `null`.

`license` reports the `.nuspec` license element: `type` is `expression` or
`file` when that attribute is present, otherwise `null`, and `value` is the
element text. `repository` reports `type`, `url`, `commit`, and `branch`
attributes when a repository element is present. Absent elements stay `null`.
Transport URL userinfo is excluded, with `url_credentials_redacted` marking
that exclusion; a URL whose credential span cannot be located is `null` with
that flag set. Other URL spelling and query values are preserved. OPC
relationship diagnostics apply the same exclusion.

`dependency_groups` lists each `.nuspec` dependency group with its
`target_framework` and dependencies (`id`, `version` range as spelled,
`include`, `exclude`, `development_dependency`). Ungrouped dependencies appear
as a group with `target_framework: null` when the `.nuspec` has no `<group>`.
Beside `<group>` elements, in any `<dependencies>` element, they are omitted and
a limitation gives their count: NuGet's restore-time reader ignores them, and
`nuget pack` refuses that mix. Version ranges are recorded as text; restore
results are unknown.

`contents` lists file ZIP members with the stored ZIP `name`, a logical `path`
(backslashes as `/`, leading `./` removed), uncompressed and compressed sizes,
an `encrypted` flag, and a `path`-derived `role` (`lib`, `ref`, `runtimes`,
`native`, `analyzers`, `build`, `buildTransitive`, `buildMultiTargeting`,
`content`, `contentFiles`, `tools`, `nuspec`, `opc`, or `unknown`). `opc` marks
OPC packaging parts: `[Content_Types].xml`, `.rels` relationship parts, and
members under `_rels/` or `package/`, where `nuget pack` writes the core
properties `.psmdcp`. Directory markers are omitted. Encrypted members are
listed and not extracted.
Unflagged non-ASCII names use the ZIP CP437 fallback unless a valid Unicode Path
extra field supplies the name. For fallback names, limitations identify the
member, retain the exact raw filename bytes as hex, and mark the source encoding
as unverified. ASCII names, flagged UTF-8 names, and valid Unicode Path names do
not carry that uncertainty warning.

`nuspec` names the selected manifest path, decoded byte length, and whether it
came from an OPC `_rels/.rels` manifest relationship or a unique root `.nuspec`.
When selection is missing or ambiguous, `nuspec` is `null` and the inventory
still succeeds with a limitation.

The `.nuspec` is chosen from a unique OPC relationship with Type
`http://schemas.microsoft.com/packaging/2010/07/manifest` when that target
exists in the ZIP. Both `Relationships` and `Relationship` must use the OPC
relationships namespace. The inspector skips other child elements and still
considers eligible relationships beside them. Without an eligible target, it
uses a unique `.nuspec` at the package root. Multiple conflicting manifests
are not decoded.

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

Evidence parameters retain only caller-selected controls; execution resolves omitted budgets from the documented defaults.
