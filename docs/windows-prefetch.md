# Windows Prefetch files

REA inventories Windows Prefetch (`.pf`) files through `inspect-artifact` /
`inspect_artifact`. Parsing is static, needs no Windows host, and never touches a
live endpoint.

```sh
rea inspect-artifact ./GOOGLE.EXE-1A2B3C4D.pf --json
```

For MCP, open the file with `open_binary`, then call `inspect_artifact`. The
summary keeps the complete Evidence; use `parent_evidence_id` with
`inspect_analysis_view` to read the recorded header fields.

## Recognition

An uncompressed Prefetch file starts with a little-endian version DWORD and the
four-byte `SCCA` signature. Recognition reads that prefix only, so the file name
does not matter. A compressed container replaces the whole header with `MAM` at
offset 0; it is recognized as `windows-prefetch` and then refused with an
explicit "does not decode that container" failure rather than being reported as
corrupt.

## What the header reports

For the v17 and v23 generations this reader reports:

- the recorded executable name and the four-byte name-hash, as lowercase
  hexadecimal;
- the recorded run count, which both generations keep at the same offset, and
  whether a last-run timestamp is present, which requires the eight FILETIME
  bytes at the generation's own offset (0x78 for v17, 0x80 for v23);
- the declared file size, kept beside the observed size so a truncated or padded
  capture is visible.

## What stays unknown

The last-run timestamp value, the volumes and the read-ahead file list are not
decoded, and the inventory says so in its limitation instead of reporting empty
values. A run count records how often the system prefetched the program; it does
not establish that a user intended to run it or that the program completed.
Windows 8/8.1 v26 files keep the uncompressed generation DWORD plus `SCCA`
layout; MAM wrapping was introduced with v30/31 on Windows 10+, so those
generations arrive as MAM containers rather than as this prefix. Generations the
reader does not parse are identified from the prefix and then refused, without
being decoded.

## Limits

- The whole file is read into memory; files above 64 MiB are refused. Windows
  caps generated Prefetch files at 1 MiB, so this only rejects implausible input.
- One occurrence is reported: the root. The references this reader does not
  decode are not materialized as inventory entries.
