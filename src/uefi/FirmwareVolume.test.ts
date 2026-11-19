import { Buffer } from "node:buffer";
import { expect, it } from "vitest";

import {
  buildFv,
  buildImage,
  buildFfsFile,
} from "../../tests/fixtures/uefiImage.js";
import { imageRegion } from "./UefiBytes.js";
import {
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
