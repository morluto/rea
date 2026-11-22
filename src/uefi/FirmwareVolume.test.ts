import { Buffer } from "node:buffer";
import { expect, it } from "vitest";

import { buildFv } from "../../tests/fixtures/uefiImage.js";
import { imageRegion } from "./UefiBytes.js";
import {
  inspectFirmwareVolumeExtension,
  parseFirmwareVolumeHeader,
  scanFirmwareVolumes,
} from "./FirmwareVolume.js";

it("observes valid volume geometry and retains the header after checksum corruption", () => {
  const { buffer } = buildFv({ files: [] });
  const region = imageRegion(buffer, 0, buffer.length);
  expect(parseFirmwareVolumeHeader(region, 0)).toMatchObject({
    declaredLength: 0x1000,
    headerLength: 72,
    attributes: 0x800,
    erasePolarity: true,
    revision: 2,
    checksumValid: true,
    fileSystemGuid: "8c8ce578-8a3d-4f1c-9935-896185c32dd3",
    blockMap: [{ numBlocks: 1, blockLength: 0x1000 }],
  });

  buffer[55] = 3; // revision byte is covered by the header checksum
  expect(parseFirmwareVolumeHeader(region, 0)).toMatchObject({
    revision: 3,
    checksumValid: false,
  });
});

it("returns null when the signature is absent", () => {
  const region = imageRegion(Buffer.alloc(64, 0x11), 0, 64);
  expect(parseFirmwareVolumeHeader(region, 0)).toBeNull();
});

it("counts both accepted and rejected volume candidates toward the scan cap", () => {
  const { buffer } = buildFv({ files: [] });
  const garbage = Buffer.alloc(0x1000, 0x41);
  garbage.write("_FVH", 40, "ascii");
  const image = Buffer.concat([buffer, garbage, buffer]);
  const region = imageRegion(image, 0, image.length);
  const first = { header: { absoluteBase: 0 } };
  const second = { header: { absoluteBase: 0x2000 } };
  const rejected = [
    {
      absoluteBase: 0x1000,
      signatureLocal: 0x1028,
      reason: "header-unparseable",
    },
  ];

  expect(scanFirmwareVolumes(region, 16)).toMatchObject({
    volumes: [first, second],
    rejected,
    limit: null,
  });
  expect(scanFirmwareVolumes(region, 2)).toMatchObject({
    volumes: [first],
    rejected,
    limit: "candidates",
  });
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
