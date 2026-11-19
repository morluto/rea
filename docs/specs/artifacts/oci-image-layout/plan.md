# Implementation plan

## Boundary and contract

Add the result and input schemas in `src/domain/oci/imageLayout.ts` and the
tool contract in `src/contracts/oci/ociImageLayoutToolContracts.ts`, registered
with the tool families, effects and capability declarations. The application
port and service live in `src/application/oci/`; the service admits one
absolute directory path and delegates to the provider. The CLI command is
`src/cli/ociImageLayoutCommands.ts`.

`src/oci/OciImageLayoutParser.ts` owns directory enumeration, JSON decoding,
nested index walking, config inventory, streamed blob hashing and limitation
wording. The provider opens a `DirectoryArtifactReader` under
`ArtifactResourceScope` so child symbolic links are not followed.

## Incremental work and validation

1. Define the domain schema, tool contract and capability registration.
2. Implement bounded directory enumeration and JSON decoding for `oci-layout`
   and `index.json`.
3. Walk nested indexes and image manifests; inventory config and layers.
4. Hash present referenced blobs under the blob budget; record findings for
   mismatches and missing or unreferenced blobs.
5. Add the service, composition and CLI wiring.
6. Add parser, domain and service tests with synthetic fixtures in
   `src/oci/OciImageLayout.fixture.ts`.
7. Update the usage guide, CLI guide, README and skill references.

## Effects and compatibility

The tool reads one existing local directory. Nothing is executed, extracted to
the host, or downloaded. The change is additive to the CLI and MCP surfaces.
Directory form only; tar input is not admitted.
