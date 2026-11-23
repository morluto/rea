import { createHash } from "node:crypto";
import { buffer } from "node:stream/consumers";
import { artifactPreparationRecoveryCases } from "../../tests/fixtures/artifactReaderLifecycle.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import { stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";

import { expect, it, vi } from "vitest";
import * as hexRecordDecoding from "../domain/firmware/hexRecords.js";
import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";

import { ArtifactReaderFailure } from "../resources/ArtifactReader.js";
import { HexRecordArtifactReader } from "./HexRecordArtifactReader.js";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import { extractArtifact } from "./extraction/ArtifactExtraction.js";
import {
  INTEL_HEX_I32_GAP,
  SREC_S19,
  intelHexInterleavedRuns,
  intelHexRecord,
} from "../domain/firmware/hexRecords.fixture.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

const writeImage = async (name: string, text: string): Promise<string> => {
  const directory = await createTestTempDirectory("rea-hex-records-");
  const path = join(directory, name);
  await writeFile(path, text);
  return path;
};

const firstRegion = async (reader: HexRecordArtifactReader) => {
  for await (const entry of reader.entries()) return entry;
  throw new Error("Missing region");
};

it.each(["close", "cancel"] as const)(
  "does not complete a decoded-region inventory after %s while paused",
  async (interruption) => {
    const path = await writeImage(
      "image.hex",
      `${intelHexRecord(0, 0, [1])}\n:00000001FF\n`,
    );
    const reader = new HexRecordArtifactReader(path, "intel-hex");
    const controller = new AbortController();
    try {
      const entries = reader.entries(controller.signal)[Symbol.asyncIterator]();
      expect((await entries.next()).done).toBe(false);
      if (interruption === "close") await reader.close();
      else controller.abort();
      await expect(entries.next()).rejects.toMatchObject({
        reason: interruption === "close" ? "unavailable" : "cancelled",
      });
    } finally {
      await reader.close();
    }
  },
);

it("reports unknown coverage and termination facts as limitations", async () => {
  const truncated = await scanCanonicalArtifactInventory(
    await writeImage("truncated.s19", SREC_S19.replace("S9030000FC\n", "")),
  );
  expect(truncated.manifest.root_format).toBe("srec");
  expect(truncated.coverage.status).toBe("unknown");
  expect(truncated.limitations).toContainEqual(
    expect.stringMatching(/no termination record.*may be truncated/iu),
  );
  expect(truncated.occurrences.map((row) => row.logical_path).sort()).toEqual([
    ".",
    "0x00000000-0x0000001f.bin",
  ]);
  const mismatched = await scanCanonicalArtifactInventory(
    await writeImage(
      "s7.s19",
      SREC_S19.replace("S9030000FC", "S70500000000FA"),
    ),
  );
  expect(mismatched.coverage.status).toBe("complete");
  expect(mismatched.limitations).toContainEqual(
    expect.stringMatching(
      /termination.*S7.*does not match.*address width.*S1/iu,
    ),
  );
});

it("refuses one over-limit physical run even when all addresses could merge", async () => {
  await expect(
    scanCanonicalArtifactInventory(
      await writeImage("runs.hex", intelHexInterleavedRuns(true)),
    ),
  ).rejects.toMatchObject({
    reason: "limit",
    boundary: "capacity",
    message: expect.stringContaining(
      "more than 65536 address-discontiguous record runs",
    ),
  });
});

it("leaves an invalid first record to plain file classification", async () => {
  const snapshot = await scanCanonicalArtifactInventory(
    await writeImage("notes.hex", ":0300300002337A1F\n:00000001FF\n"),
  );
  expect(snapshot.manifest.root_format).toBe("file");
});

it("re-inventories extracted regions as raw files", async () => {
  const directory = await createTestTempDirectory("rea-hex-extract-");
  const path = join(directory, "firmware.hex");
  await writeFile(path, INTEL_HEX_I32_GAP);
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: path,
      inputFormat: "intel-hex",
      outputRoot: join(directory, "out"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    const reinventoried = await scanCanonicalArtifactInventory(
      extracted.output_root,
    );
    expect(reinventoried.manifest.root_format).toBe("directory");
    expect(
      reinventoried.occurrences
        .filter((row) => row.entry_kind === "file")
        .map((row) => row.logical_path)
        .sort(),
    ).toEqual(["0x08000000-0x0800001f.bin", "0x08000100-0x08000103.bin"]);
  } finally {
    await resourceScope.close();
  }
});

