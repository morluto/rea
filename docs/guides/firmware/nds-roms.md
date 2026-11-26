# Nintendo DS ROMs

`inspect-artifact` and `extract-artifact` read a Nintendo DS cartridge ROM
(`.nds`) offline. The ROM is inventoried as a container. Its root
`format_metadata` (`kind: "nds"`) holds the cartridge header facts, and each
CPU binary, overlay file and filesystem file is a member that can be hashed,
classified and extracted. Nothing is decrypted, decompressed or executed.

The format has no magic number. Detection reads the header, so the file name
does not matter: the stored logo CRC at `0x15C` must be `0xCF56`, the unit
code must be 0, 2 or 3, the ARM9 binary must start after the header, and
either the logo area or the header checksum at `0x15E` must agree with its
stored CRC. Both checksums use CRC-16/MODBUS.

## What the root reports

- Identity: title, game code, maker code, unit code (`nds`, `nds-dsi`,
  `dsi`), device capacity and ROM version.
- `arm9` and `arm7`: ROM offset, entry address, RAM load address and size.
- Table locations: FNT, FAT, both overlay tables and the banner offset.
- `total_used_rom_size` and `header_size`.
- `logo_crc` and `header_crc`: the declared and computed values. A mismatch
  is a limitation, never assumed away.
- Counts: FAT entries (`file_count`), directories reached from the root, and
  ARM9 and ARM7 overlay entries.

## Members

| Path                              | Holds                                                   |
| --------------------------------- | ------------------------------------------------------- |
| `arm9.bin`, `arm7.bin`            | The CPU binaries, with RAM and entry addresses          |
| `overlays/<cpu>/overlay_<id>.bin` | The FAT file an overlay entry names, with its table row |
| `data/<path>`                     | Files named by the FNT directory tree                   |
| `fat/<id>.bin`                    | FAT files no name or overlay reached, listed by file ID |

Each member's `format_metadata` (`kind: "nds-entry"`) gives its role, FAT
file ID, and for overlays the overlay ID, RAM address, RAM and BSS sizes,
static initializer range and flags word. An ARM9 binary's trailing
module-parameter footer, if any, is not part of `arm9.bin`.

## Comparison

`compare-artifacts` / `compare_artifacts` reports a metadata change for a
matching member path when a CPU binary's `ram_address` or `entry_address`
changes, even if its stored bytes are identical. For overlays it compares
`overlay.ram_address`, `overlay.ram_size`, `overlay.bss_size`,
`overlay.static_init_start`, `overlay.static_init_end` and `overlay.flags`.
The role repeats the member path, and the FAT file ID and overlay ID are
layout fields excluded from metadata comparison.

## Ranges that disagree with the file

Coverage is `complete` only when both stored checksums agree, every table
was read in full and every range fits in the file. Otherwise coverage is
`unknown` and a limitation names the problem:

- A logo or header CRC mismatch is named. A header CRC mismatch means the
  fields that locate every region may be corrupt.
- A header text field (`title`, `game_code` or `maker_code`) with unprintable
  bytes or non-zero bytes after its first NUL is reported with its raw hex
  bytes; the decoded text replaces unprintable bytes with `?` and drops bytes
  after the first NUL.
- A CPU binary or FAT entry that ends past the file is not listed. A range is
  never clipped.
- A table that starts past the file is not read. A table that runs past the
  file is read up to the file end. An empty table is not read, wherever it is
  declared, and is not a limitation.
- A truncated FNT main table reports the number of missing directory rows
  and leaves coverage unknown. The walk uses only complete rows. A root
  subtable that starts inside the declared main table is also reported.
- An FNT directory reached twice (a loop or shared subdirectory) is walked
  once. If directories share or overlap subtables, so that the walk would read
  more bytes than the FNT holds, the walk stops there.
- A name that is not a portable path segment (`/`, `\`, `..`, non-ASCII
  bytes, or a Windows-reserved character, trailing dot/space or device name),
  or the same name twice in one directory, is reported, and its file is listed
  under `fat/` instead.
- An FNT name for a file ID an overlay or another directory already claimed
  is reported, and the earlier listing is kept.
- An overlay that names a file ID another entry already claimed is reported,
  and the earlier listing is kept.
- An overlay that names a file with no valid FAT entry is not listed.

Repeated limitations of one kind, such as bad FAT entries or unsafe names,
are itemized up to eight times; one more line counts the rest.

The file and directory ID ranges (61,440 files, 4,096 directories) bound the
FAT, FNT and overlay table sizes REA reads. Expanded FNT paths are further
bounded to 64 directory levels and 16 MiB of aggregate member path text
before paths are allocated or retained. Aggregate readable member bytes
(including distinct FAT entries that alias the same ROM range) are admitted
against `artifact_limits.expanded_bytes` before member bytes are hashed or
extracted.

A file shorter than the `0x160`-byte header, or one with an unknown unit
code, is not detected as `nds`, so `inspect-artifact` reports an unsupported
binary format. The reader refuses the same inputs as truncated or malformed
when it is handed one directly.

## CLI

```sh
rea inspect-artifact game.nds --detail summary --json
rea extract-artifact game.nds --json
```

## Verification scope

A synthetic ROM built from the GBATEK header and NitroROM filesystem
descriptions covers header facts, both CRC results, one overlay, a two-level
file tree, an empty overlay table, a FAT entry past the file end, a directory
loop, an unsafe name, a file ID claimed twice, two overlays that share a
file ID, and truncated headers. No commercial ROM was used.
Secure-area encryption, compressed overlays, NitroARC (`NARC`) archives
inside files and the DSi extended header are not decoded.
