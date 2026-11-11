# Tasks

- [x] Define the first-step scope, contract and limits.
- [x] Parse FILE record headers and update-sequence fixups with synthesized
      fixtures and explicit limitations.
- [x] Add the reader, format descriptor and byte classification.
- [ ] Decode attribute records, then `$FILE_NAME` attributes with parent
      references, names, hard links and timestamps.
- [x] Parse `$UsnJrnl:$J` V2 records and correlate them by full file reference.
- [x] Return a bounded source-order page through CLI and MCP, preserving both
      input digests and explicit coverage rows.
- [ ] Decode supported non-V2 journal layouts and surface acquisition gaps.
- [ ] Verify against real `$MFT` and journal captures from a Windows host.
