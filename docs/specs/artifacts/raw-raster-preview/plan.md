# Raw raster preview implementation plan

This plan implements only the exploratory boundary in [the specification](spec.md).
It is not a maintainer-approved architecture or a committed public API.

## Ownership and flow

1. Put pure typed layout validation and decoding in `src/domain/rawRaster.ts`.
   Reuse REA's `Result` channel for expected failures. Keep filesystem access,
   hashing, PNG compression and transport concepts out of the domain module.
2. Pass explicit input-byte and RGBA-output-byte allowances to the decoder rather
   than introduce unreviewed permanent configuration defaults. Validate selected
   range and consumed span before RGBA allocation. The exporter separately owns
   admission for scanlines, compression and serialized output.
3. Keep a small experimental PNG/demo adapter separate from the core. Preserve
   the complete requested range in the manifest and make its non-identity status
   explicit. Its output must not overwrite source files. No production provider
   or transport calls this experiment.
4. Add an unregistered file script using `ArtifactFileSource` and
   `readArtifactRange`. Reuse core layout admission against the opened file size
   before reading only the requested range. Recheck the descriptor and
   caller-selected path after reading, close the source on success and failure,
   and restore the original file-relative offset in the preview manifest.
   Descriptor metadata is evidence of an observed check, not a snapshot guarantee.
5. Add focused synthetic and file-boundary tests for R1–R4 and R6; verify that no
   registration or generated catalog changes are introduced (R5).

## Integration decisions left open

The issue must settle the initial format subset, built-in provider versus shared
application ownership, and the mapping to existing artifact/subject identity.
Do not invent parallel identity infrastructure. The experimental file script
reuses existing selected-source and bounded range reading owners, while hashing
the exact bytes decoded. Production integration still needs a decision about
whole-artifact identity, Evidence, cancellation and snapshot semantics.

Before any public tool is enabled, use the canonical contracts and shared
application workflow for both CLI and MCP; account for full representation
expansion under the existing [limits model](../../../design/limits-and-recovery.md).
This branch does not claim that those integration requirements are complete.

## Verification

Run focused source tests, test discovery, applicable type/lint checks and an
independent PNG decoder check against the final implementation. Run documentation
checks when dependencies are available. Record actual results and unavailable
coverage separately; synthetic success is not real-provider verification or
maintainer approval. The human owner retains PR readiness declarations.

## Running this branch's experiment

Use the pinned Node version and install the locked dependencies with `npm ci`.
From the repository root, the file workflow is:

```sh
node --import tsx scripts/experiments/raw-raster-file.mjs INPUT_FILE LAYOUT_JSON NEW_OUTPUT_DIRECTORY
```

For example, a JSON layout for two RGB888 rows with a one-byte prefix and one
inter-row padding byte is:

```json
{
  "offset": 1,
  "length": 13,
  "width": 2,
  "height": 2,
  "format": "rgb888",
  "stride": 7,
  "rowOrder": "top-down"
}
```

Supply values matching your file; this is an example, not automatic detection.
The destination must not exist and its parent directory must already exist. The
script writes `preview.png` and `manifest.json`, leaving the source unchanged.
The manifest hashes the complete selected range, records its original file offset
and describes the source metadata check without claiming REA subject identity.
Leaf symlinks and non-regular source files are rejected. Layout JSON is limited to
64 KiB. The harness chooses 1 MiB selected-source and RGBA-output allowances;
PNG filter rows and encoder copies use additional bounded memory. These are
experimental script allowances, not new REA runtime settings.

A synthetic demo and focused test commands are also available:

```sh
npm run test:local -- src/domain/rawRaster.test.ts
node --import tsx --test scripts/experiments/raw-raster-preview.test.mjs scripts/experiments/raw-raster-file.test.mjs
node --import tsx scripts/experiments/raw-raster-preview.mjs /tmp/rea-raster-preview-new
```

The synthetic demo uses red/green/blue/white pixels only. Neither script is a
registered REA product command or supported public API. File-workflow verification
must be recorded separately from earlier synthetic checks below.

## Verification recorded for this branch

- 24 core Vitest tests passed; 40 tests passed including existing artifact-file,
  artifact-reader and regular-file admission coverage.
- Ten experimental Node tests passed, including a real subprocess CLI invocation,
  a sparse 128 MiB file with a small selected range, source changes/truncation,
  descriptor cleanup on Linux, symlink rejection, no-clobber and source preservation.
- The synthetic 2×2 PNG was independently decoded with Pillow, checking integrity,
  RGBA mode and all four pixels. The real-file subprocess test validates the same
  workflow's output and actual selected source range.
- Independent reviews checked decoder and file-workflow boundaries. Suggested
  fixtures, selected-path provenance and misleading documentation were corrected.
- `npm run check:fast` (typecheck and full lint), `npm run docs:check`, focused
  format/lint, test discovery and module-boundary checks passed.

Full repository test suite and aggregate PR gate are not run. Fixtures are
synthetic binary files, not representative real-world firmware. Official REA
CLI/MCP, cancellation integration and artifact/subject identity remain deferred.
Maintainer approval and human review are pending; these checks do not establish
production or release readiness.
