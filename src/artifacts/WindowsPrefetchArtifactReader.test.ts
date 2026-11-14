import { expect, it, vi } from "vitest";

import { prefetchMetadataSchema } from "../domain/artifactFormatMetadata.js";
import { WindowsPrefetchArtifactReader } from "./WindowsPrefetchArtifactReader.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { ArtifactFileSource } from "./ArtifactFileSource.js";
import { assertArtifactReadActive } from "./ArtifactFileOperation.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import { prefetchFixture, writePrefetch } from "./windows/Prefetch.fixture.js";

const PARSED_VERSIONS = ["17", "23"] as const;

const readerFor = async (
  bytes: Buffer,
): Promise<WindowsPrefetchArtifactReader> =>
  new WindowsPrefetchArtifactReader(
    await writePrefetch("GOOGLE.EXE-1.pf", bytes),
  );

const inventory = async (
  reader: WindowsPrefetchArtifactReader,
): Promise<string[]> => {
  const limitations: string[] = [];
  for await (const _entry of reader.entries(undefined, {
    onCoverage: (coverage) => {
      limitations.push(...coverage.limitations);
    },
  }))
    continue;
  return limitations;
};

it.each(PARSED_VERSIONS)(
  "reports the v%s header without enumerating members",
  async (version) => {
    const reader = await readerFor(prefetchFixture({ version }));
    try {
      expect((await inventory(reader)).length).toBeGreaterThan(0);
      expect(reader.formatMetadata()).toMatchObject({
        kind: "windows-prefetch",
        version,
        file_bytes: prefetchFixture({ version }).length,
        executable_name: "GOOGLE.EXE",
        executable_path_hash: "1a2b3c4d",
      });
    } finally {
      await reader.close();
    }
  },
);

it("reports the v23 run count and last-run presence as declared", async () => {
  const reader = await readerFor(
    prefetchFixture({ version: "23", runCount: 12, runTimeSlots: 1 }),
  );
  try {
    await inventory(reader);
    expect(reader.formatMetadata()).toMatchObject({
      run_count: 12,
      run_time_slots: 1,
    });
  } finally {
    await reader.close();
  }
});

it("reports the v17 run count from the same field", async () => {
  const reader = await readerFor(prefetchFixture({ version: "17" }));
  try {
    await inventory(reader);
    expect(reader.formatMetadata()).toMatchObject({
      run_count: 7,
      run_time_slots: 1,
    });
  } finally {
    await reader.close();
  }
});

it("names the undecoded fields in its one limitation", async () => {
  const limitations = await inventory(
    await readerFor(prefetchFixture({ version: "23" })),
  );
  expect(limitations.join(" ")).toContain("not decoded");
});

it("identifies a Windows 8+ generation it does not parse", async () => {
  const reader = await readerFor(prefetchFixture({ version: "26" }));
  try {
    await expect(inventory(reader)).rejects.toMatchObject({
      reason: "unavailable",
      message: expect.stringContaining("v26") as unknown,
    });
  } finally {
    await reader.close();
  }
});

it("calls a truncated newer-generation capture malformed, not unsupported", async () => {
  const reader = await readerFor(
    prefetchFixture({ version: "26" }).subarray(0, 60),
  );
  try {
    await expect(inventory(reader)).rejects.toMatchObject({
      reason: "format",
      message: expect.stringContaining(
        "ends inside the Prefetch header",
      ) as unknown,
    });
  } finally {
    await reader.close();
  }
});

it("refuses a MAM container without calling it corrupt", async () => {
  const reader = await readerFor(
    prefetchFixture({ version: "23", compressed: true }),
  );
  try {
    await expect(inventory(reader)).rejects.toMatchObject({
      reason: "unavailable",
      message: expect.stringContaining("MAM") as unknown,
    });
  } finally {
    await reader.close();
  }
});

