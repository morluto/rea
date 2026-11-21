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

- Recognize the file from its first bytes: a little-endian generation DWORD (17,
  23 or 26) followed by the four-byte `SCCA` signature, or a MAM container that
  begins at offset 0 with `MAM` (v30/31 are MAM-wrapped; v26 keeps the
  uncompressed layout). Recognition never depends on the file name.
- Report the recorded executable name, the four-byte name-hash as lowercase
  hexadecimal, the declared file size beside the observed size, the recorded run
  count and whether a last-run timestamp is present.
- Parse the v17 and v23 fixed headers. Both keep the run count at the same
  offset in the file-information block; report a value the file does not reach
  as `null` rather than zero.
- Refuse v26 and MAM containers with an explicit unsupported-container failure,
  so a supported generation is never reported as corrupt.
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
