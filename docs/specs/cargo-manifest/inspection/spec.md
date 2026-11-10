# Inventory one Cargo manifest offline

Issue: https://github.com/morluto/rea/issues/9040

## Problem

REA can read a saved `Cargo.toml`, but dependency declarations were only part of
the picture. A manifest's package settings, target-specific tables and features
were not inventoried together, so an analyst could not tell which declarations a
single manifest states without resolving, downloading or compiling anything.

## Desired behavior

`inspect_cargo_manifest` reads one local `Cargo.toml` and returns retained
Evidence of its declared packages, dependencies, target-specific tables and
features. Cargo, build scripts, proc macros and dependency code are never
executed and no registry or network request is made.

## Requirements

- Each dependency keeps the facts the manifest states: its key, package name and
  alias, source kind and detail, the alternate registry beside it, the declared
  requirement, `optional`, `default_features` and `features`, the containing
  target condition, and the JSON Pointer that produced it.
- Anything the manifest does not state is absent rather than inferred. A
  dependency with no version, `path`, `git` or `workspace` source is an
  `invalid-dependency-declaration` diagnostic, not a synthesized package.
- A `[package]` setting that is present but is neither a string nor a
  `workspace = true` inheritance is an `invalid-package-table` diagnostic and
  stays absent. A malformed `edition` therefore does not fall back to the
  pre-2024 default: edition-dependent interpretation such as `default_features`
  stays unknown.
- `[patch]` and `[replace]` override dependency sources without appearing in any
  dependency table, so their presence makes source coverage partial.
- Target conditions such as `cfg(windows)` are recorded verbatim and are not
  evaluated for the current host.
- A `workspace = true` setting records inheritance without reading the parent
  workspace, and the missing parent is stated as a limitation.

## Limits

`max_file_bytes` defaults to and is capped at 32 MiB. Retained facts are bounded
by a separate 32 MiB allowance, so a manifest large enough to parse can still be
refused for its representation rather than silently truncated. The manifest must
be UTF-8 TOML; duplicate tables and malformed text are typed `invalid_format`
input failures, not partial inventories.

## Acceptance

- A single manifest yields every declared dependency with its source and the
  pointer that produced it, and each field the manifest states keeps its value.
- A malformed package setting, a sourceless dependency and an unsupported
  override form each produce their diagnostic, and `source_coverage.status` is
  `partial` whenever one was recorded.
- No dependency is reported as resolved, downloaded or compiled.

## Non-goals

Reading `Cargo.lock`, opening workspace member manifests, resolving versions
against a registry, evaluating target conditions for the current host, and
executing Cargo, build scripts or proc macros.
