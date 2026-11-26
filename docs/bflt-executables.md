# uClinux bFLT flat executables

`inspect-artifact` and `extract-artifact` recognize a uClinux flat executable
by its `bFLT` magic, regardless of filename. These files come from no-MMU
embedded Linux systems (Cortex-M, ColdFire, Blackfin, RISC-V nommu). The
reader works on local bytes only: it does not run the program or apply its
relocations, and it does not change the file.

The root is an archive with unknown executable architecture. The flat header
does not name a CPU, so the target architecture must come from elsewhere,
such as the firmware image or the kernel configuration.

## Header facts

The 64-byte header is big-endian. Its offsets count from the start of the
file as the loader sees it, header included. The root `format_metadata`
(`kind: "bflt"`) reports:

| Field                                  | Meaning                                                                                                                                                                                                                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `revision`                             | 4 (`FLAT_VERSION`) or 2 (`OLD_FLAT_VERSION`); others are kept                                                                                                                                                                                                           |
| `entry`                                | Offset of the first instruction                                                                                                                                                                                                                                         |
| `data_start`, `data_end`, `bss_end`    | Segment boundaries; `text_size`, `data_size`, `bss_size` follow                                                                                                                                                                                                         |
| `stack_size`                           | Requested stack size                                                                                                                                                                                                                                                    |
| `reloc_start`, `reloc_count`           | Relocation table position and entry count                                                                                                                                                                                                                               |
| `flags`, `flag_names`, `unknown_flags` | `ram`, `gotpic`, `gzip`, `gzdata`, `ktrace`, `l1stk`; other bits stay in `unknown_flags`                                                                                                                                                                                |
| `build_date`, `build_date_iso`         | Revision 4 build time, or null when zero                                                                                                                                                                                                                                |
| `compression`, `inflated_bytes`        | `none`, `gzip` or `gzdata`, and the inflated body size                                                                                                                                                                                                                  |
| `relocations`, `relocations_truncated` | The first 64 relocation offsets                                                                                                                                                                                                                                         |
| `out_of_range_relocation_count`        | Revision 4 entries past the end of bss, measured from the byte after the header; null for revision 2, when entries exist but that end is not established, or when entries exist but the table is not read (it runs past the image, or the gzip body cannot be inflated) |

## Segments

Each segment is one extractable entry (`kind: "bflt-segment"`):

- `text.bin`: image bytes `[0, data_start)`, header included. `entry` is a
  file offset into this image. Revision 4 relocation offsets count from the
  first byte after the header, and the loader accepts them through the end
  of bss. For ARM M-profile targets, open it as `raw-binary` with
  `architecture: "arm"`, an `architecture_variant`, `base_address` at the
  load base and `entry_point` at that base plus `entry`; for other CPUs,
  `raw-binary` maps offset 0 at `entry_point` and starts analysis in the
  header rather than at `base + entry`.
- `data.bin`: `[data_start, data_end)`.
- `relocations.bin`: the complete relocation table, `reloc_count` big-endian
  32-bit values. Revision 4 values are offsets from the first byte after the
  header.

Stored segments keep their file range as `source_location`. Segments that
exist only after inflation have no file range; `image_offset` gives their
position in the inflated image.

## Compressed bodies

With `gzip`, everything after the header is one gzip stream. With `gzdata`,
text is stored and the stream starts at `data_start`. Revision 2 loaders
ignore these flags, so a revision 2 body is always read as stored. The reader
inflates the stream in memory under `artifact_limits.expanded_bytes` (by
default 500 times the file size, at least 256 MiB), capped at a fixed 128 MiB
in-memory inflation ceiling. When the stream exceeds the active limit or cannot
be inflated, the header facts are still reported, coverage is `unknown`, a
limitation names the cause, and the stored bytes are served as
`compressed-body.gz` (plus `text.bin` for `gzdata`).

## Limits and limitations

The reader admits files up to a fixed 128 MiB, as the DfuSe and Intel HEX
readers do. Only a missing magic or a header shorter than 64 bytes refuses
the file. Other problems become limitations beside the facts that still hold:

- an unknown revision, reported with the revision 4 layout;
- revision 2, whose loaders ignore stored flags and whose relocation entries
  pack a segment type beside an offset whose bit order and base segment
  depend on the target CPU; entries are listed as stored and not
  range-checked;
- inconsistent `data_start` and `data_end`, or a data segment past the
  image, in which case text and data are not served;
- an entry point outside text, or `bss_end` before `data_end`;
- a relocation table past the image, in which case relocations are not
  listed;
- more than 64 relocations, where the inline list is truncated and
  `relocations.bin` keeps the full table.
