import { once } from "node:events";
import { buffer } from "node:stream/consumers";
import { finished } from "node:stream/promises";

import { expect, it, vi } from "vitest";

import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import { createTestTempFile } from "../../tests/fixtures/temporaryDirectory.js";
import { phaseGate } from "../../tests/support/lifecycleHarness.js";
import { testWaitDeadline } from "../../tests/support/testWait.js";
import { resolveArtifactReaderLimits } from "../domain/artifactReaderLimits.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import {
  ArtifactEntryContentUnavailable,
  ArtifactReaderFailure,
} from "../resources/index.js";
import { buildNro, buildNso } from "../domain/switchExecutable.fixture.js";
import { SwitchExecutableArtifactReader } from "./SwitchExecutableArtifactReader.js";

const fixture = (bytes: Buffer): Promise<string> =>
  createTestTempFile("rea-switch-boundary-", "image", bytes);

const collect = async (reader: SwitchExecutableArtifactReader) => {
  const entries = [];
  let coverage: { status: string; limitations: readonly string[] } | undefined;
  for await (const entry of reader.entries(undefined, {
    onCoverage: (value) => (coverage = value),
  }))
    entries.push(entry);
  return { entries, coverage };
};

it("refuses a file without a full NSO header", async () => {
  const reader = new SwitchExecutableArtifactReader(
    await fixture(buildNso().subarray(0, 0x40)),
    "nso",
  );
  try {
    const failure = await collect(reader).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    expect(failure).toMatchObject({
      reason: "truncated",
      message: expect.stringContaining("truncated"),
      parseFailure: {
        kind: "truncated",
        format: "nso",
        offset: 0,
        field: "header",
        extent: { availableBytes: 0x40, requiredBytes: 0x100 },
      },
    });
  } finally {
    await reader.close();
  }
});

it("preserves parse failure facts for malformed NSO and NRO headers", async () => {
  const overlap = buildNso();
  overlap.writeUInt32LE(0x20, 0x10);
  const nsoReader = new SwitchExecutableArtifactReader(
    await fixture(overlap),
    "nso",
  );
  try {
    const failure = await collect(nsoReader).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    expect(failure).toMatchObject({
      reason: "malformed",
      message: expect.stringContaining("overlaps the header"),
      parseFailure: {
        kind: "malformed",
        format: "nso",
        offset: 0x10,
        field: "text_segment.file_offset",
      },
    });
  } finally {
    await nsoReader.close();
  }

  const badNro = buildNro();
  badNro.writeUInt32LE(0x1000, 0x34);
  const nroReader = new SwitchExecutableArtifactReader(
    await fixture(badNro),
    "nro",
  );
  try {
    const failure = await collect(nroReader).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    expect(failure).toMatchObject({
      reason: "malformed",
      message: expect.stringContaining("past the declared image size"),
      parseFailure: {
        kind: "malformed",
        format: "nro",
        offset: 0x30,
        field: "data_segment",
      },
    });
  } finally {
    await nroReader.close();
  }
});

it("lists a truncated segment with a limitation and refuses its content", async () => {
  const reader = new SwitchExecutableArtifactReader(
    await fixture(buildNso({ truncateBy: 3 })),
    "nso",
  );
  try {
    const { entries, coverage } = await collect(reader);
    const data = entries.find((entry) => entry.path === "data.bin");
    expect(data?.limitations.join(" ")).toContain("truncated");
    expect(data?.formatMetadata).toMatchObject({ hash_status: "unavailable" });
    expect(coverage?.status).toBe("unknown");
    await expect(reader.open(data!)).rejects.toThrow(/truncated/u);
    const rodata = entries.find((entry) => entry.path === "rodata.bin");
    expect((await buffer(await reader.open(rodata!))).toString()).toBe(
      "read-only data segment",
    );
  } finally {
    await reader.close();
  }
});

