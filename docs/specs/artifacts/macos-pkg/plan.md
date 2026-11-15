# Implementation plan

## Boundary and contract

Follow the existing container-reader spine used by uImage, FIT and UnityFS.
`src/domain/macosPkgFormat.ts` owns the XAR header and resource allowances.
`src/artifacts/macosPkg/` owns TOC XML, Distribution/PackageInfo and odc cpio
parsers. `MacosPkgArtifactReader` implements `ArtifactReader` with
`format: "pkg"`. `artifactFormats.ts` constructs the reader, sets
`absentInventory: "unavailable"`, and states the honest `readerLimitation`.

No new CLI command or MCP tool: inventory remains the internal primitive of
`inspect-artifact` / `inspect_artifact`. Extraction uses the existing contained
output tree for stored XAR files and expanded gzip-cpio members. A dedicated
inspect command would duplicate a container that is already classified.

## Incremental work and validation

1. Header parser with Result/`ParseFailureError` and synthetic header tests.
2. TOC, installer XML and gzip-cpio parsers with bounded allowances.
3. Reader, format metadata, `artifactFormats` registration and lifecycle
   cases.
4. CLI acceptance and MCP boundary tests on the product-archive fixture.
5. Guide, CLI page, README rows, VitePress route and authored skill wording.

## Effects and compatibility

The workflow reads one caller-selected local file. It adds no target
execution, injection, mutation, protection recovery or network access, so no
maintainer scope decision is required. Existing tools are unchanged; PKG
inventories gain children and root `format_metadata`.
