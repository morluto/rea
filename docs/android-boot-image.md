# Android boot and vendor_boot images

`inspect-artifact` and `extract-artifact` recognize `ANDROID!` boot images
(header versions 0 through 4) and `VNDRBOOT` vendor_boot images (header
versions 3 and 4) regardless of filename. They read local stored bytes
without booting, executing, decompressing, or modifying the image.

The same header facts and artifact reader serve CLI and MCP. The root is an
archive with unknown executable architecture. `ANDROID!` covers boot,
init_boot, and recovery images; the header does not record which role the
file had.

## Header facts

Versions 0 through 2 store a page size from 2048 through 65536, a power of
two. The header occupies the first page. Kernel, ramdisk, and second stage
follow, each padded up to the next page. Version 1 adds a recovery DTBO at
a page-aligned file offset. Version 2 adds a DTB after that offset. The
32-byte header digest is recorded and not checked.

Versions 3 and 4 use a fixed 4096-byte page. The kernel and ramdisk follow
the header page. Version 4 can append a signature. That signature is a
stored range with a size. It is not verified.

Vendor_boot versions 3 and 4 record the kernel, ramdisk, and tags load
addresses, the board name, a 2048-byte command line, the vendor ramdisk,
and a DTB. Version 3 exposes one `vendor_ramdisk` child when that section
is non-empty. Version 4 exposes each ramdisk table entry as
`vendor_ramdisk/<name>`, then the DTB, then bootconfig. The table itself
is not a child. Each entry is at least the 108-byte v4 structure: size,
offset, type, a 32-byte name, and 16 board-id words. A larger
`entry_size` keeps those fields and leaves the trailing bytes undecoded.
Entry names that are empty, `.`, `..`, or contain `/` become
`ramdisk-<index>`. A repeated name gains `-<index>`. If that name is
already used, the suffix gains another number until the path is unique.

OS version and security patch level are decoded from the packed `os_version`
word. A month outside 1 through 12 leaves the patch level null and keeps
the raw word. Vendor_boot has no OS version field.

Command line, board name, and vendor ramdisk names are target-derived and
untrusted. Versions 0 through 2 concatenate `cmdline` and `extra_cmdline`
with no separator. Versions 3 and 4 store one combined command line.
Invalid UTF-8 stays null and the raw field bytes are kept as hex.

## Children

Non-empty components become children:

| Path                    | Role                             |
| ----------------------- | -------------------------------- |
| `kernel`                | kernel                           |
| `ramdisk`               | ramdisk                          |
| `second`                | second stage                     |
| `recovery_dtbo`         | recovery DTBO                    |
| `dtb`                   | devicetree blob                  |
| `vendor_ramdisk`        | version 3 vendor ramdisk section |
| `vendor_ramdisk/<name>` | version 4 ramdisk table entry    |
| `bootconfig`            | bootconfig                       |
| `signature`             | version 4 boot signature         |

A child whose first bytes match gzip (`1f 8b`), an lz4 frame (`04 22 4d 18`),
legacy lz4 (`02 21 4c 18`), or zstd (`28 b5 2f fd`) records that compression.
Other prefixes stay unknown, which does not prove the bytes are uncompressed.
Nothing in this reader decompresses a payload. A kernel that starts with the
ELF magic is classified as `elf` by the existing content check. A `dtb` child
stays a file; extract it and run `inspect-devicetree` on the extracted file.

## Standalone vbmeta images

`inspect-artifact` and `extract-artifact` also recognize standalone vbmeta
images (`vbmeta.img`, `vbmeta_system.img`, `vbmeta_vendor.img`, and the AVB
metadata appended to `boot`/`init_boot`/`vendor_boot`/`dtbo` images when it
stands alone): files whose first four bytes are `AVB0`. They read local
stored bytes without verifying, executing, or modifying the image.

