# NuGet packages

`inspect-nuget-package` (CLI) and `inspect_nuget_package` (MCP) read one local
`.nupkg` and report what the package declares and what it ships. Nothing is
restored, no feed is contacted, and nothing inside the package is loaded or
executed.

```bash
rea inspect-nuget-package ./artifacts/Newtonsoft.Json.13.0.3.nupkg
```

## What is reported

- **Package identity** from the `.nuspec`: id, version, authors, description,
  license, project and repository metadata.
- **Dependency declarations**: the groups the document states, each with its
  target framework, and each dependency's version range, `include` and
  `exclude`. An absent attribute is `null`, which is not the same as an empty
  one.
- **Every archive member**: its stored path, declared size, asset kind, and its
  target-framework and runtime-identifier folder where the layout supplies one.

Asset kinds follow the path prefixes NuGet consumers distinguish: `lib/` is
`assemblies`, `ref/`, `runtimes/`, `analyzers/`, `build/`, `buildTransitive/`,
`buildMultiTargeting/`, `content/`, `contentFiles/`, `tools/`, `resources/` and
`docs/` are classified by their own prefix, and anything else is `other`.

## What is not applied

NuGet's restore-time selection for a target framework is **not** performed. A
package usually carries several framework folders and NuGet picks one per
consumer; this inventory lists them all and leaves the choice to you. A listed
asset is therefore not a claim that a given project receives it, and dependency
version ranges are declarations rather than a resolved graph. The report says so
in `source_coverage`:

```json
{
  "scope": "package-contents",
  "status": "complete-within-scope",
  "target_framework_selection": "not-applied",
  "dependency_resolution": "not-performed",
  "signatures": "not-verified",
  "package_contents": "not-executed",
  "network": "not-contacted"
}
```

## What is refused

- A member path that leaves the package root — an absolute path, a drive
  letter, or a `..` segment — is refused instead of inventoried.
- An encrypted member is not read.
- A malformed `.nuspec`, or one carrying a document type declaration, is a
  diagnostic rather than a partial guess.
- A package with no readable `.nuspec` reports `no-nuspec` and a `partial`
  status, so missing identity is never mistaken for an empty package.

Every refusal is a diagnostic. When one is present, the affected fact is
unknown; it is not reported as absent.

## Multiple `.nuspec` files

NuGet allows a `.nuspec` beside `lib/` folders as well as at the package root.
Every distinct document is reported separately and a `duplicate-nuspec`
diagnostic is added, so a disagreement between them is visible instead of one
being silently chosen.

## Delivery and retained evidence

Summary delivery reports declaration counts and source coverage while retaining the
full package inventory as parent Evidence. Reaching the member limit marks the
inventory partial only when another directory entry exists; exact end of archive
is complete within the stated scope.

Hashing and ZIP inspection use the same admitted file descriptor. Replacing or
changing the selected file is refused rather than mixing an old digest with new
contents. A cleanup failure retains the resource for retry and preserves any
completed inventory in the error Evidence.

## Limits

- File admission is 64 MiB and the member allowance is 20,000. A larger package
  reports `entry-limit-reached` and a `partial` status instead of listing
  everything.
- Only `.nuspec` members are decompressed, each into a bounded buffer; every
  other member is inventoried from the ZIP directory alone.
- The ZIP reader verifies member CRCs as it reads. Package signatures and
  publisher trust are not evaluated.

Package metadata is publisher-provided. This inventory describes what a package
declares and ships; it does not establish that the package is safe.