it("refuses to decompress a segment over the expansion budget", async () => {
  const big = Buffer.alloc(4096, 7);
  const path = await fixture(
    buildNso({
      segments: [big, Buffer.from("ro"), Buffer.from("rw")],
      compress: [true, false, false],
    }),
  );
  const reader = new SwitchExecutableArtifactReader(
    path,
    "nso",
    undefined,
    1024,
  );
  let requiredValue: number | undefined;
  try {
    const { entries, coverage } = await collect(reader);
    const text = entries.find((entry) => entry.path === "text.bin");
    expect(text?.declaredSize).toBe(4096);
    expect(text?.limitations.join(" ")).toContain(
      "artifact_limits.expanded_bytes",
    );
    expect(text?.formatMetadata).toMatchObject({ hash_status: "unavailable" });
    expect(coverage?.status).toBe("unknown");
    const failure = await reader.open(text!).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactEntryContentUnavailable);
    const cause = (failure as Error).cause;
    expect(cause).toBeInstanceOf(ArtifactReaderFailure);
    const expectedRequired = text!.byteLength! + 4096;
    expect(cause).toMatchObject({
      readerLimit: {
        parameter: "artifact_limits.expanded_bytes",
        effective_value: 1024,
        required_value: expectedRequired,
      },
    });
    requiredValue = expectedRequired;
  } finally {
    await reader.close();
  }
  const retried = new SwitchExecutableArtifactReader(
    path,
    "nso",
    undefined,
    requiredValue,
  );
  try {
    const { entries, coverage } = await collect(retried);
    const text = entries.find((entry) => entry.path === "text.bin");
    expect(coverage?.status).toBe("complete");
    expect(text?.formatMetadata).toMatchObject({ hash_status: "match" });
    expect((await buffer(await retried.open(text!))).equals(big)).toBe(true);
  } finally {
    await retried.close();
  }
});

const storedNso = (
  parts: readonly [
    { readonly stored: number; readonly decoded: number },
    { readonly stored: number; readonly decoded: number },
    { readonly stored: number; readonly decoded: number },
  ],
  compress: readonly [boolean, boolean, boolean],
): Buffer => {
  const header = Buffer.alloc(0x100);
  header.write("NSO0", 0, "latin1");
  let flags = 0;
  const payloads: Buffer[] = [];
  let fileOffset = 0x100;
  parts.forEach((part, index) => {
    if (compress[index]) flags |= 1 << index;
    const bytes = compress[index] ? part.stored : part.decoded;
    header.writeUInt32LE(fileOffset, 0x10 + index * 0x10);
    header.writeUInt32LE(index * 0x1000, 0x14 + index * 0x10);
    header.writeUInt32LE(part.decoded, 0x18 + index * 0x10);
    header.writeUInt32LE(part.stored, 0x60 + index * 4);
    payloads.push(Buffer.alloc(bytes, 0xab));
    fileOffset += bytes;
  });
  header.writeUInt32LE(flags >>> 0, 0x0c);
  return Buffer.concat([header, ...payloads]);
};

const empty = { stored: 0, decoded: 0 };

it("refuses a stored range larger than the expansion budget before reading it", async () => {
  const reader = new SwitchExecutableArtifactReader(
    await fixture(
      storedNso(
        [{ stored: 64 * 1024, decoded: 16 }, empty, empty],
        [true, false, false],
      ),
    ),
    "nso",
    undefined,
    1024,
  );
  try {
    const { entries, coverage } = await collect(reader);
    const text = entries.find((entry) => entry.path === "text.bin");
    expect(text?.declaredSize).toBe(16);
    expect(text?.limitations.join(" ")).toContain(
      "artifact_limits.expanded_bytes",
    );
    expect(text?.limitations.join(" ")).not.toContain("LZ4");
    expect(text?.formatMetadata).toMatchObject({ hash_status: "unavailable" });
    expect(coverage?.status).toBe("unknown");
    const failure = await reader.open(text!).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactEntryContentUnavailable);
    expect((failure as Error).cause).toMatchObject({
      readerLimit: {
        parameter: "artifact_limits.expanded_bytes",
        effective_value: 1024,
        required_value: 64 * 1024 + 16,
      },
    });
  } finally {
    await reader.close();
  }
});