it("recognizes a checksum-bearing MAM header as the same container", async () => {
  // The wrapper sets the high bit of the compression byte when it records a
  // checksum; the low seven bits still select XPRESS Huffman, so this is the
  // same unsupported container rather than an unrecognized file.
  const reader = await readerFor(
    prefetchFixture({ version: "23", compressed: true, checksum: true }),
  );
  try {
    await expect(inventory(reader)).rejects.toMatchObject({
      reason: "unavailable",
      message: expect.stringContaining("MAM") as unknown,
    });
  } finally {
    await reader.close();
  }
});

it("calls a file that ends inside the MAM header malformed, not unsupported", async () => {
  const reader = await readerFor(
    prefetchFixture({ version: "23", compressed: true }).subarray(0, 5),
  );
  try {
    await expect(inventory(reader)).rejects.toMatchObject({
      reason: "format",
      message: expect.stringContaining("MAM container header") as unknown,
    });
    expect(reader.formatMetadata()).toBeUndefined();
  } finally {
    await reader.close();
  }
});

it("does not read a MAM prefix without the container version byte as Prefetch", async () => {
  // A file whose first three bytes spell "MAM" carries no container header, so
  // the three letters alone must not give it Prefetch provenance.
  const bytes = prefetchFixture({ version: "23", compressed: true });
  bytes[3] = 0;
  const snapshot = await scanCanonicalArtifactInventory(
    await writePrefetch("MAM-prefixed.bin", bytes),
  );
  expect(snapshot.manifest.root_format).not.toBe("windows-prefetch");
});

it.each([
  ["inside the version byte", 4],
  ["inside the uncompressed-size field", 5],
] as const)(
  "routes a MAM capture truncated %s to the Prefetch reader",
  async (_label, length) => {
    // The four-byte signature establishes MAM ownership; a capture that ends
    // inside the fixed header is a truncated container, not an executable. A
    // signature-only probe falls through to executable parsing, where this
    // truncation is indistinguishable from corruption.
    const bytes = prefetchFixture({ version: "23", compressed: true }).subarray(
      0,
      length,
    );
    await expect(
      scanCanonicalArtifactInventory(
        await writePrefetch("MAM-truncated.bin", bytes),
      ),
    ).rejects.toMatchObject({
      reason: "format",
      message: expect.stringContaining(
        "ends inside the MAM container header",
      ) as unknown,
    });
  },
);

it.each([
  ["17", 0x78],
  ["23", 0x80],
] as const)(
  "keeps the last-run timestamp unknown when a v%s capture ends before 0x%i",
  async (version, offset) => {
    // The file-information block is reached, but the generation's own FILETIME
    // is not, so presence cannot be claimed from the metrics array alone.
    const reader = await readerFor(
      prefetchFixture({ version }).subarray(0, offset + 4),
    );
    try {
      await inventory(reader);
      expect(reader.formatMetadata()).toMatchObject({ run_time_slots: null });
    } finally {
      await reader.close();
    }
  },
);

it("reports a truncated header as a format failure", async () => {
  const reader = await readerFor(
    prefetchFixture({ version: "23" }).subarray(0, 40),
  );
  try {
    await expect(inventory(reader)).rejects.toBeInstanceOf(
      ArtifactReaderFailure,
    );
  } finally {
    await reader.close();
  }
});

it("does not claim bytes that lack a Prefetch signature", async () => {
  const bytes = Buffer.alloc(128, 0x41);
  bytes.write("MZ", 0);
  const reader = await readerFor(bytes);
  try {
    await expect(inventory(reader)).rejects.toMatchObject({
      message: expect.stringContaining("No Prefetch generation") as unknown,
    });
  } finally {
    await reader.close();
  }
});

it("inventories a .pf file as windows-prefetch end to end", async () => {
  const path = await writePrefetch(
    "GOOGLE.EXE-1A2B3C4D.pf",
    prefetchFixture({ version: "23" }),
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("windows-prefetch");
  expect(snapshot.coverage).toMatchObject({
    scope: "container-entries",
    status: "complete",
  });
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root).toMatchObject({
    artifact_kind: "container",
    artifact_format: "windows-prefetch",
    format_metadata: {
      kind: "windows-prefetch",
      executable_name: "GOOGLE.EXE",
      run_count: 7,
    },
  });
  expect(
    snapshot.limitations.some((limitation) =>
      limitation.startsWith("Windows Prefetch inventory"),
    ),
  ).toBe(true);
});

