# Tasks

- [x] Define the first-step scope, contract and limits.
- [x] Parse FILE record headers and update-sequence fixups with synthesized
      fixtures and explicit limitations.
- [x] Add the reader, format descriptor and byte classification.
- [x] Decode attribute records, then `$FILE_NAME` attributes with parent
      references, names, hard links and timestamps.
- [x] Parse `$UsnJrnl:$J` V2 records and correlate them by full file reference.
- [x] Return a bounded source-order page through CLI and MCP, preserving both
      input digests and explicit coverage rows.
- [x] Decode V3/V4 layouts, bound extent samples, and report unknown history coverage.
- [x] Page MFT metadata independently of journal events.
- [x] Decode resident standard information, attribute-list references and nonresident mapping metadata.
- [x] Resolve resident attribute-list graphs into acquired extension metadata with full ownership checks, bounded decoding and explicit partial coverage.
- [x] Verify Windows 11 MFT records through the packaged Linux CLI, with pinned provenance and digests.
- [x] Verify paired logical MFT/journal streams from a public NTFS volume fixture on Linux against an independent parser.
- [ ] Verify Windows-host execution.