it("refuses when stored and decoded bytes together exceed the expansion budget", async () => {
  const reader = new SwitchExecutableArtifactReader(
    await fixture(
      storedNso(
        [{ stored: 600, decoded: 600 }, empty, empty],
        [true, false, false],
      ),
    ),
    "nso",
    undefined,
    1000,
  );
  try {
    const { entries } = await collect(reader);
    const text = entries.find((entry) => entry.path === "text.bin");
    expect(text?.limitations.join(" ")).toContain(
      "artifact_limits.expanded_bytes",
    );
    expect(text?.limitations.join(" ")).not.toContain("LZ4");
    const failure = await reader.open(text!).catch((cause: unknown) => cause);
    expect((failure as Error).cause).toMatchObject({
      readerLimit: {
        parameter: "artifact_limits.expanded_bytes",
        effective_value: 1000,
        required_value: 1200,
      },
    });
  } finally {
    await reader.close();
  }
});

it("charges a segment's stored bytes against the budget shared with later segments", async () => {
  const reader = new SwitchExecutableArtifactReader(
    await fixture(
      storedNso(
        [{ stored: 800, decoded: 4 }, { stored: 800, decoded: 4 }, empty],
        [true, true, false],
      ),
    ),
    "nso",
    undefined,
    1000,
  );
  try {
    const { entries } = await collect(reader);
    const text = entries.find((entry) => entry.path === "text.bin");
    const rodata = entries.find((entry) => entry.path === "rodata.bin");
    expect(text?.limitations.join(" ")).toContain("LZ4 data is invalid");
    expect(rodata?.limitations.join(" ")).toContain(
      "artifact_limits.expanded_bytes",
    );
    const failure = await reader.open(rodata!).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactEntryContentUnavailable);
    expect((failure as Error).cause).toMatchObject({
      readerLimit: {
        parameter: "artifact_limits.expanded_bytes",
        effective_value: 1000,
        required_value: 1608,
      },
    });
  } finally {
    await reader.close();
  }
});

it("reports invalid LZ4 data as a segment limitation", async () => {
  const bytes = buildNso();
  // The text segment's literal-run length claims more literals than stored.
  bytes[0x101] = 200;
  const reader = new SwitchExecutableArtifactReader(
    await fixture(bytes),
    "nso",
  );
  try {
    const { entries } = await collect(reader);
    const text = entries.find((entry) => entry.path === "text.bin");
    expect(text?.limitations.join(" ")).toContain("LZ4 data is invalid");
    await expect(reader.open(text!)).rejects.toThrow(/LZ4/u);
  } finally {
    await reader.close();
  }
});

it("lists a truncated NRO asset with a limitation", async () => {
  const reader = new SwitchExecutableArtifactReader(
    await fixture(
      buildNro({
        assets: { romfs: Buffer.from("romfs-bytes") },
        truncateBy: 2,
      }),
    ),
    "nro",
  );
  try {
    const { entries, coverage } = await collect(reader);
    const romfs = entries.find((entry) => entry.path === "assets/romfs.bin");
    const text = entries.find((entry) => entry.path === "text.bin");
    expect(romfs?.limitations.join(" ")).toContain("truncated");
    expect(romfs?.formatMetadata).toMatchObject({ hash_status: "unavailable" });
    expect(text?.formatMetadata).toMatchObject({ hash_status: "not-checked" });
    expect(coverage?.status).toBe("unknown");
    await expect(reader.open(romfs!)).rejects.toThrow(/NRO is malformed/u);
  } finally {
    await reader.close();
  }

  const truncatedSegment = new SwitchExecutableArtifactReader(
    await fixture(buildNro({ truncateBy: 2 })),
    "nro",
  );
  try {
    const { entries, coverage } = await collect(truncatedSegment);
    const data = entries.find((entry) => entry.path === "data.bin");
    expect(data?.limitations.join(" ")).toContain("truncated");
    expect(data?.formatMetadata).toMatchObject({ hash_status: "unavailable" });
    expect(coverage?.status).toBe("unknown");
    await expect(truncatedSegment.open(data!)).rejects.toThrow(
      /NRO is malformed/u,
    );
  } finally {
    await truncatedSegment.close();
  }
});

