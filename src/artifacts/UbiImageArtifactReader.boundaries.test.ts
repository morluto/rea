import { artifactPreparationRecoveryCases } from "../../tests/fixtures/artifactReaderLifecycle.js";
import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { finished } from "node:stream/promises";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import { UbiImageArtifactReader } from "./UbiImageArtifactReader.js";
import {
  twoVolumeUbiImage,
  ubiImage,
  ubiImageWithEmbeddedPebHeaders,
  ubiImageWithStaticGeometryEvidence,
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
      reason: "malformed",
      message: expect.stringContaining("is not a multiple"),
    });
  } finally {
    await reader.close();
  }
});

it("refuses to expose rootfs from a truncated dump with embedded PEB headers", async () => {
  const image = ubiImageWithEmbeddedPebHeaders();
  const reader = new UbiImageArtifactReader(
    await fixture(image.subarray(0, 73_728)),
  );
  try {
    await expect(entries(reader)).rejects.toMatchObject({
      reason: "malformed",
      message: expect.stringContaining("32768-byte eraseblock size"),
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
      reason: "malformed",
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
      reason: "malformed",
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
      reason: "malformed",
      message: expect.stringContaining("also fits a 32768-byte eraseblock"),
    });
  } finally {
    await reader.close();
  }
});

