# macOS FSEvents store tasks

## Step 1 — offline single-file store inventory

- [x] Header signature recognizer for raw DLS and gzip-wrapped DLS prefixes.
- [x] Bounded gzip decompression and raw DLS stream validation (`1SLD`, `2SLD`, `3SLD`).
- [x] `BinaryReader`-based block and record decoding with continuity & flag counts.
- [x] UTF-8 validation and raw path hex retention for invalid encodings.
- [x] Bounded inline block, record, and diagnostic windows alongside whole-file totals.
- [x] Reader, format descriptor, recognizer, and domain schema registration.
- [x] Parser, reader, recognition, and target vocabulary tests.

## Step 2 — directory and multi-store correlation

- [ ] Read `.fseventsd` directory metadata (`fseventsd-uuid`, `no_log`) and align
      rotated store files by event ID span.

## Step 3 — bounded filtering and paged inspection

- [ ] Filter retained FSEvents records by event ID, path prefix, flags, and node ID.
