# Offline Cargo manifest inventory

`inspect_cargo_manifest` reads one local `Cargo.toml`. It inventories declared
packages, dependencies, target-specific tables and features; the facts describe
declarations, not resolved, downloaded or compiled dependencies.

This version deliberately stops at a single manifest:

- `Cargo.lock` is not read, so no resolved version, checksum or lockfile source
  identifier appears in the result.
- Workspace member manifests are not opened. `[workspace.dependencies]` entries
  in the supplied manifest are inventoried as declarations, and a member's
  `workspace = true` entry is reported as inherited rather than resolved to the
  workspace requirement.
- Cargo, build scripts, proc macros and dependency code are never executed, and
  no registry or network request is made.
- Target conditions such as `cfg(windows)` are recorded verbatim and are not
  evaluated for the current host.

Anything the manifest does not state is absent rather than inferred: a
dependency with no version, `path`, `git` or `workspace` source is reported as
an `invalid-dependency-declaration` diagnostic instead of a synthesized package.

## Declaration shape

Each dependency keeps the manifest text that produced it:

| fact               | meaning                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `dependency_key`   | identity that survives later edits to the same declaration                                                                    |
| `dependency_id`    | source-scoped identity, including the manifest digest                                                                         |
| `name` / `alias`   | package name and the manifest key when it was renamed                                                                         |
| `source`           | `registry`, `git`, `path`, `workspace` or `unknown`                                                                           |
| `source_detail`    | path, Git URL with `rev`/`tag`/`branch`, or the registry name                                                                 |
| `registry`         | the alternate registry named beside any source, else absent                                                                   |
| `default_features` | `true`/`false` when stated; absent for a `workspace = true` entry whose setting lives in a manifest this reader does not open |
| `declared_by`      | `package` or `workspace`                                                                                                      |
| `target`           | the `cfg(...)` or target triple from the containing table                                                                     |
| `source_pointer`   | JSON Pointer into the parsed manifest                                                                                         |

A `[package]` setting that is present but is neither a string nor a
`workspace = true` inheritance is reported as an `invalid-package-table`
diagnostic and kept as absent, so a malformed `edition` never silently becomes a
pre-2024 default: edition-dependent interpretation such as `default_features`
stays unknown while that diagnostic is present.

`source_coverage` states what was not examined (`lockfile`, `resolution`,
`workspace_member_manifests`) and its `status` is `partial` whenever a
diagnostic was recorded.

## Select a useful answer

```json
{ "path": "/artifacts/Cargo.toml" }
```

`max_file_bytes` defaults to and is capped at 32 MiB. Retained facts are bounded
by a separate 32 MiB allowance, so a manifest large enough to parse can still be
refused for its representation rather than silently truncated.

The manifest must be UTF-8 TOML; duplicate tables and malformed text are typed
`invalid_format` input failures, not partial inventories.