it("binds the carrier digest, rejects forged entries and detects same-size source drift", async () => {
  const path = await writeImage("identity.hex", INTEL_HEX_I32_GAP);
  const reader = new HexRecordArtifactReader(path, "intel-hex");
  try {
    const observed = createHash("sha256")
      .update(INTEL_HEX_I32_GAP)
      .digest("hex");
    const wrong = "0".repeat(64);
    await expect(reader.prepareContainer(wrong)).rejects.toMatchObject({
      reason: "integrity",
      integrityCheck: "container-identity",
      details: { declaredSha256: wrong, calculatedSha256: observed },
    });
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const entry = entries[1];
    if (entry === undefined) throw new Error("Missing region");
    await expect(
      reader.open({ ...entry, declaredSize: 1 }),
    ).rejects.toMatchObject({
      reason: "integrity",
      integrityCheck: "entry-metadata",
    });
    await expect(
      reader.open({ ...entry, adapterKey: "hex-records:9" }),
    ).rejects.toMatchObject({
      reason: "integrity",
      integrityCheck: "foreign-entry",
    });
    expect(entry.path).toBe("0x08000100-0x08000103.bin");
    const replacement = INTEL_HEX_I32_GAP.replace(
      ":04010000DEADBEEFC3",
      ":04020000DEADBEEFC2",
    );
    expect(replacement).not.toBe(INTEL_HEX_I32_GAP);
    const { size } = await stat(path);
    await writeFile(path, replacement);
    // Stabilize the distinct timestamp even on a coarse-resolution volume.
    await utimes(path, 1_000_000_000, 1_000_000_000);
    expect((await stat(path)).size).toBe(size);
    await expect(reader.open(entry)).rejects.toMatchObject({
      reason: "integrity",
      integrityCheck: "container-identity",
    });
  } finally {
    await reader.close();
  }
});

it("settles an active region stream when closed", async () => {
  const path = await writeImage("close.hex", INTEL_HEX_I32_GAP);
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new HexRecordArtifactReader(path, "intel-hex", admitted);
  try {
    const entry = await firstRegion(reader);
    const stream = await reader.open(entry);
    let closed = false;
    stream.once("close", () => {
      closed = true;
    });
    stream.read(0);
    await reader.close();
    expect(closed).toBe(true);
    await expect(reader.open(entry)).rejects.toMatchObject({
      reason: "unavailable",
    });
  } finally {
    await reader.close();
    await admitted.handle.close();
  }
});

