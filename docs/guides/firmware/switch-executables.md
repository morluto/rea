# Nintendo Switch NSO and NRO executables

`inspect-artifact` and `extract-artifact` read Nintendo Switch NSO modules
and NRO homebrew executables without running, patching or disassembling
them. The reader reports the header facts that pair a module with crash logs
and patches, splits the file into its text, rodata and data segments, and
for NRO lists the icon, NACP and RomFS ranges in the `ASET` trailer.

Detection uses the bytes, not the file name. A file is `nso` when it starts
with `NSO0`, and `nro` when `NRO0` sits at offset `0x10`.

## What inventory reports

The root occurrence's `format_metadata` (`kind: "switch-executable"`)
records:

- `format`: `nso` or `nro`.
- `version`, `flags` and, for NSO, `unknown_flags`: flag bits outside the six
  that mark per-segment LZ4 compression and hash checks. Unknown bits are
  reported and add a limitation; they are not interpreted.
- `module_id`: the 32-byte build id, as lowercase hex.
- `bss_size`, and the `embedded`, `dynstr` and `dynsym` offset and size pairs
  as the header declares them.
- `mod0_offset`: the MOD0 header offset. For NSO it is read from the loaded
  text at `text+4` and is relative to the start of text; `mod0_present` is
  `null`. For NRO it is the header field at file offset `0x4`, relative to the
  start of the file, and `mod0_present` says whether `MOD0` is at that file
  offset.
- `image_size` (NRO only) and `asset_section`: the `ASET` offset and version,
  or `null` when the NRO has no asset trailer.

Each entry's `format_metadata` (`kind: "switch-executable-entry"`) records
its `role` (`text`, `rodata`, `data`, `icon`, `nacp`, `romfs`), file offset,
memory offset for segments, stored size and whether it is compressed. Entries
are named `text.bin`, `rodata.bin`, `data.bin`, `assets/icon.jpg`,
`assets/control.nacp` and `assets/romfs.bin`.

## Compressed segments and hashes

NSO segments flagged as compressed are raw LZ4 blocks. The reader decodes
them in memory so it can hash and extract the loaded bytes. The stored
compressed bytes and the decompressed bytes are both charged to
`artifact_limits.expanded_bytes` before those buffers are allocated. A
segment that would exceed the remaining allowance is still listed with its
declared sizes, its
`hash_status` is `unavailable`, coverage becomes `unknown`, and the entry
carries a limitation that names the setting. Opening it reports the content as
unavailable, with the limit failure as its cause. `artifact_limits.expanded_bytes`
is a per-call parameter (`update_analysis_settings` does not accept it): pass a
larger value on the next `inspect_artifact` or `extract_artifact` call, for
example `rea inspect-artifact main.nso --artifact-limits '{"expanded_bytes":1073741824}' --json`.

For NSO, `declared_sha256` is the header's SHA-256 of the loaded segment and
`observed_sha256` is the digest REA computed. `hash_status` is:

- `match` or `mismatch` when the header's flag asks for a check;
- `not-checked` when it does not (both digests are still reported);
- `unavailable` when the segment was truncated, over budget or not valid LZ4.

A mismatch is a limitation on that entry and on the inventory. It does not
drop the segment.

## Truncated and malformed files

A missing magic or a header shorter than `0x100` bytes (NSO) or `0x80` bytes
(NRO) refuses the file as malformed. So does an NSO segment that overlaps the
header, or an NRO segment that ends past the declared image size.

A segment or asset whose stored range ends past the end of the file is listed
with a `truncated` limitation, and opening it is refused while the rest of the
inventory is kept. An NRO file shorter than its declared image size adds a
limitation. Bytes after an NRO image that do not start with `ASET`, and an
`ASET` header cut short, are reported as uninterpreted; the segments are still
listed.

## CLI

```sh
rea inspect-artifact main.nso --json
rea extract-artifact main.nso --json
```

The extracted `text.bin` holds the decompressed code that a disassembler can
load at the reported memory offset.

## Verification scope

Synthetic fixtures built in the tests cover NSO files with compressed and
stored segments, a hash mismatch, unchecked hashes, unknown flag bits, a
truncated segment, invalid LZ4 data and the expansion allowance, and NRO
files with and without an `ASET` trailer, a truncated asset and trailing
bytes. No retail or homebrew files were checked.
