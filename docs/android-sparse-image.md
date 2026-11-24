# Android sparse images (`simg`)

`inspect-artifact` and `extract-artifact` (and their MCP counterparts
`inspect_artifact` and `extract_artifact`) detect Android sparse images by
their 4-byte little-endian magic `0xed26ff3a` (`3a ff 26 ed`) at offset zero and
classify them as format `android-sparse-image`.

Standard AOSP containers built with `img2simg` or `ext2simg` (commonly
`system.img`, `vendor.img`, `vendor_dlkm.img`, or `super.img`) use this framing
to omit large zeroed or repeated regions from the on-disk file.

## Header and chunk decoding

Parsing is strictly static and read-only. REA validates the 28-byte
little-endian `sparse_header_t` and walks each 12-byte `chunk_header_t` using
bounded header read windows without allocating or materializing virtual output
blocks:

- **Header fields** (`format_metadata.kind = "android-sparse-image"`):
  `magic` (`0xed26ff3a`), `major_version` (`1` only), `minor_version`,
  `file_header_size` (`>= 28`), `chunk_header_size` (`>= 12`), `block_size`
  (non-zero multiple of 4), `total_blocks`, `total_chunks`,
  `image_checksum`, plus computed virtual `unsparsed_size`, `file_size`,
  `parsed_bytes`, and `trailing_bytes`.
- **Chunk types**:
  - `RAW` (`0xCAC1`): stored payload bytes directly in the carrier at
    `chunkOffset + chunk_hdr_sz` of length `chunk_sz * blk_sz`. Exposed as
    extractable positional entries `chunks/chunk-<index>-raw.bin`
    (`format_metadata.kind = "android-sparse-chunk"`) with carrier
    `source_location` and virtual output block/byte offsets.
  - `FILL` (`0xCAC2`): stores one 4-byte little-endian `fill_pattern` representing
    `chunk_sz * blk_sz` repeated virtual output bytes; summarized in metadata
    counts and `virtual_fill_bytes` without expanding output blocks.
  - `DONT_CARE` (`0xCAC3`): stores 0 payload bytes representing
    `chunk_sz * blk_sz` omitted output bytes; summarized in metadata counts and
    `virtual_dont_care_bytes` without allocating zeroes.
  - `CRC32` (`0xCAC4`): `chunk_sz === 0` with one 4-byte little-endian checksum
    word; recorded in `crc32_chunk_values` without recomputing over virtual
    output blocks (`crc32_verified: false`).

Integer overflow checks use exact bigint arithmetic across `chunk_sz * blk_sz`,
`total_blks * blk_sz`, cumulative block counts (both 32-bit unsigned wraparound
and `total_blks` equality), `total_sz` framing, and carrier file bounds.

## Bounded metadata, summaries, and limits

Header dimensions stay grounded in the format's intrinsic bounds and actual
carrier size:

- `file_header_size`: at least `28` bytes and within `uint16` and the file size
  (extended bytes between `28` and `file_header_size` are skipped without buffering).
- `chunk_header_size`: at least `12` bytes and within `uint16`, each chunk's
  `total_sz`, and the file size.
- `total_chunks`: carriers whose declared chunks cannot physically fit inside
  the file fail immediately as truncated; otherwise chunk walking defaults to
  `65536` chunks and is adjustable per call via
  `artifact_limits.android_sparse.chunk_count` (`count`, minimum `1`, maximum
  `2147483647`). Exceeding `chunk_count` reports a retryable limit failure
  naming `artifact_limits.android_sparse.chunk_count` so callers can raise it
  on the next operation.
- Inline descriptor bounds: `format_metadata.chunks` retains up to the first
  `256` chunks (`chunks_omitted` counts the rest) and `crc32_chunk_values`
  retains up to the first `64` checksums (`crc32_chunk_values_omitted` counts
  the rest), while all chunk counts and block/byte totals reflect every chunk
  in the file.

Passing `--detail summary --evidence_output <path>` (CLI) or `detail: "summary"`
(MCP) projects `root_format_metadata.kind = "android-sparse-image-summary"`,
keeping header facts, virtual sizing, and chunk/block counts while omitting the
inline `chunks` and `crc32_chunk_values` arrays.

## CLI and MCP examples

```sh
rea inspect-artifact ./vendor.img --json
rea inspect-artifact ./vendor.img --detail summary --evidence_output vendor-sparse.json --json
rea extract-artifact ./vendor.img --output-root ./vendor-raw-chunks --json
```

Only physical `RAW` chunk slices are extracted to disk or hashed during
inspection; unsparsed container reassembly and filesystem mounting are not
performed. Unparsed trailing bytes after `total_chunks`, when present, are
counted in `trailing_bytes` and lower `coverage.status` to `"unknown"`.

## What this verifies

Target header fields and chunk declarations describe what the carrier header
stores. Full-image checksum verification against virtual `FILL` and `DONT_CARE`
blocks is not performed, embedded payloads are never executed, and container
authenticity (such as external AVB signatures) requires separate verification.
