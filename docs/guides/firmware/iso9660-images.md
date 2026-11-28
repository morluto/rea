# ISO 9660 disc images

`inspect-artifact` and `extract-artifact` read ISO 9660 (ECMA-119) disc
images, such as installer, recovery, and appliance `.iso` files, on every
host. The image is recognized by the `CD001` volume descriptor at sector 16
(byte 32769), regardless of filename. REA reads the local bytes without
mounting the image, calling a host tool, or executing anything in it.

The same reader serves CLI and MCP. The root is an archive with unknown
executable architecture. `open_binary` reports `format: "iso9660"`, also for
an image named with a Hopper `.hop` suffix; selecting the database target
kind keeps the database interpretation.

## Volume facts

The root occurrence's `format_metadata` (`kind: "iso9660"`) records the
primary volume descriptor: system, volume, volume set, publisher, data
preparer, and application identifiers; volume space size in blocks; the
logical block size; volume set size and sequence number; path table size;
the walked tree's root extent; and the creation, modification, expiration,
and effective dates. Dates that are unrecorded or not valid calendar times
are `null`. These are observed declarations from the image and are
untrusted. It also records the El Torito boot catalog sector as declared (a
boot record whose version is not 1 returns `unsupported_target`). The
descriptor count, whether an El Torito boot record is present, the Joliet
level, which tree supplied names (`name_source`), and the directory and file
counts are derived from the descriptors found and the tree walked.

Both-endian fields are decoded from both halves. A disagreement is a
malformed image. Only 2048-byte logical blocks and file structure version 1
are decoded; other values return `unsupported_target`. A volume set size of
0, a sequence number outside the set, or a volume space that ends before the
descriptor set terminator is malformed. The descriptor's root record must be
a single-extent directory with identifier 0x00 on this volume.

Every directory record names its volume. A volume sequence number of 0 or
above the declared volume set size names no volume and is malformed. Another
volume within the set returns `unsupported_target`, because REA reads one
image and does not follow references to other volumes.

## Entries

REA walks one directory tree, and every file and directory in that tree
becomes an occurrence. When an eligible Joliet supplementary descriptor is
present (version 1, registered escape sequences), its tree and UCS-2 names are
used; otherwise the primary tree is. `name_source` records which tree was
walked. The primary, Joliet, and other supplementary hierarchies are separate
and may list different files or extents, so a file present only in a tree that
was not walked is not reported. REA does not establish that two trees list the
same files. The inventory's coverage is therefore `complete` only when the
primary tree is the image's only tree. Otherwise it is `unknown`, with a
limitation naming each tree that was not walked: the primary tree when Joliet
names are used, a further Joliet descriptor, or a supplementary descriptor
without Joliet escape sequences. A Joliet descriptor that is not eligible is
skipped with a limitation saying why. An eligible Joliet descriptor whose
volume space size, volume set size, or volume sequence number differs from the
primary descriptor's is malformed. Joliet names are UCS-2; a surrogate pair is
read as the UTF-16 character, and an unpaired surrogate is malformed. A primary
identifier with bytes above 0x7F, which ECMA-119 does not assign, is shown as
Latin-1 with a limitation saying the intended characters are unknown.
The `;1` version suffix (a semicolon followed by digits) and an empty extension dot are removed from file names; a semicolon with no digits after it stays in the name.
`source_path` and the entry's `identifier` keep the stored spelling.

