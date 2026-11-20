import { Buffer } from "node:buffer";
import { expect, it } from "vitest";

import {
  buildFv,
  buildImage,
  buildFfsFile,
} from "../../tests/fixtures/uefiImage.js";
import { imageRegion } from "./UefiBytes.js";
import {
  inspectFirmwareVolumeExtension,
  parseFirmwareVolumeHeader,
  scanFirmwareVolumes,
} from "./FirmwareVolume.js";

const driverFile = (guid: string): Buffer =>
  buildFfsFile({ guid, typeCode: 0x07, payload: Buffer.from("body") });

it("parses a valid built volume header with verified checksum", () => {
  const fv = buildFv({
    files: [driverFile("11111111-2222-3333-4444-555555555555")],
  });
  const region = imageRegion(fv.buffer, 0, fv.buffer.length);
  const header = parseFirmwareVolumeHeader(region, 0);
  expect(header).not.toBeNull();
  expect(header?.declaredLength).toBe(fv.declaredLength);
  expect(header?.headerLength).toBe(72);
  expect(header?.attributes).toBe(0x800);
  expect(header?.erasePolarity).toBe(true);
  expect(header?.revision).toBe(2);
  expect(header?.checksumValid).toBe(true);
  expect(header?.fileSystemGuid).toBe("8c8ce578-8a3d-4f1c-9935-896185c32dd3");
  expect(header?.blockMap).toEqual([
    { numBlocks: expect.any(Number), blockLength: 0x1000 },
  ]);
});

it("flags a corrupted header byte as checksum mismatch but keeps the header", () => {
  const fv = buildFv({
    files: [driverFile("12111111-2222-3333-4444-555555555555")],
  });
  fv.buffer[55] = 3; // revision byte carries the corrupted word checksum
  const region = imageRegion(fv.buffer, 0, fv.buffer.length);
  const header = parseFirmwareVolumeHeader(region, 0);
  expect(header?.revision).toBe(3);
  expect(header?.checksumValid).toBe(false);
});

it("returns null when the signature is absent", () => {
  const region = imageRegion(Buffer.alloc(64, 0x11), 0, 64);
  expect(parseFirmwareVolumeHeader(region, 0)).toBeNull();
});

it("discovers every volume in an image and rejects implausible _FVH hits", () => {
  const fvA = buildFv({
    files: [driverFile("13111111-2222-3333-4444-555555555555")],
  });
  const fvB = buildFv({
    files: [driverFile("14111111-2222-3333-4444-555555555555")],
  });
  // Garbage _FVH text inside a payload: the preceding "header" has zero length,
  // so the hit must be rejected, never silently mapped.
  const garbage = Buffer.concat([
    Buffer.alloc(40, 0x41),
    Buffer.from("_FVH", "ascii"),
    Buffer.alloc(16, 0x42),
  ]);
  const image = buildImage({ volumes: [fvA.buffer, garbage, fvB.buffer] });
  const region = imageRegion(image, 0, image.length);
  const scan = scanFirmwareVolumes(region, 16);
  expect(scan.volumes).toHaveLength(2);
  expect(scan.rejected).toHaveLength(1);
  const firstOffset = scan.volumes[0]?.header.absoluteBase ?? -1;
  const secondOffset = scan.volumes[1]?.header.absoluteBase ?? -1;
  expect(secondOffset - firstOffset).toBeGreaterThan(0);
  expect(scan.rejected[0]?.reason).not.toBe("");
});

it("respects the maxVolumes budget while scanning", () => {
  const fvA = buildFv({
    files: [driverFile("15111111-2222-3333-4444-555555555555")],
  });
  const fvB = buildFv({
    files: [driverFile("16111111-2222-3333-4444-555555555555")],
  });
  const image = buildImage({ volumes: [fvA.buffer, fvB.buffer] });
  const region = imageRegion(image, 0, image.length);
  const scan = scanFirmwareVolumes(region, 1);
  expect(scan.volumes).toHaveLength(1);
});