it("rejects Prefetch sizes the parser cannot report", async () => {
  // A successful parse always holds the 84-byte common header and stays within
  // the 64 MiB allowance, so a persisted size outside that range is impossible
  // Evidence rather than a fact to accept at the boundary.
  const facts = {
    kind: "windows-prefetch",
    version: "23",
    file_bytes: 84,
    declared_file_bytes: 0,
    executable_name: null,
    executable_path_hash: "1a2b3c4d",
    run_count: null,
    run_time_slots: null,
  } as const;
  expect(prefetchMetadataSchema.parse(facts)).toMatchObject({ file_bytes: 84 });
  for (const invalid of [0, 83, 64 * 1024 * 1024 + 1, -1, 1.5])
    expect(() =>
      prefetchMetadataSchema.parse({ ...facts, file_bytes: invalid }),
    ).toThrow();
});

it("rejects run facts a capture this small could not report", async () => {
  // A capture reports the last-run FILETIME only from 128 bytes (v17) or 136
  // (v23), and the run count only from 156. Members are reachable only once the
  // bytes reach them, so these combinations are impossible Evidence even though
  // each member alone is in range.
  const facts = {
    kind: "windows-prefetch",
    version: "23",
    file_bytes: 84,
    declared_file_bytes: 0,
    executable_name: null,
    executable_path_hash: "1a2b3c4d",
    run_count: null,
    run_time_slots: null,
  } as const;
  expect(prefetchMetadataSchema.parse(facts)).toMatchObject(facts);
  for (const impossible of [
    { run_count: 7 },
    { run_time_slots: 1 },
    { run_count: 7, run_time_slots: 1 },
  ])
    expect(() =>
      prefetchMetadataSchema.parse({ ...facts, ...impossible }),
    ).toThrow();
  // Each fact becomes possible exactly at the byte the parser can reach it.
  for (const [version, fullFileBytes] of [
    ["17", 128],
    ["23", 136],
  ] as const) {
    expect(() =>
      prefetchMetadataSchema.parse({
        ...facts,
        version,
        file_bytes: fullFileBytes - 1,
        run_time_slots: 1,
      }),
    ).toThrow();
    expect(
      prefetchMetadataSchema.parse({
        ...facts,
        version,
        file_bytes: fullFileBytes,
        run_time_slots: 1,
      }),
    ).toMatchObject({ run_time_slots: 1 });
  }
  expect(() =>
    prefetchMetadataSchema.parse({ ...facts, file_bytes: 155, run_count: 7 }),
  ).toThrow();
  expect(
    prefetchMetadataSchema.parse({
      ...facts,
      file_bytes: 156,
      run_count: 7,
      run_time_slots: 1,
    }),
  ).toMatchObject({ run_count: 7, run_time_slots: 1 });
});

it("rejects a name hash that is not eight lowercase hex digits", async () => {
  // A persisted or client-supplied inventory parses `format_metadata` through
  // this schema, so a value the producer never emits must fail at the boundary
  // rather than propagate as a four-byte path hash.
  const facts = {
    kind: "windows-prefetch",
    version: "23",
    file_bytes: 84,
    declared_file_bytes: 0,
    executable_name: null,
    run_count: null,
    run_time_slots: null,
  } as const;
  expect(
    prefetchMetadataSchema.parse({
      ...facts,
      executable_path_hash: "1a2b3c4d",
    }),
  ).toMatchObject({ executable_path_hash: "1a2b3c4d" });
  // A successful parse always reaches the hash word, so null is impossible
  // Evidence rather than an absent fact.
  expect(() =>
    prefetchMetadataSchema.parse({ ...facts, executable_path_hash: null }),
  ).toThrow();
  for (const invalid of ["not-a-hash", "1A2B3C4D", "1a2b3c4", "1a2b3c4d5"])
    expect(() =>
      prefetchMetadataSchema.parse({ ...facts, executable_path_hash: invalid }),
    ).toThrow();
});

