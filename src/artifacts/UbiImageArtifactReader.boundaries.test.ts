import { artifactPreparationRecoveryCases } from "../../tests/fixtures/artifactReaderLifecycle.js";
import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import { UbiImageArtifactReader } from "./UbiImageArtifactReader.js";
import {
  twoVolumeUbiImage,
  ubiImage,
  ubiLayoutPebs,
} from "../domain/firmware/ubiImage.fixture.js";
import {
  UBI_MAX_PEB_BYTES,
  UBI_MAX_PEBS,
  UBI_PEB_COUNT_LIMIT,
  UBI_PEB_SIZE_LIMIT,
} from "../domain/firmware/ubiImage.js";

const fixture = async (bytes: Buffer): Promise<string> => {
  const path = join(
    await createTestTempDirectory("rea-ubi-image-boundary-"),
    "nand.ubi",
  );
  await writeFile(path, bytes);
  return path;
};

const entries = async (reader: UbiImageArtifactReader) => {
  const result = [];
  for await (const entry of reader.entries()) result.push(entry);
  return result;
};

it("refuses a PEB size that does not divide the file as a format failure", async () => {
  const image = twoVolumeUbiImage();
  const reader = new UbiImageArtifactReader(
    await fixture(image.subarray(0, image.length - 512)),
  );
  try {
    await expect(entries(reader)).rejects.toMatchObject({
      reason: "format",
      message: expect.stringContaining("is not a multiple"),
    });
  } finally {
    await reader.close();
  }
});

it("refuses a header layout change between eraseblocks", async () => {
  const image = Buffer.concat([
    twoVolumeUbiImage().subarray(0, 4096),
    ubiImage([{ kind: "free" }], { vidHeaderOffset: 512, dataOffset: 1024 }),
  ]);
  const reader = new UbiImageArtifactReader(await fixture(image));
  try {
    await expect(entries(reader)).rejects.toMatchObject({
      reason: "format",
    });
  } finally {
    await reader.close();
  }
});

it("refuses an eraseblock size measured across a skipped eraseblock", async () => {
  const [layout0, layout1] = ubiLayoutPebs([
    { id: 0, name: "rootfs", type: "dynamic", reservedPebs: 1 },
  ]);
  const reader = new UbiImageArtifactReader(
    await fixture(
      ubiImage([layout0!, { kind: "erased" }, layout1!, { kind: "free" }]),
    ),
  );
  try {
    await expect(entries(reader)).rejects.toMatchObject({
      reason: "format",
      message: expect.stringContaining("eraseblock size is ambiguous"),
    });
  } finally {
    await reader.close();
  }
});

it("refuses an eraseblock size that also fits with erased eraseblocks between", async () => {
  const geometry = { pebSize: 32 * 1024 };
  const [layout0, layout1] = ubiLayoutPebs(
    [{ id: 0, name: "rootfs", type: "dynamic", reservedPebs: 1 }],
    geometry,
  );
  const reader = new UbiImageArtifactReader(
    await fixture(
      ubiImage(
        [
          layout0!,
          { kind: "erased" },
          layout1!,
          { kind: "erased" },
          {
            kind: "leb",
            volId: 0,
            lnum: 0,
            data: Buffer.from("ROOTFS"),
            sqnum: 2n,
          },
          { kind: "erased" },
        ],
        geometry,
      ),
    ),
  );
  try {
    await expect(entries(reader)).rejects.toMatchObject({
      reason: "format",
      message: expect.stringContaining("also fits a 32768-byte eraseblock"),
    });
  } finally {
    await reader.close();
  }
});

