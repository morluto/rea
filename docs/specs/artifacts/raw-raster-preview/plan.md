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
node --import tsx scripts/experiments/raw-raster-file.mjs --help
node --import tsx scripts/experiments/raw-raster-file.mjs --max-memory-mib 128 INPUT_FILE LAYOUT_JSON NEW_OUTPUT_DIRECTORY
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

For `indexed4`, use `format: "indexed4"`, `bitOrder: "msb-first"` or
`"lsb-first"`, and `palette` containing exactly 16 `[R,G,B,A]` integer tuples
(each component 0–255). Stride is still bytes, with at least `ceil(width / 2)`
bytes per row. The unused final nibble in an odd-width row is ignored. Palette
entries are copied during validation and preserved in the manifest, including
straight alpha. Container-specific LUT/CLUT conversion is the caller's job; the
core neither infers a palette nor parses firmware resources.

Supply values matching your file; this is an example, not automatic detection.
The destination must not exist and its parent directory must already exist. The
script writes `preview.png` and `manifest.json`, leaving the source unchanged.
The manifest hashes the complete selected range, records its original file offset
and describes the source metadata check without claiming REA subject identity.
By default the manifest contains no source paths or filenames, including no
relative spelling or basename. `sourceSnapshot` retains only size and the observed
stability-check statement, not device/inode identifiers or timestamps. Hashes,
range, layout and output metadata remain available for comparison. Canonical
resolution and descriptor checks still happen internally; privacy does not weaken
source validation.

Only explicit `--include-source-paths` (API `includeSourcePaths: true`) adds
`sourcePath` with the original spelling and `sourceResolvedPath` with the verified
canonical absolute path. The CLI warns that these values can reveal usernames and
local directory/filename information. Use the option only when needed and inspect
the result before sharing. Previously generated manifests are not rewritten;
remove their path/identity fields before sharing or regenerate without the option.
The tool does not upload results. PNG content and palette may themselves be
sensitive, so absence of paths does not make arbitrary outputs safe to publish.
Leaf symlinks and non-regular source files are rejected. Layout JSON is limited to
64 KiB. `--max-memory-mib N` selects a conservative working-buffer estimate budget
(default 64 MiB, integer 1–512), not a process RSS limit. Admission includes selected
input, RGBA, PNG filter rows, worst-case default-deflate output and encoding copies.
It happens before reading selected pixel bytes. The manifest records the selected
budget and estimate. These are experimental script allowances, not REA settings.

For `R = width × height × 4`, `F = R + height`, the estimate is selected input
length + R + F + 5 × (compressBound(F) + 64) + 512 KiB. The last allowance covers
zlib workspace and small framing buffers. Runtime baseline, allocator retention
and unrelated resident input are not covered. Reduce the selected range/layout
or raise the explicit budget when admission reports capacity exhaustion.

Output serialization happens before claiming the destination. After claiming it,
`.incomplete` is created before PNG/manifest writes and removed only on success.
On an I/O error the script exits unsuccessfully and reports the retained directory;
the marker remains if it could be created. Inspect or remove that directory before
retrying. No automatic recursive cleanup can erase unrelated files.

A synthetic demo and focused test commands are also available:

```sh
npm run test:raw-raster
node --import tsx scripts/experiments/raw-raster-preview.mjs /tmp/rea-raster-preview-new
```

The `Experimental raw raster` workflow runs `npm run test:raw-raster` on Linux
and Windows for relevant pushes and pull requests, and supports manual dispatch.
This explicitly includes the Node `.test.mjs` harness, which is not discovered by
Vitest. It uses synthetic temporary files only; it does not upload outputs. The
Linux descriptor-count check and selected leaf-symlink fixture are platform-scoped
and are skipped on Windows. A green Windows job does not claim those checks ran.

The synthetic demo uses red/green/blue/white pixels only. Neither script is a
registered REA product command or supported public API. File-workflow verification
must be recorded separately from earlier synthetic checks below.

## Verification recorded for this branch

- 41 core Vitest tests passed; 57 tests passed including existing artifact-file,
  artifact-reader and regular-file admission coverage.
