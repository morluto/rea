# Sega Mega Drive and Genesis ROMs

`inspect-artifact` and `extract-artifact` read a Sega Mega Drive or Genesis
ROM offline. The ROM is inventoried as a container. Its root
`format_metadata` (`kind: "mega-drive-rom"`) holds the 68000 vector table and
the header at `0x100`. `vectors.bin`, `header.bin` and `program.bin` are
members that can be hashed and extracted. Nothing is executed.

A plain image (`.bin`, `.md`, `.gen`, or any other name) is recognized when
the four bytes at file offset `0x100` are `SEGA`. An interleaved SMD copier
dump is recognized when bytes 8 and 9 are `0xAA 0xBB`, byte 0 equals the
16 KiB block count modulo 256, and every `SEGA` byte the examined prefix
actually holds matches. The odd half of that marker (`E`, `A`) is at file
offsets 640 and 641, so a 4 KiB or 8 KiB prefix is enough to claim the file.
The reader still checks all four bytes after de-interleave. An ELF, Mach-O,
DOS MZ or FAT header is left to that format when it also contains `SEGA` at
`0x100`.

## What the root reports

- `layout`: `plain` or `smd`. `smd_blocks` is the copier block count, or null.
- `system_kind`: `mega-drive`, `genesis`, `32x`, `sega-cd` or `other`, from
  the system string. `32x` and `sega-cd` are the string only. Their extra
  structures are not decoded, and coverage is `unknown`.
- Header strings (`system`, `copyright`, `domestic_title`, `overseas_title`,
  `serial`, `revision`, `device_support`, `region`, `modem`, `memo`).
  Trailing spaces are removed from `text`. `raw_hex` keeps every byte. A byte
  outside printable ASCII is `?` in `text`, and a limitation names the field.
- `serial` is the 12 bytes at `0x180`. `revision` is the 2 bytes at `0x18C`.
- `devices` lists known device letters in header order. Spaces are padding.
  Other characters stay in `unknown_device_characters`. The letters are `J`
  joypad, `6` six-button, `0` Master System joypad, `4` multitap, `K`
  keyboard, `P` printer, `B` control ball, `F` floppy, `L` activator, `M`
  mouse, `C` CD-ROM, `R` RS-232, `T` tablet, `V` paddle, `S` analog.
- `initial_ssp` and `reset_pc`, plus `vectors`: 64 big-endian longwords.
  Unassigned slots are named `reserved`.
- `checksum.declared` and `checksum.computed`. The computed value is the
  16-bit sum of big-endian words from image offset `0x200` through the
  declared ROM end, counting a word only when both bytes are inside that
  window and inside the image. A mismatch is a limitation.
- `rom` and `ram` start and end addresses, as declared, with `bus_start` and
  `bus_end`, the 24-bit addresses the 68000 drives for them. Ends are
  inclusive. `reset_pc_bus` is the same for the reset vector.
  Address checks use the 68000's 24-bit bus, so the top byte is ignored:
  the SGDK form `0xE0FF0000`-`0xE0FFFFFF` is work RAM, and a reset PC of
  `0xFF000200` is inside a ROM range that covers `0x200`. ROM ordering,
  extent, a nonzero start and the checksum window use those bus addresses
  too, so `0xFF000000`-`0xFF0002FF` sums through image offset `0x2FF`. A
  RAM range is work RAM when it covers at most 64 KiB inside the
  `0xE00000`-`0xFFFFFF` mirror.
- `external_ram`. The 12 raw bytes are always kept. Structured access,
  battery and addresses are set when the field starts with `RA` and the type
  byte is one of `0xA0`, `0xB0`, `0xB8`, `0xE0`, `0xF0`, `0xF8`.
- `region_style`: `letters` for `J`, `U`, `E`, `A` and `B`; `hex` for one hex
  digit, with `region_mask` 0 through 15; `ambiguous` for a single `A`, `B`
  or `E`, which is both a letter and a hex digit, with both readings kept in
  `region_characters` and `region_mask` and a limitation; `empty` when the
  field is only spaces; otherwise `other`.

## Members

| Path          | Holds                                                        |
| ------------- | ------------------------------------------------------------ |
| `vectors.bin` | Image bytes `0x000` through `0x0FF`                          |
| `header.bin`  | Image bytes `0x100` through `0x1FF`                          |
| `program.bin` | The whole linear image, including bytes past a short ROM end |

For a plain image, `source_location` is the file range. For an SMD dump the
bytes are not one file range, so `source_location` is null and
`image_offset` in `kind: "mega-drive-rom-entry"` is the offset in the linear
image. `program.bin` overlaps `vectors.bin` and `header.bin` because those
ranges are also part of the image.

## SMD dumps

Each 16 KiB block after the 512-byte copier header stores the odd image bytes
in its first half and the even image bytes in its second half. `program.bin`
is those blocks de-interleaved. Header byte 1 is the copier ID (normally
`0x03`). Header byte 2 is the split flag: `0x40` means more parts follow, and
that flag is a limitation. The file is still read as one image. A file whose
size is not a whole number of blocks is not this format.

## Ranges and checksum

Coverage is `complete` only when the header has no limitations. Otherwise
coverage is `unknown` and a limitation names the problem:

- A declared checksum that differs from the computed word sum.
- A ROM or RAM end before its start. That range is not also described as
  longer than the file.
- A well-formed ROM range longer than the image. The checksum then sums only
  the complete words that are present.
- A ROM end below `0x200`. The checksum window is empty and the computed sum
  is 0.
- An image longer than the declared ROM range. The extra bytes stay in
  `program.bin`.
- A ROM start other than 0. File offset 0 is mapped at that address, and the
  checksum still sums image offset `0x200`.
- An odd `reset_pc`, or a `reset_pc` outside a well-formed declared ROM range.
- An external RAM type byte outside the known set, or an external RAM end
  before its start.
- Unprintable header bytes, unknown device characters, a 32X or Sega CD
  system string, and an SMD split flag (`0x40` in header byte 2).

A header shorter than `0x200` bytes is refused. The refusal says the header
is truncated.

## Hand-off to raw m68k

Extract `program.bin`. Open it with `format: "raw-binary"`,
`architecture: "m68k"` and `entry_point` set to `rom.bus_start`, usually
`0x0`. Raw m68k uses full 32-bit addresses and does not apply the console's
24-bit address aliases, so use the bus value rather than the stored
`rom.start`: a header that stores `0xFF000000` is console address `0x0`.
Raw m68k maps file offset 0 at `entry_point` and does not discover a vector
table, so the image then sits at the ROM start. `reset_pc_bus` is the address
of the first instruction in that load; `reset_pc` keeps the stored vector.
Analysis started at `entry_point` `0x0` begins on the vector table, not at
`reset_pc_bus`. The entry must be even.
Windows Ghidra P0 does not admit `m68k`. See
[raw binary](../../providers/raw-binary.md).

## Limits

The linear image ceiling is 8 MiB (`The Mega Drive ROM byte ceiling`). An SMD
dump is at most 512 blocks of 16 KiB plus the 512-byte copier header (`The
Mega Drive SMD block ceiling`), which is the same image. Both are fixed
format ceilings. This release has no runtime override. A file past either
ceiling is refused before its bytes are buffered.

## Comparison

`compare-artifacts` / `compare_artifacts` does not compare these metadata
facts. They come from the file's own bytes, which content comparison covers.
The entry role repeats the member path, and `image_offset` is layout.