it("retries decoded-region preparation cancelled while reading", async () => {
  const path = await writeImage("retry.hex", INTEL_HEX_I32_GAP);
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new HexRecordArtifactReader(path, "intel-hex", admitted);
  const controller = new AbortController();
  const reason = { stage: "decoded region read" };
  const nativeRead = admitted.handle.read.bind(admitted.handle);
  const read = vi.spyOn(admitted.handle, "read").mockImplementation((async (
    ...args: unknown[]
  ) => {
    const result = await Reflect.apply(nativeRead, admitted.handle, args);
    controller.abort(reason);
    return result;
  }) as typeof admitted.handle.read);
  try {
    await expect(
      reader.entries(controller.signal)[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
    read.mockRestore();
    expect(await firstRegion(reader)).toMatchObject({
      path: "0x08000000-0x0800001f.bin",
      declaredSize: 32,
    });
  } finally {
    read.mockRestore();
    await reader.close();
    await admitted.handle.close();
  }
});

it("does not publish decoded regions when final source verification fails", async () => {
  const path = await writeImage("partial.hex", INTEL_HEX_I32_GAP);
  const control = new HexRecordArtifactReader(path, "intel-hex");
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new HexRecordArtifactReader(path, "intel-hex", admitted);
  const physical = Object.assign(new Error("final descriptor stat failed"), {
    code: "EIO",
  });
  const stats = vi.spyOn(admitted.handle, "stat");
  const nativeRead = admitted.handle.read.bind(admitted.handle);
  let remaining = admitted.initial.size;
  const read = vi.spyOn(admitted.handle, "read").mockImplementation((async (
    ...args: unknown[]
  ) => {
    const result = (await Reflect.apply(nativeRead, admitted.handle, args)) as {
      bytesRead: number;
    };
    remaining -= result.bytesRead;
    if (remaining === 0) stats.mockRejectedValueOnce(physical);
    return result;
  }) as typeof nativeRead);
  try {
    const expected = await firstRegion(control);
    await expect(reader.entries()[Symbol.asyncIterator]().next()).rejects.toBe(
      physical,
    );
    expect(reader.formatMetadata()).toBeUndefined();
    await expect(reader.open(expected)).rejects.toMatchObject({
      reason: "integrity",
      integrityCheck: "foreign-entry",
    });
    read.mockRestore();
    expect(await firstRegion(reader)).toEqual(expected);
  } finally {
    read.mockRestore();
    stats.mockRestore();
    await reader.close();
    await admitted.handle.close();
    await control.close();
  }
});

it("honors cancellation before admitting a file with the exact reason", async () => {
  const reader = new HexRecordArtifactReader(
    await writeImage("cancel.hex", INTEL_HEX_I32_GAP),
    "intel-hex",
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

it.each(["cancel", "close"] as const)(
  "settles decoding when the caller requests %s",
  async (action) => {
    const data = Array.from({ length: 128 }, () => 7);
    const rows = Array.from({ length: 384 }, (_, index) =>
      intelHexRecord(0, index * data.length, data),
    );
    const text = [...rows, ":00000001FF", ""].join("\n");
    const reader = new HexRecordArtifactReader(
      await writeImage("large.hex", text),
      "intel-hex",
    );
    const controller = new AbortController();
    const reason = { stage: "decoding" };
    let completion: Promise<void> | undefined;
    let pending: Promise<unknown> | undefined;
    let decoded = 0;
    let acknowledge = (): void => undefined;
    const decoding = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const create = hexRecordDecoding.createHexRecordDecoder;
    const observer = vi
      .spyOn(hexRecordDecoding, "createHexRecordDecoder")
      .mockImplementation((encoding, bytes) => {
        const result = create(encoding, bytes);
        if (!result.ok) return result;
        const decoder = result.value;
        return {
          ok: true,
          value: {
            write: (chunk) => {
              const written = decoder.write(chunk);
              decoded += 1;
              acknowledge();
              return written;
            },
            finish: () => decoder.finish(),
          },
        };
      });
    try {
      pending = reader
        .entries(controller.signal)
        [Symbol.asyncIterator]()
        .next();
      await awaitAcknowledgement(decoding, pending, "HEX record decoding");
      const requestedAt = decoded;
      if (action === "cancel") controller.abort(reason);
      else completion = reader.close();
      const failure = await pending.catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      expect(failure).toMatchObject(
        action === "cancel"
          ? { reason: "cancelled", cause: reason }
          : { reason: "unavailable" },
      );
      if (action === "cancel") {
        if (!(failure instanceof ArtifactReaderFailure)) throw failure;
        expect(failure.cause).toBe(reason);
      }
      await completion;
      expect(decoded).toBe(requestedAt);
    } finally {
      try {
        await reader.close();
      } finally {
        await pending?.catch(() => undefined);
        observer.mockRestore();
      }
    }
  },
);

it("retains the caller's cancellation reason after a region stream was opened", async () => {
  const reader = new HexRecordArtifactReader(
    await writeImage("stream-cancel.hex", INTEL_HEX_I32_GAP),
    "intel-hex",
  );
  const controller = new AbortController();
  const reason = { stage: "region consumption" };
  try {
    const entry = await firstRegion(reader);
    const stream = await reader.open(entry, controller.signal);
    controller.abort(reason);
    await setImmediate();
    expect(stream.closed).toBe(true);
    await expect(buffer(stream)).rejects.toMatchObject({
      reason: "cancelled",
      cause: reason,
    });
  } finally {
    await reader.close();
  }
});

it("bounds copied region chunks and isolates cached bytes across opens", async () => {
  const bank = (index: number, value: number): string[] => {
    const data = Array.from({ length: 128 }, () => value);
    return [
      intelHexRecord(4, 0, [0, index]),
      ...Array.from({ length: 512 }, (_, row) =>
        intelHexRecord(0, row * data.length, data),
      ),
    ];
  };
  const text = [...bank(0, 7), ...bank(1, 13), ":00000001FF"].join("\n");
  const reader = new HexRecordArtifactReader(
    await writeImage("chunked.hex", text),
    "intel-hex",
  );
  const controller = new AbortController();
  const reason = { stage: "partial region consumption" };
  try {
    const entry = await firstRegion(reader);
    const stream = await reader.open(entry, controller.signal);
    const iterator = stream[Symbol.asyncIterator]();
    const { value: first }: { value: unknown } = await iterator.next();
    if (!Buffer.isBuffer(first)) throw new Error("Expected byte chunk");
    expect(first.length).toBeLessThanOrEqual(64 * 1024);
    expect(entry.declaredSize).toBe(128 * 1024);
    first[0] = 42;
    const reopened = await reader.open(entry);
    const peer = reopened[Symbol.asyncIterator]();
    const { value: again }: { value: unknown } = await peer.next();
    if (!Buffer.isBuffer(again)) throw new Error("Expected byte chunk");
    expect(again[0]).toBe(7);
    controller.abort(reason);
    await expect(iterator.next()).rejects.toMatchObject({
      reason: "cancelled",
      cause: reason,
    });
    const received = [again];
    for await (const chunk of peer) {
      if (!Buffer.isBuffer(chunk)) throw new Error("Expected peer bytes");
      received.push(chunk);
    }
    const expected = Buffer.concat([
      Buffer.alloc(64 * 1024, 7),
      Buffer.alloc(64 * 1024, 13),
    ]);
    expect(Buffer.concat(received).equals(expected)).toBe(true);
    await reader.close();
    expect(stream.closed).toBe(true);
    expect(reopened.closed).toBe(true);
  } finally {
    await reader.close();
  }
});

artifactPreparationRecoveryCases({
  image: () => Buffer.from(INTEL_HEX_I32_GAP),
  createReader: (path, admitted) =>
    new HexRecordArtifactReader(path, "intel-hex", admitted),
});
