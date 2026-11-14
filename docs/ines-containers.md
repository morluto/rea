# iNES and NES 2.0 container inspection

REA recognizes iNES from the `NES` + `0x1a` byte signature, independently
of the file extension. Header byte 7 bits 2–3 equal to `0b10` select NES 2.0;
other headers are read as classic iNES. Both report the `ines` artifact format.
This read-only container inspection uses portable Node.js file reads; it needs
neither Ghidra nor an emulator.

```bash
rea inspect-artifact ./cartridge.nes --json
rea extract-artifact ./cartridge.nes --json
```

Through MCP, call `open_binary` with the local path, then `inspect_artifact`.
Use `extract_artifact` to materialize the regions in the fresh directory named
by its result. The caller owns that successful extraction directory.

## Header and file regions

Inspection returns `container-header` and `reconstruction` observations inline.
The single inventory Evidence under `substeps[].evidence.normalized_result`
contains the complete graph and an `ines` object:

- `ines.header`: `format` (`ines` or `nes-2.0`), original 16-byte `header_hex`,
  PRG/CHR file-unit counts, mapper, raw flags 6/7, trainer and battery flags,
  and the declared mirroring mode. Classic iNES reports only these fields.
- NES 2.0 headers add `prg_rom_bytes`/`chr_rom_bytes`, the 12-bit mapper and
  `submapper`, `console_type`, `cpu_ppu_timing`, declared PRG-RAM,
  PRG-NVRAM, CHR-RAM and CHR-NVRAM byte sizes (`0` when none is declared),
  `misc_rom_count` and `default_expansion_device`. Vs. System headers add
  `vs_ppu_type` and `vs_hardware_type`; extended console headers add
  `extended_console_type`. These codes are reported as numbers. When the
  exponent-multiplier form declares a ROM size, its unit count is omitted
  rather than reported as zero.
- `occurrences[]`: each region's path, `source_location.offset` and
  `source_location.length` in the original container. Follow `artifact_id` to
  the node's observed SHA-256 and byte count.
- `ines.reconstruction`: ordered region paths, concatenated byte count,
  SHA-256 and `verified: true`. REA accumulates the concatenation digest during
  the same physical-order region scan that produces node hashes, then compares
  it with the original whole-file digest. Final source freshness is also checked.
  No reconstructed file is written during inspection.

Regions are `header.bin`, optional `trainer.bin` (512 bytes),
`prg/000.bin` onward (16 KiB each), `chr/000.bin` onward (8 KiB each), and
optional `trailing.bin`. An exponent-multiplier size is one `prg.bin` or
`chr.bin` region of the declared byte length. When NES 2.0 declares
miscellaneous ROMs, all bytes after CHR-ROM form `misc-rom.bin` instead of
`trailing.bin`; the boundaries between several miscellaneous ROMs are
mapper-specific and are not split. Every input byte is retained, including
unused header fields and uninterpreted trailing data. Zero CHR-ROM units create
no CHR region; REA does not fabricate CHR-RAM contents. Declared RAM and NVRAM
sizes create no regions.

After extraction, concatenate the materialized files in
`ines.reconstruction.region_order` from the inspection inventory. Their bytes
reproduce the input exactly. Graph path order is lexical and is not physical
file order; use the explicit region order or source offsets.

## Supported boundary

This lane supports classic iNES with a complete 16-byte header, nonzero
PRG count, complete declared trainer/PRG/CHR payload, and zero reserved bytes
12–15. Dirty legacy headers are refused because their upper mapper bits are
ambiguous; REA does not silently repair them. NES 2.0 additionally requires
nonzero PRG-ROM, zero unused header bits (byte 12 bits 2–7, byte 13 outside
the Vs. System and extended console fields, byte 14 bits 2–7 and byte 15 bits
6–7), and at least one byte after CHR-ROM when miscellaneous ROMs are
declared. A NES 2.0 size larger than the file, including an exponent-multiplier
size beyond the safe integer range, is refused with its exact declared total;
REA does not fall back to a classic reading. UNIF signatures, unsupported
header variants and truncated payloads are explicitly refused. An arbitrary
file named `.nes` is not admitted as iNES.

The PRG/CHR units describe file storage, not mapper bank sizes or CPU windows.
The mapper number, flags, RAM/NVRAM sizes, timing, console and expansion-device
values are header declarations, not proof of cartridge hardware or runtime
behavior. Bank switching, 6502/65816 disassembly, emulator
sessions and interpretation of console-specific trailing data remain outside
this lane. Raw-binary Ghidra analysis is a separate workflow. This container
increment addresses the first milestone of [#2072](https://github.com/morluto/rea/issues/2072);
the related [#1641](https://github.com/morluto/rea/issues/1641) tracks 6502/65816
native analysis with explicit load addresses and provider limitations. Extracted
PRG units still need caller-selected CPU windows before static code analysis;
their physical file offsets do not establish those addresses.

Source-owned byte fixtures verify original offsets and hashes, extraction and
byte-exact reconstruction, CLI/stdio MCP parity, malformed/unsupported inputs,
failed target-switch recovery, cancellation and source identity. These checks
do not establish emulator behavior or compatibility with every historical ROM.
The portable CLI/stdio MCP acceptance and source-identity checks run in Linux
and macOS CI. The same workflows have also been executed on native Windows x64.
Synthetic NES 2.0 headers additionally cover simple and exponent-multiplier
sizes, trainer and miscellaneous ROM regions, console and timing fields,
refused declarations, source-boundary extraction and compiled CLI inspection
in the same Linux and macOS CI jobs. No real NES 2.0 cartridge image is
part of the test suite.

Format references: [iNES](https://www.nesdev.org/wiki/INES) and
[NES 2.0](https://www.nesdev.org/wiki/NES_2.0).
