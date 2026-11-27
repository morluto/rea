# Nintendo 64 ROMs

`inspect-artifact` and `extract-artifact` read a Nintendo 64 cartridge ROM
offline. Dumps circulate in three byte orders. Big-endian `.z64` starts with
`80 37 12 40`. 16-bit byte-swapped `.v64` starts with `37 80 40 12`. 32-bit
little-endian `.n64` starts with `40 12 37 80`. The file name does not matter.
Recognition reads that first word and a plausible header: the image length is
a whole number of the order's swap unit (any length for `.z64`, even for
`.v64`, a multiple of 4 for `.n64`, as in mupen64plus-core), and the boot
address is 4-byte aligned and lies in KSEG0 or KSEG1 (`0x80000000` through
`0xBFFFFFFF`).

The reader normalizes header facts and every extracted member to big-endian
order. Nothing is executed or patched. A CRC mismatch is reported and left
unchanged.

## What the root reports

Root `format_metadata` (`kind: "n64-rom"`) holds the cartridge header after
that normalization:

- `source_order`: `z64`, `v64` or `n64`, the order of the file that was read.
- `rom_bytes`, `pi_dom1_config` (normalized `0x80371240`), `clock_rate` and
  `boot_address`.
- `libultra_release`: the raw word at `0x0C`. REA does not map it to a
  libultra version name.
- `crc`: `match`, `mismatch` or `not-checked`, with the declared pair and the
  computed pair when one was produced.
- `ipl3_crc32`: the IEEE CRC32 of bytes `0x40..0x1000`, or null when the file
  does not contain that range.
- `cic`: `6101`, `6102/7101`, `6103/7103`, `6105/7105`, `6106/7106`, or
  `unknown`. NTSC and PAL partners that share one boot image share one name.
- `title_raw_hex` and `title_ascii`. The 20 title bytes are JIS X 0201.
  `title_ascii` keeps printable ASCII and replaces every other byte with `.`.
- `media_byte` and `media_name` (`cartridge`, `64dd`,
  `expandable-cartridge`, `expandable-64dd`, `aleck64`, or null).
- `cartridge_id`, `cartridge_id_hex`, `destination_byte`,
  `destination_code`, `destination_name` and `version`. Non-printable
  destination bytes render as `?`. Codes outside the known table have a
  null `destination_name`; `destination_byte` keeps the source byte.

## Members

| Path          | Holds                                                            |
| ------------- | ---------------------------------------------------------------- |
| `header.bin`  | The 64-byte header in big-endian order                           |
| `ipl3.bin`    | Boot code at `0x40..0x1000` (4032 bytes). Omitted below `0x1000` |
| `program.z64` | The whole ROM in big-endian order                                |

Each member's `format_metadata` (`kind: "n64-rom-entry"`) records `role`
(`header`, `ipl3` or `program`), `source_order` and `decoded`. `decoded` is
true when the dump was v64 or n64, so the served bytes were swapped out of
the file. A z64 dump serves stored ranges, and `program.z64` is the file
itself. A v64 or n64 dump swaps `header.bin`, `ipl3.bin` and `program.z64`
with the same byte-order swap. The source order stays on the entry.

## CIC and the cartridge CRC

IPL3 is named by the IEEE CRC32 of bytes `0x40..0x1000`. A hash in the known
table selects that variant's checksum routine. 6101 has its own boot image
and the same checksum seed as 6102/7101. For a known variant the reader
recomputes the CRC pair over the 1 MiB window at `0x1000..0x101000`. Bytes
past the end of a shorter file are read as zero, and a limitation says how
many. A file that ends inside a word keeps that word's present bytes. The
reference implementations define no value for bytes a cartridge does not hold,
so zero is an assumption: libdragon's `n64tool` zero-pads the images it writes.
A mismatch names both pairs and the CIC. The file is not corrected.

An IPL3 hash outside the table, or a file that ends before `0x1000`, leaves
the pair `not-checked`.

