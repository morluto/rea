# Tasks

- [x] Define the container scope, contract and limits.
- [x] Parse the header, DIFAT/FAT tables and directory entries with synthesized
      fixtures and explicit limitations.
- [x] Add the reader, format descriptor and byte classification.
- [ ] Resolve mini FAT chains so streams below the cutoff get byte ranges.
- [ ] Interpret DestList records for AutomaticDestinations and entry tables for
      CustomDestinations.
- [ ] Decode embedded Shell Link records and associate them with their entries.
- [ ] Verify against real Jump List and Thumbs.db captures from a Windows host.