- Twenty-one experimental Node tests passed, including a real subprocess CLI invocation,
  a sparse 128 MiB file with a small selected range, source changes/truncation,
  descriptor cleanup on Linux, symlink rejection, no-clobber and source preservation.
  Additional cases cover budget rejection/override, CLI help and errors, and
  ENOSPC partial-output retention.
- The synthetic 2×2 PNG was independently decoded with Pillow, checking integrity,
  RGBA mode and all four pixels. The real-file subprocess test validates the same
  workflow's output and actual selected source range.
- Independent reviews checked decoder and file-workflow boundaries. Suggested
  fixtures, selected-path provenance and misleading documentation were corrected.
- `npm run check:fast` (typecheck and full lint), `npm run docs:check`, focused
  format/lint, test discovery and module-boundary checks passed.

Full repository test suite and aggregate PR gate are not run. Fixtures include
synthetic binary files and the external PPM below, not representative firmware. Official REA
CLI/MCP, cancellation integration and artifact/subject identity remain deferred.
Maintainer approval and human review are pending; these checks do not establish
production or release readiness.

## Indexed4 verification scope

The experimental increment adds only generic packed indices with explicit RGBA
palette, not a provider or firmware-specific parser. Synthetic checks cover all
16 indices and alpha values, both nibble and row orders, odd-width rows, padding,
subviews, truncated input, sparse/invalid palettes and copied metadata. A real
subprocess file test checks PNG pixels and manifest palette/range provenance.
An independent reviewer checked 144 size/order combinations. Private firmware
verification is tracked separately and never requires publishing source bytes or
palettes.

## External fixture verification

A publicly available photographic PPM P6 fixture was checked, not firmware:
[Pillow hopper.ppm at pinned revision](https://raw.githubusercontent.com/python-pillow/Pillow/7533ff222598f4745487b402dfb58f39b438288b/Tests/images/hopper.ppm).
No third-party image is vendored. Image-specific rights were not independently
established; this is a reproducible source pointer rather than a redistribution.
Source SHA-256: `4c5f7cecc9d468eb37c886840d8f7e7824267e7e315d08751318efddb09a5efb`.

```json
{
  "offset": 53,
  "length": 49152,
  "width": 128,
  "height": 128,
  "stride": 384,
  "format": "rgb888",
  "rowOrder": "top-down"
}
```

The file CLI exported the raw body using the explicit layout above. Independent
Pillow 13.0.0 decoded the original PPM and output PNG: all 16,384 pixels (65,536
RGBA bytes) matched; PNG integrity, selected-range hash, output hash and unchanged
source were verified. The selected-range SHA-256 is
`007b25e71a766d530394bec4f86f73442b8a41cfc34f04dd326a47a34c0b9525`.
This validates real external pixel data, not container autodetection or firmware
provider behavior.

## Private indexed4 validation

The actual published decoder and PNG exporter at revision `0a34803b` were run on
an authorized private firmware-derived indexed4 resource. All 88,000 pixels
(352,000 RGBA bytes) matched both the existing decoder reference and an independent
scalar reference; PNG integrity, manifest hashes/palette/order, and unchanged
input were verified. This exercised the exact decoding/export source in a minimal
Node/tsx harness, not the full file-acquisition CLI on that machine. Private raw
bytes, palette, personal paths and reference output are not published. The generic
core has no firmware-specific LUT/CLUT parser.

### Full private file-workflow acceptance

On 2026-11-15 the unregistered file CLI at `da9d35c3` was run on the same
private 440×200 indexed4 resource, using Node 24.22.2 on macOS (one patch above
the repository pin). Independent Pillow decoding matched all 88,000 pixels
(352,000 RGBA bytes) against the retained reference. PNG integrity, selected-range
and output hashes, explicit palette/order, unchanged source/layout, default
manifest privacy and refusal to overwrite an existing output all passed. This
closes the earlier full file-acquisition CLI gap for that sample on macOS, not
production REA CLI/MCP integration or proprietary container parsing. No private
source, palette, paths or images are included in the repository or CI.
