# Windows Prefetch header inventory

## Problem and outcome

Analysts reviewing a Windows host need the execution history a Prefetch file
records, without a live endpoint and without running the referenced program.
REA classifies such a file only through its name today, so the recorded header
stays hidden. Let `inspect-artifact` / `inspect_artifact` report the file as root
format `windows-prefetch` with the fields its header records, and say which
fields this reader does not decode. The
[user guide](../../../windows-prefetch.md) documents the result.

## Requirements

- Recognize the file from its first bytes: a four-byte ASCII version tag (17, 23,
  26, 30 or 31) followed by an uncompressed `S` signature or the `MSCF` marker of
  a MAM-compressed container. Recognition never depends on the file name.
- Report the recorded executable name, the four-byte name-hash as lowercase
  hexadecimal, the declared file size beside the observed size, the declared run
  total and the declared count of last-run timestamp slots.
- Parse the v17 and v23 fixed headers. v17 reports no run total; report `null`
  there rather than zero.
- Refuse v26/30/31 and MAM containers with an explicit unsupported-container
  failure, so a supported generation is never reported as corrupt.
- Do not decode last-run times, volumes or the read-ahead file list. State that in
  one limitation instead of reporting empty arrays or zero counts, and do not
  synthesize inventory entries for them.
- Keep the run total distinct from intent: a recorded run proves the system
  prefetched the program, not that a user chose to run it or that it completed.
- Read the whole file with a fixed 64 MiB ceiling and no runtime override.

## Acceptance

Fixtures cover v17 and v23 headers, a truncated header, a missing signature, a
v26 tag and a MAM container. A named `.pf` file is inventoried end to end through
`inspect_artifact`, and a byte prefix is classified without its name. Boundary
tests cover the metadata schema and the format vocabulary.