it("bounds the executable name to what the header field holds", async () => {
  // `utf16Name()` reads at most 30 UTF-16 code units and stops at the first
  // NUL, so an empty, NUL-bearing or over-long name is impossible Evidence.
  const facts = {
    kind: "windows-prefetch",
    version: "23",
    file_bytes: 84,
    declared_file_bytes: 0,
    executable_name: "GOOGLE.EXE",
    executable_path_hash: "1a2b3c4d",
    run_count: null,
    run_time_slots: null,
  } as const;
  expect(prefetchMetadataSchema.parse(facts)).toMatchObject({
    executable_name: "GOOGLE.EXE",
  });
  expect(
    prefetchMetadataSchema.parse({ ...facts, executable_name: null }),
  ).toMatchObject({ executable_name: null });
  expect(
    prefetchMetadataSchema.parse({ ...facts, executable_name: "A".repeat(30) }),
  ).toMatchObject({ executable_name: "A".repeat(30) });
  for (const invalid of ["", "GOOGLE\u0000.EXE", "A".repeat(31)])
    expect(() =>
      prefetchMetadataSchema.parse({ ...facts, executable_name: invalid }),
    ).toThrow();
});

it("retries a shared preparation cancelled by another traversal", async () => {
  const reader = await readerFor(prefetchFixture({ version: "23" }));
  const controller = new AbortController();
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const read = ArtifactFileSource.prototype.read;
  const spy = vi
    .spyOn(ArtifactFileSource.prototype, "read")
    .mockImplementationOnce(async function (this: ArtifactFileSource, signal) {
      entered();
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      assertArtifactReadActive(signal);
      return read.call(this, signal);
    });
  try {
    const cancelled = reader
      .entries(controller.signal)
      [Symbol.asyncIterator]()
      .next();
    const cancelledResult = expect(cancelled).rejects.toMatchObject({
      reason: "cancelled",
    });
    await started;
    const other = reader.entries()[Symbol.asyncIterator]().next();
    controller.abort("cancelled first traversal");
    await cancelledResult;
    await expect(other).resolves.toMatchObject({ done: true });
    expect(reader.formatMetadata()).toMatchObject({
      executable_name: "GOOGLE.EXE",
    });
  } finally {
    controller.abort();
    spy.mockRestore();
    await reader.close();
  }
});

it("verifies the source before publishing header facts", async () => {
  const reader = await readerFor(prefetchFixture({ version: "23" }));
  const read = ArtifactFileSource.prototype.read;
  const spy = vi
    .spyOn(ArtifactFileSource.prototype, "read")
    .mockImplementationOnce(function (this: ArtifactFileSource, signal) {
      return read.call(this, signal);
    })
    .mockRejectedValueOnce(new Error("final source verification failed"));
  try {
    await expect(
      reader.entries()[Symbol.asyncIterator]().next(),
    ).rejects.toThrow("final source verification failed");
    expect(reader.formatMetadata()).toBeUndefined();
    await expect(
      reader.entries()[Symbol.asyncIterator]().next(),
    ).resolves.toMatchObject({ done: true });
    expect(reader.formatMetadata()).toMatchObject({
      kind: "windows-prefetch",
      executable_name: "GOOGLE.EXE",
    });
  } finally {
    spy.mockRestore();
    await reader.close();
  }
});

it("reports a source that changed during the read as an integrity failure", async () => {
  // Bytes read before the source changed are not this file's contents, so a
  // capture that no longer parses must not be reported as stable malformed
  // input when the carrier itself moved.
  const reader = await readerFor(
    prefetchFixture({ version: "23" }).subarray(0, 60),
  );
  const read = ArtifactFileSource.prototype.read;
  const spy = vi
    .spyOn(ArtifactFileSource.prototype, "read")
    .mockImplementationOnce(function (this: ArtifactFileSource, signal) {
      return read.call(this, signal);
    })
    .mockRejectedValueOnce(
      new ArtifactReaderFailure("integrity", "source identity changed"),
    );
  try {
    await expect(
      reader.entries()[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({
      reason: "integrity",
      message: expect.stringContaining("identity changed") as unknown,
    });
  } finally {
    spy.mockRestore();
    await reader.close();
  }
});
