# Implementation plan

## Boundary and contract

Follow the existing artifact readers. `src/domain/windows/ntfsMft.ts` owns FILE
record bytes and coverage; `src/domain/artifactFormatMetadata.ts` owns the
`ntfs-mft` result schema. `NtfsMftArtifactReader` reads the admitted file
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

The workflow reads one caller-selected local file. It adds no target execution,
injection, mutation, protection recovery, network access, volume mount or live
filesystem access, so no maintainer scope decision is required.
`inspect_artifact` routing for every existing format is unchanged, and the new
format id appears only for bytes whose first record carries the `FILE`
signature.

## References

- https://learn.microsoft.com/en-us/windows/win32/fileio/master-file-table
- https://github.com/libyal/libfsntfs/blob/main/documentation/New%20Technologies%20File%20System%20(NTFS).asciidoc
