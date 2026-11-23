# UBI images

`inspect-artifact` and `extract-artifact` recognize a UBI image (a `.ubi`
file from `ubinize` or a NAND dump of a UBI partition) by the `UBI#`
erase-counter header at offset 0 with a valid header CRC, independent of the
file name. They read the erase-counter (EC) and volume-identifier (VID)
headers and the volume table, then reassemble each volume from its logical
eraseblocks (LEBs). Nothing is mounted, attached or written, and UBIFS or
SquashFS contents inside a volume are not decoded.

The same domain facts and artifact reader serve CLI and MCP. The root is an
archive with unknown executable architecture. A `UBI#` header whose CRC does
not match, or whose version is not 1, is refused rather than read as a
container.

```sh
rea inspect-artifact ./nand.ubi --detail summary \
  --evidence_output nand.evidence.json --json
rea extract-artifact ./nand.ubi --json
```

With MCP, `open_binary` then `inspect_artifact` with `detail: "summary"`
retains the complete Evidence. Use `inspect_analysis_view` and its
`parent_evidence_id` for exact logical paths and selected fields.

## Eraseblock layout

The physical eraseblock (PEB) size is the distance from offset 0 to the next
EC header with the same `vid_hdr_offset`, `data_offset` and a compatible
`image_seq`, searched on a 512-byte grid up to 16 MiB. As in Linux UBI, an
`image_seq` of 0 is unspecified; every nonzero `image_seq` must agree. The
file size must be a whole number of PEBs, and every later EC header must
declare the same layout. Either inconsistency refuses the image. A valid EC
header off the PEB grid within the next four PEBs means eraseblocks before
the second header were skipped, so the size is ambiguous and the image is
refused. The image is also refused when a smaller size (the PEB size divided
by one of its prime factors, still above `data_offset`) fits: every EC and VID
header position on that smaller grid between measured PEBs is erased and every
mapped LEB's `data_size` plus `data_pad` fits the smaller LEB, so the bytes
equally describe smaller PEBs with erased ones between. A valid EC header
anywhere in the image where a PEB of any such smaller size would begin shows
that PEBs were skipped and also refuses it. Both header checks set aside a
position that only smaller sizes would begin at whose LEB cannot hold a mapped
LEB's `data_size` plus `data_pad`, or under which no volume table copy stays
valid: no smaller PEB starts there, so the header is LEB data, such as a nested
UBI image inside a static volume. The LEB size is the PEB size minus `data_offset`.

Root `format_metadata` (kind `ubi-image`) records `peb_size`, `leb_size`,
`vid_header_offset`, `data_offset`, `image_seq`, the PEB count and how many
PEBs are mapped to a LEB, free (an EC header with an erased VID area), erased
(all `0xFF`) or corrupt, the minimum and maximum erase counters, and the
number of stale LEB copies. A PEB whose EC or VID header has a bad magic,
version or CRC, or whose VID header declares sizes that do not fit a LEB, is
counted in `corrupt_peb_count`, skipped and named in the limitations. When
only the VID header is corrupt, the valid EC header still counts toward the
erase counter range and the `image_seq` agreement check.

Static payload CRC checks for competing copies and candidate geometry share
the `UBI static payload CRC bytes` budget of twice the image size. Each
distinct payload range counts once across all candidates. The parser refuses
the image if another check would exceed the budget.

## Volume table

The layout volume (`vol_id` 0x7FFFEFFF) stores two copies of the volume
table in LEB 0 and LEB 1. Each record's CRC is checked, the update marker must be 0 or 1, and empty
records must be all zero. A record's `data_pad` must equal `leb_size % alignment`, as
Linux `vtbl.c` checks. The first valid copy is used; `volume_table_source_leb` names
it. When both copies are valid but differ, or only one copy is valid, the
inventory names that limitation. With no valid copy the image is refused.

