# Android sparse images

`inspect-artifact` and `extract-artifact` recognize an Android sparse image
(`system.img`, `vendor.img`, `super.img` and other partitions from factory
images and fastboot packages) by its little-endian `0xED26FF3A` magic,
independent of the file name. They read the sparse header and chunk table and
expand one raw partition image offline. No host tool such as `simg2img` runs,
nothing is decompressed and nothing is mounted.

The same domain facts and artifact reader serve CLI and MCP. The root is an
archive with unknown executable architecture. Major version 1 is supported; a
readable major version other than 1 is refused.

```sh
rea inspect-artifact ./system.img --json
rea extract-artifact ./system.img --json
```

With MCP, `open_binary` then `inspect_artifact`, and `extract_artifact` to
write the expanded image.

## Header and chunks

Root `format_metadata` (kind `android-sparse-image`) records the header:
`major_version`, `minor_version`, `file_header_size`, `chunk_header_size`,
`block_size`, `total_blocks`, `total_chunks`, the stored `image_checksum` and
`expanded_size` (`total_blocks` times `block_size`).

Every chunk header is walked. `chunk_counts` counts RAW, FILL, DONT_CARE and
CRC32 chunks, and `covered_bytes` gives the expanded bytes RAW, FILL and
DONT_CARE chunks produce. `fill_patterns` lists the first 16 distinct FILL
patterns as hex, and `crc32_chunks` lists the file offset and stored value of
the first 16 CRC32 chunks. A limitation says when a further distinct pattern or
CRC32 chunk was counted but not listed.

A header or chunk header larger than the 28-byte and 12-byte version 1.0
structures keeps the known fields. `undecoded_file_header_bytes`,
`undecoded_file_header_hex` and `undecoded_chunk_header_bytes` record what was
not decoded. Bytes after the declared chunks are counted in `trailing_bytes`.

## Expansion

The image has one child, `image.raw`, written in chunk order:

- RAW chunks copy their stored bytes.
- FILL chunks repeat their 4-byte pattern.
- DONT_CARE chunks produce zeros. The original contents of those blocks are
  unknown, and the child records that limitation.
- CRC32 chunks produce no bytes.

`image_checksum` and the CRC32 chunk values are recorded and not verified, so
`checksums_verified` is always `false`. The expanded child is hashed and
classified like any other member: a boot image becomes `android-boot-image`,
and ext4 or EROFS partitions stay `file`.

## Failures and bounded work

A chunk with an unknown type, a `total_sz` that disagrees with its type and
block count, a zero block size, or a block size that is not a multiple of 4 is
malformed. A chunk table whose output blocks do not equal `total_blks` is
malformed. A chunk header or RAW chunk that ends past the file is truncated,
and so is a `total_chunks` whose chunk headers cannot fit in the file.

The reader reads the 28-byte header, then only the extension `file_hdr_sz`
declares, and admits two per-call limits before any chunk is read:

| `artifact_limits` field            |                                          Default | Unit and admission                                          |
| ---------------------------------- | -----------------------------------------------: | ----------------------------------------------------------- |
| `android_sparse_image.chunk_count` |                                        1,048,576 | Declared `total_chunks`; bounds the walk and expansion plan |
| `expanded_bytes`                   | 500 times the sparse file size, at least 256 MiB | Declared `total_blks` times `blk_sz`                        |

A refusal reports the exceeded field and the required value in
`details.reader_limit`. Select at least that value for the next call; the
fields are independent, so raising `expanded_bytes` does not admit a larger
chunk table:

```sh
rea inspect-artifact ./system.img --json \
  --artifact-limits '{"android_sparse_image":{"chunk_count":2097152},"expanded_bytes":68719476736}'
```

MCP uses the same object as the `artifact_limits` argument of
`inspect_artifact` or `extract_artifact`. Expansion streams from the file and
never holds the whole partition in memory.

## Verification scope

Source and compiled CLI/MCP tests cover synthesized images with all four chunk
types, larger header sizes, listed and counted fill patterns and CRC32 chunks,
chunk sum mismatch, unknown chunk types, zero and unaligned block sizes,
truncated RAW chunks, a chunk table that cannot fit in the file, major
version 2 refusal, the expansion allowance, chunk-count refusal and retry
through the CLI and MCP, a table of 1,048,577 one-block FILL chunks admitted
after raising `chunk_count`, header reads limited to the declared size,
cancellation during expansion, a sparse image nested in a zip, and a
sparse-wrapped boot image whose child classifies as `android-boot-image`. A
public factory image is not required for these fixtures.
