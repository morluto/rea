# Implementation plan

## Boundary and contract

Follow the existing artifact readers. `src/domain/windows/ntfsMft.ts` owns FILE
record bytes and coverage; `src/domain/artifactFormatMetadata.ts` owns the
`ntfs-mft` result schema. `ntfsMftAttributes.ts` owns verified attribute
values and descriptor contracts. Journal joins retain an ordered identity/header
index and its reference lookup per validated acquisition pair. MFT detail pages
select at most 32 records from this index and decode only their retained source
bytes; page selection never triggers a new whole-MFT scan. `NtfsMftArtifactReader` reads the admitted file
through `ArtifactFileSource` and exposes its facts through `formatMetadata()`.
A record stream is its own content, so the root occurrence carries every fact
and no members are enumerated.

Recognition lives in `hasMftFileRecordSignature` and is applied in
`classifyArtifactBytes`, next to the other unambiguous magic probes.

## Incremental work and validation

1. Define the first-step contract, limits and observations; add parser fixtures.
2. Implement the FILE record header and update-sequence fixup parse with
   explicit limitations.
3. Add the reader, format descriptor and byte classification.
4. Decode attribute records, then `$FILE_NAME` attributes so a record's parent
   reference, names and timestamps become explicit; keep hard links separate.
5. Parse `$UsnJrnl:$J` records and correlate them to records by full file
   reference, including sequence numbers, reporting unresolved references.
6. Document the workflow in a native Windows artifact guide.

## Effects and compatibility

The inventory reads one caller-selected MFT file; the journal workflow reads
the explicitly paired MFT and journal files. It adds no target execution,
injection, mutation, protection recovery, network access, volume mount or live
filesystem access, so no maintainer scope decision is required.
`inspect_artifact` routing for every existing format is unchanged, and the new
format id appears only for bytes whose first record carries the `FILE`
signature.

## References

- https://learn.microsoft.com/en-us/windows/win32/fileio/master-file-table
- https://github.com/libyal/libfsntfs/blob/main/documentation/New%20Technologies%20File%20System%20(NTFS).asciidoc

Current analyst behavior and limitations live in the
[NTFS guide](../../../guides/native/ntfs-metadata.md).

## Acquired extension metadata

The MFT owner resolves attribute-list graphs for selected base records, using
its existing verified record decoder and a page-local cache. The scanner's
bounded sample and the journal's independent detail projection share this rule.
The acquisition cache continues retaining only headers and raw validated bytes.
Typed reference outcomes and linked attribute/name schemas belong to
`ntfsMftAttributes.ts` and are consumed by the common metadata contract. Global
physical counts stay independent of bounded reference delivery.

A page decodes at most 32 additional records beyond its selected physical
records. Each base emits at most 32 reference results, retaining source list
entries and explicit discovered omissions. This adds no volume reads, path
reconstruction, nonresident payload recovery or target execution. Real extension
captures and Windows-host execution remain unverified; source-built fixtures
exercise reference ownership, malformed prefixes, cycles and resource bounds.

Journal and extension joins share `hasVerifiedMftRecordIdentity` at the MFT
owner. It consumes parsed sequence, slot verdict, extent and fixup facts; each
consumer keeps its separate base-versus-extension ownership rule.
