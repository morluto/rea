# ELF separate debug-file linkage

## Problem and outcome

A stripped ELF often names a separate debug file through `.gnu_debuglink`,
`.gnu_debugaltlink`, or its GNU build-id. REA reports ELF notes and layout, but
it has no workflow that answers which debug file an image names or whether a
file the caller already has is that debug file. An agent has to guess from
file names.

This feature adds `inspect_elf_debug_link` and `inspect-elf-debug-link`. They
read one selected ELF32 or ELF64 image, report its debug-file linkage, and, when
the caller supplies one candidate file, check whether the candidate matches.

[ELF debug files](../../../elf-debug-link.md) describes the current behavior and
limitations. This directory is the feature specification, implementation plan
and task list. The guide does not replace these files.

## Requirements

1. The image is a local ELF32 or ELF64 file, read through the stable artifact
   read. It is never executed. Nothing is searched for on the filesystem or
   the network.
2. `.gnu_debuglink` reports its NUL-terminated file name and the CRC32 that
   follows the 4-byte padding, in the image endianness.
3. `.gnu_debugaltlink` reports its NUL-terminated file name and the raw
   build-id bytes that follow it.
4. The GNU build-id is read from `PT_NOTE` and `SHT_NOTE` tables through the
   existing ELF note parser. The same build-id from both tables is one
   observation. Distinct build-ids are listed and none is selected.
5. `.gnu_debugdata` reports presence, file offset, stored size, and whether the
   first six bytes are the xz magic. The payload is not decoded.
6. `lookup_paths` lists the conventional GNU/Linux strings derived from the
   build-id, the debuglink name, and the alternate build-id. These strings are
   not opened. A debuglink name that is empty, `.`, `..`, or contains a path
   separator does not produce the directory-derived strings.
7. A missing named section is observed absence only when section names are
   complete. Incomplete names make it `unknown`. A malformed or truncated
   section is `malformed`, not absence.
8. With a candidate, the CRC32 over the whole candidate and the image and
   candidate GNU build-ids are compared. Any mismatch is `does_not_match`. A
   match with no mismatch is `matches`. If neither check can run, the status is
   `cannot_verify`. The candidate's `.debug_info` and `.symtab` presence is
   reported.
9. The candidate is streamed in bounded chunks. Candidates within
   `max_file_bytes` are also decoded for sections and build-id. Larger ones get
   CRC32 and SHA-256 over the whole file and an ELF header decode only. A
   missing, unreadable, changed, or over-limit candidate returns
   `cannot_verify` with `candidate_unreadable`, and the image linkage is still
   reported. A candidate that exceeds the `max_entries` or ELF decoding budget
   keeps the image linkage and the CRC32 check; its build-id check is
   `unavailable` with `candidate_build_id_unknown`, and sections that were not
   decoded are `unknown`.
10. Names, build-ids and note scans are bounded: 4096-byte names, 256-byte
    build-ids, and a `max_entries` note budget. Target-derived names and lookup
    paths are marked untrusted.
11. MCP requires absolute paths through `absoluteLocalPathStringSchema`, and the
    advertised schema carries that constraint. The CLI resolves relative paths
    against the working directory.

## Acceptance

- Unit tests cover each section layout, both endiannesses, malformed and
  truncated sections, conflicting build-ids, and lookup path derivation.
- Service tests cover candidate match, mismatch, unreadable, oversized, and late
  cancellation.
- CLI acceptance, filesystem boundary, and MCP boundary tests exercise the
  public contract, including the absolute-path schema.

## Non-goals

- Searching debug directories or debuginfod for a candidate.
- Decoding the `.gnu_debugdata` xz payload.
- Loading DWARF from the candidate.
