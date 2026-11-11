# Implementation plan

## Boundary and contract

Follow the existing artifact readers. `src/domain/windows/registryHive.ts` owns
REGF bytes and coverage; `src/domain/artifactFormatMetadata.ts` owns the
`regf-hive` result schema. `RegistryHiveArtifactReader` reads the admitted file
through `ArtifactFileSource` and exposes its facts through `formatMetadata()`.
A hive is its own content, so the root occurrence carries every fact and no
members are enumerated.

Recognition lives in `hasRegfHiveSignature` and is applied in
`classifyArtifactBytes`, before the plist and executable probes, because the
magic is unambiguous.

## Incremental work and validation

1. Define the contract, limits and observations; add failing parser fixtures.
2. Implement the base-block, hive-bin and cell parse with explicit limitations.
3. Add the reader, format descriptor and byte classification.
4. Decode key nodes, then value records and typed values, with key-path queries.
5. Replay `.LOG1`/`.LOG2` against a derived in-memory view with recovery
   provenance.
6. Document the workflow in a native Windows registry guide.

## Effects and compatibility

The workflow reads one caller-selected local file. It adds no target execution,
injection, mutation, protection recovery, network access or host registry
access, so no maintainer scope decision is required. `inspect_artifact` routing
for every existing format is unchanged.

## References

- https://learn.microsoft.com/en-us/windows/win32/sysinfo/registry-files
- https://github.com/libyal/dtformats/blob/main/documentation/Windows%20NT%20Registry%20File%20(REGF)%20format.asciidoc
