# Implementation plan

One format-aware parser normalizes the header, vendor ramdisk table, and AVB
footer. The artifact reader consumes that result. Registration follows the
uImage reader. Requirements are numbered in [spec.md](spec.md).

## Boundary and contract

1. Keep parsing in `src/domain/androidBootImageFormat.ts`. That module imports
   only `./result.js`. Export `hasAndroidBootImageMagic`,
   `parseAndroidBootHeader`, `parseVendorRamdiskTable`, `inspectAvbFooter`,
   and `compressionFromPrefix`.
2. Add `AndroidBootImageArtifactReader` with format `android-boot-image`. It
   probes at most 4096 header bytes, reads a 64-byte tail for the AVB check,
   and streams member bytes on demand. Table admission uses the 4096-entry,
   4096-byte entry, and 1 MiB header caps before any table read.
3. Add `androidBootImageMetadataSchema` and
   `androidBootImageEntryMetadataSchema` as `strictObject` members of the
   kind-discriminated artifact metadata union. Catalog order does not select
   the schema.
4. Add `android-boot-image` to `ARTIFACT_FORMATS` with the same container
   flags as uImage: `roleContainer`, `retainClassifiedSource`, `extractable`,
   and `absentInventory: "unavailable"`. `createArtifactReader`, inventory
   classification, and extraction follow that registry.
   `ArtifactGraphConstruction` and `BinaryTargetResolver` call
   `hasAndroidBootImageMagic`. Add the kind to `ArtifactReader`, the artifact
   graph, evidence subject, analysis snapshot, live target summary, and
   binary target types.
5. Carry untrusted target-derived strings and the unknown boot, init_boot, or
   recovery role in reader limitations. CLI and MCP preserve that Evidence.
   Summary detail keeps the full Evidence and uses `inspect_analysis_view`
   for paging.
6. Reuse `ArtifactFileSource`, ranged reads, chunk reads, and
   `ArtifactResourceScope`. A failed close stays owned so a later close can
   retry. Cancellation covers admission, paused inventory, buffered bytes,
   and multi-chunk reads.

## Validation

Synthetic fixtures live in `tests/fixtures/androidBootImage.ts`: version 0,
version 2 with a DTB, versions 3 and 4 boot, version 4 vendor_boot with two
ramdisk table entries, and truncated and overlapping-range negatives. Cover
the parser, the reader, filesystem boundaries, CLI acceptance, and MCP
boundary output, including matching Evidence limitations. State that no
vendor or device image was checked.

## Effects and compatibility

The reader only reads an admitted local file. It introduces no execution,
boot, decompression, digest check, or signature check. The new metadata kinds
are additive. Other artifact formats keep their existing schemas.
