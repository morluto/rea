# Windows path spelling in Evidence identity

## Status

Proposed; implementation requires maintainer scope approval.

## Context

Windows file paths are case-insensitive, but Evidence records can currently derive different semantic identities when the same file is selected with different letter casing. Separator and dot-segment normalization already collapse equivalent spellings, while case remains in `parameters.path`, `normalized_result`, and artifact locations.

`caller_input_path` is explicitly display metadata and should continue preserving the caller's exact spelling.

## Decision proposal

Canonicalize resolved Windows paths before computing semantic Evidence identity. Apply the canonical form consistently to semantic `parameters`, normalized artifact paths, and artifact-path locations. Preserve the verbatim caller path only in `caller_input_path` and `caller_input_paths`.

The canonicalization must be scoped to Windows path semantics. POSIX paths remain case-sensitive even when processed on Windows, and non-path strings must not be lowercased.

## Consequences

- One Windows file receives one Evidence identity across case-only path spellings.
- Existing Windows Evidence IDs that include path case will change when recreated.
- Display metadata remains caller-faithful.
- Boundary tests must cover drive-letter case, directory/file component case, separators, dot segments, POSIX paths, and non-path parameters.

## Open implementation questions

- Identify the owning boundary that resolves target paths before Evidence construction.
- Define how path-bearing fields in provider normalized results are identified without recursively lowercasing arbitrary strings.
- Add a compatibility note for imported pre-canonicalization records.