The reader decodes the 256-byte `AvbVBMetaImageHeader` (required libavb
version 1.x, algorithm type, rollback index and location, flags, release
string) and the descriptor table inside the auxiliary block: property,
hashtree, hash, kernel cmdline, and chain partition descriptors. Each
descriptor becomes a child named `descriptor-<index>-<kind>.bin` holding its
stored bytes. Property key and value sizes count only the text bytes; each
is followed by its own separate NUL byte, and the value starts after the
key's NUL. Partition names and kernel command lines are stored without a
terminating NUL and are read for exactly their counted length. The
rollback index is a 64-bit counter and is reported as a decimal string so
values above the safe-integer range stay exact; unrecognized descriptor
tags are likewise kept exact. The hash and signature are recorded as offsets and sizes and
are never verified; the public key bytes are not decoded. Descriptors with
an unrecognized tag stay undecoded and are exposed as-is. The
authentication and auxiliary blocks must be multiples of 64 bytes, each
descriptor's size a multiple of 8 bytes, and the hash, signature, public
key, and descriptor ranges must stay inside their blocks without
overlapping. A vbmeta image larger than 16 MiB, or a descriptor table with
more than 4,096 descriptors, exceeds a capacity limit. Trailing bytes after
the declared image are reported as a limitation; a trailing `AVBf` footer
is named, not decoded as part of the image.

## AVB footer

The reader checks the final 64 bytes for an `AVBf` footer when those bytes
begin at or after the end of the last declared image component, even if they
start before the page-rounded image end. A matching footer records its version,
original image size, and vbmeta offset and size. The footer and vbmeta remain
unverified metadata. If no footer is recognized, the reader reports undecoded
trailing bytes beyond the page-rounded image end. A vbmeta range that overlaps
the header, a component, or the footer is malformed.

## Bounded work

The reader admits at most 4,096 vendor ramdisk table entries and an entry size
of at most 4,096 bytes. It verifies that the table dimensions agree and the
declared bytes fit in the image before applying those limits and reading the
table. A vendor `header_size` above 1 MiB also exceeds a capacity limit. Unsupported
header revisions, truncated declared structures and malformed layouts all
return `unsupported_target`. Truncated and malformed refusals carry
`details.failure_kind` (`truncated` or `malformed`), `details.format`
(`android-boot-image`) and, when the parser names them, `details.offset` and
`details.field`. The page
padding after the last component carries no data and may be absent. These refusals
do not produce an empty successful inventory. Gaps inside a vendor ramdisk
section, or bytes between the sequential layout and a recovery DTBO, are named
in limitations instead of being invented as entries.

```sh
rea inspect-artifact boot.img --detail summary \
  --evidence_output boot.evidence.json --json
rea extract-artifact vendor_boot.img --json
```

With MCP, `inspect_artifact` with `detail: "summary"` retains the complete
Evidence. Use `inspect_analysis_view` and its `parent_evidence_id` for exact
logical paths, batches of occurrence/content IDs, selected fields and pages.

## Verification scope

Source and compiled CLI/MCP tests cover stored component bytes, compression
magics, unsupported revisions, truncation, overlapping ranges, capacity,
cancellation, and cleanup. Standalone vbmeta coverage is synthetic fixtures
only: one descriptor of each tag (0 through 4), truncated headers and
descriptor tables, overlapping authentication/auxiliary ranges, and `AVB0`
images with a trailing `AVBf` footer. No `avbtool info_image` cross-check
was run (avbtool is not installed in the test environment), and no
device-dumped vbmeta image was checked. An independent offline check used AOSP
`mkbootimg.py` and `unpack_bootimg.py` at commit
`d2bb0af5ba6d3198a3e99529c97eda1be0b5a093`: boot versions 0 through 4 and
vendor_boot versions 3 and 4 had component ranges and digests matching their
small inert input files and official unpacked output. Version 4 vendor_boot
extraction also matched those inputs. No device-dumped image, signature
verification, AVB digest verification, or payload decompression was checked.
