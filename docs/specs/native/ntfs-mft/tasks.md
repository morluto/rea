# Tasks

- [x] Define the first-step scope, contract and limits.
- [x] Parse FILE record headers and update-sequence fixups with synthesized
      fixtures and explicit limitations.
- [x] Add the reader, format descriptor and byte classification.
- [ ] Decode attribute records, then `$FILE_NAME` attributes with parent
      references, names, hard links and timestamps.
- [ ] Parse `$UsnJrnl:$J` records and correlate them to records by full file
      reference.
- [ ] Verify against real `$MFT` and journal captures from a Windows host.
