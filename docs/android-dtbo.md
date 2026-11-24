# Android DTBO partition images

`inspect-artifact` and `extract-artifact` recognize Android device tree
table overlay (`DTBO`) partition images starting with the big-endian
`dt_table_header` magic `0xd7b7ab1e` regardless of filename. The reader parses
static container headers and `dt_table_entry` records without decompressing,
overlaying, or executing any binary code.

## Header and entry table layout

The container begins with a big-endian 32-byte `dt_table_header`:

| Header field        | Purpose                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| `magic`             | Must be `0xd7b7ab1e`                                                                    |
| `total_size`        | Declared container byte extent (`>= header_size`, `<= file size`)                       |
| `header_size`       | Must be at least 32 bytes (bounded by `ANDROID_DTBO_MAX_HEADER_SIZE`)                   |
| `dt_entry_size`     | Must be at least 32 bytes when entries exist (bounded by `ANDROID_DTBO_MAX_ENTRY_SIZE`) |
| `dt_entry_count`    | Entry table row count (bounded by `ANDROID_DTBO_MAX_ENTRY_COUNT`)                       |
| `dt_entries_offset` | Table start (`>= header_size`, fits within `total_size`)                                |
| `page_size`         | Flash page alignment declared by the builder                                            |
| `version`           | Table revision (`0` or `1`)                                                             |

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
  verbatim, set `fdt_magic_valid = false`, and record a limitation stating that
  compressed payloads are not decompressed.
- Extra bytes beyond the 32-byte header/entry records and trailing file bytes
  after `total_size` remain undecoded and are reported in limitations.

## Extraction and device tree inspection

```sh
rea inspect-artifact ./dtbo.img --json
rea extract-artifact ./dtbo.img --json
```

When one or more uncompressed entries start with `0xd00dfeed`, inspection probes
propose `extract_artifact` followed by `inspect_devicetree` on the extracted
`.dtbo` files (see [Flattened devicetree inspection](devicetree.md)).

## Bounds, overlap checks, and refusals

- `dt_table_header` version other than `0` or `1` returns an unsupported-input
  refusal (`version`).
- Files shorter than the 32-byte header, declared `header_size`, declared
  `total_size`, or entry table return a truncated refusal before entry
  capacities are applied.
- Declared table dimensions are checked against `total_size` before fixed
  parser ceilings (`64 KiB` `header_size`, `4096` `dt_entry_size`, `4096`
  `dt_entry_count`).
- Every non-empty entry payload is verified not to overlap `dt_table_header`, the
  `dt_table_entry` table, any other non-empty entry payload, or `total_size`.
- Standalone DTBO partition images are distinct from single `0xd00dfeed`
  devicetrees and Android boot/vendor_boot images (see [Android boot and vendor_boot images](android-boot-image.md)).
