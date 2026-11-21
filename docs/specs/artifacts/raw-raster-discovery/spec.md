# Raw raster candidate discovery

Status: draft scope expansion of the raw-raster preview proposal. The original
[#8162](https://github.com/morluto/rea/issues/8162) excluded autodetection. This
proposal changes that scope explicitly; it is not a claim of maintainer approval.

## Analyst question

Which selected bytes might be tightly packed raw pixels, when no signature or
known firmware profile identifies them? Return ranked, reproducible hypotheses
that the existing explicit-layout decoder can preview. Do not label them images.

## Requirements

- D1: Test a bounded caller-configurable grid of offsets, widths, heights and
  gray8/RGB888/RGBA8888 layouts, without firmware names, hashes, addresses or tables.
- D2: Compare horizontal and vertical sample differences with distant samples;
  require variation and spatial continuity. Return the component measurements,
  score and layout. Expose `min_score` (default 0.5, range 0..1). A score is not a calibrated probability.
- D3: Bound selected bytes (16 MiB), hypotheses (100,000), retained candidates
  (100), dimensions (32 choices per axis, 8..4096) and samples (256 pixel positions
  per hypothesis). Report grid completeness separately from output truncation.
- D4: Preserve overlapping geometries. Width/height describe a tested window,
  not discovered object boundaries. Channel order and row orientation are unknown;
  defaults are only a preview convention. Alpha bytes are not classified.
- D5: Reuse existing artifact ownership and Evidence contracts for local file
  acquisition, stability, cancellation, identity and CLI/MCP. Never execute a
  target or modify source bytes. Treat the classification as inferred evidence.
- D6: The operation does not repeat signature search. Analysts may select ranges
  informed by `inspect_firmware_regions`, `extract_firmware` uncovered regions,
  or `inspect_byte_entropy`. Those observations remain owned by their producer.
  A decompressed child range is not an offset in the original compressed file.

## Limits and acceptance

This is a useful but narrow raw-candidate search, not universal autodetection.
Compression, palettes, sub-byte formats, RGB565, row padding, tiled layouts,
exact image boundaries and semantic image recognition are not solved. Smooth
numeric tables can pass. Text/icons/high-detail images may fail. A budget may
leave the tail of the selected range untested; empty output never proves absence.

Tests must include planted unheadered grayscale/RGB/RGBA, no profile dependence,
zero/random controls, structured non-image false positives, off-grid misses,
cancellation, deterministic ranking, retained-output bounds and decoder admission.
File/service and transport tests must separately exercise Evidence and actual
CLI/MCP registration. Synthetic results do not establish real-firmware recall.