it("lists valid NRO assets and reports a skipped unsafe range", async () => {
  const bytes = buildNro({
    assets: { icon: Buffer.from("jpeg"), nacp: Buffer.alloc(16, 1) },
  });
  const offset = bytes.readUInt32LE(0x18);
  bytes.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER), offset + 0x28);
  bytes.writeBigUInt64LE(1n, offset + 0x30);
  const reader = new SwitchExecutableArtifactReader(
    await fixture(bytes),
    "nro",
  );
  try {
    const { entries, coverage } = await collect(reader);
    expect(
      entries
        .map((entry) => entry.path)
        .filter((path) => path.startsWith("assets/")),
    ).toEqual(["assets/icon.jpg", "assets/control.nacp"]);
    expect(coverage).toEqual({
      status: "unknown",
      limitations: [
        "NRO romfs asset range exceeds a safe file offset; that asset is not listed.",
      ],
    });
  } finally {
    await reader.close();
  }
});

it("reports uninterpreted bytes after an NRO without ASET", async () => {
  const reader = new SwitchExecutableArtifactReader(
    await fixture(buildNro({ trailing: Buffer.from("JUNKJUNK") })),
    "nro",
  );
  try {
    const { coverage } = await collect(reader);
    expect(coverage?.limitations.join(" ")).toContain("without an ASET header");
  } finally {
    await reader.close();
  }
});

const occurrence = (
  snapshot: Awaited<ReturnType<typeof scanCanonicalArtifactInventory>>,
  path: string,
) => snapshot.occurrences.find((row) => row.logical_path === path);

it("keeps the NSO inventory when segment content is refused", async () => {
  const truncated = await scanCanonicalArtifactInventory(
    await fixture(buildNso({ truncateBy: 3 })),
  );
  expect(truncated.coverage.status).toBe("unknown");
  expect(occurrence(truncated, "data.bin")).toMatchObject({
    hash_status: "unavailable",
  });
  // The entry's limitation and the refusal's name one reason, reported once.
  expect(occurrence(truncated, "data.bin")?.limitations).toEqual([
    expect.stringContaining("data segment is truncated"),
  ]);
  expect(occurrence(truncated, "rodata.bin")?.artifact_id).not.toBeNull();

  const invalid = buildNso();
  invalid[0x101] = 200;
  const lz4 = await scanCanonicalArtifactInventory(await fixture(invalid));
  expect(occurrence(lz4, "text.bin")?.limitations.join(" ")).toContain(
    "LZ4 data is invalid",
  );

  const overBudget = await scanCanonicalArtifactInventory(
    await fixture(
      buildNso({
        segments: [Buffer.alloc(4096, 7), Buffer.from("ro"), Buffer.from("rw")],
        compress: [true, false, false],
      }),
    ),
    {
      readerLimits: resolveArtifactReaderLimits({ expanded_bytes: 1024 }),
    },
  );
  expect(occurrence(overBudget, "text.bin")).toMatchObject({
    hash_status: "unavailable",
  });
  expect(occurrence(overBudget, "text.bin")?.limitations).toEqual([
    expect.stringContaining("artifact_limits.expanded_bytes"),
  ]);
});

