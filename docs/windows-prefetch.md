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

A Prefetch file starts with a four-byte ASCII version tag and a signature byte
`S`. Recognition reads that prefix only, so the file name does not matter. A file
whose tag is followed by the `MSCF` marker is a compressed Prefetch file: it is
recognized as `windows-prefetch` and then refused with an explicit
"does not decode that container" failure rather than being reported as corrupt.

## What the header reports

For the v17 and v23 generations this reader reports:

- the recorded executable name and the four-byte name-hash, as lowercase
  hexadecimal;
- the declared run total (v23 only) and the declared number of last-run
  timestamp slots;
- the declared file size, kept beside the observed size so a truncated or padded
  capture is visible.

## What stays unknown

The last-run times, volumes and the read-ahead file list are not decoded, and the
inventory says so in its limitation instead of reporting empty values. A run total
records how often the system prefetched the program; it does not establish that a
user intended to run it or that the program completed. Windows 8+ generations
(26, 30, 31) are MAM-compressed as a whole and are identified without being
decoded.

## Limits

- The whole file is read into memory; files above 64 MiB are refused. Windows
  caps generated Prefetch files at 1 MiB, so this only rejects implausible input.
- One occurrence is reported: the root. The references this reader does not
  decode are not materialized as inventory entries.
