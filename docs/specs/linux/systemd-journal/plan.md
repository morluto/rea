# Implementation plan

## Boundary and contract

Follow the existing artifact readers. `src/domain/linux/systemdJournal.ts` owns
header and object-header bytes and coverage; `src/domain/artifactFormatMetadata.ts`
owns the `systemd-journal` result schema.
`src/artifacts/SystemdJournalArtifactReader.ts` reads the admitted file through
`ArtifactFileSource` and exposes its facts through `formatMetadata()`. A journal
file is its own content, so the root occurrence carries every fact and no
members are enumerated.

Recognition lives in `hasSystemdJournalHeader` and is applied in
`classifyArtifactBytes`, next to the other unambiguous magic probes. The
predicate also requires an aligned `header_size` inside the classification
prefix, so a coincidental signature cannot claim a file whose object area has
no trustworthy start.

## Incremental work and validation

1. Define the first-step contract, limits and observations; add parser fixtures.
2. Implement the 272-byte header parse, flag naming and object-chain walk with
   explicit limitations. Done.
3. Add the reader, format descriptor, byte classification and tests. Done.
4. Decode data, field and entry objects, preserving repeated fields and binary
   values, and report entry-level provenance.
5. Resolve entry arrays and both hash tables into per-entry views with paging.
6. Support the format's compressed payloads with strict decompression limits.
7. Add time-range, boot-id, unit, priority, executable and field filters, then
   multi-file timeline assembly that retains file and boot provenance.
8. Document the workflow in a Linux artifact guide.
