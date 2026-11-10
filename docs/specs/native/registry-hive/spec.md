# Windows Registry hive inspection

This specification records an implementation increment and its original problem
statement. It covers the first step of #9424 only: recognition plus the base
block, hive-bin and cell inventory. Key nodes, values, security descriptors and
transaction logs are deliberately not decoded here.

## Problem and outcome

An analyst who receives a `SYSTEM`, `SOFTWARE`, `SAM`, `SECURITY` or
`NTUSER.DAT` file outside a running Windows host can only ask whether its
header is well formed by hand. Add offline recognition and a structural
inventory that reports what the base block and its hive bins declare, so later
steps have an owned, validated parse to build value decoding on.

## Requirements

- Recognise a REGF hive from the `regf` magic at offset 0, independent of the
  file's name or extension, and report root format `regf-hive` from
  `inspect_artifact`.
- Validate the 4 KiB base block: magic, major and minor version, the primary and
  secondary sequence numbers, the root cell offset, the declared hive-bin span
  and the base-block checksum (the XOR of its first 127 dwords).
- Report a sequence mismatch as dirty and a checksum mismatch as a limitation.
  Neither is a refusal: a dirty hive is exactly the case an analyst receives.
- Walk hive bins from the end of the base block, requiring the `hbin` signature,
  a declared span that is a positive multiple of 4096 and that fits the file.
- Walk each bin's cells at 8-byte granularity, where a negative stored size
  marks an allocated cell. A cell whose size is not a positive multiple of eight,
  or whose span crosses its bin, ends the examined run with a limitation.
- Stop and report a limitation rather than infer facts for bytes not examined:
  an unexpected signature, a bin or cell that overruns, or a declared bin span
  longer than the file each produce an explicit diagnostic naming the offset.
- Bound the whole file at a fixed 512 MiB ceiling. Read nothing outside the
  admitted extent and never write to the supplied file.

## Acceptance

Synthesized fixtures cover a clean hive, a mismatched sequence pair, a wrong
checksum, a cell crossing its bin, a cell size that is not a multiple of eight,
a declared bin span longer than the file, a file without the `regf` signature and
a file shorter than the base block. A hive fed to the streaming decoder in
uneven chunks yields the same cells as a whole-buffer parse. Classification
covers the same hive under `SYSTEM`, `NTUSER.DAT` and a neutral name.

## Out of scope

Key nodes, value records and typed value decoding, subkey and value indexes,
class data, security descriptors, `.LOG1`/`.LOG2` transaction-log replay,
deleted-cell carving, cross-hive comparison, and any key-path query. No Windows
API, registry mount, privilege or execution is involved; nothing recovered is
treated as complete or authoritative.
