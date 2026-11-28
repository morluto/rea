import { artifactPreparationRecoveryCases } from "../../tests/fixtures/artifactReaderLifecycle.js";
import { getEventListeners, once } from "node:events";
import { mkdir, readFile, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { setImmediate } from "node:timers/promises";

import { expect, it, vi } from "vitest";

import { FitArtifactReader } from "./FitArtifactReader.js";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../resources/ArtifactReader.js";
import { extractArtifact } from "./extraction/ArtifactExtraction.js";
import * as fitStructure from "./fit/FitStructure.js";
import * as fileChunks from "../filesystem/readFileHandleChunks.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import {
  FIT_DEVICETREE,
  FIT_EMBEDDED,
  FIT_EXTERNAL,
  FIT_KERNEL,
  fitFixture,
} from "./fit/FitImage.fixture.js";
import {
  cells,
  devicetreeFixture,
  dtString,
} from "../domain/firmware/devicetree.fixture.js";
import {
  createTestTempDirectory,
  createTestTempFile,
} from "../../tests/fixtures/temporaryDirectory.js";
import { renameOpenParent } from "../../tests/fixtures/renameOpenParent.js";
import { phaseGate } from "../../tests/support/lifecycleHarness.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import { ArtifactFileSource } from "../resources/index.js";

const MIB = 1024 * 1024;

const writeFit = (name: string, bytes: Buffer): Promise<string> =>
  createTestTempFile("rea-fit-", name, bytes);

const withTotalsize = (bytes: Buffer, totalsize: number): Buffer => {
  const copy = Buffer.from(bytes);
  copy.writeUInt32BE(totalsize, 4);
  return copy;
};

const LARGE_FIT = fitFixture({
  images: [{ name: "kernel", data: Buffer.alloc(MIB, 7), hashes: ["sha256"] }],
  mode: "offset",
});

const firstEntry = async (reader: FitArtifactReader) => {
  const { value: entry } = await reader
    .entries()
    [Symbol.asyncIterator]()
    .next();
  if (entry === undefined) throw new Error("Missing FIT image");
  return entry;
};

it.each(["close", "cancel"] as const)(
  "refuses to finish a paused FIT inventory after %s",
  async (action) => {
    const reader = new FitArtifactReader(
      await writeFit("paused-inventory.itb", FIT_EXTERNAL),
    );
    const controller = new AbortController();
    const reason = { stage: "after final entry" };
    const iterator = reader.entries(controller.signal)[Symbol.asyncIterator]();
    try {
      expect((await iterator.next()).done).toBe(false);
      expect((await iterator.next()).done).toBe(false);
      if (action === "close") await reader.close();
      else controller.abort(reason);
      const failure: unknown = await iterator.next().then(
        () => {
          throw new Error("Expected the paused inventory to fail");
        },
        (cause: unknown) => cause,
      );
      expect(failure).toMatchObject(
        action === "close"
          ? { reason: "unavailable" }
          : { reason: "cancelled" },
      );
      if (action === "cancel") {
        if (!(failure instanceof ArtifactReaderFailure)) throw failure;
        expect(failure.cause).toBe(reason);
      }
    } finally {
      await reader.close();
    }
  },
);

