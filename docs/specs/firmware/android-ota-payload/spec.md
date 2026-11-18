# Android OTA payload inspection

This specification records an implementation increment and its original
problem statement. For current behavior and limitations, see
[Android OTA update payloads](../../../guides/firmware/android-ota-payload.md).

## Problem and outcome

REA has no reader for Android A/B OTA `payload.bin` files (update_engine,
magic `CrAU`). An analyst holding a payload cannot ask which partitions it
writes, what sizes and hashes the manifest declares, whether the payload is
full or delta, or which operations are present. Add a read-only inspector
that inventories the header and `DeltaArchiveManifest` and, when cheap,
reconstructs REPLACE/ZERO/REPLACE_ZSTD partition images.

## Requirements

- Recognize CrAU v2 from leading bytes under any file name. Report a
  readable major version other than 2 as an unsupported-version refusal.
- Decode the v2 header and the manifest fields listed in the product guide:
  block size, minor version, timestamps, partial update, security patch,
  per-partition identities, operation counts, Virtual A/B groups and
  apex_info.
- Count metadata and payload signature blobs without verifying them.
- Reconstruct a partition only when every operation is REPLACE, ZERO or
  REPLACE_ZSTD, the new size is known and within the extract ceiling, and
  needed blob extents are present. Bound REPLACE_ZSTD decode to destination
  extent bytes, never above the extract ceiling, and refuse a partition
  open when distinct operation blob bytes exceed the operation-data
  budget. Verify the image against the declared hash when present. Other
  operation types stay inventoried and refuse content reads.
- Keep a complete manifest inventory when the blob is truncated. Refuse
  malformed magic, truncated headers or manifests, oversize counts, and
  operation extents that overrun the blob, without inventing zeros.

## Acceptance

Synthesized fixtures cover a full payload with REPLACE and ZERO operations,
dynamic groups and apex_info; a delta payload with SOURCE_COPY and
BROTLI_BSDIFF; an unknown operation type; v1 refusal; truncated blob with
complete manifest; oversize manifest; malformed protobuf; and hash
match/mismatch. Reader, CLI and MCP tests use those fixtures. Nested zip
`payload.bin` members classify by magic.

## Non-goals

Signature verification, applying delta or compressed operations other than
REPLACE_ZSTD, reading `payload_properties.txt` or zip metadata, recursive
zip inventory of partitions, and device-side update_engine execution.
