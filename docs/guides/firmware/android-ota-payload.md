# Android OTA update payloads

`inspect-artifact` and `extract-artifact` recognize a CrAU v2 `payload.bin`
from Android A/B and virtual A/B OTA packages by the four-byte `CrAU` magic,
independent of the file name. They read the local header and
`DeltaArchiveManifest` protobuf without applying the update, verifying
signatures, or executing postinstall.

The same domain facts and artifact reader serve CLI and MCP. The root is an
archive with unknown executable architecture. Major version 2 is supported;
a readable major version other than 2 is refused. Version 1 Chrome OS-style
headers are that refusal, not a different container.

```sh
rea inspect-artifact ./payload.bin --detail summary \
  --evidence_output payload.evidence.json --json
rea extract-artifact ./payload.bin --json
```

With MCP, `open_binary` then `inspect_artifact` with `detail: "summary"`
retains the complete Evidence. Use `inspect_analysis_view` and its
`parent_evidence_id` for exact logical paths and selected fields.

## Header, manifest and signatures

Root `format_metadata` records the 24-byte v2 header (magic, major version,
manifest size, metadata signature size, manifest and blob offsets) and the
decoded manifest: `block_size`, `minor_version` (`0` is a full payload;
greater than `0` is a delta), `max_timestamp`, `partial_update`,
`security_patch_level` when present, dynamic partition groups, Virtual A/B
flags (`snapshot_enabled`, `vabc_enabled`, `vabc_compression_param`) and
`apex_info` entries.

The summary view keeps those header and manifest scalars under kind
`android-ota-payload-summary` and replaces the partition, dynamic partition
group and `apex_info` arrays with `partition_count`,
`extractable_partition_count`, `dynamic_partition_group_count` and
`apex_info_count`. The complete Evidence and the paged inventory views keep
every array.

Each partition is an occurrence (`boot.img`, `system.img`, …) with its
`new_partition_info` size and SHA-256 hex, optional `old_partition_info` for
deltas, version, postinstall fields, operation counts by type (unknown
enumerators stay `unknown`), total blob data length, merge operation count
and `estimate_cow_size`. Operation types include REPLACE, ZERO,
REPLACE_BZ/XZ/ZSTD, SOURCE_COPY, BSDIFF family, PUFFDIFF, ZUCCHINI and
LZ4DIFF.

Repeated encodings of the singular old/new `PartitionInfo` messages merge
their fields under Protobuf rules. A later size-only or empty message does
not erase an earlier declared hash; a repeated scalar field keeps its last
value. The resulting size and hash feed both inventory and extraction.

Metadata and payload signature blobs are counted from the `Signatures`
protobuf. A payload signature is declared when both `signatures_offset` and
`signatures_size` are present. Inventory preserves a lone field as manifest
metadata and leaves the payload signature blob size and count null.
`signatures_verified` is always `false`: sizes and counts are
facts, not a cryptographic check. `payload_properties.txt` and
`META-INF/com/android/metadata` beside a zip member are out of scope. A zip
that already lists `payload.bin` still classifies that member by `CrAU`
magic; zip inventory does not recurse into its partitions.

## Extraction

A partition is reconstructed only when every install operation is REPLACE,
ZERO or REPLACE_ZSTD (via `node:zlib` zstd), the new size is known and at
most 32 MiB, and every needed blob extent is present. When an operation
declares `data_sha256_hash`, REA checks its stored blob bytes before writing
or decompressing them. A mismatch prevents reconstruction. The reconstructed
image is checked against `new_partition_info.hash` when that hash is
present. Any other operation type leaves the occurrence inventoried with
`hash_status: unavailable` and refuses extraction of that member.
Delta payloads therefore inventory completely and fail a full extract.

A truncated file whose header and manifest still fit keeps the partition
table and records that the blob was truncated. Bytes past end of file are
not invented as zeros.

## Bounded work

The reader admits at most 16 MiB of manifest, 4096 partitions, 65,536
operations per partition, 262,144 operations in total, 1,048,576 source
and destination extents in total, 1 MiB per signature blob, 64
signatures, 256 dynamic groups and 4096 apex entries. Those ceilings are
resource policy. Shared artifact identity hashing has separate
cost. Partition reconstruction is bounded at 32 MiB per image and runs when
a member is opened, not during inventory of the manifest. REPLACE_ZSTD
decode is bounded to destination extent bytes, never above that 32 MiB
extract ceiling. Opening a partition refuses when distinct operation blob
bytes exceed the 32 MiB operation-data budget.

## Verification scope

Source and compiled CLI/MCP tests cover synthesized CrAU v2 full and delta
payloads, Virtual A/B and apex fields, unknown operation types, v1
refusal, truncated blobs with a complete manifest, oversize counts,
malformed protobuf, hash match and mismatch, nested zip member
classification, REPLACE_ZSTD output past destination extents, and
distinct operation blob data past the read budget. Signatures are not
verified against device keys. Delta and compressed operations other than
REPLACE_ZSTD are not applied. A public factory OTA image is not required
for these fixtures.
