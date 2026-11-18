# Implementation plan

## Boundary and contract

Follow the existing artifact readers. `src/domain/firmware/androidOtaPayload.ts`
owns CrAU header and `DeltaArchiveManifest` decode, recognition, reconstruction
and capacity ceilings. `src/domain/artifactFormatMetadata.ts` owns the
`android-ota-payload` and `android-ota-partition` result schemas.
`AndroidOtaPayloadArtifactReader` reads the admitted file through
`ArtifactFileSource`, inventories partitions from the manifest, and
reconstructs extractable images on `open()`.

Recognition lives in `recognizeAndroidOtaPayload` and is applied in the
shared `ARTIFACT_FORMAT_RECOGNIZERS` table immediately after uImage, so
inventory classification and binary target resolution share one verdict.
A v1 (or other non-v2) header is refused like an ESP8266 image: nested
classification keeps a plain file; `open_binary` reports the unsupported
version.

Field numbers are taken from AOSP `system/update_engine/update_metadata.proto`
(`chromeos_update_engine`). Unknown protobuf fields are skipped. The proto
is not vendored.

## Incremental work and validation

1. Define header, manifest, signature-count and reconstruction contracts with
   synthesized CrAU fixtures.
2. Implement parse, recognition and REPLACE/ZERO/REPLACE_ZSTD reconstruction
   with typed format, unsupported-version, capacity, unsupported-operation
   and integrity failures.
3. Add the reader, format descriptor and byte classification.
4. Wire CLI/MCP through the existing inspect/extract artifact contracts.
5. Document the workflow and limits.

## Effects and compatibility

The inventory reads one caller-selected payload file. Nested zip members
named `payload.bin` classify by magic when the zip reader already surfaces
them; zip inventory does not recurse into partitions. The change adds no
target execution, injection, mutation, protection recovery, network access
or live device update, so no maintainer scope decision is required.
Existing format routing is unchanged; the new format id appears only for
CrAU v2 bytes.
