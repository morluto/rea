# Implementation plan

## Boundary and contract

Follow the existing artifact readers. `src/domain/windows/compoundFile.ts` owns
container bytes and coverage; `src/domain/artifactFormatMetadata.ts` owns the
`compound-file` result schema. `CompoundFileArtifactReader` reads the admitted
file through `ArtifactFileSource` and lists each directory entry as one
inventory occurrence, with the container facts on `formatMetadata()`.

Recognition lives in `hasCompoundFileSignature` and is applied in
`classifyArtifactBytes`, next to the other unambiguous magic probes.

## Incremental work and validation

1. Define the container contract, limits and observations; add parser fixtures.
2. Implement the header, DIFAT/FAT tables and directory entry parse with
   explicit limitations.
3. Add the reader, format descriptor and byte classification.
4. Resolve mini FAT chains so streams below the cutoff get real byte ranges.
5. Interpret DestList records for AutomaticDestinations and entry tables for
   CustomDestinations, exposing identifiers, counters and timestamps.
6. Decode embedded Shell Link records through the existing shortcut parser and
   associate them with their containing entry.
7. Document the workflow in a native Windows artifact guide.

## Effects and compatibility

The workflow reads one caller-selected local file. It adds no target execution,
injection, mutation, protection recovery, network access, volume mount or live
filesystem access, so no maintainer scope decision is required.
`inspect_artifact` routing for every existing format is unchanged, and the new
format id appears only for bytes whose first eight bytes are the compound file
signature.

## References

- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-cfb/
- https://github.com/libyal/libolecf/blob/main/documentation/OLE%20Compound%20File%20format.asciidoc
- https://github.com/EricZimmerman/JumpList