it.each([
  ["embedded", FIT_EMBEDDED, "embedded"],
  ["external", FIT_EXTERNAL, "data-offset"],
] as const)(
  "inventories %s FIT images with root and image facts",
  async (_mode, bytes, dataSource) => {
    const snapshot = await scanCanonicalArtifactInventory(
      await writeFit("boot.itb", bytes),
    );
    expect(snapshot.manifest.root_format).toBe("fit");
    expect(snapshot.coverage).toMatchObject({
      scope: "container-entries",
      status: "complete",
    });
    expect(
      snapshot.limitations.some((limitation) =>
        limitation.startsWith("FIT inventory"),
      ),
    ).toBe(true);
    const root = snapshot.occurrences.find((row) => row.logical_path === ".");
    expect(root).toMatchObject({
      artifact_kind: "container",
      format_metadata: {
        kind: "fit",
        fdt_version: 17,
        description: "Test FIT",
        timestamp: 1_700_000_000,
        address_cells: 1,
        default_configuration: "conf-1",
        configurations: [
          {
            name: "conf-1",
            description: "Boot Linux",
            kernel: ["kernel"],
            fdt: ["fdt-1"],
            signature_algorithms: ["sha256,rsa2048"],
          },
        ],
      },
    });
    const kernel = snapshot.occurrences.find(
      (row) => row.logical_path === "images/kernel.bin",
    );
    const devicetree = snapshot.occurrences.find(
      (row) => row.logical_path === "images/fdt-1.bin",
    );
    expect(snapshot.occurrences).toHaveLength(3);
    for (const [row, data] of [
      [kernel, FIT_KERNEL],
      [devicetree, FIT_DEVICETREE],
    ] as const) {
      const offset = row?.source_location?.offset ?? -1;
      expect(row?.declared_size).toBe(data.length);
      expect(bytes.subarray(offset, offset + data.length).equals(data)).toBe(
        true,
      );
    }
    expect(kernel?.format_metadata).toMatchObject({
      kind: "fit-image",
      name: "kernel",
      type: "kernel",
      arch: "arm64",
      load: "0x40200000",
      entry: "0x40200000",
      data_source: dataSource,
      hashes_verified: 6,
      hashes_unverified: 0,
    });
    expect(devicetree?.format_metadata).toMatchObject({
      kind: "fit-image",
      type: "flat_dt",
      hashes_verified: 1,
    });
  },
);

it.each(["crc32", "md5", "sha1", "sha256", "sha384", "sha512"])(
  "fails a %s hash mismatch naming the image, node and algorithm",
  async (algo) => {
    const bytes = fitFixture({
      images: [{ name: "kernel", data: FIT_KERNEL, hashes: [algo] }],
      mode: "offset",
    });
    const kernel = bytes.indexOf(FIT_KERNEL);
    bytes[kernel + 10] = (bytes[kernel + 10] ?? 0) ^ 1;
    await expect(
      scanCanonicalArtifactInventory(await writeFit("bad.itb", bytes)),
    ).rejects.toMatchObject({
      reason: "integrity",
      integrityCheck: "declared-digest",
      message: expect.stringMatching(
        new RegExp(
          `^FIT image kernel hash-1 ${algo} does not match: declared [0-9a-f]+, computed [0-9a-f]+$`,
          "u",
        ),
      ),
    });
  },
);

it.each(["crc32", "md5", "sha1", "sha256", "sha384", "sha512"])(
  "emits FIT images and records %s hash mismatch under record-and-continue",
  async (algo) => {
    const bytes = fitFixture({
      images: [
        { name: "kernel", data: FIT_KERNEL, hashes: [algo] },
        { name: "fdt-1", data: FIT_DEVICETREE, hashes: ["sha256"] },
      ],
      mode: "offset",
    });
    const kernelOffset = bytes.indexOf(FIT_KERNEL);
    bytes[kernelOffset + 10] = (bytes[kernelOffset + 10] ?? 0) ^ 1;
    const snapshot = await scanCanonicalArtifactInventory(
      await writeFit(`bad-${algo}.itb`, bytes),
      { integrity: "record-and-continue" },
    );
    expect(snapshot.manifest.root_format).toBe("fit");
    expect(
      snapshot.occurrences
        .filter((row) => row.logical_path !== ".")
        .map((row) => row.logical_path)
        .sort(),
    ).toEqual(["images/fdt-1.bin", "images/kernel.bin"]);
    const kernel = snapshot.occurrences.find(
      (row) => row.logical_path === "images/kernel.bin",
    );
    expect(kernel?.format_metadata).toMatchObject({
      kind: "fit-image",
      name: "kernel",
      hashes_verified: 0,
    });
    expect(kernel?.limitations.join(" ")).toMatch(
      new RegExp(`FIT image kernel hash-1 ${algo} does not match`, "u"),
    );
    expect(snapshot.limitations.join(" ")).toMatch(
      new RegExp(`FIT image kernel hash-1 ${algo} does not match`, "u"),
    );
    if (algo === "sha256" || algo === "md5") {
      expect(kernel?.hash_status).toBe("mismatched");
      expect(snapshot.integrity_contradictions).toEqual([
        expect.objectContaining({ logical_path: "images/kernel.bin" }),
      ]);
    }
  },
);

