import { collectEntries } from "../../tests/fixtures/artifactEntries.js";
import { writeFile } from "node:fs/promises";
import { buffer } from "node:stream/consumers";

import { expect, it, vi } from "vitest";

import { AndroidBootImageArtifactReader } from "./AndroidBootImageArtifactReader.js";
import {
  artifactFixedLimitFailure,
  malformedArtifact,
} from "../resources/index.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import {
  buildBootImage,
  buildVendorBootImage,
} from "../../tests/fixtures/androidBootImage.js";
import { artifactReaderLifecycleCases } from "../../tests/fixtures/artifactReaderLifecycle.js";
import { createTestTempFile } from "../../tests/fixtures/temporaryDirectory.js";

const fixture = (bytes: Buffer): Promise<string> =>
  createTestTempFile("rea-android-boot-boundary-", "image", bytes);

it("does not publish preparation metadata or coverage after carrier mutation", async () => {
  const bytes = buildBootImage({ version: 0 });
  const path = await fixture(bytes);
  class ChangedDuringPreparation extends AndroidBootImageArtifactReader {
    protected override async prepareEntries(signal?: AbortSignal) {
      const prepared = await super.prepareEntries(signal);
      await writeFile(path, Buffer.concat([bytes, Buffer.from([0])]));
      return prepared;
    }
  }
  const reader = new ChangedDuringPreparation(path);
  const onCoverage = vi.fn();
  let yielded = 0;
  try {
    await expect(
      (async () => {
        for await (const _entry of reader.entries(undefined, { onCoverage }))
          yielded += 1;
      })(),
    ).rejects.toMatchObject({ reason: "integrity" });
    expect(yielded).toBe(0);
    expect(onCoverage).not.toHaveBeenCalled();
    expect(reader.formatMetadata()).toBeUndefined();
  } finally {
    await reader.close();
  }
});

it.each(["invalid", "cancelled"] as const)(
  "retries a first %s preparation without publishing its metadata",
  async (mode) => {
    const path = await fixture(buildBootImage({ version: 0 }));
    const controller = new AbortController();
    let refuse = true;
    class InterruptedPreparation extends AndroidBootImageArtifactReader {
      protected override async prepareEntries(signal?: AbortSignal) {
        const prepared = await super.prepareEntries(signal);
        if (refuse) {
          refuse = false;
          if (mode === "invalid")
            throw malformedArtifact(
              "android-boot-image",
              "injected preparation failure",
            );
          controller.abort(new Error("cancel final preparation validation"));
        }
        return prepared;
      }
    }
    const reader = new InterruptedPreparation(path);
    try {
      const onCoverage = vi.fn();
      await expect(
        (async () => {
          for await (const _entry of reader.entries(controller.signal, {
            onCoverage,
          })) {
            throw new Error("Failed preparation yielded an entry");
          }
        })(),
      ).rejects.toMatchObject({
        reason: mode === "invalid" ? "malformed" : "cancelled",
      });
      expect(onCoverage).not.toHaveBeenCalled();
      expect(reader.formatMetadata()).toBeUndefined();
      expect(await collectEntries(reader)).toHaveLength(2);
      expect(reader.formatMetadata()).toMatchObject({
        header_version: 0,
        component_count: 2,
      });
    } finally {
      await reader.close();
    }
  },
);

