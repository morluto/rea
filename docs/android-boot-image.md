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

## AVB footer

When bytes follow the page-aligned image, the last 64 bytes are compared with
the `AVBf` footer. A matching footer records its version, original image size,
and vbmeta offset and size. The footer and vbmeta are not children and are not
verified. A shorter tail, or a tail that does not start with `AVBf`, is
reported as undecoded trailing bytes. A vbmeta range that overlaps the header,
a component, or the footer is malformed.

## Bounded work

The reader admits at most 4,096 vendor ramdisk table entries and an entry size
of at most 4,096 bytes. A vendor `header_size` above 1 MiB is the same kind of
capacity limit. Those checks happen before the table is read. A truncated
image is malformed, not an empty inventory. Gaps inside a vendor ramdisk
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

Tests use synthetic headers and stored payloads only. No vendor or device
image was checked in this change. Source and compiled CLI/full/compact MCP
tests cover versions 0, 2, 3, and 4, a version 4 vendor_boot with two ramdisk
table entries, compression magics, truncation, overlapping ranges, capacity,
cancellation, and cleanup. No signature, AVB digest, or decompressor was run.
