# macOS FSEvents store plan

## Step 1 — offline single-file store inventory (this increment)

- `src/domain/apple/macosFsevents.ts`: header sniffing for raw and gzip-wrapped
  DLS headers, bounded decompression (`gunzipSync` with explicit input and output
  ceilings), `BinaryReader`-based block and record decoding (`1SLD`/`2SLD`/`3SLD`),
  disk flag decoding, continuity accounting, and bounded sample/diagnostic windows.
- `src/artifacts/MacosFseventsArtifactReader.ts`: `ArtifactReader` reading the
  admitted file within the fixed compressed-size limit and exposing
  `macos-fsevents` metadata on the root occurrence.
- Format registration: `macos-fsevents` ID, `macosFseventsMetadataSchema`,
  descriptor with explicit limitation, recognizer, and subject/target/snapshot
  vocabularies.
- Tests: unit parser tests, `MacosFseventsArtifactReader` inventory and failure
  tests, recognizer tests, and target vocabulary coverage.

## Step 2 — directory and multi-store correlation

- Enumerate `.fseventsd` store files with `fseventsd-uuid` and `no_log`
  provenance, ordering across store boundaries while reporting missing ID spans
  and rotation boundaries explicitly.

## Step 3 — bounded filtering and paged inspection

- Support caller filters on event ID range, path prefix, decoded flags, and
  node ID without losing filtered-out totals.