it("keeps NRO segments when the ASET header is cut short", async () => {
  const full = buildNro({ assets: { icon: Buffer.from("icon") } });
  // Keep "ASET" and a few header bytes, well short of the 0x38-byte header.
  const imageSize = full.readUInt32LE(0x18);
  const reader = new SwitchExecutableArtifactReader(
    await fixture(full.subarray(0, imageSize + 0x10)),
    "nro",
  );
  try {
    const { entries, coverage } = await collect(reader);
    expect(entries.map((entry) => entry.path)).toEqual([
      "text.bin",
      "rodata.bin",
      "data.bin",
    ]);
    expect(coverage?.status).toBe("unknown");
    expect(coverage?.limitations.join(" ")).toContain(
      "NRO asset header is truncated",
    );
    expect(reader.formatMetadata()).toMatchObject({ asset_section: null });
  } finally {
    await reader.close();
  }
});

it("reports 1-3 bytes after an NRO image as uninterpreted", async () => {
  for (const length of [1, 3]) {
    const reader = new SwitchExecutableArtifactReader(
      await fixture(buildNro({ trailing: Buffer.alloc(length, 0x41) })),
      "nro",
    );
    try {
      const { coverage } = await collect(reader);
      expect(coverage?.status).toBe("unknown");
      expect(coverage?.limitations.join(" ")).toContain(
        `${String(length)} bytes follow the NRO image without an ASET header`,
      );
    } finally {
      await reader.close();
    }
  }
});

it("reports an NRO shorter than its declared image size", async () => {
  const full = buildNro();
  const header = Buffer.from(full);
  // Declare 16 bytes more image than the file holds; segments still fit.
  header.writeUInt32LE(full.readUInt32LE(0x18) + 16, 0x18);
  const reader = new SwitchExecutableArtifactReader(
    await fixture(header),
    "nro",
  );
  try {
    const { entries, coverage } = await collect(reader);
    expect(entries).toHaveLength(3);
    expect(coverage?.status).toBe("unknown");
    expect(coverage?.limitations.join(" ")).toContain(
      "missing 16 bytes were not read",
    );
  } finally {
    await reader.close();
  }
});

it("retires a compressed segment's decode when the reader closes", async () => {
  const reader = new SwitchExecutableArtifactReader(
    await fixture(
      buildNso({
        segments: [
          Buffer.alloc(8 * 1024 * 1024, 7),
          Buffer.from("ro"),
          Buffer.from("rw"),
        ],
        compress: [true, false, false],
      }),
    ),
    "nso",
  );
  let closed = false;
  try {
    const { entries } = await collect(reader);
    const text = entries.find((entry) => entry.path === "text.bin");
    const stream = await reader.open(text!);
    const read = buffer(stream).catch((cause: unknown) => cause);
    // Let the owned stream start its carrier read and decode before close.
    await new Promise((resolve) => setImmediate(resolve));
    await reader.close();
    closed = true;
    // Close waited for the owned member stream, as it does for stored ranges.
    expect(stream.destroyed).toBe(true);
    const failure = await read;
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    expect(failure).toMatchObject({
      reason: "unavailable",
      message: "NSO reader closed",
    });
  } finally {
    if (!closed) await reader.close();
  }
});

it("cancels a decoded segment when the caller aborts", async () => {
  const reader = new SwitchExecutableArtifactReader(
    await fixture(buildNso()),
    "nso",
  );
  try {
    const { entries } = await collect(reader);
    const text = entries.find((entry) => entry.path === "text.bin");
    const controller = new AbortController();
    const stream = await reader.open(text!, controller.signal);
    controller.abort(new Error("caller stopped"));
    await expect(buffer(stream)).rejects.toMatchObject({
      reason: "cancelled",
    });
  } finally {
    await reader.close();
  }
});

const withDeadline = async <T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = testWaitDeadline(),
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

