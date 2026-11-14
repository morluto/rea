# Implementation plan

## Boundary and contract

`src/domain/windows/prefetchFormat.ts` owns recognition and header parsing: the
generation DWORD, the `SCCA`/`MAM` distinction, the field offsets it reads, and a
`Result` failure of kind `format`, `limit` or `unsupported`. It never guesses a
field it cannot read; a missing value stays `null` and adds a limitation.

`prefetchMetadataSchema` in `src/domain/artifactFormatMetadata.ts` is the
persisted contract for the reported facts. Its comparison entry is `notCompared`,
because every fact comes from the header's own bytes, which content comparison
already covers.

## Reader

`WindowsPrefetchArtifactReader` reads the whole admitted file, parses it, and
exposes the facts through `formatMetadata()`. It enumerates no members: the file
is its own content, so the root occurrence carries every fact. `open()` therefore
refuses, and extraction has nothing to materialize.

## Wiring

- `windows-prefetch` joins `ARTIFACT_FORMAT_IDS` and the content-format list, so
  the target, Evidence, snapshot and binary-target vocabularies accept it.
- The format registry entry is a container with `roleContainer`, so the root
  occurrence is reported as a container and `inventoryCoverage` reports
  `container-entries` with the reader's limitation.
- `classifyArtifactBytes` and `BinaryTargetResolver` both match the prefix after
  the FIT probe, so a generation DWORD without the signature stays a plain file
  and a `MAM` container routes to the format's own refusal instead of
  executable parsing.

## Later increments

- MAM decoding needs an LZ77-style decompressor; no dependency provides it
  today and adding one is a separate decision.
- After decompression, the Win10+ filename-string and read-ahead sections become
  decodable, along with volumes and last-run times for all generations.
