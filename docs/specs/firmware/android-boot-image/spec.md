# Android boot and vendor_boot images

## Problem and outcome

Android firmware inspection starts from `boot.img`, `init_boot.img`,
`recovery.img`, and `vendor_boot.img`. REA inventories APKs, devicetree blobs,
legacy uImage containers, and FIT images. It has no reader for an Android boot
image, so `inspect_artifact` and `extract_artifact` cannot expose the kernel,
ramdisk, or DTB stored in one.

This feature adds a provider-less artifact reader for `ANDROID!` headers
(versions 0 through 4) and `VNDRBOOT` headers (versions 3 and 4). Header facts
and component children use the existing artifact inventory, extraction, CLI,
and MCP path.

[Android boot and vendor_boot images](../../../android-boot-image.md) describes
the current behavior and limitations. This directory is the feature
specification, implementation plan, and task list. The guide does not replace
these files.

## Requirements

1. Classification uses the 8-byte magic `ANDROID!` or `VNDRBOOT`, independent
   of filename. `hasAndroidBootImageMagic` is the only magic owner. Target
   resolution and artifact-graph construction call it.
2. `src/domain/androidBootImageFormat.ts` decodes the header, the vendor
   ramdisk table, and the AVB footer once. The reader consumes those facts.
   Header multi-byte fields are little-endian. AVB footer sizes and versions
   are big-endian. `u64`, `alignUp`, and range ends reject values that are not
   safe integers. Parse failures return `Result` with
   `AndroidBootFormatFailure` or `AndroidBootCapacityFailure`.
3. Boot versions 0 through 2 take a power-of-two page size from 2048 through 65536. The header occupies the first page. Kernel, ramdisk, and second
   stage follow, each padded to the next page. Version 1 adds a recovery DTBO
   at a page-aligned file offset. Version 2 adds a DTB after that offset. The
   32-byte header digest is recorded. Boot versions 3 and 4 use a fixed
   4096-byte page. Kernel and ramdisk follow the header page. Version 4 can
   append a signature as a stored range with a size.
4. Vendor_boot versions 3 and 4 record kernel, ramdisk, and tags load
   addresses, the board name, a 2048-byte command line, the vendor ramdisk,
   and a DTB. The vendor page size is a power of two from 2048 through 65536.
   Version 3 exposes one `vendor_ramdisk` child when that section is
   non-empty. Version 4 exposes each ramdisk table entry as
   `vendor_ramdisk/<name>`, then the DTB, then bootconfig. The table itself
   stays metadata. Each entry is at least the 108-byte v4 structure: size,
   offset, type, a 32-byte name, and 16 board-id words. A larger `entry_size`
   keeps those fields and leaves the trailing bytes undecoded. An empty name,
   `.`, `..`, or a name containing `/` becomes `ramdisk-<index>`. A repeated
   name gains `-<index>`, then further numeric suffixes until the path is
   unique.
5. OS version and security patch level come from the packed `os_version` word
   on a boot image. A month outside 1 through 12 leaves the patch level null
   and keeps the raw word. Vendor_boot has no OS version field. Versions 0
   through 2 concatenate `cmdline` and `extra_cmdline` with no separator.
   Versions 3 and 4 store one combined command line. Invalid UTF-8 leaves the
   text null and keeps the raw field bytes as hex. Command line, board name,
   and vendor ramdisk names are target-derived and untrusted. An `ANDROID!`
   image covers boot, init_boot, and recovery; the header leaves that role
   unknown.
6. Non-empty components become children: `kernel`, `ramdisk`, `second`,
   `recovery_dtbo`, `dtb`, `vendor_ramdisk`, `vendor_ramdisk/<name>`,
   `bootconfig`, and `signature`. A prefix of gzip (`1f 8b`), an lz4 frame
   (`04 22 4d 18`), legacy lz4 (`02 21 4c 18`), or zstd (`28 b5 2f fd`)
   records that compression. Any other prefix leaves compression null. Null
   means none of those magics matched. Stored bytes stay compressed. A kernel
   that starts with ELF magic is classified as `elf` by the existing content
   check. A `dtb` child stays a file for a later `inspect-devicetree` on the
   extracted file.
7. When bytes follow the page-aligned image, the last 64 bytes are compared
   with `AVBf`. A match records footer version, original image size, and
   vbmeta offset and size. The footer and vbmeta stay header facts. A shorter
   tail, or a tail that does not start with `AVBf`, is undecoded trailing
   bytes. A vbmeta range that overlaps the header, a component, or the footer
   is malformed.
8. The header probe is at most 4096 bytes. The reader admits at most 4096
   vendor ramdisk table entries, an entry size of at most 4096 bytes, and a
   vendor `header_size` of at most 1 MiB. Those checks run before the table
   is read. A truncated image is malformed. Gaps inside a vendor ramdisk
   section, and bytes between the sequential layout and a recovery DTBO, are
   named in limitations. Member bytes stream on demand.
9. CLI and MCP return the same Evidence shape, including the untrusted-string
   limitation and the unknown boot role. `androidBootImageMetadataSchema` and
   `androidBootImageEntryMetadataSchema` are `strictObject` members of the
   kind-discriminated artifact metadata union. Summary detail retains
   Evidence. `inspect_analysis_view` pages it.
10. The reader reuses `ArtifactFileSource`, `readArtifactFileBytes`,
    `readFileHandleChunks`, and `ArtifactResourceScope`. Close rethrows a
    scope or source close failure and keeps the handle for retry.
    Cancellation applies during admission, paused inventory, buffered reads,
    and multi-chunk reads. A source change after prepare fails closed.

## Acceptance

Synthetic fixtures cover a version 0 image, a version 2 image with a DTB,
version 3 and version 4 boot images, and a version 4 vendor_boot image with
two ramdisk table entries, plus truncated and overlapping-range inputs.
Parser tests, reader tests, boundary tests, the CLI acceptance test, and the
MCP boundary test cover those images, compression magics, capacity limits,
cancellation, and cleanup retry. CLI and MCP tests assert the same Evidence
limitations. Temp directories use `createTestTempDirectory` without an
`afterEach` root removal. The MCP extraction cleanup removes the extraction
output root.

Fixtures are synthetic headers and stored payloads. This feature includes no
vendor or device image. No signature check, AVB digest check, or decompressor
runs.

## Non-goals

- Decompressing ramdisk, kernel, or bootconfig bytes.
- Checking the header digest, the version 4 boot signature, or the AVB footer.
- A separate `inspect_android_boot_image` tool.
- A Binwalk or Unblob adapter.
- Assigning boot, init_boot, or recovery from the header.
- Executing, booting, or modifying the image.