it.for([
  { label: "with no chunks read", chunksToRead: 0, action: "close" as const },
  {
    label: "after reading one chunk",
    chunksToRead: 1,
    action: "close" as const,
  },
  { label: "with no chunks read", chunksToRead: 0, action: "abort" as const },
  {
    label: "after reading one chunk",
    chunksToRead: 1,
    action: "abort" as const,
  },
])(
  "retires a paused compressed segment on $action $label",
  async ({ chunksToRead, action }) => {
    const reader = new SwitchExecutableArtifactReader(
      await fixture(
        buildNso({
          segments: [
            Buffer.alloc(512 * 1024, 0x5a),
            Buffer.from("ro"),
            Buffer.from("rw"),
          ],
          compress: [true, false, false],
        }),
      ),
      "nso",
    );
    let closed = false;
    try {
      const { entries } = await collect(reader);
      const text = entries.find((entry) => entry.path === "text.bin");
      const controller = new AbortController();
      const callerReason = new Error("caller stopped reading");
      const stream = await reader.open(text!, controller.signal);
      const settled = finished(stream, { cleanup: true }).catch(
        (cause: unknown) => cause,
      );
      await withDeadline(once(stream, "readable"), "initial buffer fill");
      for (let index = 0; index < chunksToRead; index++) {
        const chunk = stream.read() as Buffer | null;
        expect(chunk).not.toBeNull();
        expect(chunk!.length).toBeGreaterThan(0);
        await withDeadline(once(stream, "readable"), "buffer refill");
      }
      expect(stream.readableLength).toBeGreaterThan(0);
      if (action === "close") {
        await withDeadline(reader.close(), "reader.close()");
        closed = true;
        expect(stream.destroyed).toBe(true);
        const failure = await withDeadline(settled, "stream settlement");
        expect(failure).toBeInstanceOf(ArtifactReaderFailure);
        expect(failure).toMatchObject({
          reason: "unavailable",
          message: "NSO reader closed",
        });
      } else {
        controller.abort(callerReason);
        const failure = await withDeadline(
          settled,
          "aborted stream settlement",
        );
        expect(stream.destroyed).toBe(true);
        expect(failure).toBeInstanceOf(ArtifactReaderFailure);
        expect(failure).toMatchObject({
          reason: "cancelled",
          cause: callerReason,
        });
        await withDeadline(reader.close(), "reader.close() after abort");
        closed = true;
      }
    } finally {
      if (!closed) await reader.close();
    }
  },
);

it("surfaces the original error when a pending compressed segment read rejects", async () => {
  const path = await fixture(buildNso());
  const descriptor = await openRegularFile(path, { symlinks: "reject" });
  const reader = new SwitchExecutableArtifactReader(path, "nso", descriptor);
  const gate = phaseGate();
  const ioFailure = Object.assign(new Error("physical descriptor I/O failed"), {
    code: "EIO",
  });
  let closed = false;
  try {
    const { entries } = await collect(reader);
    const text = entries.find((entry) => entry.path === "text.bin");
    const { handle } = descriptor;
    const read = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation((...args: unknown[]) =>
      Promise.resolve(Reflect.apply(read, handle, args)).then(
        async (result) => {
          await gate.hold();
          return result;
        },
      ),
    );
    const controller = new AbortController();
    const stream = await reader.open(text!, controller.signal);
    const settled = finished(stream, { cleanup: true }).catch(
      (cause: unknown) => cause,
    );
    stream.resume();
    await gate.reached(settled, "compressed segment read");
    controller.abort(new Error("caller cancelled during pending read"));
    const closing = reader.close().then(() => {
      closed = true;
    });
    gate.reject(ioFailure);
    const failure = await withDeadline(settled, "pending read rejection");
    await withDeadline(closing, "reader.close() after read rejection");
    expect(failure).toBe(ioFailure);
  } finally {
    gate.release();
    if (!closed) await reader.close();
    await descriptor.handle.close();
  }
});