Each volume is an occurrence at `volumes/<name>`. Names keep letters, digits,
`.`, `_` and `-`; other runs become `_`, leading dots are dropped, an empty
name becomes `volume-<id>`, and a repeated name gets a `-<n>` suffix. Volume
`format_metadata` (kind `ubi-volume`) records the volume id, name, `dynamic`
or `static` type, `reserved_pebs`, `alignment`, `data_pad`, the update marker,
flags (with `autoresize`), the usable LEB size, `used_ebs` for static volumes,
mapped, stale and missing LEB counts, and the reassembled `data_bytes`.
Names are decoded as UTF-8; when that replaces invalid bytes,
`name_bytes_hex` keeps the stored bytes, and it is null otherwise.

The summary view keeps the root scalars under kind `ubi-image-summary` and
replaces the `volumes` array with `volume_count` and
`extractable_volume_count`. The complete Evidence keeps the array.

## Reassembly

For each `(vol_id, lnum)` the copy with the highest `sqnum` wins; older
copies are counted as stale. Two copies with the same `sqnum` refuse the
image, as in Linux UBI, since neither is newer. As in Linux UBI, a newer copy whose `copy_flag`
marks a wear-leveling copy wins only when its data matches its VID
`data_crc`; otherwise the older copy is used and the inventory names that
limitation. A static volume holds LEBs `0` to
`used_ebs - 1`, each contributing its VID `data_size` bytes, so the last LEB
stops at its stored size. A dynamic volume holds full usable LEBs
(`leb_size - data_pad`) from LEB 0 to its highest mapped LEB; trailing
unmapped LEBs are not part of the output.

A missing LEB inside that range refuses the volume with a named limitation
and `hash_status: unavailable`; REA does not fill the gap with `0xFF` or
zero bytes. A static volume whose LEBs disagree on `used_ebs`, declare a
`used_ebs` of 0 while mapped, declare more
data than a LEB holds, or hold less than a full usable LEB before the last
one, is refused the same way, as is a volume whose VID headers declare a
volume type or `data_pad` other than its volume table record. A volume with no
mapped LEB is empty only when no PEB is corrupt; otherwise a corrupt PEB may
have held its data, so it is refused the same way with `used_ebs: null`. LEBs of volumes without
a volume table record, and LEB numbers outside their volume, are counted in
`ignored_leb_count`. A full extract fails when any volume is refused.

Other VID `data_crc` values are not verified (`data_crc_verified: false`).

## Bounded work

Inventory reads 64 bytes at offset 0, the PEB-size search window, and the
first `vid_hdr_offset + 64` bytes of each PEB, the four PEBs after the
first to check the PEB size (twice when its first off-grid header turns
out to be LEB data), the whole image once in 64 KiB chunks for EC
headers where a smaller PEB would begin (when a smaller size is possible), the
first `vid_hdr_offset + 64` bytes at each smaller-grid header position until
one is written, the data of wear-leveling copies that compete
with another copy, then the two volume table copies. It admits at most 262,144 PEBs and 128 volumes. Volume bytes are
streamed from their LEB ranges when a member is opened, not buffered during
inventory.

## Verification scope

Source and compiled CLI/MCP tests cover synthesized images with a static and
a dynamic volume, a stale duplicate LEB, free and erased PEBs, bad EC and VID
header CRCs, an inconsistent PEB size and header layout, disagreeing and
corrupt volume table copies, a missing dynamic LEB, inconsistent static
`used_ebs`, a short non-final static LEB, VID type and `data_pad`
mismatches, PEB sizes measured across a skipped PEB or fitting a smaller
PEB size, zero `image_seq` values, LEBs sharing a `sqnum`, volume table
`data_pad` that disagrees with `alignment`, a mapped static LEB with zero
`used_ebs`, interrupted
wear-leveling copies, sparse LEB numbers near 2^32, non-UTF-8 volume names,
unsafe and duplicate volume names, and nested ZIP member
classification. Images written by `ubinize` and real NAND dumps with OOB
data, bad blocks or bit flips were not verified. Fastmap is not read.
