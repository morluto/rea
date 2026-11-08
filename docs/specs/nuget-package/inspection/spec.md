# Inventory a local NuGet package offline

Issue: https://github.com/morluto/rea/issues/8144

## Problem

REA identifies NuGet as an important .NET package ecosystem but had no focused,
read-only workflow for inspecting a supplied `.nupkg`. A NuGet package contains
more than assemblies: its `.nuspec` metadata, target-framework asset groups,
dependency declarations, build and analyzer assets and package content decide
how consumers actually receive the code, and none of that was observable
without restoring the package or contacting a feed.

## Desired behavior

`inspect_nuget_package` (MCP) and `rea inspect-nuget-package` (CLI) read one
local `.nupkg` and return retained Evidence describing its declared identity,
its dependency declarations and every archive member. No package is restored,
no feed is contacted, and nothing inside the package is loaded or executed.

## Requirements

- Package identity, version, authors, description, license, project and
  repository metadata are read from the `.nuspec`.
- Dependency groups and their version ranges are reported as declarations, in
  the order the document states them, keeping `include` and `exclude` distinct
  from "absent".
- Every archive member is inventoried by its stored path, declared size, asset
  kind and, where the layout supplies one, its target-framework and
  runtime-identifier folder. `lib/<tfm>/` is `assemblies`; a RID-specific copy
  under `runtimes/<rid>/lib/<tfm>/` stays a `runtime` asset so the two are not
  conflated.
- NuGet's restore-time asset selection for a framework is **not** applied. A
  listed asset is not a claim that a consumer receives it; `source_coverage`
  says so with `target_framework_selection: not-applied` and
  `dependency_resolution: not-performed`.
- Every `.nuspec` member is reported separately rather than one being chosen.
  A malformed document, a rejected document type declaration and a package with
  no readable `.nuspec` are diagnostics, and a duplicate `.nuspec` is an
  observation that does not by itself reduce coverage.
- A member path that leaves the package root — an absolute path, a drive
  letter, or a `..` segment — is refused rather than inventoried, and an
  encrypted member is not read. Both are diagnostics, so their absence never
  reads as "the package does not contain this".
- A reached member allowance is reported as `entry-limit-reached` and marks the
  inventory `partial`; diagnostics are themselves bounded so one hostile
  archive cannot grow the report without limit.
- The report states that package metadata is publisher-provided and does not
  establish that the package is safe, and that signatures are not verified.

## Non-goals

Package restore, feed access, installation, target-framework asset selection and
assembly decompilation. This is a focused artifact inspector, not a package
manager.