CIC 6105/7105 XORs each window word with the boot-code word at file offset
`0x750 + (window offset & 0xFF)` before the same accumulation.

## Comparison

`compare-artifacts` / `compare_artifacts` does not treat `n64-rom` or
`n64-rom-entry` metadata as a metadata change. `role` repeats the member
path. Header and CRC facts are in the served bytes. `source_order` and
`decoded` differ between a z64 dump and a swapped dump of the same program,
while the served `program.z64` bytes match, so content comparison reports
those members as unchanged. The root file digest still differs, because the
dump bytes differ.

## Limitations and ceilings

Coverage is `complete` only when the image has no limitations. Otherwise
coverage is `unknown` and a limitation names the cause:

- The checksum window is shorter than 1 MiB, so bytes past the file were
  taken as zero.
- IPL3 matches none of the known CIC variants, so the CRC pair stays
  unchecked.
- The file is shorter than `0x1000`, so the boot code is incomplete, the CIC
  stays unknown and the CRC pair stays unchecked.
- Reserved header bytes at `0x18..0x1F` or `0x34..0x3A` are not zero.
- The declared CRC pair differs from the computed pair for the named CIC.

A file shorter than the 64-byte header is truncated. An odd `.v64` length or an
`.n64` length that is not a multiple of 4 is malformed, because its byte order
cannot be normalized; a `.z64` image of any length needs no swap. A boot
address outside KSEG0/KSEG1, or one that is not 4-byte aligned, is malformed.
A prefix shorter than the header does not claim the format.

Retail cartridge masks stop at 64 MiB (512 Mbit, 67,108,864 bytes). A larger
file is refused before its bytes are swapped. The refusal is the fixed
allowance "The Nintendo 64 ROM size allowance" (`n64.rom_bytes`). This
release has no runtime override. `artifact_limits.expanded_bytes` does not
raise it. A header that is otherwise plausible on a file above 64 MiB is
still recognized, so the reader can report that ceiling.

`header.bin`, `ipl3.bin` and `program.z64` are counted separately toward
`artifact_limits.expanded_bytes` before they are hashed, including the
overlap of the program range with the header and IPL3. A v64 or n64 dump
also counts a decoded copy of each member. The default budget is 500 times
the file size, at least 256 MiB.

## CLI

```sh
rea inspect-artifact ./game.z64 --detail summary --json
rea extract-artifact ./game.z64 --json
```

The same commands read a `.v64` or `.n64` dump. `program.z64` in the extract
is the big-endian image.

## Opening the program image

REA does not load `program.z64` as MIPS. The MIPS Ghidra lane admits ELF
images. `raw-binary` admits `x86`, `x86_64`, `arm`, `arm64`, `6502` and
`m68k`, and `base_address` is available only with an ARM M-profile
`architecture_variant`. Routing a raw console image through an installed
Ghidra language is the open design in
[#5657](https://github.com/morluto/rea/issues/5657).

`program.z64` is the whole cartridge in big-endian order. `boot_address` is
the RDRAM address IPL3 jumps to, often `0x80000400`. IPL3 copies the cartridge
bytes starting at file offset `0x1000` into RDRAM at `boot_address` and then
jumps there. The reader reports that address with the other header facts. It
does not apply it as a load base.

To read the game code in a loader that accepts a raw big-endian MIPS image:

1. Run `rea extract-artifact ./game.z64 --json` and note `boot_address` from
   the root format metadata.
2. Open `program.z64` as big-endian 32-bit MIPS (VR4300).
3. Map file offset `0x1000` at `boot_address`, and start disassembly there.

## Verification scope

Synthetic images in all three orders cover header facts, a matching CRC, a
CRC mismatch, a short checksum window read as zero, an unknown IPL3 hash, a
file that ends inside IPL3, a non-zero reserved header byte, a truncated
header, an odd length, an implausible boot address and a file above 64 MiB.
No commercial ROM was used. The published CIC table is not replaced by the
test boot stub.
