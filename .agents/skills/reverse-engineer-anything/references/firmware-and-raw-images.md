# Firmware and raw images

## Firmware regions and extraction

Use `inspect_firmware_regions` when advertised. Use `extract_firmware` when
extraction is requested, with a caller-selected new absolute output directory.
These tools use caller-supplied Binwalk/Unblob on Linux; see the
[firmware guide](https://github.com/morluto/rea/blob/main/docs/guides/firmware/firmware-analysis.md).

## Headerless raw images and firmware containers

For other headerless images (embedded firmware without ELF/Mach-O/PE/MZ
headers), open with `format: "raw-binary"`, `architecture` (`x86`, `x86_64`,
`arm`, `arm64`, `6502`, or `m68k`), and `entry_point` (`0x` hex). File offset 0 is mapped at
that address. Hopper and IDA refuse this interpretation; Ghidra uses
`BinaryLoader` with a generic language: big-endian for `m68k`, little-endian
otherwise. Big-endian ARM, Thumb-only, and Cortex-M variants are unsupported.
`6502` selects NMOS 6502; the entry and complete file mapping must fit within
`0x0000..0xffff`. 65C02, 65816, cartridge containers, bank switching, and mapper
semantics are unsupported. `m68k` requires an even entry and decodes the 68040
superset of the 68000 family; Amiga/Atari containers and vector-table entry
discovery are unsupported. Windows Ghidra P0 admits raw images only for `6502`. See [raw binary guide](https://github.com/morluto/rea/blob/main/docs/providers/raw-binary.md).

Intel HEX, S-record, UF2 and DfuSe files are containers, not raw images:
`inspect_artifact` lists address regions (UF2 per familyID, DfuSe per element
with its alternate setting), and `extract_artifact` writes each region. Open an
extracted region as `raw-binary` with its start address as `entry_point`. UF2
numbering gaps leave coverage unknown; a DfuSe suffix CRC mismatch follows
`integrity_policy`. See [UF2 and DfuSe](https://github.com/morluto/rea/blob/main/docs/uf2-dfuse.md).

## ESP images

For an ESP32-family app or bootloader image, `open_binary` then
`inspect_artifact` with `detail: "summary"`. `root_format_metadata` holds the
observed `header` and `descriptor` (its `kind` is the app or bootloader role)
and the derived `chip`, `checksum`, `appended_sha256` and
`undescribed_trailing` ranges. Segment rows (`segment-NN.bin`) carry
`load_addr`, `classification` (`mapped`, `loaded`, `not-loaded` or `unknown`,
per ESP-IDF `should_map`/`should_load`; RAM ranges are not checked) and
`source_location`; select them with `inspect_analysis_view` and
`logical_paths`. Signature blocks are `unverified`; `public_key_sha256`
matches eFuse key digests.

Unknown `source_coverage` means truncation or undescribed trailing bytes, such
as the flash segments of a `--ram-only-header` image; do not infer absence
from it. Erased flash is described. Integrity mismatches are facts, not
refusals. ESP8266 images are refused, and flash-encrypted images are not
recognized. Segments are not disassembled, and RISC-V or Xtensa segments
cannot be opened as raw-binary. See
[ESP images](https://github.com/morluto/rea/blob/main/docs/esp-image.md).

## ESP flash images

A whole-flash dump opens as `esp-flash-image`. `root_format_metadata` holds
`partition_table` (its `method`: `default`, `caller` or a derived
`scan`), `bootloader` and `apps` ESP image facts, the `otadata` records,
`partitions_outside_dump` and `boot_selection`. Every table has a
`boot_selection`: its `basis` names the bootloader's branch (`no-otadata`
without otadata, `none` when the bootloader rejects the table, `unknown`
when a record is missing), and it lists its `assumptions`;
`running_partition` is always `unknown`. Each image names its entry
`path`. With `detail: "summary"` the root kind is `esp-flash-image-summary`
and each image is a compact `summary` (chip, entry point, segment count,
classified load ranges, signature block count, descriptor identity,
integrity); complete detail keeps every segment. Partition rows
(`partitions/<label>.bin`) carry the declared `type`, `subtype`, names,
`flash_address`, `size` and flags; `encrypted` is a storage flag, not
proof of ciphertext. `written_offset`/`written_end` bound the bytes that
are not erased: an app slot whose facts say `erased` can still hold an older
image, and a limitation says so. For a dump read from another flash address, call
`open_binary` with `format: "esp-flash-image"` and `flash_offset`; an
`esp-image` whose `flash_dump` is set names that offset in a next probe; a
relocated table can be named with `partition_table_offset`. No table found
means unknown, often flash encryption. Extraction writes `nvs_keys` as
ordinary data. See
[ESP flash images](https://github.com/morluto/rea/blob/main/docs/esp-flash-image.md).
