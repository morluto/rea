# Raw raster preview implementation plan

This plan implements only the exploratory boundary in [the specification](spec.md).
It is not a maintainer-approved architecture or a committed public API.

## Ownership and flow

1. Put pure typed layout validation and decoding in `src/domain/rawRaster.ts`.
   Reuse REA's `Result` channel for expected failures. Keep filesystem access,
   hashing, PNG compression and transport concepts out of the domain module.
2. Pass explicit input-byte and output-pixel allowances to the decoder rather
   than introduce unreviewed permanent configuration defaults. Validate selected
   range and consumed span before RGBA allocation. The exporter separately owns
   admission for scanlines, compression and serialized output.
3. Keep a small experimental PNG/demo adapter separate from the core. Feed it
   synthetic bytes, preserve the complete requested range in the manifest, and
   make its non-identity status explicit. Its output must not overwrite source
   files. No production provider or transport calls this experiment.
4. Add focused synthetic tests for R1–R4 and verify that no registration or
   generated catalog changes are introduced (R5).

## Integration decisions left open

The issue must settle the initial format subset, built-in provider versus shared
application ownership, and the mapping to existing artifact/subject identity.
Do not invent parallel identity infrastructure. Future file-backed work should
reuse existing artifact selected-source, bounded range reading and hashing owners,
including their stability and cancellation semantics.

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
From the repository root:

```sh
npm run test:local -- src/domain/rawRaster.test.ts
node --import tsx --test scripts/experiments/raw-raster-preview.test.mjs
node --import tsx scripts/experiments/raw-raster-preview.mjs /tmp/rea-raster-preview-new
```

The destination must not exist. The harness writes `preview.png` and
`manifest.json` from synthetic red/green/blue/white pixels only. It does not read
firmware files. The exported experimental helper accepts an in-memory byte view
and layout; it is not a supported product API. The core receives explicit byte
allowances. The harness chooses 1 MiB input/output allowances, accounting for PNG
filter-row expansion and bounded encoder copies; those are not new REA settings.

## Verification recorded for this branch

- 23 core Vitest tests passed, including five formats, multi-column/top-down and
  bottom-up layouts, subviews, invalid input, and distinct malformed/capacity errors.
- Three experimental PNG/manifest/no-clobber Node tests passed.
- An independent reviewer checked 5 formats × 2 row directions × 20 pixels and
  found no blocking issues; additional permanent fixtures were added on review.
- The generated 2×2 PNG was independently decoded with Pillow, checking integrity,
  RGBA mode and all four pixel values.
- Full TypeScript typecheck, test-discovery and module-boundary checks passed.

Full repository test suite, aggregate PR gate, real firmware, real CLI/MCP and
production file acquisition are not verified. Maintainer approval and human
review are still pending. Passing these focused checks does not establish release
readiness.