it.each([
  ["embedded", FIT_EMBEDDED],
  ["external", FIT_EXTERNAL],
] as const)(
  "extracts byte-exact %s images that re-inventory as raw files",
  async (_mode, bytes) => {
    const path = await writeFit("boot.itb", bytes);
    const resourceScope = new ArtifactResourceScope();
    try {
      const extracted = await extractArtifact({
        inputPath: path,
        inputFormat: "fit",
        outputRoot: join(path, "..", "out"),
        environment: process.env,
        integrityPolicy: "fail",
        resourceScope,
      });
      expect(extracted.containment_verified).toBe(true);
      for (const [name, data] of [
        ["kernel.bin", FIT_KERNEL],
        ["fdt-1.bin", FIT_DEVICETREE],
      ] as const)
        expect(
          Buffer.compare(
            await readFile(join(extracted.output_root, "images", name)),
            data,
          ),
        ).toBe(0);
      const reinventoried = await scanCanonicalArtifactInventory(
        extracted.output_root,
      );
      expect(
        reinventoried.occurrences
          .filter((row) => row.entry_kind === "file")
          .map((row) => [row.logical_path, row.artifact_format])
          .sort(),
      ).toEqual([
        // The stored flat_dt image is a devicetree in its own right.
        ["images/fdt-1.bin", "devicetree"],
        ["images/kernel.bin", "file"],
      ]);
    } finally {
      await resourceScope.close();
    }
  },
);

it("inventories an external-data FIT larger than 16 MiB", async () => {
  const bytes = fitFixture({
    images: [
      {
        name: "rootfs",
        data: Buffer.alloc(0),
        properties: { "data-offset": cells(17 * MIB), "data-size": cells(4) },
      },
    ],
    mode: "offset",
  });
  const path = await writeFit("large.itb", bytes);
  const base = Math.ceil(bytes.readUInt32BE(4) / 4) * 4;
  await truncate(path, base + 17 * MIB + 4);
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(
    snapshot.occurrences.find(
      (row) => row.logical_path === "images/rootfs.bin",
    ),
  ).toMatchObject({
    declared_size: 4,
    source_location: { offset: base + 17 * MIB, length: 4 },
  });
});

it("fails an embedded devicetree above 16 MiB with a fixed limit", async () => {
  const path = await writeFit(
    "huge.itb",
    withTotalsize(FIT_EMBEDDED, 16 * MIB + 4),
  );
  await truncate(path, 16 * MIB + 8);
  await expect(scanCanonicalArtifactInventory(path)).rejects.toMatchObject({
    reason: "limit",
    boundary: "memory",
  });
});

it("fails a devicetree totalsize past the end of the file", async () => {
  await expect(
    scanCanonicalArtifactInventory(
      await writeFit(
        "short.itb",
        withTotalsize(FIT_EMBEDDED, FIT_EMBEDDED.length + 4),
      ),
    ),
  ).rejects.toMatchObject({
    reason: "truncated",
    parseFailure: {
      kind: "truncated",
      format: "fit",
      field: "totalsize",
      extent: {
        availableBytes: FIT_EMBEDDED.length,
        requiredBytes: FIT_EMBEDDED.length + 4,
      },
    },
  });
});

it("fails /images followed by a malformed structure, and reads a plain DTB as a devicetree", async () => {
  const bytes = Buffer.from(FIT_EMBEDDED);
  const end = bytes.readUInt32BE(8) + bytes.readUInt32BE(36) - 4;
  expect(bytes.readUInt32BE(end)).toBe(9);
  bytes.writeUInt32BE(10, end);
  await expect(
    scanCanonicalArtifactInventory(await writeFit("broken.itb", bytes)),
  ).rejects.toMatchObject({
    reason: "malformed",
    message: expect.stringMatching(/FDT.*token 10/iu),
  });
  const plain = await scanCanonicalArtifactInventory(
    await writeFit("board.dtb", devicetreeFixture()),
  );
  expect(plain.manifest.root_format).toBe("devicetree");
});