it("reads an eraseblock size whose volume table padding rules out a smaller one", async () => {
  // With alignment 10240 and data_pad 4096, 128 KiB (LEB 126976) matches
  // while every smaller divisor (64/32/16/8 KiB) requires different padding.
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
                alignment: 10_240,
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
      reason: "malformed",
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

it("reads no VID header past the eraseblock ceiling", async () => {
  const vidHeaderOffset = UBI_MAX_PEB_BYTES * 4;
  const path = await fixture(
    ubiImage([{ kind: "free" }], {
      vidHeaderOffset,
      dataOffset: vidHeaderOffset + 64,
    }),
  );
  await truncate(path, vidHeaderOffset + 4096);
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new UbiImageArtifactReader(path, admitted);
  const reads = vi.spyOn(admitted.handle, "read");
  try {
    await expect(entries(reader)).rejects.toMatchObject({
      reason: "limit",
      boundary: "capacity",
      parserLimit: { name: UBI_PEB_SIZE_LIMIT, maximum: UBI_MAX_PEB_BYTES },
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

it.each([
  { name: "closes the reader when a paused volume is cancelled", held: null },
  {
    name: "cancels a paused volume after a held read succeeds",
    held: "success",
  },
  {
    name: "preserves a paused volume's late EIO after cancellation",
    held: "failure",
  },
])("$name", async ({ held }) => {
  const wide = { pebSize: 128 * 1024, dataOffset: 4096 };
  const lebCount = 6;
  const layouts = ubiLayoutPebs(
    [{ id: 0, name: "rootfs", type: "static", reservedPebs: lebCount }],
    wide,
  );
  const lebs = Array.from({ length: lebCount }, (_, lnum) => ({
    kind: "leb" as const,
    volId: 0,
    lnum,
    data: Buffer.alloc(wide.pebSize - wide.dataOffset, 0x40 + lnum),
    sqnum: BigInt(lnum + 2),
    volType: "static" as const,
    usedEbs: lebCount,
  }));
  const path = await fixture(ubiImage([...layouts, ...lebs], wide));
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new UbiImageArtifactReader(path, admitted);
  const controller = new AbortController();
  const reason = new Error("cancel paused volume");
  const deadline = new AbortController();
  try {
    const [volume] = await entries(reader);
    let acknowledgeReadAhead!: () => void;
    const readAhead = new Promise<void>((resolve) => {
      acknowledgeReadAhead = resolve;
    });
    // The first LEB fills the paused output. Both chunks of the next LEB
    // are read ahead, one into each producer stream.
    const lastReadPosition = BigInt(
      (layouts.length + 1) * wide.pebSize + wide.dataOffset + 64 * 1024,
    );
    let releaseRead!: () => void;
    let rejectRead!: (cause: Error) => void;
    const heldRead = new Promise<void>((resolve, reject) => {
      releaseRead = resolve;
      rejectRead = reject;
    });
    const ioFailure = Object.assign(new Error("volume read failed"), {
      code: "EIO",
    });
    const nativeRead = admitted.handle.read.bind(admitted.handle);
    const read = vi.spyOn(admitted.handle, "read").mockImplementation((async (
      ...args: unknown[]
    ) => {
      const result = await Reflect.apply(nativeRead, admitted.handle, args);
      if (args[3] === lastReadPosition) {
        acknowledgeReadAhead();
        if (held !== null) await heldRead;
      }
      return result;
    }) as typeof admitted.handle.read);
    let stream: Awaited<ReturnType<UbiImageArtifactReader["open"]>> | undefined;
    try {
      const volumeStream = await reader.open(volume!, controller.signal);
      stream = volumeStream;
      const streamError = finished(volumeStream).catch(
        (cause: unknown) => cause,
      );
      volumeStream.once("data", () => volumeStream.pause());
      const failure = await Promise.race([
        (async () => {
          await readAhead;
          // Let the producer continuations publish the completed read and yield.
          await setImmediate(undefined, { signal: deadline.signal });
          expect(volumeStream.isPaused()).toBe(true);
          expect(volumeStream.readableLength).toBeGreaterThanOrEqual(
            volumeStream.readableHighWaterMark,
          );
          controller.abort(reason);
          if (held !== null) expect(volumeStream.destroyed).toBe(false);
          if (held === "failure") rejectRead(ioFailure);
          else releaseRead();
          await reader.close();
          return streamError;
        })(),
        delay(2000, undefined, { signal: deadline.signal }).then(() => {
          throw new Error(
            "Reader did not close after cancelling a paused volume",
          );
        }),
      ]);
      if (held === "failure") {
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure).toMatchObject({
          cause: ioFailure,
          errors: [ioFailure, { reason: "cancelled", cause: reason }],
        });
      } else {
        expect(failure).toMatchObject({ reason: "cancelled", cause: reason });
      }
    } finally {
      releaseRead();
      deadline.abort();
      stream?.destroy();
      try {
        await reader.close();
      } finally {
        read.mockRestore();
      }
    }
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
      reason: "malformed",
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

it("reads past nested EC headers no eraseblock could begin at", async () => {
  // The dump starts with a static LEB holding a nested header 64 KiB in, and
  // a dynamic LEB in PEB 2 starts with a nested image of 2 KiB eraseblocks,
  // whose headers lie 4096 and 6144 bytes into the 128 KiB eraseblock.
  const wide = { pebSize: 128 * 1024, dataOffset: 4096 };
  const lebBytes = wide.pebSize - wide.dataOffset;
  const records = [
    { id: 0, name: "kernel", type: "static" as const, reservedPebs: 1 },
    { id: 1, name: "rootfs", type: "dynamic" as const, reservedPebs: 1 },
  ];
  const kernel = Buffer.alloc(lebBytes, 0x4b);
  ubiImage([{ kind: "free" }], { pebSize: 64 * 1024, dataOffset: 2048 })
    .subarray(0, 64)
    .copy(kernel, 64 * 1024 - wide.dataOffset);
  const rootfs = Buffer.alloc(lebBytes, 0x52);
  ubiImage([{ kind: "free" }, { kind: "free" }]).copy(rootfs, 0);
  const reader = new UbiImageArtifactReader(
    await fixture(
      ubiImage(
        [
          {
            kind: "leb",
            volId: 0,
            lnum: 0,
            data: kernel,
            sqnum: 2n,
            volType: "static",
            usedEbs: 1,
          },
          ...ubiLayoutPebs(records, wide),
          { kind: "leb", volId: 1, lnum: 0, data: rootfs, sqnum: 3n },
        ],
        wide,
      ),
    ),
  );
  try {
    const volumes = await entries(reader);
    expect(volumes).toMatchObject([
      { declaredSize: lebBytes },
      { declaredSize: lebBytes },
    ]);
    expect((await buffer(await reader.open(volumes[0]!))).equals(kernel)).toBe(
      true,
    );
    expect((await buffer(await reader.open(volumes[1]!))).equals(rootfs)).toBe(
      true,
    );
  } finally {
    await reader.close();
  }
});

it("reads a first dynamic LEB holding a nested image", async () => {
  // Four 128 KiB eraseblocks; the nested image's header 6144 bytes in does
  // not divide the 524288-byte file, so it cannot be the eraseblock size.
  const wide = { pebSize: 128 * 1024, dataOffset: 4096 };
  const lebBytes = wide.pebSize - wide.dataOffset;
  const records = [
    { id: 0, name: "rootfs", type: "dynamic" as const, reservedPebs: 2 },
  ];
  const first = Buffer.alloc(lebBytes, 0x52);
  ubiImage([{ kind: "free" }, { kind: "free" }]).copy(first, 0);
  const second = Buffer.alloc(lebBytes, 0x53);
  const reader = new UbiImageArtifactReader(
    await fixture(
      ubiImage(
        [
          { kind: "leb", volId: 0, lnum: 0, data: first, sqnum: 2n },
          ...ubiLayoutPebs(records, wide),
          { kind: "leb", volId: 0, lnum: 1, data: second, sqnum: 3n },
        ],
        wide,
      ),
    ),
  );
  try {
    const volumes = await entries(reader);
    expect(volumes).toMatchObject([{ declaredSize: 2 * lebBytes }]);
    expect(
      (await buffer(await reader.open(volumes[0]!))).equals(
        Buffer.concat([first, second]),
      ),
    ).toBe(true);
  } finally {
    await reader.close();
  }
});

it("retries past a dividing 64 KiB EC header in a dynamic first LEB when the volume table rules out smaller sizes", async () => {
  const wide = { pebSize: 128 * 1024, dataOffset: 4096 };
  const usableLebBytes = wide.pebSize - wide.dataOffset - 4096;
  expect(usableLebBytes).toBe(122_880);
  const records = [
    {
      id: 0,
      name: "rootfs",
      type: "dynamic" as const,
      reservedPebs: 1,
      alignment: 10_240,
      dataPad: 4_096,
    },
  ];
  const rootfsData = Buffer.alloc(usableLebBytes, 0x52);
  ubiImage([{ kind: "free" }], wide)
    .subarray(0, 64)
    .copy(rootfsData, 64 * 1024 - wide.dataOffset);
  const rootfsLeb = {
    kind: "leb" as const,
    volId: 0,
    lnum: 0,
    data: rootfsData,
    sqnum: 2n,
    dataPad: 4_096,
  };
  const bytes = ubiImage([rootfsLeb, ...ubiLayoutPebs(records, wide)], wide);
  expect(bytes.length % (64 * 1024)).toBe(0);
  const reader = new UbiImageArtifactReader(await fixture(bytes));
  try {
    const volumes = await entries(reader);
    expect(reader.formatMetadata()).toMatchObject({
      peb_size: 131_072,
      peb_count: 3,
    });
    expect(volumes).toMatchObject([
      { path: "volumes/rootfs", declaredSize: 122_880 },
    ]);
    const reconstructed = await buffer(await reader.open(volumes[0]!));
    expect(reconstructed.length).toBe(122_880);
    expect(reconstructed.equals(rootfsData)).toBe(true);
  } finally {
    await reader.close();
  }
});

it.each([undefined, 7])(
  "reads both volumes past a nested 64 KiB EC header with image_seq override %s",
  async (imageSeq) => {
    const { bytes, wide, rootfsData, kernelData } =
      ubiImageWithStaticGeometryEvidence(imageSeq);
    const lebBytes = wide.pebSize - wide.dataOffset;
    expect(bytes.length).toBe(4 * wide.pebSize);
    const reader = new UbiImageArtifactReader(await fixture(bytes));
    try {
      const volumes = await entries(reader);
      expect(reader.formatMetadata()).toMatchObject({
        peb_size: 131_072,
        peb_count: 4,
        corrupt_peb_count: 0,
      });
      expect(volumes).toMatchObject([
        { path: "volumes/rootfs", declaredSize: lebBytes },
        { path: "volumes/kernel", declaredSize: lebBytes },
      ]);
      const rootfs = await buffer(await reader.open(volumes[0]!));
      expect(rootfs.equals(rootfsData)).toBe(true);
      const kernel = await buffer(await reader.open(volumes[1]!));
      expect(kernel.equals(kernelData)).toBe(true);
    } finally {
      await reader.close();
    }
  },
);

it("refuses a retry that would swallow neighboring eraseblock boundaries inside layout PEBs", async () => {
  const g = { pebSize: 64 * 1024, dataOffset: 4096 };
  const records = [
    {
      id: 0,
      name: "rootfs",
      type: "dynamic" as const,
      reservedPebs: 1,
      alignment: 10_240,
      dataPad: 4_096,
    },
  ];
  const [layout0, layout1] = ubiLayoutPebs(records, g);
  const bytes = ubiImage(
    [
      layout0!,
      { kind: "free" },
      layout1!,
      { kind: "free" },
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        data: Buffer.alloc(g.pebSize - g.dataOffset - 4096, 0x52),
        sqnum: 2n,
        dataPad: 4096,
      },
      { kind: "free" },
    ],
    g,
  );
  const reader = new UbiImageArtifactReader(await fixture(bytes));
  try {
    await expect(entries(reader)).rejects.toMatchObject({
      reason: "malformed",
      message: expect.stringContaining("no valid volume table"),
    });
  } finally {
    await reader.close();
  }
});

it("reads a dynamic first LEB holding a nested mapped image with matching headers", async () => {
  const wide = { pebSize: 128 * 1024, dataOffset: 4096 };
  const lebBytes = wide.pebSize - wide.dataOffset;
  const records = [
    { id: 0, name: "rootfs", type: "dynamic" as const, reservedPebs: 2 },
  ];
  const narrow = { pebSize: 32 * 1024, dataOffset: 4096 };
  const nested = ubiImage(
    [
      { kind: "leb", volId: 0, lnum: 0, data: Buffer.alloc(100, 1), sqnum: 1n },
      { kind: "leb", volId: 0, lnum: 1, data: Buffer.alloc(100, 2), sqnum: 2n },
    ],
    narrow,
  );
  const first = Buffer.alloc(lebBytes, 0x52);
  nested.copy(first, 0);
  const second = Buffer.alloc(lebBytes, 0x53);
  const bytes = ubiImage(
    [
      { kind: "leb", volId: 0, lnum: 0, data: first, sqnum: 2n },
      ...ubiLayoutPebs(records, wide),
      { kind: "leb", volId: 0, lnum: 1, data: second, sqnum: 3n },
    ],
    wide,
  );
  const reader = new UbiImageArtifactReader(await fixture(bytes));
  try {
    const volumes = await entries(reader);
    expect(reader.formatMetadata()).toMatchObject({
      peb_size: wide.pebSize,
      peb_count: 4,
    });
    expect(volumes).toMatchObject([
      { path: "volumes/rootfs", declaredSize: 2 * lebBytes },
    ]);
    expect(
      (await buffer(await reader.open(volumes[0]!))).equals(
        Buffer.concat([first, second]),
      ),
    ).toBe(true);
  } finally {
    await reader.close();
  }
});

it("counts a corrupt oversized data_pad on PEB 0 instead of skipping the real PEB boundary", async () => {
  const wide = { pebSize: 128 * 1024, dataOffset: 4096 };
  const lebBytes = wide.pebSize - wide.dataOffset;
  const configData = Buffer.from("CONFIG", "latin1");
  const records = [
    { id: 0, name: "config", type: "static" as const, reservedPebs: 1 },
  ];
  const bytes = ubiImage(
    [
      {
        kind: "leb",
        volId: 1,
        lnum: 0,
        data: Buffer.alloc(lebBytes, 0x50),
        sqnum: 1n,
        dataPad: 131_072,
      },
      ...ubiLayoutPebs(records, wide),
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        data: configData,
        sqnum: 2n,
        volType: "static",
        usedEbs: 1,
      },
    ],
    wide,
  );
  const reader = new UbiImageArtifactReader(await fixture(bytes));
  try {
    const volumes = await entries(reader);
    expect(reader.formatMetadata()).toMatchObject({
      peb_size: wide.pebSize,
      peb_count: 4,
      corrupt_peb_count: 1,
    });
    expect(volumes).toMatchObject([
      { path: "volumes/config", declaredSize: configData.length },
    ]);
    const extracted = await buffer(await reader.open(volumes[0]!));
    expect(extracted.equals(configData)).toBe(true);
  } finally {
    await reader.close();
  }
});
