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
the exact bytes decoded. The separate discovery workflows reuse production identity, Evidence,
cancellation and acquisition owners. This experiment remains a separate caller,
not an alternative public transport.

Before any public tool is enabled, use the canonical contracts and shared
application workflow for both CLI and MCP; account for full representation
expansion under the existing [limits model](../../../design/limits-and-recovery.md).
The separate discovery specifications describe the registered workflows; their
implementation does not establish maintainer acceptance of the expanded scope.

## Verification

Run focused source tests, test discovery, applicable type/lint checks and an
independent PNG decoder check against the final implementation. Run documentation
checks when dependencies are available. Record actual results and unavailable
coverage separately; synthetic success is not real-provider verification or
maintainer approval. The human owner retains PR readiness declarations.

## Running the experiment

See the [experimental raw raster guide](../../../guides/firmware/raw-raster-preview.md)
for the file CLI, explicit layouts, memory budget, output privacy and recovery.
The registered workflows are described in the
[structured raster guide](../../../guides/firmware/structured-raster-discovery.md).

## Verification scope

Committed core and experimental file tests cover exact pixels, explicit palettes,
row/nibble order, padding, bounds, source stability, no-clobber publication,
working-buffer admission and partial-output retention. The file CLI is tested in
real subprocesses. Linux-only descriptor and symlink checks are not a Windows
verification claim. Run `npm run test:raw-raster` for the current result.

An external photographic PPM fixture is available from
[Pillow at a pinned revision](https://raw.githubusercontent.com/python-pillow/Pillow/7533ff222598f4745487b402dfb58f39b438288b/Tests/images/hopper.ppm).
It is not vendored; image-specific redistribution rights were not established.
The RGB888 body begins at offset 53, has length 49152, dimensions 128×128 and
stride 384 with top-down rows. Independent decoding previously matched every
pixel and verified unchanged source and output hashes. This is an explicit-layout
control, not container autodetection or firmware-provider verification.

A private indexed4 resource also matched an independent decoder through both the
pure core and the experimental file CLI. Private bytes, palette, paths and output
are not distributed, so that observation is not a public CI fixture or evidence
of unseen-format coverage. Current verification belongs in the PR and CI results,
not a running history in this implementation plan.

The separate raw and structured discovery workflows provide registered CLI/MCP
operations; this experimental script remains unregistered. Human readiness and
maintainer acceptance are separate from all automated checks.
