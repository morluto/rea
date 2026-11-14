# Tasks

- [x] Define the first-step scope, contract and limits.
- [x] Parse the fixed 272-byte header, name flag bits, and walk the object
      chain with synthesized fixtures and explicit limitations.
- [x] Add the reader, format descriptor and byte classification.
- [ ] Decode data, field and entry objects with repeated fields and binary values.
- [ ] Resolve entry arrays and both hash tables into paged per-entry views.
- [ ] Support XZ, LZ4 and ZSTD payloads with strict decompression limits.
- [ ] Add time, boot-id, unit, priority, executable and field filters.
- [ ] Assemble a multi-file timeline that retains file and boot provenance.
- [ ] Verify fixtures from real journal files written by supported systemd versions.
- [ ] Document the workflow in a Linux artifact guide.