it("reads an eraseblock size whose volume table padding rules out a smaller one", async () => {
  // Under 64 KiB eraseblocks alignment 6144 would pad nothing, so this
  // table's data_pad of 4096 fits only the 128 KiB size.
  const geometry = {
    pebSize: 128 * 1024,
    vidHeaderOffset: 2048,
    dataOffset: 4096,
  };
  const reader = new UbiImageArtifactReader(
    await fixture(
      ubiImage(
        [
          ...ubiLayoutPebs(
            [
              {
                id: 0,
                name: "rootfs",
                type: "dynamic",
                reservedPebs: 1,
                alignment: 6144,
                dataPad: 4096,
              },
            ],
            geometry,
          ),
          {
            kind: "leb",
            volId: 0,
            lnum: 0,
            data: Buffer.from("ROOTFS"),
            sqnum: 2n,
            dataPad: 4096,
          },
        ],
        geometry,
      ),
    ),
  );
  try {
    expect(await entries(reader)).toHaveLength(1);
  } finally {
    await reader.close();
  }
});

it("refuses two copies of one LEB that share a sequence number", async () => {
  const records = [
    { id: 0, name: "rootfs", type: "dynamic" as const, reservedPebs: 1 },
  ];
  const copy = (fill: number) => ({
    kind: "leb" as const,
    volId: 0,
    lnum: 0,
    data: Buffer.alloc(16, fill),
    sqnum: 2n,
  });
  const reader = new UbiImageArtifactReader(
    await fixture(ubiImage([...ubiLayoutPebs(records), copy(1), copy(2)])),
  );
  try {
    await expect(entries(reader)).rejects.toMatchObject({
      reason: "format",
      message: expect.stringContaining("so neither copy is newer"),
    });
  } finally {
    await reader.close();
  }
});

it("reads eraseblocks whose image sequence is zero alongside a nonzero one", async () => {
  const records = [
    { id: 0, name: "rootfs", type: "dynamic" as const, reservedPebs: 1 },
  ];
  const [layout0, layout1] = ubiLayoutPebs(records);
  const reader = new UbiImageArtifactReader(
    await fixture(
      Buffer.concat([
        ubiImage([layout0!, { kind: "free" }], { imageSeq: 0 }),
        ubiImage([layout1!]),
      ]),
    ),
  );
  try {
    expect((await entries(reader)).map((entry) => entry.path)).toEqual([
      "volumes/rootfs",
    ]);
    expect(reader.formatMetadata()).toMatchObject({
      peb_size: 2048,
      peb_count: 3,
      image_seq: 0x1234_5678,
    });
  } finally {
    await reader.close();
  }
});

it("stops the eraseblock search at the fixed ceiling", async () => {
  const path = await fixture(ubiImage([{ kind: "free" }]));
  await truncate(path, UBI_MAX_PEB_BYTES * 2);
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new UbiImageArtifactReader(path, admitted);
  const reads = vi.spyOn(admitted.handle, "read");
  try {
    await expect(entries(reader)).rejects.toMatchObject({
      reason: "limit",
      boundary: "capacity",
      parserLimit: { name: UBI_PEB_SIZE_LIMIT, maximum: UBI_MAX_PEB_BYTES },
      fixedAllowance: {
        kind: "parser",
        name: `The ${UBI_PEB_SIZE_LIMIT} allowance`,
        limit: UBI_MAX_PEB_BYTES,
        unit: "bytes",
      },
    });
    for (const [, , length, offset] of reads.mock
      .calls as readonly (readonly unknown[])[])
      expect(Number(length) + Number(offset)).toBeLessThanOrEqual(
        UBI_MAX_PEB_BYTES + 64,
      );
  } finally {
    reads.mockRestore();
    await reader.close();
    await admitted.handle.close();
  }
});

it("names the eraseblock count ceiling it stops at", async () => {
  const path = await fixture(ubiImage([{ kind: "free" }, { kind: "free" }]));
  await truncate(path, 2048 * (UBI_MAX_PEBS + 1));
  const reader = new UbiImageArtifactReader(path);
  try {
    await expect(entries(reader)).rejects.toMatchObject({
      reason: "limit",
      boundary: "capacity",
      parserLimit: {
        name: UBI_PEB_COUNT_LIMIT,
        maximum: UBI_MAX_PEBS,
        required: UBI_MAX_PEBS + 1,
      },
      fixedAllowance: {
        kind: "parser",
        name: `The ${UBI_PEB_COUNT_LIMIT} allowance`,
        limit: UBI_MAX_PEBS,
        unit: "eraseblocks",
      },
    });
  } finally {
    await reader.close();
  }
});