Names that are empty, `.`, `..`, or contain `/`, `\`, NUL, or a control
character become `entry-<index>`, with a limitation naming the rename. A
repeated name gains `-<index>`, and another number if that is also taken.

Each entry's `format_metadata` (`kind: "iso9660-entry"`) records, as
observed in its first directory record, its identifier, extent block,
extended attribute length, raw file flags, recording date, file unit size,
and interleave gap. The extent count and layout and the hidden and associated
flags are derived. Every section of a multi-extent file must repeat the first
section's identifier and its file flags apart from the protection and multi-extent bits, so an
associated file and an ordinary file with the same name are not joined. A
file's `source_location` is its byte range in the
image; extracted children are classified by content, so a `setup.exe` inside
the image reports `pe`.

A multi-extent file whose extents are adjacent is read as one range. A
multi-extent file with separated extents, or an interleaved file (non-zero
file unit size or gap), is listed but not read: its occurrence has
`hash_status: "unavailable"` and a limitation, and a complete extraction
fails with `unavailable`. Opening such a file first rechecks the image's
identity, as opening a readable file does, so a changed image fails as a
changed source rather than as an unread layout. Its `source_location` covers only the bytes stored
contiguously at the start of its first extent: that whole extent, or its first
file unit when the first extent is interleaved. Select other occurrences with
`occurrence_ids` to extract them.

## Bounded work

The reader defaults to at most 64 volume descriptors (`descriptor_count`), 64
nested directory levels (`directory_depth`), 262,144 raw directory records
(`record_count`), 64 MiB of directory extents (`directory_bytes`), and 64 MiB of
expanded entry paths (`path_bytes`, the UTF-8 bytes of each entry's `path` and
`source_path`, charged before the entry is kept). The record count includes
`.`, `..`, and each section of a multi-extent file. Exceeding one returns a
`limit` failure reporting the `artifact_limits.iso9660.*` parameter so callers
can raise it and retry the same image. A directory extent, the
root's included, is checked against the image and the declared volume before
its bytes are charged, so a directory that cannot exist is malformed or
truncated rather than over the limit. The walk yields to the event loop and
checks for cancellation every 256 records or padded directory sectors, whether
or not they list an entry, so a long multi-extent chain or padding run is
cancellable. Declared file bytes share the
artifact expansion budget; separated and interleaved files, which are not
read, are not charged. A directory whose extent was already visited is
a malformed cycle. A directory extent is malformed when it lacks its `.` and
`..` records, when `.` does not describe the directory's own extent or `..`
its parent's (extent block, data length, and extended attribute length; the
root's `..` describes the root), or when a later record uses identifier 0x00
or 0x01. In the Joliet tree, a `..` that describes its own directory is also
accepted: libisofs (xorriso) writes every Joliet `..` record that way. A record whose even-length identifier lacks its zero padding byte, or
that declares an interleave gap without a file unit size, is malformed. An
extent that starts or ends, counting
interleave gaps, outside the declared volume is malformed. An extent inside
the declared volume that the image ends before or within is `truncated`.
These refusals do not produce an empty successful inventory. An empty file without an extended attribute record stores no bytes, so its
extent location is not checked; writers such as libarchive record the
unallocated sentinel `0xfffffff0` there, and the entry carries a limitation
saying its `source_location` names no stored bytes.

```sh
rea inspect-artifact ./installer.iso --detail summary \
  --evidence_output installer.evidence.json --json
rea extract-artifact ./installer.iso --json
```

## Not decoded

Rock Ridge (SUSP) system-use fields, UDF bridge structures, El Torito boot
catalogs and boot images, path tables, and extended attribute record contents
are not decoded. A Rock Ridge name, symlink, or permission is therefore not
reported; the Joliet or primary name is. Hybrid MBR or GPT data in the
system area is not interpreted.

## Verification scope

Source and compiled CLI/MCP tests use images built in TypeScript: primary-only
and Joliet trees with nested directories, a PE child, contiguous and separated
multi-extent files, interleaved files, unsafe names, both-endian mismatches,
directory cycles, extents past the end, unsupported block sizes, depth limits,
cancellation, and cleanup. A Joliet image from macOS `hdiutil makehybrid -iso
-joliet` listed the expected nested paths and sizes, its file digests matched
the source files, and an ISO stored inside it was classified as `iso9660`. A
primary-only `hdiutil makehybrid -iso` image of the same files listed the
same tree.
Images from `mkisofs`, `xorriso`, or vendor installer media, and Rock Ridge or
UDF hybrids, were not checked.