it("preserves cancellation during header admission", async () => {
  const path = await fixture(buildBootImage({ version: 0 }));
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new AndroidBootImageArtifactReader(path, admitted);
  const controller = new AbortController();
  const reason = new Error("cancel header admission");
  const nativeRead = admitted.handle.read.bind(admitted.handle);
  const reads = vi.spyOn(admitted.handle, "read").mockImplementation((async (
    ...args: unknown[]
  ) => {
    const result = await Reflect.apply(nativeRead, admitted.handle, args);
    if (args[3] === 0) controller.abort(reason);
    return result;
  }) as typeof admitted.handle.read);
  try {
    await expect(
      (async () => {
        for await (const _entry of reader.entries(controller.signal)) {
          /* Exhaust the admitted operation. */
        }
      })(),
    ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
  } finally {
    await reader.close();
    reads.mockRestore();
    await admitted.handle.close();
  }
});

const vendorBootWithRamdisks = (count: number): Buffer =>
  buildVendorBootImage({
    version: 4,
    ramdisks: Array.from({ length: count }, (_, index) => ({
      name: `ramdisk${String(index)}`,
      bytes: Buffer.from([index & 0xff]),
    })),
  });

it("inventories a vendor ramdisk table at its 4096-entry allowance", async () => {
  const path = await fixture(vendorBootWithRamdisks(4096));
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new AndroidBootImageArtifactReader(path, admitted);
  try {
    const listed = await collectEntries(reader);
    expect(
      listed.filter((entry) => entry.path.startsWith("vendor_ramdisk")),
    ).toHaveLength(4096);
  } finally {
    await reader.close();
    await admitted.handle.close();
  }
});

it("rejects an excessive vendor ramdisk count before reading the table", async () => {
  const path = await fixture(vendorBootWithRamdisks(4097));
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new AndroidBootImageArtifactReader(path, admitted);
  const reads = vi.spyOn(admitted.handle, "read");
  try {
    const failure: unknown = await collectEntries(reader).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    // The limit's facts and the recovery its owning formatter produces.
    expect(failure).toMatchObject({
      reason: "limit",
      boundary: "capacity",
      fixedAllowance: artifactFixedLimitFailure(
        {
          name: "Android vendor ramdisk table entry count",
          kind: "parser",
          limit: 4096,
          unit: "entries",
        },
        "table count",
      ).fixedAllowance,
      cause: {
        kind: "limit",
        failure: { limit: { maximum: 4096 } },
      },
    });
    expect(reads).toHaveBeenCalledTimes(1);
  } finally {
    await reader.close();
    reads.mockRestore();
    await admitted.handle.close();
  }
});

it("reports a truncated vendor ramdisk table above the count allowance without reading its rows", async () => {
  const image = vendorBootWithRamdisks(4097);
  // One header page and two pages of 1-byte ramdisks precede 4097 108-byte rows.
  const tableEnd = 3 * 4096 + 4097 * 108;
  const path = await fixture(image.subarray(0, tableEnd - 1));
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new AndroidBootImageArtifactReader(path, admitted);
  const reads = vi.spyOn(admitted.handle, "read");
  try {
    await expect(collectEntries(reader)).rejects.toMatchObject({
      reason: "truncated",
      cause: {
        kind: "truncated",
        failure: { field: "components", offset: tableEnd - 1 },
      },
    });
    expect(reads).toHaveBeenCalledTimes(1);
  } finally {
    await reader.close();
    reads.mockRestore();
    await admitted.handle.close();
  }
});

artifactReaderLifecycleCases({
  image: () => buildBootImage({ version: 0 }),
  createReader: (path, admitted) =>
    new AndroidBootImageArtifactReader(path, admitted),
});

it("rejects a source changed after its header was prepared", async () => {
  const bytes = buildBootImage({ version: 0 });
  const path = await fixture(bytes);
  const reader = new AndroidBootImageArtifactReader(path);
  try {
    const [entry] = await collectEntries(reader);
    await writeFile(path, Buffer.concat([bytes, Buffer.from([0])]));
    await expect(reader.open(entry!)).rejects.toMatchObject({
      reason: "integrity",
    });
  } finally {
    await reader.close();
  }
});

it("checks a multi-chunk member and preserves read cancellation", async () => {
  const kernel = Buffer.alloc(128 * 1024, 0x61);
  const bytes = buildBootImage({
    version: 0,
    kernel,
    ramdisk: Buffer.alloc(0),
  });
  const reader = new AndroidBootImageArtifactReader(await fixture(bytes));
  try {
    const [entry] = await collectEntries(reader);
    const controller = new AbortController();
    const reason = new Error("cancel member bytes");
    const stream = await reader.open(entry!, controller.signal);
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort(reason);
    await expect(iterator.next()).rejects.toMatchObject({
      reason: "cancelled",
      cause: reason,
    });
    expect((await buffer(await reader.open(entry!))).equals(kernel)).toBe(true);
  } finally {
    await reader.close();
  }
});