it("rejects a changed carrier during extraction preparation", async () => {
  const reader = new FitArtifactReader(
    await writeFit("changed.itb", FIT_EMBEDDED),
  );
  try {
    await expect(reader.prepareContainer("0".repeat(64))).rejects.toMatchObject(
      { reason: "integrity" },
    );
  } finally {
    await reader.close();
  }
});

it("isolates returned declaration arrays from saved FIT facts", async () => {
  const reader = new FitArtifactReader(
    await writeFit("metadata-copy.itb", FIT_EXTERNAL),
  );
  try {
    const entry = await firstEntry(reader);
    if (entry.formatMetadata?.kind !== "fit-image")
      throw new Error("Missing FIT image metadata");
    const original = structuredClone(entry.formatMetadata);
    entry.formatMetadata.unreadable_fields.push("load");
    entry.formatMetadata.hash_algorithms[0] = "changed";
    entry.formatMetadata.signature_algorithms.push("changed");
    const fresh = await firstEntry(reader);
    expect(fresh.formatMetadata).toEqual(original);
    await expect(reader.open(entry)).rejects.toMatchObject({
      reason: "integrity",
    });
    const stream = await reader.open(fresh);
    expect((await buffer(stream)).equals(FIT_KERNEL)).toBe(true);
  } finally {
    await reader.close();
  }
});

it("rejects forged entries and changed carrier identity, then closes idempotently", async () => {
  const path = await writeFit("identity.itb", FIT_EXTERNAL);
  const reader = new FitArtifactReader(path);
  try {
    const entry = await firstEntry(reader);
    if (entry.formatMetadata?.kind !== "fit-image")
      throw new Error("Missing FIT image metadata");
    await expect(
      reader.open({
        ...entry,
        formatMetadata: {
          ...entry.formatMetadata,
          unreadable_fields: ["load"],
        },
      }),
    ).rejects.toMatchObject({ reason: "integrity" });
    await expect(
      reader.open({ ...entry, byteOffset: 0 }),
    ).rejects.toMatchObject({ reason: "integrity" });
    await expect(
      reader.open({ ...entry, adapterKey: "fit:9" }),
    ).rejects.toMatchObject({ reason: "integrity" });
    await writeFile(path, FIT_EMBEDDED);
    await expect(reader.open(entry)).rejects.toMatchObject({
      reason: "integrity",
    });
  } finally {
    await reader.close();
    await reader.close();
  }
});

it("settles an active image stream when closed", async () => {
  const reader = new FitArtifactReader(await writeFit("close.itb", LARGE_FIT));
  try {
    const stream = await reader.open(await firstEntry(reader));
    await reader.close();
    expect(stream.destroyed).toBe(true);
    await expect(
      reader.entries()[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ reason: "unavailable" });
  } finally {
    await reader.close();
  }
});