it("preserves cancellation while streaming a volume", async () => {
  const path = await fixture(twoVolumeUbiImage());
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new UbiImageArtifactReader(path, admitted);
  const controller = new AbortController();
  const reason = new Error("cancel volume");
  try {
    const listed = await entries(reader);
    const rootfs = listed.find((entry) => entry.path === "volumes/rootfs")!;
    const stream = await reader.open(rootfs, controller.signal);
    controller.abort(reason);
    await expect(buffer(stream)).rejects.toMatchObject({
      reason: "cancelled",
      cause: reason,
    });
    const recovered = await buffer(await reader.open(rootfs));
    expect(recovered.subarray(0, 8).toString("latin1")).toBe("ROOTFS-0");
  } finally {
    await reader.close();
    await admitted.handle.close();
  }
});

artifactPreparationRecoveryCases({
  image: () => twoVolumeUbiImage(),
  createReader: (path, admitted) => new UbiImageArtifactReader(path, admitted),
});

it("refuses a header on a smaller eraseblock grid beyond the spacing check", async () => {
  const records = [
    { id: 0, name: "rootfs", type: "dynamic" as const, reservedPebs: 4 },
  ];
  const [layout0, layout1] = ubiLayoutPebs(records);
  const erased = { kind: "erased" as const };
  const leb = (lnum: number) => ({
    kind: "leb" as const,
    volId: 0,
    lnum,
    data: Buffer.alloc(1920, 0x30 + lnum),
    sqnum: BigInt(lnum + 2),
  });
  const reader = new UbiImageArtifactReader(
    await fixture(
      ubiImage([
        layout0!,
        erased,
        layout1!,
        erased,
        leb(0),
        erased,
        erased,
        erased,
        erased,
        erased,
        leb(1),
        { kind: "free" },
      ]),
    ),
  );
  try {
    await expect(entries(reader)).rejects.toMatchObject({
      reason: "format",
      message: expect.stringContaining(
        "erase-counter header at offset 22528 contradicts the 4096-byte eraseblock size",
      ),
    });
  } finally {
    await reader.close();
  }
});

it("reads a static volume whose payload holds EC headers no smaller LEB could hold", async () => {
  // A nested UBI image in full 126976-byte static LEBs puts valid headers on
  // the 64 KiB grid inside and the 32 KiB grid beyond the spacing check.
  const wide = { pebSize: 128 * 1024, dataOffset: 4096 };
  const lebBytes = wide.pebSize - wide.dataOffset;
  const nestedHeader = ubiImage([{ kind: "free" }], wide).subarray(0, 64);
  const records = [
    { id: 0, name: "nested", type: "static" as const, reservedPebs: 6 },
  ];
  const lebs = Array.from({ length: 6 }, (_, lnum) => {
    const data = Buffer.alloc(lebBytes, 0x40 + lnum);
    if (lnum === 0) nestedHeader.copy(data, 64 * 1024 - wide.dataOffset);
    if (lnum === 5) nestedHeader.copy(data, 32 * 1024 - wide.dataOffset);
    return {
      kind: "leb" as const,
      volId: 0,
      lnum,
      data,
      sqnum: BigInt(lnum + 2),
      volType: "static" as const,
      usedEbs: 6,
    };
  });
  const reader = new UbiImageArtifactReader(
    await fixture(ubiImage([...ubiLayoutPebs(records, wide), ...lebs], wide)),
  );
  try {
    const [volume] = await entries(reader);
    expect(volume).toMatchObject({ declaredSize: 6 * lebBytes });
    const bytes = await buffer(await reader.open(volume!));
    expect(bytes.equals(Buffer.concat(lebs.map((leb) => leb.data)))).toBe(true);
  } finally {
    await reader.close();
  }
});
