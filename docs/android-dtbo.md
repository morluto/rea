# Android DTBO partition images

`inspect-artifact` and `extract-artifact` recognize Android device tree
table overlay (`DTBO`) partition images starting with the big-endian
`dt_table_header` magic `0xd7b7ab1e` regardless of filename. The reader parses
static container headers and `dt_table_entry` records without decompressing,
overlaying, or executing any binary code.

## Header and entry table layout

The container begins with a big-endian 32-byte `dt_table_header`:

| Header field        | Purpose                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `magic`             | Must be `0xd7b7ab1e`                                                                                       |
| `total_size`        | Declared container byte extent (`>= header_size`, `<= file size`)                                          |
| `header_size`       | Must be at least 32 bytes (bounded by `total_size` and `dt_entries_offset`; only 32 header bytes are read) |
| `dt_entry_size`     | Must be at least 32 bytes when entries exist                                                               |
| `dt_entry_count`    | Entry table row count                                                                                      |
| `dt_entries_offset` | Table start (`>= header_size`, fits within `total_size`)                                                   |
| `page_size`         | Flash page alignment declared by the builder                                                               |
| `version`           | Table revision (`0` or `1`)                                                                                |

Each `dt_table_entry` row yields an entry named `dtbo-<index>.dtbo` unless
`dt_size` is `0` (empty rows are omitted and noted in limitations):

- **Common entry fields**: `dt_size`, `dt_offset` (relative to header start),
  `id`, `rev`.
- **Version 0 (`version = 0`)**: `flags` and `compression` are `null`; `custom`
  records the four trailing 32-bit words (`custom[4]`).
- **Version 1 (`version = 1`)**: `flags` records the raw 32-bit word,
  `compression` decodes `flags & 0x0f` (`0` = `none`, `1` = `zlib`, `2` =
  `gzip`, `3..15` = `unknown`), and `custom` records the three trailing 32-bit
  words (`custom[3]`).

## Child magic verification and limitations

For every non-empty entry, the reader probes the first 4 bytes at `dt_offset`:

- Uncompressed entries (`version = 0` or `compression = "none"`) set
  `fdt_magic_valid = true` when the payload begins with `0xd00dfeed`, and record
  an explicit limitation when the bytes are shorter than 4 bytes or start with a
  different magic.
- Compressed v1 entries (`zlib`, `gzip`, or `unknown`) keep their stored bytes
  verbatim, set `fdt_magic_valid = null` (the inner magic is unknown, not
  absent), and record a limitation stating that compressed payloads are not
  decompressed.
- Extra bytes beyond the 32-byte header/entry records and trailing file bytes
  after `total_size` remain undecoded and are reported in limitations.
- Entries that point at exactly the same payload range are valid: `mkdtimg`
  writes a repeated input file once and points every entry for it at that
  payload. Each entry is listed, and a limitation names the shared range.
  Every row is hashed and can be extracted separately, so the declared bytes of
  all rows, shared or not, are admitted against `artifact_limits.expanded_bytes`
  before any payload is read.
- Bytes inside `total_size` that the header, entry table and payloads do not
  claim are reported with their range, and coverage becomes `unknown` because
  they may hold data no entry lists.

## Extraction and device tree inspection

```sh
rea inspect-artifact ./dtbo.img --json
rea extract-artifact ./dtbo.img --json
```

When one or more uncompressed entries start with `0xd00dfeed`, inspection probes
propose `extract_artifact` followed by `inspect_devicetree` on the extracted
`.dtbo` files (see [Flattened devicetree inspection](devicetree.md)).

## Bounds, overlap checks, and admission limits

- `dt_table_header` version other than `0` or `1` returns an unsupported-input
  refusal (`version`).
- Files shorter than the 32-byte header, declared `header_size`, declared
  `total_size`, or entry table return a truncated refusal before entry
  admission limits are applied.
- `header_size` and `dt_entry_size` are bounded by intrinsic format invariants
  and declared `total_size` / file size; the reader reads only 32 bytes from
  `dt_table_header` and 32 decoded bytes per row.
- Every non-empty entry payload is verified not to overlap `dt_table_header`, the
  `dt_table_entry` table, or `total_size`, and not to partially overlap another
  non-empty payload (an exactly shared payload is allowed, as above).
- Table size and row count are bounded by caller-adjustable per-call controls in
  `artifact_limits.android_dtbo` (defaults: `entry_table_bytes = 16777216`,
  `entry_count = 4096`):
  - `artifact_limits.android_dtbo.entry_table_bytes` bounds the buffered
    `dt_entry_count * dt_entry_size` read (`bytes`, up to Node string/buffer
    representation capacity).
  - `artifact_limits.android_dtbo.entry_count` bounds `dt_entry_count`
    (`count`).
  - Refusals carry `details.reader_limit` naming the exact parameter and allowed
    range so callers can raise it on the next call (for example,
    `--artifact-limits '{"android_dtbo":{"entry_count":8192}}'`).
- Standalone DTBO partition images are distinct from single `0xd00dfeed`
  devicetrees and Android boot/vendor_boot images (see [Android boot and vendor_boot images](android-boot-image.md)).