it("keeps the cancellation reason before admission", async () => {
  const reader = new FitArtifactReader(
    await writeFit("cancel.itb", FIT_EMBEDDED),
  );
  const controller = new AbortController();
  const reason = { stage: "before admission" };
  controller.abort(reason);
  try {
    await expect(
      reader.entries(controller.signal)[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
  } finally {
    await reader.close();
  }
});

it("does not publish FIT entries when final source verification fails", async () => {
  const path = await writeFit("partial-publication.itb", FIT_EMBEDDED);
  const control = new FitArtifactReader(path);
  const reader = new FitArtifactReader(path);
  const expected = await firstEntry(control);
  const nativeRead = ArtifactFileSource.prototype.read;
  const physical = Object.assign(
    new Error("final source verification failed"),
    { code: "EIO" },
  );
  let calls = 0;
  const read = vi
    .spyOn(ArtifactFileSource.prototype, "read")
    .mockImplementation(function (this: ArtifactFileSource, ...args) {
      calls += 1;
      if (calls === 4) return Promise.reject(physical);
      return nativeRead.apply(this, args);
    });
  try {
    await expect(firstEntry(reader)).rejects.toBe(physical);
    await expect(reader.open(expected)).rejects.toMatchObject({
      reason: "integrity",
    });
    read.mockRestore();
    expect((await firstEntry(reader)).path).toBe(expected.path);
  } finally {
    read.mockRestore();
    await reader.close();
    await control.close();
  }
});

it("keeps the cancellation reason during hash verification", async () => {
  const reader = new FitArtifactReader(
    await writeFit("hashing.itb", LARGE_FIT),
  );
  const controller = new AbortController();
  const reason = { stage: "hashing" };
  const create = fitStructure.createFitDigest;
  const observer = vi
    .spyOn(fitStructure, "createFitDigest")
    .mockImplementation((algo) => {
      const digest = create(algo);
      return (
        digest && {
          update: (chunk) => {
            controller.abort(reason);
            digest.update(chunk);
          },
          digest: () => digest.digest(),
        }
      );
    });
  try {
    await expect(
      reader.entries(controller.signal)[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
    expect(observer).toHaveBeenCalledWith("sha256");
    observer.mockRestore();
    expect((await firstEntry(reader)).kind).toBe("file");
  } finally {
    observer.mockRestore();
    await reader.close();
  }
});

it.each([false, true])(
  "joins an admitted FIT preparation digest read when closing (I/O fault: %s)",
  async (fail) => {
    const data = Buffer.from("external payload checked by the FIT digest");
    const bytes = fitFixture({
      images: [{ name: "kernel", data, hashes: ["sha256"] }],
      mode: "offset",
    });
    const imageOffset = bytes.indexOf(data);
    expect(imageOffset).toBeGreaterThanOrEqual(bytes.readUInt32BE(4));
    const path = await writeFit("held-hash.itb", bytes);
    const descriptor = await openRegularFile(path, { symlinks: "reject" });
    const reader = new FitArtifactReader(path, descriptor);
    const gate = phaseGate();
    const read = descriptor.handle.read.bind(descriptor.handle);
    const physical = Object.assign(new Error("FIT digest read failed"), {
      code: "EIO",
    });
    vi.spyOn(descriptor.handle, "read").mockImplementation(
      async (...args: unknown[]) => {
        const result = await Reflect.apply(read, descriptor.handle, args);
        if (args[3] === BigInt(imageOffset)) await gate.hold();
        return result;
      },
    );
    try {
      const inventory = firstEntry(reader).catch((cause: unknown) => cause);
      await gate.reached(inventory, "external FIT image digest read");
      let closed = false;
      const closing = reader.close().then(() => {
        closed = true;
      });
      await setImmediate();
      const closeWaited = !closed;
      if (fail) gate.reject(physical);
      else gate.release();
      const outcome = await inventory;
      await closing;
      if (fail) expect(outcome).toBe(physical);
      else expect(outcome).toMatchObject({ reason: "unavailable" });
      expect(closeWaited).toBe(true);
      expect(reader.formatMetadata()).toBeUndefined();
    } finally {
      gate.release();
      await reader.close();
      await descriptor.handle.close();
    }
  },
);

it("keeps FIT extraction bound to the admitted descriptor", async (context) => {
  const root = await createTestTempDirectory("rea-fit-admitted-source-");
  const selected = join(root, "selected");
  await mkdir(selected);
  const path = join(selected, "kernel.itb");
  const data = Buffer.from("original FIT image");
  const fixture = (image: Buffer) =>
    fitFixture({
      mode: "offset",
      images: [{ name: "kernel", data: image, hashes: ["sha256"] }],
    });
  await writeFile(path, fixture(data));
  const descriptor = await openRegularFile(path, { symlinks: "reject" });
  const reader = new FitArtifactReader(path, descriptor);
  try {
    const entry = await firstEntry(reader);
    const swapped = await renameOpenParent(selected, join(root, "original"));
    if (swapped.kind === "blocked") context.skip();
    await mkdir(selected);
    await writeFile(path, fixture(Buffer.from("replaced FIT image")));
    expect(entry).toMatchObject({
      path: "images/kernel.bin",
      sourcePath: "/images/kernel",
      formatMetadata: { hashes_verified: 1 },
    });
    expect((await buffer(await reader.open(entry))).equals(data)).toBe(true);
  } finally {
    await reader.close();
    await descriptor.handle.close();
  }
});

it("keeps the cancellation reason after an image stream was opened", async () => {
  const reader = new FitArtifactReader(await writeFit("stream.itb", LARGE_FIT));
  const controller = new AbortController();
  const reason = { stage: "image consumption" };
  try {
    const stream = await reader.open(
      await firstEntry(reader),
      controller.signal,
    );
    controller.abort(reason);
    await expect(
      (async () => {
        for await (const _chunk of stream) {
          /* drain */
        }
      })(),
    ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
    await reader.close();
    expect(stream.closed).toBe(true);
  } finally {
    await reader.close();
  }
});

it.each([null, { stage: "buffered image" }])(
  "keeps cancellation attached to buffered image bytes (reason %j)",
  async (reason) => {
    const reader = new FitArtifactReader(
      await writeFit("buffered.itb", FIT_EXTERNAL),
    );
    const controller = new AbortController();
    const readChunks = fileChunks.readFileHandleChunks;
    let sourceClosed: Promise<unknown> | undefined;
    let observer: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const entry = await firstEntry(reader);
      observer = vi
        .spyOn(fileChunks, "readFileHandleChunks")
        .mockImplementation((...args) => {
          const source = readChunks(...args);
          sourceClosed = once(source, "close");
          return source;
        });
      const stream = await reader.open(entry, controller.signal);
      await once(stream, "finish");
      expect(sourceClosed).toBeDefined();
      await sourceClosed;
      expect(stream.readableLength).toBe(FIT_KERNEL.length);
      expect(stream.closed).toBe(false);
      controller.abort(reason);
      await expect(
        (async () => {
          for await (const _chunk of stream) {
            /* drain */
          }
        })(),
      ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
      await reader.close();
      expect(stream.closed).toBe(true);
      expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    } finally {
      observer?.mockRestore();
      await reader.close();
    }
  },
);

it("preserves a final validation failure when cancellation overlaps it", async () => {
  const path = await writeFit("final-validation.itb", FIT_EXTERNAL);
  const descriptor = await openRegularFile(path, { symlinks: "reject" });
  const reader = new FitArtifactReader(path, descriptor);
  const controller = new AbortController();
  const finalValidation = phaseGate();
  let consumed: Promise<Buffer> | undefined;
  try {
    const entry = await firstEntry(reader);
    const stream = await reader.open(entry, controller.signal);
    const stat = descriptor.handle.stat.bind(descriptor.handle);
    vi.spyOn(descriptor.handle, "stat").mockImplementationOnce(
      async (...args) => {
        await finalValidation.hold();
        return await stat(...args);
      },
    );
    consumed = buffer(stream);
    await finalValidation.reached(consumed, "FIT final validation");
    await truncate(path, FIT_EXTERNAL.length - 1);
    controller.abort({ stage: "final validation" });
    finalValidation.release();
    await expect(consumed).rejects.toMatchObject({
      reason: "integrity",
      integrityCheck: "container-identity",
    });
    await reader.close();
    expect(stream.closed).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  } finally {
    finalValidation.release();
    await consumed?.catch(() => undefined);
    await reader.close();
    await descriptor.handle.close();
  }
});

artifactPreparationRecoveryCases({
  image: () => FIT_EMBEDDED,
  createReader: (path, admitted) => new FitArtifactReader(path, admitted),
});

/**
 * An image field the structure reader could not decode leaves the inventory
 * unknown, the same way `NtfsMftArtifactReader` reports a recorded limitation.
 */
it("reports unknown coverage when an image field could not be decoded", async () => {
  const file = fitFixture({
    images: [
      {
        name: "kernel",
        data: FIT_KERNEL,
        // Three cells is not a 1- or 2-cell address, so `load` stays undecoded.
        properties: {
          description: dtString("Linux kernel"),
          type: dtString("kernel"),
          load: cells(0, 1, 2),
        },
      },
    ],
  });
  const snapshot = await scanCanonicalArtifactInventory(
    await writeFit("undecodable.itb", file),
  );
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  const image = snapshot.occurrences.find((row) =>
    row.logical_path.startsWith("images/kernel"),
  );
  expect(
    (image?.format_metadata as { unreadable_fields?: string[] })
      ?.unreadable_fields,
  ).toContain("load");
  expect(root).toBeDefined();
  expect(snapshot.coverage).toMatchObject({ status: "unknown" });
  // The reason travels with the status, so a coverage consumer can name the field.
  expect(
    snapshot.limitations.some(
      (line) => line.includes("kernel") && line.includes("load"),
    ),
  ).toBe(true);
});