it("admits a supported aligned volume after an earlier foreign and unaligned volume", async () => {
  const { admitUefiFlashImage } = await import("./UefiFormatProbe.js");
  const foreign = buildFv({
    files: [],
    fileSystemGuid: "19111111-2222-3333-4444-555555555555",
  }).buffer;
  const ffs = buildFv({ files: [] }).buffer;
  expect(
    admitUefiFlashImage(Buffer.concat([foreign, Buffer.alloc(1), ffs])),
  ).toBe(false);
  expect(
    admitUefiFlashImage(
      Buffer.concat([foreign, Buffer.alloc(1), ffs, Buffer.alloc(15), ffs]),
    ),
  ).toBe(true);
});

it.each([
  { size: 64, blockLength: 64, reason: "header-exceeds-volume" },
  { size: 4096, blockLength: 2048, reason: "block-map-shorter-than-volume" },
  { size: 4096, blockLength: 0, reason: "block-map-empty-run" },
])(
  "rejects contradictory FV geometry ($reason)",
  ({ size, blockLength, reason }) => {
    const { buffer } = buildFv({ files: [] });
    buffer.writeBigUInt64LE(BigInt(size), 32);
    buffer.writeUInt32LE(blockLength, 60);
    const scan = scanFirmwareVolumes(imageRegion(buffer, 0, buffer.length), 4);
    expect(scan.volumes).toEqual([]);
    expect(scan.rejected).toMatchObject([{ reason }]);
  },
);

it("does not use an FV beyond the signature search boundary to admit the image", async () => {
  const { admitUefiFlashImage } = await import("./UefiFormatProbe.js");
  const prefix = Buffer.alloc(0x1000);
  prefix.write("_FVH", 0, "ascii");
  const image = Buffer.concat([prefix, buildFv({ files: [] }).buffer]);
  expect(admitUefiFlashImage(image, prefix.length)).toBe(false);
  expect(admitUefiFlashImage(image)).toBe(true);
});

it.each([false, true])(
  "keeps candidate bases outside a skipped FV (unsupported filesystem: %s)",
  (unsupported) => {
    const first = buildFv(
      unsupported
        ? { files: [], fileSystemGuid: "19111111-2222-3333-4444-555555555555" }
        : { files: [] },
    ).buffer;
    const later = buildFv({ files: [] }).buffer;
    const overlappingBase = first.length - 16;
    const siblingBase = overlappingBase + later.length;
    const image = Buffer.alloc(siblingBase + later.length);
    first.copy(image);
    later.copy(image, overlappingBase);
    later.copy(image, siblingBase);
    const discoveredBases = (buffer: Buffer): number[] =>
      scanFirmwareVolumes(imageRegion(buffer, 0, buffer.length), 8, {
        skipNested: !unsupported,
      }).volumes.map(({ header }) => header.absoluteBase);
    expect(discoveredBases(image)).toEqual([0, siblingBase]);
    expect(discoveredBases(Buffer.concat([first, later]))).toEqual([
      0,
      first.length,
    ]);
  },
);

it.each([
  { type: 1, mask: 0x80000001, length: 8, needs: "40 bytes" },
  { type: 1, mask: 0x80000001, length: 40, needs: null },
  { type: 2, mask: 0, length: 8, needs: "20 bytes" },
  { type: 2, mask: 0, length: 20, needs: null },
  { type: 0x8000, mask: 0, length: 8, needs: null },
])(
  "validates only the mandatory layout of FV extension type $type with $length bytes",
  ({ type, mask, length, needs }) => {
    const { buffer } = buildFv({ files: [], extendedHeader: "standalone" });
    buffer.writeUInt32LE(20 + length, 88);
    buffer.writeUInt16LE(length, 92);
    buffer.writeUInt16LE(type, 94);
    buffer.writeUInt32LE(mask, 96);
    const region = imageRegion(buffer, 0, buffer.length);
    const header = parseFirmwareVolumeHeader(region, 0);
    if (header === null) throw new Error("Expected an admitted FV");
    expect(header.implausibilities).toEqual([]);

    const issues = [
      ...inspectFirmwareVolumeExtension(
        region,
        header,
        () => true,
        () => {},
      ),
    ];
    expect(issues).toMatchObject(
      needs === null
        ? []
        : [
            {
              kind: "unparsed-region",
              offset: 92,
              length,
              detail: expect.stringContaining(needs),
            },
          ],
    );
  },
);
